import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { RealtimeService } from '../realtime/realtime.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { FriendsService } from '../friends/friends.service';
import { GroupsService } from '../groups/groups.service';
import { LiveActivityService } from '../live-activity/live-activity.service';

@Injectable()
export class CheckinsService {
  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
    private realtime: RealtimeService,
    private gateway: RealtimeGateway,
    private friends: FriendsService,
    private groups: GroupsService,
    private liveActivity: LiveActivityService,
  ) {}

  /**
   * Build the Live Activity content state from a hydrated checkin row.
   * Mirrors the Swift `ContentState` struct in `SeatTimerWidget`.
   */
  private liveActivityState(checkin: any) {
    return {
      zoneName: checkin.zone?.name ?? 'Study Zone',
      building: checkin.zone?.floor?.building?.name ?? '',
      floor:
        checkin.zone?.floor?.name ?? `Floor ${checkin.zone?.floor?.index ?? '?'}`,
      seatLabel: checkin.seat?.label ?? null,
      startedAt: (checkin.startedAt as Date).toISOString(),
      expiresAt: checkin.expiresAt ? (checkin.expiresAt as Date).toISOString() : null,
      extendedCount: checkin.extendedCount ?? 0,
    };
  }

  /**
   * Fan presence (check-in / check-out) out to a user's friends and any
   * study groups they belong to. Best-effort: never throws.
   */
  private fanOutPresence(
    userId: string,
    kind: 'checked-in' | 'checked-out',
    zone?: { id: string; name: string; building: string; floor: string },
  ): void {
    void this.friends.broadcastPresenceToFriends(userId, kind, zone).catch(() => undefined);
    void this.groups.broadcastMemberPresence(userId, kind, zone).catch(() => undefined);
  }

  private get timeoutMinutes(): number {
    return parseInt(this.config.get('CHECKIN_TIMEOUT_MINUTES', '60'), 10);
  }

  private get maxExtensions(): number {
    return parseInt(this.config.get('CHECKIN_MAX_EXTENSIONS', '3'), 10);
  }

  async create(userId: string, qrToken: string) {
    // Verify QR token and get zone/seat info
    const { zoneId, seatId } = await this.verifyQRToken(qrToken);

    // Check if user already has an active check-in
    const existingCheckin = await this.prisma.checkin.findFirst({
      where: {
        userId,
        endedAt: null,
      },
    });

    if (existingCheckin) {
      throw new BadRequestException('You already have an active check-in. Please check out first.');
    }

    // If seat specified, check if seat is already occupied
    if (seatId) {
      const seatCheckin = await this.prisma.checkin.findFirst({
        where: {
          seatId,
          endedAt: null,
        },
      });

      if (seatCheckin) {
        throw new BadRequestException('This seat is already occupied');
      }
    }

    // Verify zone exists
    const zone = await this.prisma.zone.findUnique({
      where: { id: zoneId },
      include: {
        checkins: {
          where: { endedAt: null },
        },
        seats: {
          where: { isActive: true },
        },
      },
    });

    if (!zone) {
      throw new NotFoundException('Zone not found');
    }

    // Check capacity - use seat count if zone has seats, otherwise use capacity field
    const effectiveCapacity = zone.seats.length > 0 ? zone.seats.length : zone.capacity;
    if (zone.checkins.length >= effectiveCapacity) {
      throw new BadRequestException('Zone is at full capacity');
    }

    // Create check-in with configured timeout (default 60 min, see CHECKIN_TIMEOUT_MINUTES env)
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.timeoutMinutes * 60 * 1000);

    const checkin = await this.prisma.checkin.create({
      data: {
        userId,
        zoneId,
        seatId,
        expiresAt,
      },
      include: {
        zone: {
          include: {
            floor: {
              include: {
                building: true,
              },
            },
          },
        },
        seat: true,
      },
    });

    // Real-time fan-out (best-effort)
    void this.realtime.broadcastZoneOccupancy(zoneId).catch(() => undefined);
    this.gateway.emitMyCheckin(userId, {
      kind: 'created',
      checkinId: checkin.id,
      zoneId,
      expiresAt: checkin.expiresAt?.toISOString() ?? null,
    });

    // Friends + groups presence
    this.fanOutPresence(userId, 'checked-in', {
      id: checkin.zone.id,
      name: checkin.zone.name,
      building: checkin.zone.floor.building.name,
      floor: checkin.zone.floor.name || `Floor ${checkin.zone.floor.index}`,
    });

    return {
      id: checkin.id,
      startedAt: checkin.startedAt,
      expiresAt: checkin.expiresAt,
      zone: {
        id: checkin.zone.id,
        name: checkin.zone.name,
        building: checkin.zone.floor.building.name,
        floor: checkin.zone.floor.name || `Floor ${checkin.zone.floor.index}`,
      },
      seat: checkin.seat ? { id: checkin.seat.id, label: checkin.seat.label } : null,
    };
  }

  async checkout(id: string, userId: string) {
    const checkin = await this.prisma.checkin.findFirst({
      where: {
        id,
        userId,
        endedAt: null,
      },
      include: {
        zone: { include: { floor: { include: { building: true } } } },
        seat: true,
      },
    });

    if (!checkin) {
      throw new NotFoundException('Active check-in not found');
    }

    const updated = await this.prisma.checkin.update({
      where: { id },
      data: {
        endedAt: new Date(),
        endedReason: 'CHECKOUT',
      },
    });

    // Real-time fan-out (best-effort)
    void this.realtime.broadcastZoneOccupancy(checkin.zoneId).catch(() => undefined);
    this.gateway.emitMyCheckin(userId, {
      kind: 'ended',
      checkinId: id,
      zoneId: checkin.zoneId,
      expiresAt: null,
    });
    this.fanOutPresence(userId, 'checked-out');
    void this.liveActivity
      .pushEnd(id, this.liveActivityState(checkin))
      .catch(() => undefined);

    return updated;
  }

  async getActiveCheckin(userId: string) {
    const checkin = await this.prisma.checkin.findFirst({
      where: {
        userId,
        endedAt: null,
      },
      include: {
        zone: {
          include: {
            floor: {
              include: {
                building: true,
              },
            },
          },
        },
        seat: true,
      },
    });

    if (!checkin) {
      return null;
    }

    // Get the qrCodeId for validation during session extension
    const qrCodeId = checkin.seat?.qrCodeId || checkin.zone.qrCodeId;

    return {
      id: checkin.id,
      startedAt: checkin.startedAt,
      expiresAt: checkin.expiresAt,
      extendedCount: checkin.extendedCount,
      pomodoroUsed: checkin.pomodoroUsed,
      qrCodeId: qrCodeId, // Include for extension validation
      zone: {
        id: checkin.zone.id,
        name: checkin.zone.name,
        building: checkin.zone.floor.building.name,
        floor: checkin.zone.floor.name || `Floor ${checkin.zone.floor.index}`,
      },
      seat: checkin.seat ? { id: checkin.seat.id, label: checkin.seat.label } : null,
    };
  }

  async extendSession(userId: string) {
    const checkin = await this.prisma.checkin.findFirst({
      where: {
        userId,
        endedAt: null,
      },
    });

    if (!checkin) {
      throw new NotFoundException('No active check-in found');
    }

    // Check if session has already expired
    if (checkin.expiresAt && new Date() > checkin.expiresAt) {
      throw new BadRequestException('Session has already expired. Please check in again.');
    }

    // Cap the number of extensions to prevent indefinite seat hogging
    if (checkin.extendedCount >= this.maxExtensions) {
      throw new BadRequestException(
        `Maximum of ${this.maxExtensions} session extensions reached. Please check out and check in again.`,
      );
    }

    // Add the configured timeout to the current expiry time
    const currentExpiresAt = checkin.expiresAt ? new Date(checkin.expiresAt) : new Date();
    const newExpiresAt = new Date(
      currentExpiresAt.getTime() + this.timeoutMinutes * 60 * 1000,
    );

    const updated = await this.prisma.checkin.update({
      where: { id: checkin.id },
      data: {
        expiresAt: newExpiresAt,
        extendedCount: { increment: 1 },
        notifiedAt: null, // Reset notification flag so a new reminder fires
      },
      include: {
        zone: { include: { floor: { include: { building: true } } } },
        seat: true,
      },
    });

    this.gateway.emitMyCheckin(userId, {
      kind: 'extended',
      checkinId: checkin.id,
      zoneId: checkin.zoneId,
      expiresAt: updated.expiresAt?.toISOString() ?? null,
    });

    // Live Activity: push the new expiresAt so the lock-screen timer updates.
    void this.liveActivity
      .pushUpdate(checkin.id, this.liveActivityState(updated))
      .catch(() => undefined);

    return updated;
  }

  async updatePomodoroUsage(userId: string) {
    const checkin = await this.prisma.checkin.findFirst({
      where: {
        userId,
        endedAt: null,
      },
    });

    if (!checkin) {
      throw new NotFoundException('No active check-in found');
    }

    return this.prisma.checkin.update({
      where: { id: checkin.id },
      data: { pomodoroUsed: true },
    });
  }

  async checkExpiredSessions() {
    const now = new Date();
    const graceSeconds = parseInt(
      this.config.get('CHECKIN_GRACE_SECONDS', '60'),
      10,
    );
    const gracePeriod = new Date(now.getTime() - graceSeconds * 1000);

    // Find sessions that expired more than the grace period ago.
    // Hydrate enough zone/seat info for Live Activity end-state.
    const expiredCheckins = await this.prisma.checkin.findMany({
      where: {
        endedAt: null,
        expiresAt: {
          lt: gracePeriod,
        },
      },
      include: {
        zone: { include: { floor: { include: { building: true } } } },
        seat: true,
      },
    });

    // Auto-checkout expired sessions
    if (expiredCheckins.length > 0) {
      await this.prisma.checkin.updateMany({
        where: {
          id: { in: expiredCheckins.map(c => c.id) },
        },
        data: {
          endedAt: now,
          endedReason: 'TIMEOUT',
        },
      });

      // Real-time fan-out (best-effort)
      const uniqueZones = Array.from(new Set(expiredCheckins.map((c) => c.zoneId)));
      await Promise.all(
        uniqueZones.map((zoneId) =>
          this.realtime.broadcastZoneOccupancy(zoneId).catch(() => undefined),
        ),
      );
      for (const c of expiredCheckins) {
        this.fanOutPresence(c.userId, 'checked-out');
        this.gateway.emitMyCheckin(c.userId, {
          kind: 'ended',
          checkinId: c.id,
          zoneId: c.zoneId,
          expiresAt: null,
        });
        void this.liveActivity
          .pushEnd(c.id, this.liveActivityState(c))
          .catch(() => undefined);
      }
    }

    return { checkedOut: expiredCheckins.length };
  }

  async getUserStatistics(userId: string) {
    // Get all completed check-ins for the user
    const checkins = await this.prisma.checkin.findMany({
      where: {
        userId,
        endedAt: { not: null },
      },
      select: {
        startedAt: true,
        endedAt: true,
      },
    });

    // Calculate total time spent (in minutes)
    const totalMinutes = checkins.reduce((sum, checkin) => {
      if (!checkin.endedAt) return sum;
      const duration = checkin.endedAt.getTime() - checkin.startedAt.getTime();
      return sum + Math.floor(duration / (1000 * 60));
    }, 0);

    // Get current active check-in
    const activeCheckin = await this.getActiveCheckin(userId);
    let currentSessionMinutes = 0;
    if (activeCheckin) {
      currentSessionMinutes = Math.floor(
        (Date.now() - new Date(activeCheckin.startedAt).getTime()) / (1000 * 60)
      );
    }

    return {
      totalSessions: checkins.length,
      totalMinutes,
      totalHours: Math.floor(totalMinutes / 60),
      currentSessionMinutes,
      averageSessionMinutes: checkins.length > 0 ? Math.floor(totalMinutes / checkins.length) : 0,
    };
  }

  async previewQR(qrToken: string) {
    // Verify and parse QR token
    const { zoneId, seatId } = await this.verifyQRToken(qrToken);

    // Get zone details
    const zone = await this.prisma.zone.findUnique({
      where: { id: zoneId },
      include: {
        floor: {
          include: {
            building: true,
          },
        },
        checkins: {
          where: { endedAt: null },
        },
      },
    });

    if (!zone) {
      throw new NotFoundException('Zone not found');
    }

    let seat = null;
    if (seatId) {
      seat = await this.prisma.seat.findUnique({
        where: { id: seatId },
        include: {
          checkins: {
            where: { endedAt: null },
          },
          reviews: {
            select: {
              comfort: true,
              lighting: true,
              noise: true,
            },
          },
        },
      });
    }

    const availableSpots = seat 
      ? (seat.checkins.length === 0 ? 1 : 0)
      : (zone.capacity - zone.checkins.length);

    // Calculate seat ratings if available
    let seatRatings = null;
    if (seat && seat.reviews.length > 0) {
      const avgComfort = seat.reviews.reduce((sum, r) => sum + r.comfort, 0) / seat.reviews.length;
      const avgLighting = seat.reviews.reduce((sum, r) => sum + r.lighting, 0) / seat.reviews.length;
      const avgNoise = seat.reviews.reduce((sum, r) => sum + r.noise, 0) / seat.reviews.length;
      const overallAvg = (avgComfort + avgLighting + avgNoise) / 3;

      seatRatings = {
        totalReviews: seat.reviews.length,
        averageComfort: Number(avgComfort.toFixed(1)),
        averageLighting: Number(avgLighting.toFixed(1)),
        averageNoise: Number(avgNoise.toFixed(1)),
        overallAverage: Number(overallAvg.toFixed(1)),
      };
    }

    return {
      zone: {
        id: zone.id,
        name: zone.name,
        building: zone.floor.building.name,
        floor: zone.floor.name || `Floor ${zone.floor.index}`,
        capacity: zone.capacity,
        activeCheckins: zone.checkins.length,
        available: availableSpots > 0,
      },
      seat: seat ? {
        id: seat.id,
        label: seat.label,
        available: seat.checkins.length === 0,
        ratings: seatRatings,
      } : null,
    };
  }

  private async verifyQRToken(token: string): Promise<{ zoneId: string; seatId?: string }> {
    // Parse token format: QR-CODE-ID:timestamp:signature
    const parts = token.split(':');
    if (parts.length !== 3) {
      throw new BadRequestException('Invalid QR code format');
    }

    const [qrCodeId, timestamp, signature] = parts;
    const payload = `${qrCodeId}:${timestamp}`;
    const secret = this.config.get('QR_SECRET') || 'change-me-in-production';
    
    const expectedSignature = crypto
      .createHash('sha256')
      .update(`${payload}:${secret}`)
      .digest('hex');

    if (signature !== expectedSignature) {
      throw new BadRequestException('Invalid QR code signature');
    }

    // Check if QR code is for a seat
    const seat = await this.prisma.seat.findUnique({
      where: { qrCodeId },
      include: { zone: true },
    });

    if (seat) {
      if (!seat.isActive) {
        throw new BadRequestException('This seat is not active');
      }
      return { zoneId: seat.zoneId, seatId: seat.id };
    }

    // Check if QR code is for a zone
    const zone = await this.prisma.zone.findUnique({
      where: { qrCodeId },
    });

    if (zone) {
      if (!zone.isActive) {
        throw new BadRequestException('This zone is not active');
      }
      return { zoneId: zone.id };
    }

    throw new NotFoundException('QR code not found');
  }
}
