import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeGateway } from './realtime.gateway';
import { ZoneOccupancyPayload } from './realtime.events';

/**
 * Domain wrapper around RealtimeGateway: callers ask "broadcast latest
 * occupancy for zone X" without needing to know how to compute it.
 */
@Injectable()
export class RealtimeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: RealtimeGateway,
  ) {}

  /**
   * Compute and broadcast the current occupancy snapshot for a zone.
   * Idempotent: safe to call multiple times back-to-back.
   */
  async broadcastZoneOccupancy(zoneId: string): Promise<ZoneOccupancyPayload | null> {
    const zone = await this.prisma.zone.findUnique({
      where: { id: zoneId },
      include: {
        seats: { where: { isActive: true } },
        checkins: { where: { endedAt: null } },
      },
    });
    if (!zone) return null;

    const totalSeats = zone.seats.length;
    const denominator = totalSeats > 0 ? totalSeats : zone.capacity;
    const activeCheckins = zone.checkins.length;
    const occupancyRate =
      denominator > 0
        ? Math.min(100, Math.round((activeCheckins / denominator) * 1000) / 10)
        : 0;

    const payload: ZoneOccupancyPayload = {
      zoneId,
      totalSeats,
      activeCheckins,
      occupancyRate,
      at: new Date().toISOString(),
    };
    this.gateway.emitZoneOccupancy(payload);
    return payload;
  }
}
