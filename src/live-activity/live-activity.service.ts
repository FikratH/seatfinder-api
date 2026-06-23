import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ApnsClient } from './apns.client';

/**
 * Live Activity (iOS Dynamic Island) lifecycle.
 *
 * Wire flow:
 *   1. Mobile app calls `Activity.request()` with a generated push token.
 *   2. Mobile POSTs that token to `POST /live-activity/tokens` along with
 *      its checkinId. We persist the row.
 *   3. CheckinsService → on extend / checkout / timeout → calls
 *      `pushUpdate()` / `pushEnd()` here. Each invocation hits APNs with
 *      the latest content state so the Dynamic Island stays accurate.
 *
 * Notes:
 *   - Activity attributes type (Swift struct) is named `SeatTimerAttributes`
 *     and content state is `ContentState`. Both are mirrored verbatim in
 *     the iOS widget extension.
 *   - When APNs is not configured (dev / no .p8 key), all push attempts
 *     are silently no-ops; tokens are still persisted so the feature can
 *     be flipped on later just by setting env vars.
 */
@Injectable()
export class LiveActivityService {
  private readonly logger = new Logger(LiveActivityService.name);

  static readonly ATTRIBUTES_TYPE = 'SeatTimerAttributes';

  constructor(
    private readonly prisma: PrismaService,
    private readonly apns: ApnsClient,
  ) {}

  /** Mobile registers (or replaces) the APNs push token for a given checkin. */
  async registerToken(
    userId: string,
    checkinId: string,
    pushToken: string,
    frequencyToken?: string,
  ) {
    // Confirm the checkin belongs to the user.
    const checkin = await this.prisma.checkin.findFirst({
      where: { id: checkinId, userId, endedAt: null },
      select: { id: true },
    });
    if (!checkin) throw new NotFoundException('Active check-in not found');

    return this.prisma.liveActivityToken.upsert({
      where: { checkinId },
      update: { pushToken, frequencyToken: frequencyToken ?? null },
      create: { userId, checkinId, pushToken, frequencyToken: frequencyToken ?? null },
    });
  }

  async unregisterToken(userId: string, checkinId: string) {
    await this.prisma.liveActivityToken.deleteMany({
      where: { userId, checkinId },
    });
    return { ok: true };
  }

  /**
   * Push a content-state update for an active check-in. Looks up the
   * APNs push token for that checkin and sends a `liveactivity` packet.
   *
   * `event === 'end'` instructs iOS to gracefully end the activity (the
   * banner stays visible briefly per `dismissalDate`).
   */
  async pushUpdate(
    checkinId: string,
    contentState: {
      zoneName: string;
      building: string;
      floor: string;
      seatLabel: string | null;
      startedAt: string;
      expiresAt: string | null;
      extendedCount: number;
    },
    opts: { event?: 'update' | 'end'; dismissalDelaySec?: number } = {},
  ): Promise<boolean> {
    if (!this.apns.isConfigured()) {
      // No APNs creds → silently no-op (but log once for visibility).
      return false;
    }

    const row = await this.prisma.liveActivityToken.findUnique({
      where: { checkinId },
      select: { pushToken: true, userId: true },
    });
    if (!row) return false;

    const event = opts.event ?? 'update';
    const dismissalDate =
      event === 'end' && opts.dismissalDelaySec
        ? Math.floor(Date.now() / 1000) + opts.dismissalDelaySec
        : undefined;

    // Stale date: the activity should be considered stale ~5 minutes
    // after expiresAt — gives the timer a graceful "Time's up" state.
    const staleDate = contentState.expiresAt
      ? Math.floor(new Date(contentState.expiresAt).getTime() / 1000) + 5 * 60
      : undefined;

    const ok = await this.apns.pushLiveActivity({
      pushToken: row.pushToken,
      contentState,
      attributesType: LiveActivityService.ATTRIBUTES_TYPE,
      event,
      dismissalDate,
      staleDate,
    });

    await this.prisma.liveActivityToken.update({
      where: { checkinId },
      data: { lastPushedAt: new Date() },
    });

    if (event === 'end') {
      // Drop the token after the end push — the activity is finished.
      await this.prisma.liveActivityToken.deleteMany({ where: { checkinId } });
    }

    if (!ok) this.logger.warn(`Live Activity push failed for checkin ${checkinId}`);
    return ok;
  }

  /** Convenience: push a final 'end' frame and delete the token row. */
  async pushEnd(checkinId: string, finalState: {
    zoneName: string;
    building: string;
    floor: string;
    seatLabel: string | null;
    startedAt: string;
    expiresAt: string | null;
    extendedCount: number;
  }) {
    return this.pushUpdate(checkinId, finalState, {
      event: 'end',
      dismissalDelaySec: 60, // keep banner up for 60s after checkout
    });
  }
}
