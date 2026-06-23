/**
 * Single source of truth for socket.io event names and payload shapes.
 * Imported by both the backend gateway and (mirrored to) the mobile client.
 */

export const REALTIME_EVENTS = {
  /** Server → client: occupancy of a single zone changed. */
  ZONE_OCCUPANCY: 'zone:occupancy',
  /** Server → client: the user's active check-in changed (created/extended/ended). */
  MY_CHECKIN: 'me:checkin',
  /** Server → client: a favorite zone became available (also pushed via Expo). */
  FAVORITE_AVAILABLE: 'favorite:available',
  /** Server → client: a friend's check-in/out — sent only to the friend's own user room. */
  FRIEND_PRESENCE: 'friend:presence',
  /** Server → client: an incoming friend request was received. */
  FRIEND_REQUEST: 'friend:request',
  /** Server → client: a study-group member just changed presence. */
  GROUP_MEMBER_PRESENCE: 'group:member-presence',
  /** Server → client: a study-group invite arrived. */
  GROUP_INVITE: 'group:invite',
  /** Client → server: subscribe to a specific zone room (low-traffic detail view). */
  SUBSCRIBE_ZONE: 'zone:subscribe',
  /** Client → server: leave a zone room. */
  UNSUBSCRIBE_ZONE: 'zone:unsubscribe',
  /** Client → server: subscribe to a study-group room. */
  SUBSCRIBE_GROUP: 'group:subscribe',
  /** Client → server: leave a study-group room. */
  UNSUBSCRIBE_GROUP: 'group:unsubscribe',
} as const;

export interface ZoneOccupancyPayload {
  zoneId: string;
  totalSeats: number;
  /** Active check-ins right now. */
  activeCheckins: number;
  /** activeCheckins / max(totalSeats, capacity) * 100, clamped 0..100. */
  occupancyRate: number;
  /** Server timestamp (ISO) the snapshot was computed at. */
  at: string;
}

export interface MyCheckinPayload {
  /** 'created' | 'extended' | 'ended' */
  kind: 'created' | 'extended' | 'ended';
  checkinId: string;
  zoneId: string;
  expiresAt: string | null;
}

export interface FavoriteAvailablePayload {
  zoneId: string;
  zoneName: string;
  building: string;
  floor: string;
  availableSeats: number;
  totalSeats: number;
  at: string;
}

export interface FriendPresencePayload {
  /** The friend whose status changed. */
  userId: string;
  displayName: string;
  /** 'checked-in' = friend just checked in (and is now studying).
   *  'checked-out' = friend just ended a session. */
  kind: 'checked-in' | 'checked-out';
  /** Populated when kind = checked-in. */
  zone?: {
    id: string;
    name: string;
    building: string;
    floor: string;
  };
  at: string;
}

export interface FriendRequestPayload {
  requestId: string;
  fromUserId: string;
  fromDisplayName: string;
  fromEmail: string;
  at: string;
}

export interface GroupMemberPresencePayload {
  groupId: string;
  userId: string;
  displayName: string;
  kind: 'checked-in' | 'checked-out';
  zone?: {
    id: string;
    name: string;
    building: string;
    floor: string;
  };
  at: string;
}

export interface GroupInvitePayload {
  inviteId: string;
  groupId: string;
  groupName: string;
  inviterDisplayName: string;
  at: string;
}
