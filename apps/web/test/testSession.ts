import { generateKeyPair, generateSymmetricKey } from "@schedule-app/crypto";
import type { Session } from "../src/lib/session.js";

/**
 * A session with real key material but without running scrypt, which is
 * deliberately slow (~2s) and made the suite time out under parallel load.
 * Nothing in the web client depends on *how* the keys were derived.
 */
let counter = 0;

export function testSession(overrides: Partial<Session> = {}): Session {
  const identity = generateKeyPair();
  return {
    userId: "u1",
    username: "ada",
    // Unique per session: the keyring cache is keyed by token, and tests
    // must never see each other's cached keyring.
    token: `t-${++counter}`,
    encryptionKey: generateSymmetricKey(),
    identityPublicKey: identity.publicKey,
    identitySecretKey: identity.secretKey,
    ...overrides,
  };
}
