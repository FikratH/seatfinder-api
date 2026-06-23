import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { CheckinsService } from './checkins.service';
import { RealtimeService } from '../realtime/realtime.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';

/**
 * Periodic cron that closes expired check-ins.
 *
 * - Primary path: delegates to `CheckinsService.checkExpiredSessions()`
 *   so realtime broadcasts and any future side-effects stay in one place.
 *
 * - Legacy fallback: any pre-`expiresAt` rows that snuck in (e.g. seeded
 *   with `expiresAt: null`) are forcibly closed once they exceed
 *   `CHECKIN_TIMEOUT_MINUTES` from `startedAt`, then their zones get a
 *   broadcast.
 */
@Injectable()
export class TimeoutService {
  private readonly logger = new Logger(TimeoutService.name);

  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
    private checkins: CheckinsService,
    private realtime: RealtimeService,
    private gateway: RealtimeGateway,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async handleTimeouts() {
    // 1. Modern path — handles broadcasts internally.
    const { checkedOut } = await this.checkins.checkExpiredSessions();
    if (checkedOut > 0) {
      this.logger.log(`Auto-checked-out ${checkedOut} expired check-ins`);
    }

    // 2. Legacy null-expiresAt safety net.
    const timeoutMinutes = parseInt(
      this.config.get('CHECKIN_TIMEOUT_MINUTES', '60'),
      10,
    );
    const legacyCutoff = new Date(Date.now() - timeoutMinutes * 60 * 1000);

    const stragglers = await this.prisma.checkin.findMany({
      where: {
        endedAt: null,
        expiresAt: null,
        startedAt: { lt: legacyCutoff },
      },
      select: { id: true, userId: true, zoneId: true },
    });
    if (stragglers.length === 0) return;

    await this.prisma.checkin.updateMany({
      where: { id: { in: stragglers.map((s) => s.id) } },
      data: { endedAt: new Date(), endedReason: 'TIMEOUT' },
    });

    const uniqueZones = Array.from(new Set(stragglers.map((s) => s.zoneId)));
    await Promise.all(
      uniqueZones.map((zoneId) =>
        this.realtime.broadcastZoneOccupancy(zoneId).catch(() => undefined),
      ),
    );
    for (const s of stragglers) {
      this.gateway.emitMyCheckin(s.userId, {
        kind: 'ended',
        checkinId: s.id,
        zoneId: s.zoneId,
        expiresAt: null,
      });
    }
    this.logger.log(`Closed ${stragglers.length} legacy null-expiresAt check-ins`);
  }
}
