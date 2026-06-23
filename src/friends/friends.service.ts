import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { FriendRequestStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PushService } from '../push/push.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { displayNameFor, orderedPair } from './friends.util';

/**
 * Friendship logic.
 *
 * Design choices:
 *   1. Friendship is mutual and stored once per pair (canonical lexicographic
 *      order). All reads/writes use `orderedPair` to normalize.
 *   2. FriendRequest is directional. Only one PENDING row per direction is
 *      allowed by the DB unique. We additionally collapse race-conditions
 *      where A invites B while B is in the middle of inviting A:
 *        - if a reciprocal PENDING request exists, we auto-accept instead of
 *          creating a second one.
 *   3. Search is case-insensitive on email + displayName, and excludes self,
 *      banned users, and existing friends.
 *   4. Presence (active check-in info per friend) is computed by joining
 *      Checkin (where endedAt is null). For 100s of friends this is a single
 *      indexed query, not N+1.
 */
@Injectable()
export class FriendsService {
  private readonly logger = new Logger(FriendsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly push: PushService,
    private readonly gateway: RealtimeGateway,
  ) {}

  // ─── Search ─────────────────────────────────────────────────────────

  /**
   * Search users by email or displayName, case-insensitive. Excludes:
   *   - the caller themselves
   *   - banned/deleted users
   * For each result, annotate the relationship: friend | request_sent |
   * request_received | none. The mobile UI uses this to render the right CTA
   * (Add / Pending / Accept).
   */
  async searchUsers(callerId: string, query: string, limit = 20) {
    const q = query?.trim();
    if (!q || q.length < 2) return [];

    const users = await this.prisma.user.findMany({
      where: {
        AND: [
          { id: { not: callerId } },
          { status: 'ACTIVE' },
          {
            OR: [
              { email: { contains: q, mode: 'insensitive' } },
              { displayName: { contains: q, mode: 'insensitive' } },
            ],
          },
        ],
      },
      take: Math.min(limit, 50),
      orderBy: [{ displayName: 'asc' }, { email: 'asc' }],
      select: { id: true, email: true, displayName: true },
    });
    if (users.length === 0) return [];

    const otherIds = users.map((u) => u.id);

    // One query each for friendships and pending requests, both in a single batch.
    const [friendshipsLow, friendshipsHigh, pendingRequests] = await Promise.all([
      this.prisma.friendship.findMany({
        where: { userIdLow: callerId, userIdHigh: { in: otherIds } },
        select: { userIdHigh: true },
      }),
      this.prisma.friendship.findMany({
        where: { userIdHigh: callerId, userIdLow: { in: otherIds } },
        select: { userIdLow: true },
      }),
      this.prisma.friendRequest.findMany({
        where: {
          status: FriendRequestStatus.PENDING,
          OR: [
            { fromUserId: callerId, toUserId: { in: otherIds } },
            { toUserId: callerId, fromUserId: { in: otherIds } },
          ],
        },
        select: { id: true, fromUserId: true, toUserId: true },
      }),
    ]);

    const friendIds = new Set<string>([
      ...friendshipsLow.map((f) => f.userIdHigh),
      ...friendshipsHigh.map((f) => f.userIdLow),
    ]);
    const sentTo = new Map<string, string>(); // otherId -> requestId
    const receivedFrom = new Map<string, string>();
    for (const r of pendingRequests) {
      if (r.fromUserId === callerId) sentTo.set(r.toUserId, r.id);
      else if (r.toUserId === callerId) receivedFrom.set(r.fromUserId, r.id);
    }

    return users.map((u) => {
      let relationship: 'friend' | 'request_sent' | 'request_received' | 'none' = 'none';
      let requestId: string | undefined;
      if (friendIds.has(u.id)) {
        relationship = 'friend';
      } else if (sentTo.has(u.id)) {
        relationship = 'request_sent';
        requestId = sentTo.get(u.id);
      } else if (receivedFrom.has(u.id)) {
        relationship = 'request_received';
        requestId = receivedFrom.get(u.id);
      }
      return {
        id: u.id,
        email: u.email,
        displayName: displayNameFor(u),
        relationship,
        requestId,
      };
    });
  }

  // ─── Requests ───────────────────────────────────────────────────────

