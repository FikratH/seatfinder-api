import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { GroupInviteStatus, GroupMemberRole } from '@prisma/client';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { PushService } from '../push/push.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { displayNameFor } from '../friends/friends.util';

/**
 * Study groups.
 *
 * Lifecycle:
 *   - `create()` makes a group with the caller as OWNER and a fresh 6-char
 *     join code (uppercase A–Z, digits 2–9 to avoid 0/O/1/I confusion).
 *   - `joinByCode()` adds the caller as MEMBER, capped by `maxMembers`.
 *   - `invite()` queues a PENDING `GroupInvite`; recipient may accept/decline.
 *   - `leave()` removes the member; OWNER may not leave (must transfer or delete).
 *   - `kick()` is OWNER-only.
 *   - `delete()` is OWNER-only and cascades members + invites.
 *
 * Presence:
 *   - `getDetail()` includes each member's current active checkin.
 *   - `broadcastMemberPresence()` is invoked from CheckinsService on every
 *     state change to push a `group:member-presence` event to all groups
 *     the user is a member of.
 */
@Injectable()
export class GroupsService {
  private readonly logger = new Logger(GroupsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly push: PushService,
    private readonly gateway: RealtimeGateway,
  ) {}

  // ─── Helpers ────────────────────────────────────────────────────────

  /** Generate a 6-char join code: digits 2–9 + uppercase A–Z minus O,I,L. */
  private generateJoinCode(): string {
    const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'; // excludes 0,1,I,O,L
    const out: string[] = [];
    const buf = randomBytes(6);
    for (let i = 0; i < 6; i++) out.push(ALPHABET[buf[i] % ALPHABET.length]);
    return out.join('');
  }

  private async assertMember(groupId: string, userId: string) {
    const m = await this.prisma.studyGroupMember.findUnique({
      where: { groupId_userId: { groupId, userId } },
      select: { id: true, role: true },
    });
    if (!m) throw new ForbiddenException('Not a member of this group');
    return m;
  }

  private async assertOwner(groupId: string, userId: string) {
    const g = await this.prisma.studyGroup.findUnique({
      where: { id: groupId },
      select: { ownerId: true },
    });
    if (!g) throw new NotFoundException('Group not found');
    if (g.ownerId !== userId) throw new ForbiddenException('Owner only');
    return g;
  }

  // ─── CRUD ───────────────────────────────────────────────────────────

