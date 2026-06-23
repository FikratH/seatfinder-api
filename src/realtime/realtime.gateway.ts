import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Server, Socket } from 'socket.io';
import {
  REALTIME_EVENTS,
  ZoneOccupancyPayload,
  MyCheckinPayload,
  FavoriteAvailablePayload,
  FriendPresencePayload,
  FriendRequestPayload,
  GroupMemberPresencePayload,
  GroupInvitePayload,
} from './realtime.events';

interface AuthedSocket extends Socket {
  data: {
    userId?: string;
    role?: string;
  };
}

/**
 * Real-time gateway. socket.io rooms used:
 *   - `zone:<zoneId>` — anyone subscribed to a specific zone's live occupancy.
 *   - `user:<userId>` — that user's private channel (own check-in updates,
 *     favorite-available alerts that aren't targeted to a zone room).
 *
 * Authentication: JWT is read from `auth.token` on the handshake. Public
 * read-only subscribers (e.g. the home screen which already loads zones via
 * REST) are also accepted and only get the `zone:occupancy` broadcasts.
 */
@WebSocketGateway({
  cors: {
    origin: process.env.CORS_ORIGIN?.split(',') || '*',
    credentials: true,
  },
  // No path override — defaults to /socket.io
})
export class RealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(RealtimeGateway.name);

  @WebSocketServer()
  private server!: Server;

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  // ─── Connection lifecycle ────────────────────────────────────────────

  async handleConnection(client: AuthedSocket) {
    const token =
      (client.handshake.auth?.token as string | undefined) ??
      (client.handshake.headers?.authorization?.toString().replace(/^Bearer\s+/i, ''));

    if (token) {
      try {
        const payload = this.jwt.verify(token, {
          secret: this.config.get('JWT_SECRET'),
        });
        client.data.userId = payload.sub;
        client.data.role = payload.role;
        await client.join(`user:${payload.sub}`);
      } catch {
        // Invalid token — keep connection but treat as anonymous.
        this.logger.debug(`Anonymous socket ${client.id} (bad token)`);
      }
    }
  }

  handleDisconnect(client: AuthedSocket) {
    if (client.data?.userId) {
      this.logger.debug(`Socket disconnected user=${client.data.userId} sid=${client.id}`);
    }
  }

  // ─── Client → server: zone subscription ──────────────────────────────

  @SubscribeMessage(REALTIME_EVENTS.SUBSCRIBE_ZONE)
  async onSubscribeZone(
    @ConnectedSocket() client: AuthedSocket,
    @MessageBody() body: { zoneId?: string } | string,
  ) {
    const zoneId = typeof body === 'string' ? body : body?.zoneId;
    if (!zoneId || typeof zoneId !== 'string') return { ok: false };
    await client.join(`zone:${zoneId}`);
    return { ok: true };
  }

  @SubscribeMessage(REALTIME_EVENTS.UNSUBSCRIBE_ZONE)
  async onUnsubscribeZone(
    @ConnectedSocket() client: AuthedSocket,
    @MessageBody() body: { zoneId?: string } | string,
  ) {
    const zoneId = typeof body === 'string' ? body : body?.zoneId;
    if (!zoneId || typeof zoneId !== 'string') return { ok: false };
    await client.leave(`zone:${zoneId}`);
    return { ok: true };
  }

  /**
   * Subscribe to a study-group room. Caller must already be a member;
   * we rely on the REST layer to enforce membership before invoking this
   * (we don't reach into the DB from the gateway to keep it cheap).
   * The mobile client only ever calls this for groups it's confirmed in.
   */
  @SubscribeMessage(REALTIME_EVENTS.SUBSCRIBE_GROUP)
  async onSubscribeGroup(
    @ConnectedSocket() client: AuthedSocket,
    @MessageBody() body: { groupId?: string } | string,
  ) {
    const groupId = typeof body === 'string' ? body : body?.groupId;
    if (!groupId || typeof groupId !== 'string') return { ok: false };
    if (!client.data?.userId) return { ok: false }; // require auth
    await client.join(`group:${groupId}`);
    return { ok: true };
  }

  @SubscribeMessage(REALTIME_EVENTS.UNSUBSCRIBE_GROUP)
  async onUnsubscribeGroup(
    @ConnectedSocket() client: AuthedSocket,
    @MessageBody() body: { groupId?: string } | string,
  ) {
    const groupId = typeof body === 'string' ? body : body?.groupId;
    if (!groupId || typeof groupId !== 'string') return { ok: false };
    await client.leave(`group:${groupId}`);
    return { ok: true };
  }

  // ─── Server-side broadcast helpers ───────────────────────────────────

  /** Broadcast updated occupancy for a zone to anyone listening. */
  emitZoneOccupancy(payload: ZoneOccupancyPayload): void {
    // Targeted room for that zone (detail view subscribers)
    this.server.to(`zone:${payload.zoneId}`).emit(REALTIME_EVENTS.ZONE_OCCUPANCY, payload);
    // Plus a global broadcast for home-screen list views.
    this.server.emit(REALTIME_EVENTS.ZONE_OCCUPANCY, payload);
  }

  emitMyCheckin(userId: string, payload: MyCheckinPayload): void {
    this.server.to(`user:${userId}`).emit(REALTIME_EVENTS.MY_CHECKIN, payload);
  }

  emitFavoriteAvailable(userId: string, payload: FavoriteAvailablePayload): void {
    this.server.to(`user:${userId}`).emit(REALTIME_EVENTS.FAVORITE_AVAILABLE, payload);
  }

  /** Push a friend's check-in/out to *one* friend's user-room. */
  emitFriendPresence(toUserId: string, payload: FriendPresencePayload): void {
    this.server.to(`user:${toUserId}`).emit(REALTIME_EVENTS.FRIEND_PRESENCE, payload);
  }

  emitFriendRequest(toUserId: string, payload: FriendRequestPayload): void {
    this.server.to(`user:${toUserId}`).emit(REALTIME_EVENTS.FRIEND_REQUEST, payload);
  }

  emitGroupMemberPresence(groupId: string, payload: GroupMemberPresencePayload): void {
    this.server.to(`group:${groupId}`).emit(REALTIME_EVENTS.GROUP_MEMBER_PRESENCE, payload);
  }

  emitGroupInvite(toUserId: string, payload: GroupInvitePayload): void {
    this.server.to(`user:${toUserId}`).emit(REALTIME_EVENTS.GROUP_INVITE, payload);
  }
}
