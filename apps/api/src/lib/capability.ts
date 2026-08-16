import { randomBytes, createHash } from "node:crypto";

/**
 * Capability tokens. Holding one *is* the authorisation -- there is no
 * identity check behind it, by design (see docs/ARCHITECTURE.md), so these
 * must be unguessable and are treated as sensitive as passwords.
 *
 * 32 random bytes is 256 bits. Only the hash is stored, so a database
 * breach yields values that cannot be replayed.
 */
export function generateCapabilityToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashCapabilityToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("base64");
}

/**
 * A voter's per-event pseudonym. Derived from the capability token plus the
 * event id, so the same person voting on two different events produces two
 * unlinkable pseudonyms -- the server cannot tell they are the same
 * account. Deterministic, so re-voting updates rather than duplicates.
 */
export function derivePseudonym(capabilityToken: string, eventId: string): string {
  return createHash("sha256")
    .update(`schedule-app:pseudonym:v1:${eventId}:${capabilityToken}`, "utf8")
    .digest("base64");
}
