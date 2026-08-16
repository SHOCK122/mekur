import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Database } from "../src/db/pool.js";
import {
  deriveAuthAndEncryptionKeys,
  generateKeyPair,
  generateSymmetricKey,
  deriveSharedWrapKey,
  wrapKey,
  encryptEnvelope,
} from "@schedule-app/crypto";
import { setupTestApp, truncateAll } from "./testHelpers.js";

const sendNotificationMock = vi.fn().mockResolvedValue(undefined);

vi.mock("web-push", () => ({
  default: {
    setVapidDetails: vi.fn(),
    sendNotification: (...args: unknown[]) => sendNotificationMock(...args),
  },
}));

async function registerUser(app: FastifyInstance, username: string) {
  const keys = await deriveAuthAndEncryptionKeys("some strong password");
  const keyPair = generateKeyPair();
  const response = await app.inject({
    method: "POST",
    url: "/users",
    payload: {
      username,
      displayName: username,
      publicKey: keyPair.publicKey,
      authKey: keys.authKey,
      authSalt: keys.salt,
    },
  });
  const body = response.json();
  return { userId: body.user.id as string, token: body.token as string, keyPair };
}

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

async function subscribe(app: FastifyInstance, token: string, endpoint: string) {
  return app.inject({
    method: "POST",
    url: "/push-subscriptions",
    headers: auth(token),
    payload: { endpoint, keys: { p256dh: "p256dh-value", auth: "auth-value" } },
  });
}

describe("push notifications", () => {
  let app: FastifyInstance;
  let db: Database;

  beforeAll(async () => {
    ({ app, db } = await setupTestApp());
  });

  beforeEach(async () => {
    await truncateAll(db);
    sendNotificationMock.mockClear();
    sendNotificationMock.mockResolvedValue(undefined);
  });

  afterAll(async () => {
    await app.close();
    await db.end();
  });

  it("exposes the VAPID public key without authentication", async () => {
    const response = await app.inject({ method: "GET", url: "/push/vapid-public-key" });
    expect(response.statusCode).toBe(200);
    expect(typeof response.json().publicKey).toBe("string");
  });

  it("requires auth to subscribe", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/push-subscriptions",
      payload: { endpoint: "https://push.example.com/abc", keys: { p256dh: "a", auth: "b" } },
    });
    expect(response.statusCode).toBe(401);
  });

  it("subscribes and can unsubscribe", async () => {
    const user = await registerUser(app, "subuser1");
    const endpoint = "https://push.example.com/subuser1-device";

    const subResp = await subscribe(app, user.token, endpoint);
    expect(subResp.statusCode).toBe(204);

    const unsubResp = await app.inject({
      method: "DELETE",
      url: "/push-subscriptions",
      headers: auth(user.token),
      payload: { endpoint },
    });
    expect(unsubResp.statusCode).toBe(204);
  });

  it("cannot unsubscribe someone else's subscription", async () => {
    const alice = await registerUser(app, "alicesub");
    const bob = await registerUser(app, "bobsub");
    const endpoint = "https://push.example.com/alice-device";
    await subscribe(app, alice.token, endpoint);

    const response = await app.inject({
      method: "DELETE",
      url: "/push-subscriptions",
      headers: auth(bob.token),
      payload: { endpoint },
    });
    expect(response.statusCode).toBe(404);
  });





  it("notifies a recipient when a capability is delivered to their inbox", async () => {
    // Under the capability model the server never knows an event's
    // participants, so delivery is the only moment it can legitimately
    // identify someone to notify.
    const sender = await registerUser(app, "sender1");
    const recipient = await registerUser(app, "recipient1");
    await subscribe(app, recipient.token, "https://push.example.com/recipient-device");

    const delivered = await app.inject({
      method: "POST",
      url: "/inbox/deliver",
      headers: auth(sender.token),
      payload: {
        recipientId: recipient.userId,
        envelope: { v: 1, algo: "xchacha20poly1305", keyId: "k", nonce: "bm9uY2U=", ciphertext: "c2VjcmV0" },
      },
    });
    expect(delivered.statusCode).toBe(204);

    expect(sendNotificationMock).toHaveBeenCalledTimes(1);
    const [subscriptionArg, payloadArg] = sendNotificationMock.mock.calls[0]!;
    expect(subscriptionArg.endpoint).toBe("https://push.example.com/recipient-device");
    // The server cannot read the envelope, so the payload cannot describe
    // what was shared even in principle.
    const payload = JSON.parse(payloadArg as string);
    expect(JSON.stringify(payload)).not.toContain("secret");
  }, 20_000);

  it("prunes a subscription the push service reports as gone (410), without failing delivery", async () => {
    const sender = await registerUser(app, "sender2");
    const recipient = await registerUser(app, "recipient2");
    const endpoint = "https://push.example.com/dead-device";
    await subscribe(app, recipient.token, endpoint);

    sendNotificationMock.mockRejectedValueOnce(Object.assign(new Error("gone"), { statusCode: 410 }));

    const delivered = await app.inject({
      method: "POST",
      url: "/inbox/deliver",
      headers: auth(sender.token),
      payload: { recipientId: recipient.userId, envelope: { v: 1, algo: "xchacha20poly1305", keyId: "k", nonce: "bm9uY2U=", ciphertext: "eA==" } },
    });
    // A failed push must never break the delivery that triggered it.
    expect(delivered.statusCode).toBe(204);

    const unsub = await app.inject({
      method: "DELETE",
      url: "/push-subscriptions",
      headers: auth(recipient.token),
      payload: { endpoint },
    });
    expect(unsub.statusCode).toBe(404); // already pruned
  }, 20_000);
});
