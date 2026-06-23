/**
 * Helpers for the canonical-pair Friendship table.
 *
 * The table stores each pair exactly once, with the lexicographically smaller
 * userId in `userIdLow`. Always normalize at the call site so we can use a
 * `findUnique` on the composite `[userIdLow, userIdHigh]` index.
 */

export function orderedPair(a: string, b: string): { userIdLow: string; userIdHigh: string } {
  return a < b
    ? { userIdLow: a, userIdHigh: b }
    : { userIdLow: b, userIdHigh: a };
}

/** Derive a stable display name from a User row even if `displayName` is null. */
export function displayNameFor(u: { displayName: string | null; email: string }): string {
  if (u.displayName && u.displayName.trim()) return u.displayName.trim();
  // Fall back to local part of email — the same convention the mobile UI uses.
  const at = u.email.indexOf('@');
  return at > 0 ? u.email.slice(0, at) : u.email;
}