  async create(
    callerId: string,
    data: { name: string; description?: string; isPublic?: boolean; maxMembers?: number },
  ) {
    const name = data.name?.trim();
    if (!name) throw new BadRequestException('Name is required');
    if (name.length > 80) throw new BadRequestException('Name too long');
    const max = data.maxMembers ?? 20;
    if (max < 2 || max > 100) throw new BadRequestException('maxMembers out of range (2-100)');

    // Retry up to 5 times on the rare unique collision.
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const joinCode = this.generateJoinCode();
        return await this.prisma.$transaction(async (tx) => {
          const group = await tx.studyGroup.create({
            data: {
              ownerId: callerId,
              name,
              description: data.description?.trim() || null,
              isPublic: data.isPublic ?? false,
              joinCode,
              maxMembers: max,
            },
          });
          await tx.studyGroupMember.create({
            data: {
              groupId: group.id,
              userId: callerId,
              role: GroupMemberRole.OWNER,
            },
          });
          return group;
        });
      } catch (err: any) {
        if (err?.code === 'P2002' && attempt < 4) continue;
        throw err;
      }
    }
    throw new ConflictException('Could not generate a unique join code; try again');
  }

  /** List groups the caller is a member of, with member counts + my role. */
  async listMine(callerId: string) {
    const memberships = await this.prisma.studyGroupMember.findMany({
      where: { userId: callerId },
      include: {
        group: {
          include: {
            _count: { select: { members: true } },
          },
        },
      },
      orderBy: { joinedAt: 'desc' },
    });

    return memberships.map((m) => ({
      id: m.group.id,
      name: m.group.name,
      description: m.group.description,
      isPublic: m.group.isPublic,
      joinCode: m.role === GroupMemberRole.OWNER ? m.group.joinCode : undefined, // don't leak code to non-owners in list
      maxMembers: m.group.maxMembers,
      memberCount: m.group._count.members,
      myRole: m.role,
      joinedAt: m.joinedAt,
      createdAt: m.group.createdAt,
    }));
  }

  /** Group detail with members + each member's live presence. */
  async getDetail(callerId: string, groupId: string) {
    await this.assertMember(groupId, callerId);

    const group = await this.prisma.studyGroup.findUnique({
      where: { id: groupId },
      include: {
        members: {
          include: {
            user: { select: { id: true, email: true, displayName: true } },
          },
          orderBy: { joinedAt: 'asc' },
        },
      },
    });
    if (!group) throw new NotFoundException();

    // Pull active check-ins for every member in one query.
    const userIds = group.members.map((m) => m.userId);
    const activeCheckins = await this.prisma.checkin.findMany({
      where: { userId: { in: userIds }, endedAt: null },
      include: { zone: { include: { floor: { include: { building: true } } } } },
    });
    const presenceById = new Map<string, (typeof activeCheckins)[number]>();
    for (const c of activeCheckins) presenceById.set(c.userId, c);

    return {
      id: group.id,
      name: group.name,
      description: group.description,
      isPublic: group.isPublic,
      // Only owners + admins see joinCode (so they can share it).
      joinCode:
        group.members.find(
          (m) => m.userId === callerId && (m.role === 'OWNER' || m.role === 'ADMIN'),
        )
          ? group.joinCode
          : undefined,
      maxMembers: group.maxMembers,
      ownerId: group.ownerId,
      myRole: group.members.find((m) => m.userId === callerId)?.role ?? null,
      createdAt: group.createdAt,
      members: group.members.map((m) => {
        const c = presenceById.get(m.userId);
        return {
          id: m.id,
          role: m.role,
          joinedAt: m.joinedAt,
          user: {
            id: m.user.id,
            email: m.user.email,
            displayName: displayNameFor(m.user),
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
      }),
    };
  }

  async update(
    callerId: string,
    groupId: string,
    patch: { name?: string; description?: string; isPublic?: boolean; maxMembers?: number },
  ) {
    await this.assertOwner(groupId, callerId);
    const data: any = {};
    if (patch.name !== undefined) {
      const n = patch.name.trim();
      if (!n) throw new BadRequestException('Name cannot be empty');
      if (n.length > 80) throw new BadRequestException('Name too long');
      data.name = n;
    }
    if (patch.description !== undefined) data.description = patch.description.trim() || null;
    if (patch.isPublic !== undefined) data.isPublic = patch.isPublic;
    if (patch.maxMembers !== undefined) {
      if (patch.maxMembers < 2 || patch.maxMembers > 100) {
        throw new BadRequestException('maxMembers out of range (2-100)');
      }
      data.maxMembers = patch.maxMembers;
    }
    return this.prisma.studyGroup.update({ where: { id: groupId }, data });
  }

  async delete(callerId: string, groupId: string) {
    await this.assertOwner(groupId, callerId);
    await this.prisma.studyGroup.delete({ where: { id: groupId } });
    return { ok: true };
  }

  // ─── Membership ─────────────────────────────────────────────────────

  async joinByCode(callerId: string, joinCode: string) {
    const code = joinCode?.trim().toUpperCase();
    if (!code || code.length !== 6) {
      throw new BadRequestException('Invalid join code');
    }
    const group = await this.prisma.studyGroup.findUnique({
      where: { joinCode: code },
      include: { _count: { select: { members: true } } },
    });
    if (!group) throw new NotFoundException('No group matches that code');

    return this.joinInternal(callerId, group.id, group.maxMembers, group._count.members);
  }

  private async joinInternal(
    callerId: string,
    groupId: string,
    maxMembers: number,
    currentMemberCount: number,
  ) {
    // Already a member?
    const existing = await this.prisma.studyGroupMember.findUnique({
      where: { groupId_userId: { groupId, userId: callerId } },
    });
    if (existing) {
      // Idempotent — return the group detail.
      return this.getDetail(callerId, groupId);
    }
    if (currentMemberCount >= maxMembers) {
      throw new ConflictException('Group is full');
    }

    await this.prisma.studyGroupMember.create({
      data: { groupId, userId: callerId, role: GroupMemberRole.MEMBER },
    });

    // Notify other members in real time so their roster updates.
    const me = await this.prisma.user.findUnique({
      where: { id: callerId },
      select: { email: true, displayName: true },
    });
    if (me) {
      this.gateway.emitGroupMemberPresence(groupId, {
        groupId,
        userId: callerId,
        displayName: displayNameFor(me),
        kind: 'checked-out', // they're not studying yet — mark as offline
        at: new Date().toISOString(),
      });
    }

    return this.getDetail(callerId, groupId);
  }

  async leave(callerId: string, groupId: string) {
    const m = await this.assertMember(groupId, callerId);
    if (m.role === GroupMemberRole.OWNER) {
      throw new BadRequestException(
        'Owner cannot leave. Delete the group or transfer ownership first.',
      );
    }
    await this.prisma.studyGroupMember.deleteMany({
      where: { groupId, userId: callerId },
    });
    return { ok: true };
  }

  async kick(callerId: string, groupId: string, targetUserId: string) {
    await this.assertOwner(groupId, callerId);
    if (targetUserId === callerId) {
      throw new BadRequestException("Owner can't kick themselves");
    }
    const result = await this.prisma.studyGroupMember.deleteMany({
      where: { groupId, userId: targetUserId },
    });
    if (result.count === 0) throw new NotFoundException('Member not in group');
    return { ok: true };
  }

  // ─── Invites ────────────────────────────────────────────────────────

  /** OWNER/ADMIN invites another user to the group. Pushes + realtime. */
  async invite(callerId: string, groupId: string, inviteeId: string) {
    const me = await this.assertMember(groupId, callerId);
    if (me.role === GroupMemberRole.MEMBER) {
      throw new ForbiddenException('Only owners/admins can invite');
    }
    if (inviteeId === callerId) throw new BadRequestException("Can't invite yourself");

    const [group, invitee, alreadyMember, alreadyPending] = await Promise.all([
      this.prisma.studyGroup.findUnique({
        where: { id: groupId },
        include: { _count: { select: { members: true } } },
      }),
      this.prisma.user.findUnique({
        where: { id: inviteeId },
        select: { id: true, email: true, displayName: true, status: true },
      }),
      this.prisma.studyGroupMember.findUnique({
        where: { groupId_userId: { groupId, userId: inviteeId } },
        select: { id: true },
      }),
      this.prisma.groupInvite.findFirst({
        where: { groupId, inviteeId, status: GroupInviteStatus.PENDING },
        select: { id: true },
      }),
    ]);
    if (!group) throw new NotFoundException('Group not found');
    if (!invitee || invitee.status !== 'ACTIVE') throw new NotFoundException('User not found');
    if (alreadyMember) throw new ConflictException('User is already a member');
    if (alreadyPending) return alreadyPending; // idempotent
    if (group._count.members >= group.maxMembers) {
      throw new ConflictException('Group is full');
    }

    const inviter = await this.prisma.user.findUnique({
      where: { id: callerId },
      select: { email: true, displayName: true },
    });
    const inviterName = inviter ? displayNameFor(inviter) : 'Someone';

    const created = await this.prisma.groupInvite.create({
      data: { groupId, inviterId: callerId, inviteeId },
    });

    this.gateway.emitGroupInvite(inviteeId, {
      inviteId: created.id,
      groupId,
      groupName: group.name,
      inviterDisplayName: inviterName,
      at: created.createdAt.toISOString(),
    });
    void this.push
      .sendToUser(inviteeId, {
        title: `${inviterName} invited you to ${group.name}`,
        body: 'Join the group to study together.',
        data: { type: 'group.invite', inviteId: created.id, groupId },
      })
      .catch((err) =>
        this.logger.warn(`Push failed for group invite: ${(err as Error).message}`),
      );

    return created;
  }

  async listMyInvites(callerId: string) {
    const invites = await this.prisma.groupInvite.findMany({
      where: { inviteeId: callerId, status: GroupInviteStatus.PENDING },
      include: {
        group: {
          include: { _count: { select: { members: true } } },
        },
        inviter: { select: { email: true, displayName: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    return invites.map((i) => ({
      id: i.id,
      createdAt: i.createdAt,
      group: {
        id: i.group.id,
        name: i.group.name,
        description: i.group.description,
        memberCount: i.group._count.members,
        maxMembers: i.group.maxMembers,
      },
      inviter: {
        email: i.inviter.email,
        displayName: displayNameFor(i.inviter),
      },
    }));
  }

  async acceptInvite(callerId: string, inviteId: string) {
    const invite = await this.prisma.groupInvite.findUnique({
      where: { id: inviteId },
      include: {
        group: { include: { _count: { select: { members: true } } } },
      },
    });
    if (!invite) throw new NotFoundException('Invite not found');
    if (invite.inviteeId !== callerId) throw new ForbiddenException();
    if (invite.status !== GroupInviteStatus.PENDING) {
      throw new BadRequestException('Invite is no longer pending');
    }

    await this.prisma.groupInvite.update({
      where: { id: invite.id },
      data: { status: GroupInviteStatus.ACCEPTED, respondedAt: new Date() },
    });

    return this.joinInternal(
      callerId,
      invite.groupId,
      invite.group.maxMembers,
      invite.group._count.members,
    );
  }

  async rejectInvite(callerId: string, inviteId: string) {
    const invite = await this.prisma.groupInvite.findUnique({ where: { id: inviteId } });
    if (!invite) throw new NotFoundException();
    if (invite.inviteeId !== callerId) throw new ForbiddenException();
    if (invite.status !== GroupInviteStatus.PENDING) return { ok: true };
    await this.prisma.groupInvite.update({
      where: { id: inviteId },
      data: { status: GroupInviteStatus.REJECTED, respondedAt: new Date() },
    });
    return { ok: true };
  }

  // ─── Cross-module: presence broadcast on every checkin lifecycle ────

  /** Tell every group the user is in that they just changed presence. */
  async broadcastMemberPresence(
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

      const memberships = await this.prisma.studyGroupMember.findMany({
        where: { userId },
        select: { groupId: true },
      });
      if (memberships.length === 0) return;

      const at = new Date().toISOString();
      for (const m of memberships) {
        this.gateway.emitGroupMemberPresence(m.groupId, {
          groupId: m.groupId,
          userId,
          displayName: myName,
          kind,
          zone,
          at,
        });
      }
    } catch (err) {
      this.logger.warn(`broadcastMemberPresence: ${(err as Error).message}`);
    }
  }
}
