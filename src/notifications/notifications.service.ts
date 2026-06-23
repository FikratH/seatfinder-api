import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { PushService } from '../push/push.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';

/**
 * Outbound user-facing notifications. Two kinds:
 *
 *   1. Session-expiring reminders (cron).
 *      Fires once per check-in when the session is within
 *      `CHECKIN_NOTIFY_BEFORE_MINUTES` (default 10) of `expiresAt`.
 *      Idempotent: relies on `Checkin.notifiedAt` to guarantee a single push.
 *
 *   2. Favorite-zone availability (cron).
 *      Watches each user's favorited zones and pushes when seats become
 *      available below `FAVORITE_NOTIFY_OCCUPANCY_PCT` (default 80%).
 *      Debounced per favorite via `Favorite.lastNotifiedAt`
 *      (`FAVORITE_NOTIFY_COOLDOWN_MINUTES`, default 30).
 *
 *   3. Direct events (called by other services), e.g. report resolution.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly push: PushService,
    private readonly config: ConfigService,
    private readonly gateway: RealtimeGateway,
  ) {}

  // ─── Configuration ──────────────────────────────────────────────────

  private get notifyBeforeMinutes(): number {
    return parseInt(
      this.config.get('CHECKIN_NOTIFY_BEFORE_MINUTES', '10'),
      10,
    );
  }

  private get favoriteThresholdPct(): number {
    return parseInt(
      this.config.get('FAVORITE_NOTIFY_OCCUPANCY_PCT', '80'),
      10,
    );
  }

  private get favoriteCooldownMinutes(): number {
    return parseInt(
      this.config.get('FAVORITE_NOTIFY_COOLDOWN_MINUTES', '30'),
      10,
    );
  }

  // ─── 1. Session-expiring reminders ──────────────────────────────────

  @Cron(CronExpression.EVERY_MINUTE)
  async pushExpiringSessionReminders() {
    const before = this.notifyBeforeMinutes;
    const now = new Date();
    const horizon = new Date(now.getTime() + before * 60 * 1000);

    const candidates = await this.prisma.checkin.findMany({
      where: {
        endedAt: null,
        notifiedAt: null,
        expiresAt: { gt: now, lte: horizon },
      },
      include: {
        zone: { include: { floor: { include: { building: true } } } },
      },
      take: 200, // safety cap per minute
    });

    if (candidates.length === 0) return;

    for (const c of candidates) {
      const minutesLeft = Math.max(
        1,
        Math.round((c.expiresAt!.getTime() - now.getTime()) / 60000),
      );
      try {
        await this.push.sendToUser(c.userId, {
          title: 'Your study session is ending soon',
          body: `${minutesLeft} min left at ${c.zone.name} — extend or check out.`,
          data: {
            type: 'checkin.expiring',
            checkinId: c.id,
            zoneId: c.zoneId,
          },
        });
      } catch (err) {
        this.logger.warn(
          `Failed to push expiring reminder for ${c.id}: ${(err as Error).message}`,
        );
      }
      // Mark as notified regardless of push success so we don't spam if Expo is down.
      await this.prisma.checkin.update({
        where: { id: c.id },
        data: { notifiedAt: now },
      });
    }

    this.logger.log(`Sent ${candidates.length} expiring-session reminders`);
  }

  // ─── 2. Favorite-zone availability ──────────────────────────────────

  /**
   * Run every 2 minutes — fine-grained enough to feel "live" but cheap
   * (one query per favorited zone).
   */
  @Cron('*/2 * * * *')
  async pushFavoriteAvailability() {
    const cooldownMs = this.favoriteCooldownMinutes * 60 * 1000;
    const now = new Date();
    const cooldownThreshold = new Date(now.getTime() - cooldownMs);
    const occupancyMaxPct = this.favoriteThresholdPct;

    // Pull every favorite that is not within its cooldown window.
    const favorites = await this.prisma.favorite.findMany({
      where: {
        OR: [{ lastNotifiedAt: null }, { lastNotifiedAt: { lt: cooldownThreshold } }],
      },
      include: {
        zone: {
          include: {
            floor: { include: { building: true } },
            seats: { where: { isActive: true } },
            checkins: { where: { endedAt: null } },
          },
        },
      },
      take: 500,
    });

    if (favorites.length === 0) return;

    let sent = 0;
    for (const fav of favorites) {
      const z = fav.zone;
      const denominator = z.seats.length > 0 ? z.seats.length : z.capacity;
      if (denominator <= 0) continue;
      const active = z.checkins.length;
      const occupancyPct = (active / denominator) * 100;
      if (occupancyPct >= occupancyMaxPct) continue;

      const availableSeats = Math.max(0, denominator - active);
      const buildingName = z.floor.building.name;
      const floorName = z.floor.name || `Floor ${z.floor.index}`;

      try {
        await this.push.sendToUser(fav.userId, {
          title: `Seats opened up at ${z.name}`,
          body: `${availableSeats} available at ${buildingName} • ${floorName}.`,
          data: {
            type: 'favorite.available',
            zoneId: z.id,
          },
        });
        this.gateway.emitFavoriteAvailable(fav.userId, {
          zoneId: z.id,
          zoneName: z.name,
          building: buildingName,
          floor: floorName,
          availableSeats,
          totalSeats: z.seats.length,
          at: now.toISOString(),
        });
        sent++;
      } catch (err) {
        this.logger.warn(
          `Failed to push favorite-available for fav ${fav.id}: ${(err as Error).message}`,
        );
      }

      await this.prisma.favorite.update({
        where: { id: fav.id },
        data: { lastNotifiedAt: now },
      });
    }

    if (sent > 0) {
      this.logger.log(`Sent ${sent} favorite-available alerts`);
    }
  }

  // ─── 3. Direct triggers from other services ─────────────────────────

  async notifyReportResolved(
    userId: string | null | undefined,
    reportId: string,
    resolved: boolean,
    resolution?: string | null,
  ) {
    if (!userId) return; // anonymous report
    const verb = resolved ? 'resolved' : 'closed';
    await this.push
      .sendToUser(userId, {
        title: `Your report was ${verb}`,
        body: resolution || (resolved ? 'Thanks for letting us know.' : 'No further action needed.'),
        data: { type: 'report.updated', reportId, resolved },
      })
      .catch((err) =>
        this.logger.warn(
          `Push for resolved report failed: ${(err as Error).message}`,
        ),
      );
  }
}
