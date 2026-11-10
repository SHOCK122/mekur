// Cross-language test vectors for the Rust port (crates/crypto).
//
// ts_vectors.json is made by THIS package: key derivations from fixed
// passwords and salts (deterministic -- checked on every run), plus
// envelopes and sealed envelopes (random nonces and ephemeral keys --
// recorded once). The Rust tests must derive the same keys and open every
// envelope. rust_vectors.json is made by the Rust crate; this test opens
// every envelope in it. Together they prove both directions interoperate,
// which the transition depends on. Regenerate the TS side with:
//
//   UPDATE_CRYPTO_VECTORS=1 npm run test --workspace=@schedule-app/crypto
//
// and the Rust side with `UPDATE_CRYPTO_VECTORS=1 cargo test -p mekur-crypto`.
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { EncryptedEnvelope, SealedEnvelope } from "@schedule-app/shared";
import {
  deriveAuthAndEncryptionKeys,
  sha256Base64,
  encryptEnvelope,
  decryptEnvelope,
  sealToRecipient,
  openSealed,
  fromBase64,
  type KeyPair,
} from "../src/index.js";

const dir = "../../../crates/crypto/tests/fixtures/";
const TS_VECTORS = fileURLToPath(new URL(dir + "ts_vectors.json", import.meta.url));
const RUST_VECTORS = fileURLToPath(new URL(dir + "rust_vectors.json", import.meta.url));

// Passwords chosen to exercise NFKC: "ﬁ" (U+FB01) normalises to "fi", and
// "Å" written as A + combining ring normalises to U+00C5 -- so pairs of
// these must derive identical keys in both languages.
const DERIVATIONS: { password: string; salt: string }[] = [
  { password: "correct horse battery staple", salt: "AAECAwQFBgcICQoLDA0ODw==" },
  { password: "", salt: "AAAAAAAAAAAAAAAAAAAAAA==" },
  { password: "ﬁne Å", salt: "/////////////////////w==" },
  { password: "fine Å", salt: "/////////////////////w==" },
  { password: "pässwörd \u{1F511} 日本語", salt: "c2NoZWR1bGUtYXBwIXNhbHQ=" },
];

// Payloads exercising JSON corner cases: unicode (astral, escapes,
// U+2028), nesting, numbers, every JSON type at the top level.
const PAYLOADS: unknown[] = [
  { title: "Team sync", startTime: "2026-08-01T10:00:00.000Z", endTime: "2026-08-01T11:00:00.000Z" },
  { title: "Ünïcödé \u{1F600}   \"quoted\" \\ \n\t", nested: { a: [1, -2.5, 1e21, 0.1, null, true] } },
  "a bare string",
  42,
  null,
  [],
];

type Derivation = {
  password: string;
  salt: string;
  authKey: string;
  encryptionKey: string;
  identityPublicKey: string;
  identitySecretKey: string;
  authKeyHash: string;
};
type EnvelopeVector = { key: string; envelope: EncryptedEnvelope; payload: unknown };
type SealedVector = {
  recipientSecretKey: string;
  sealed: SealedEnvelope;
  payload: unknown;
  senderPublicKey: string | null;
};
type ForgedVector = { recipientSecretKey: string; sealed: SealedEnvelope };
type Vectors = {
  derivations: Derivation[];
  envelopes: EnvelopeVector[];
  sealed: SealedVector[];
  forged: ForgedVector[];
};

async function derive(): Promise<Derivation[]> {
  const out: Derivation[] = [];
  for (const { password, salt } of DERIVATIONS) {
    const k = await deriveAuthAndEncryptionKeys(password, fromBase64(salt));
    out.push({
      password,
      salt,
      authKey: k.authKey,
      encryptionKey: k.encryptionKey,
      identityPublicKey: k.identityKeyPair.publicKey,
      identitySecretKey: k.identityKeyPair.secretKey,
      authKeyHash: sha256Base64(k.authKey),
    });
  }
  return out;
}

describe("cross-language vectors", () => {
  it("derives the recorded keys, and the TS envelopes still open", async () => {
    const derivations = await derive();
    // NFKC: the two spellings derive the same keys.
    expect(derivations[2]!.authKey).toBe(derivations[3]!.authKey);

    if (process.env.UPDATE_CRYPTO_VECTORS) {
      const [alice, bob] = [derivations[0]!, derivations[4]!];
      const pair = (d: Derivation): KeyPair => ({ publicKey: d.identityPublicKey, secretKey: d.identitySecretKey });
      const vectors: Vectors = {
        derivations,
        envelopes: PAYLOADS.map((payload, i) => {
          const key = i % 2 ? alice.encryptionKey : bob.encryptionKey;
          return { key, envelope: encryptEnvelope(payload, key, `key-${i}`), payload };
        }),
        sealed: PAYLOADS.flatMap((payload) => [
          {
            recipientSecretKey: bob.identitySecretKey,
            sealed: sealToRecipient(payload, bob.identityPublicKey),
            payload,
            senderPublicKey: null,
          },
          {
            recipientSecretKey: bob.identitySecretKey,
            sealed: sealToRecipient(payload, bob.identityPublicKey, pair(alice)),
            payload,
            senderPublicKey: alice.identityPublicKey,
          },
        ]),
        // Claims to be from alice but was made with another secret key.
        forged: [
          {
            recipientSecretKey: bob.identitySecretKey,
            sealed: sealToRecipient("trust me", bob.identityPublicKey, {
              publicKey: alice.identityPublicKey,
              secretKey: derivations[1]!.identitySecretKey,
            }),
          },
        ],
      };
      writeFileSync(TS_VECTORS, JSON.stringify(vectors, null, 2) + "\n");
    }

    const vectors = JSON.parse(readFileSync(TS_VECTORS, "utf8")) as Vectors;
    expect(vectors.derivations).toEqual(derivations);
    for (const v of vectors.envelopes) expect(decryptEnvelope(v.envelope, v.key)).toEqual(v.payload);
    for (const v of vectors.sealed) {
      expect(openSealed(v.sealed, v.recipientSecretKey)).toEqual({
        payload: v.payload,
        senderPublicKey: v.senderPublicKey,
      });
    }
    for (const v of vectors.forged) expect(() => openSealed(v.sealed, v.recipientSecretKey)).toThrow(/Sender proof/);
  }, 60_000);

  it("opens every envelope the Rust crate made", () => {
    expect(existsSync(RUST_VECTORS)).toBe(true);
    const vectors = JSON.parse(readFileSync(RUST_VECTORS, "utf8")) as Vectors;
    expect(vectors.envelopes.length).toBeGreaterThan(0);
    expect(vectors.sealed.length).toBeGreaterThan(0);
    for (const v of vectors.envelopes) expect(decryptEnvelope(v.envelope, v.key)).toEqual(v.payload);
    for (const v of vectors.sealed) {
      expect(openSealed(v.sealed, v.recipientSecretKey)).toEqual({
        payload: v.payload,
        senderPublicKey: v.senderPublicKey,
      });
    }
    for (const v of vectors.forged) expect(() => openSealed(v.sealed, v.recipientSecretKey)).toThrow(/Sender proof/);
  });
});
