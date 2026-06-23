import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PushPlatform } from '@prisma/client';
import type {
  ExpoPushMessage,
  ExpoPushTicket,
  ExpoPushReceiptId,
} from 'expo-server-sdk';

export interface SendPushOptions {
  title: string;
  body: string;
  data?: Record<string, unknown>;
  /** Channel for Android. Defaults to 'default'. */
  channelId?: string;
  /** Sound. Defaults to 'default'. Pass `null` for silent. */
  sound?: 'default' | null;
}

/**
 * Production-grade push notification service backed by the Expo Push API.
 *
 * Key behaviors:
 *   - Validates tokens with `Expo.isExpoPushToken` before sending.
 *   - Chunks messages (Expo recommends ≤100 per request).
 *   - Walks back the response and removes tokens reported as
 *     `DeviceNotRegistered` so we don't keep hammering invalid devices.
 */
@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);
  private expo: any;

  constructor(private readonly prisma: PrismaService) {}

  /** Lazy-load the ESM-only expo-server-sdk module. */
  private async getExpo() {
    if (!this.expo) {
      const { Expo } = await import('expo-server-sdk');
      this.expo = new Expo({
        accessToken: process.env.EXPO_ACCESS_TOKEN, // optional, for higher-throughput accounts
      });
    }
    return this.expo;
  }

  private async isExpoPushToken(token: string): Promise<boolean> {
    const { Expo } = await import('expo-server-sdk');
    return Expo.isExpoPushToken(token);
  }

  // ─── Token registration ──────────────────────────────────────────────

  async registerToken(
    userId: string,
    token: string,
    platform?: PushPlatform,
    deviceName?: string,
  ) {
    if (!(await this.isExpoPushToken(token))) {
      throw new Error('Invalid Expo push token');
    }

    return this.prisma.pushToken.upsert({
      where: { token },
      create: { userId, token, platform, deviceName },
      update: {
        userId, // re-bind if a device was logged into another account
        platform,
        deviceName,
        lastSeenAt: new Date(),
      },
    });
  }

  async unregisterToken(userId: string, token: string) {
    await this.prisma.pushToken.deleteMany({ where: { userId, token } });
  }

  // ─── Sending ─────────────────────────────────────────────────────────

  /**
   * Send a notification to a single user (all of their devices).
   * Returns the number of tickets that were accepted by Expo.
   */
  async sendToUser(userId: string, opts: SendPushOptions): Promise<number> {
    const rows = await this.prisma.pushToken.findMany({
      where: { userId },
      select: { token: true },
    });
    return this.sendToTokens(
      rows.map((r) => r.token),
      opts,
    );
  }

  /**
   * Send to a list of raw tokens. Invalid tokens are filtered out and
   * `DeviceNotRegistered` results are pruned from the database.
   */
  async sendToTokens(tokens: string[], opts: SendPushOptions): Promise<number> {
    const valid: string[] = [];
    for (const t of tokens) {
      if (await this.isExpoPushToken(t)) valid.push(t);
    }
    if (valid.length === 0) return 0;

    const expo = await this.getExpo();
    const messages: ExpoPushMessage[] = valid.map((to) => ({
      to,
      title: opts.title,
      body: opts.body,
      data: opts.data ?? {},
      channelId: opts.channelId ?? 'default',
      sound: opts.sound === null ? null : 'default',
      priority: 'high',
    }));

    const chunks = expo.chunkPushNotifications(messages);
    const tickets: ExpoPushTicket[] = [];
    for (const chunk of chunks) {
      try {
        const chunkTickets = await expo.sendPushNotificationsAsync(chunk);
        tickets.push(...chunkTickets);
      } catch (err) {
        this.logger.error(`Expo push chunk failed: ${(err as Error).message}`);
      }
    }

    // Walk tickets and prune invalid tokens (best-effort; failures here
    // must never propagate).
    const tokensToDrop: string[] = [];
    tickets.forEach((ticket, i) => {
      if (ticket.status === 'error') {
        const code = ticket.details?.error;
        if (code === 'DeviceNotRegistered' || code === 'InvalidCredentials') {
          tokensToDrop.push(valid[i]);
        }
        this.logger.warn(`Push ticket error ${code}: ${ticket.message}`);
      }
    });
    if (tokensToDrop.length > 0) {
      await this.prisma.pushToken
        .deleteMany({ where: { token: { in: tokensToDrop } } })
        .catch(() => undefined);
    }

    // Schedule a deferred receipt check (non-blocking) — Expo recommends
    // verifying receipts ~15 min later. We keep it simple: best-effort
    // background fire-and-forget.
    const receiptIds: ExpoPushReceiptId[] = tickets
      .map((t) => (t.status === 'ok' ? t.id : undefined))
      .filter((x): x is ExpoPushReceiptId => Boolean(x));
    if (receiptIds.length > 0) {
      setTimeout(() => {
        this.checkReceipts(receiptIds).catch(() => undefined);
      }, 15 * 60 * 1000).unref?.();
    }

    return tickets.filter((t) => t.status === 'ok').length;
  }

  private async checkReceipts(ids: ExpoPushReceiptId[]) {
    const expo = await this.getExpo();
    const idChunks = expo.chunkPushNotificationReceiptIds(ids);
    for (const chunk of idChunks) {
      const receipts = await expo
        .getPushNotificationReceiptsAsync(chunk)
        .catch(() => ({} as Record<string, any>));
      for (const [id, receipt] of Object.entries(receipts)) {
        const r = receipt as any;
        if (r.status === 'error') {
          this.logger.warn(
            `Push receipt ${id} error: ${r.message} (${r.details?.error})`,
          );
        }
      }
    }
  }
}
