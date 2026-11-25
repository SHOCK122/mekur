import { randomBytes, createHash } from "node:crypto";

const PREFIX = "sak_"; // "schedule app key"

export interface GeneratedApiKey {
  rawKey: string; // shown to the user exactly once, never stored
  keyPrefix: string; // safe to store/display so a user can tell keys apart
}

export function generateApiKey(): GeneratedApiKey {
  const rawKey = PREFIX + randomBytes(24).toString("base64url");
  return { rawKey, keyPrefix: rawKey.slice(0, PREFIX.length + 8) };
}

export function hashApiKey(rawKey: string): string {
  return createHash("sha256").update(rawKey, "utf8").digest("base64");
}

export function looksLikeApiKey(token: string): boolean {
  return token.startsWith(PREFIX);
}
