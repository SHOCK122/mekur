import { createHash } from "node:crypto";

// API keys are minted by the Rust server now (crates/api/src/api_keys.rs,
// step 3c of docs/RUST_MIGRATION.md): `sak_` + base64url(24 random bytes),
// stored as base64(sha256(key)). The TS auth plugin still recognises and
// looks them up for the routes it serves.
const PREFIX = "sak_"; // "schedule app key"

export function hashApiKey(rawKey: string): string {
  return createHash("sha256").update(rawKey, "utf8").digest("base64");
}

export function looksLikeApiKey(token: string): boolean {
  return token.startsWith(PREFIX);
}