  /** Send a request. Auto-accepts if the other user already invited the caller. */
  async sendRequest(fromUserId: string, toUserId: string) {
    if (fromUserId === toUserId) {
      throw new BadRequestException("Can't friend yourself");
    }

    const target = await this.prisma.user.findUnique({
      where: { id: toUserId },
      select: { id: true, email: true, displayName: true, status: true },
    });
    if (!target || target.status !== 'ACTIVE') {
      throw new NotFoundException('User not found');
    }

    // Already friends?
    const pair = orderedPair(fromUserId, toUserId);
    const existing = await this.prisma.friendship.findUnique({
      where: { userIdLow_userIdHigh: pair },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException('Already friends');
    }

    // Reciprocal pending? Auto-accept.
    const reciprocal = await this.prisma.friendRequest.findFirst({
      where: {
        fromUserId: toUserId,
        toUserId: fromUserId,
        status: FriendRequestStatus.PENDING,
      },
    });
    if (reciprocal) {
      return this.acceptRequest(fromUserId, reciprocal.id);
    }

    // Already pending in our direction?
    const ourPending = await this.prisma.friendRequest.findFirst({
      where: {
        fromUserId,
        toUserId,
        status: FriendRequestStatus.PENDING,
      },
    });
    if (ourPending) return ourPending;

    const sender = await this.prisma.user.findUnique({
      where: { id: fromUserId },
      select: { email: true, displayName: true },
    });
    if (!sender) throw new NotFoundException('Sender disappeared'); // shouldn't happen

    const created = await this.prisma.friendRequest.create({
      data: { fromUserId, toUserId, status: FriendRequestStatus.PENDING },
    });

    const fromName = displayNameFor(sender);
    // Real-time + push (best-effort)
    this.gateway.emitFriendRequest(toUserId, {
      requestId: created.id,
      fromUserId,
      fromDisplayName: fromName,
      fromEmail: sender.email,
      at: created.createdAt.toISOString(),
    });
    void this.push
      .sendToUser(toUserId, {
        title: 'New friend request',
        body: `${fromName} wants to study with you.`,
        data: { type: 'friend.request', requestId: created.id, fromUserId },
      })
      .catch((err) =>
        this.logger.warn(`Push failed for friend request: ${(err as Error).message}`),
      );

    return created;
  }

  /** Recipient accepts: create the Friendship row and mark request accepted. */
  async acceptRequest(callerId: string, requestId: string) {
    const req = await this.prisma.friendRequest.findUnique({
      where: { id: requestId },
    });
    if (!req) throw new NotFoundException('Request not found');
    if (req.toUserId !== callerId) throw new ForbiddenException();
    if (req.status !== FriendRequestStatus.PENDING) {
      throw new BadRequestException('Request is no longer pending');
    }

    const pair = orderedPair(req.fromUserId, req.toUserId);

    const result = await this.prisma.$transaction(async (tx) => {
      // Mark this request accepted; cancel any reciprocal pending one.
      await tx.friendRequest.update({
        where: { id: requestId },
        data: { status: FriendRequestStatus.ACCEPTED, respondedAt: new Date() },
      });
      await tx.friendRequest.updateMany({
        where: {
          fromUserId: req.toUserId,
          toUserId: req.fromUserId,
          status: FriendRequestStatus.PENDING,
        },
        data: { status: FriendRequestStatus.CANCELLED, respondedAt: new Date() },
      });

      // Create the canonical friendship if it doesn't exist (defensive).
      const friendship = await tx.friendship.upsert({
        where: { userIdLow_userIdHigh: pair },
        update: {},
        create: pair,
      });

      return friendship;
    });

    // Notify the original sender that their request was accepted.
    const accepter = await this.prisma.user.findUnique({
      where: { id: callerId },
      select: { email: true, displayName: true },
    });
    if (accepter) {
      const accepterName = displayNameFor(accepter);
      void this.push
        .sendToUser(req.fromUserId, {
          title: `${accepterName} accepted your friend request`,
          body: `You're now friends. See where they're studying.`,
          data: { type: 'friend.accepted', userId: callerId },
        })
        .catch(() => undefined);
    }

    return result;
  }

  /** Recipient rejects (deletes the row). */
  async rejectRequest(callerId: string, requestId: string) {
    const req = await this.prisma.friendRequest.findUnique({
      where: { id: requestId },
    });
    if (!req) throw new NotFoundException('Request not found');
    if (req.toUserId !== callerId) throw new ForbiddenException();
    if (req.status !== FriendRequestStatus.PENDING) {
      throw new BadRequestException('Request is no longer pending');
    }
    await this.prisma.friendRequest.update({
      where: { id: requestId },
      data: { status: FriendRequestStatus.REJECTED, respondedAt: new Date() },
    });
    return { ok: true };
  }

  /** Sender cancels their own pending request. */
  async cancelRequest(callerId: string, requestId: string) {
    const req = await this.prisma.friendRequest.findUnique({
      where: { id: requestId },
    });
    if (!req) throw new NotFoundException('Request not found');
    if (req.fromUserId !== callerId) throw new ForbiddenException();
    if (req.status !== FriendRequestStatus.PENDING) return { ok: true };
    await this.prisma.friendRequest.update({
      where: { id: requestId },
      data: { status: FriendRequestStatus.CANCELLED, respondedAt: new Date() },
    });
    return { ok: true };
  }

  /** Inbound + outbound pending requests. */
  async listPendingRequests(callerId: string) {
    const [incoming, outgoing] = await Promise.all([
      this.prisma.friendRequest.findMany({
        where: { toUserId: callerId, status: FriendRequestStatus.PENDING },
        include: {
          fromUser: { select: { id: true, email: true, displayName: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.friendRequest.findMany({
        where: { fromUserId: callerId, status: FriendRequestStatus.PENDING },
        include: {
          toUser: { select: { id: true, email: true, displayName: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    return {
      incoming: incoming.map((r) => ({
        id: r.id,
        createdAt: r.createdAt,
        from: {
          id: r.fromUser.id,
          email: r.fromUser.email,
          displayName: displayNameFor(r.fromUser),
        },
      })),
      outgoing: outgoing.map((r) => ({
        id: r.id,
        createdAt: r.createdAt,
        to: {
          id: r.toUser.id,
          email: r.toUser.email,
          displayName: displayNameFor(r.toUser),
        },
      })),
    };
  }

  // ─── Friends list with live presence ────────────────────────────────

  /** List the user's friends, each with their current active checkin (if any). */
  async listFriendsWithPresence(callerId: string) {
    // 1) Pull all friend rows containing the caller, in a single union query.
    const [low, high] = await Promise.all([
      this.prisma.friendship.findMany({
        where: { userIdLow: callerId },
        include: {
          userHigh: { select: { id: true, email: true, displayName: true } },
        },
      }),
      this.prisma.friendship.findMany({
        where: { userIdHigh: callerId },
        include: {
          userLow: { select: { id: true, email: true, displayName: true } },
        },
      }),
    ]);
    const friends = [
      ...low.map((f) => ({ friendshipId: f.id, since: f.createdAt, user: f.userHigh })),
      ...high.map((f) => ({ friendshipId: f.id, since: f.createdAt, user: f.userLow })),
    ];
    if (friends.length === 0) return [];

    // 2) One query for every friend's current active checkin.
    const friendIds = friends.map((f) => f.user.id);
    const activeCheckins = await this.prisma.checkin.findMany({
      where: { userId: { in: friendIds }, endedAt: null },
      include: {
        zone: { include: { floor: { include: { building: true } } } },
      },
    });
    const presenceById = new Map<string, (typeof activeCheckins)[number]>();
    for (const c of activeCheckins) presenceById.set(c.userId, c);

    return friends
      .map((f) => {
        const c = presenceById.get(f.user.id);
        return {
          id: f.friendshipId,
          since: f.since,
          user: {
            id: f.user.id,
            email: f.user.email,
            displayName: displayNameFor(f.user),
          },
          presence: c
            ? {
                kind: 'checked-in' as const,
                checkinId: c.id,
                startedAt: c.startedAt,
                expiresAt: c.expiresAt,
                zone: {
                  id: c.zone.id,
                  name: c.zone.name,
                  building: c.zone.floor.building.name,
                  floor: c.zone.floor.name || `Floor ${c.zone.floor.index}`,
                },
              }
            : { kind: 'offline' as const },
        };
      })
      .sort((a, b) => {
        // Sort: studying friends first (most recently checked in), then offline alphabetically.
        const aLive = a.presence.kind === 'checked-in';
        const bLive = b.presence.kind === 'checked-in';
        if (aLive && !bLive) return -1;
        if (!aLive && bLive) return 1;
        return a.user.displayName.localeCompare(b.user.displayName);
      });
  }

  /** Remove a friendship in either direction. */
  async unfriend(callerId: string, otherUserId: string) {
    const pair = orderedPair(callerId, otherUserId);
    const result = await this.prisma.friendship.deleteMany({ where: pair });
    return { removed: result.count };
  }

  // ─── Cross-module: emit presence to all friends ─────────────────────

  /**
   * Called by CheckinsService whenever a user checks in or out.
   * Looks up the user's friends and emits a `friend:presence` event to each.
   * Best-effort: any failure is logged, never thrown.
   */
  async broadcastPresenceToFriends(
    userId: string,
    kind: 'checked-in' | 'checked-out',
    zone?: { id: string; name: string; building: string; floor: string },
  ): Promise<void> {
    try {
      const me = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { email: true, displayName: true },
      });
      if (!me) return;
      const myName = displayNameFor(me);

      // Friend ids: caller is either Low or High.
      const [low, high] = await Promise.all([
        this.prisma.friendship.findMany({
          where: { userIdLow: userId },
          select: { userIdHigh: true },
        }),
        this.prisma.friendship.findMany({
          where: { userIdHigh: userId },
          select: { userIdLow: true },
        }),
      ]);
      const friendIds = [
        ...low.map((f) => f.userIdHigh),
        ...high.map((f) => f.userIdLow),
      ];
      if (friendIds.length === 0) return;

      const at = new Date().toISOString();
      for (const fid of friendIds) {
        this.gateway.emitFriendPresence(fid, {
          userId,
          displayName: myName,
          kind,
          zone,
          at,
        });
      }
    } catch (err) {
      this.logger.warn(`broadcastPresenceToFriends: ${(err as Error).message}`);
    }
  }
}
