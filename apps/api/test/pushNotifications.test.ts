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

  function buildGroupEventPayload(
    organizer: { userId: string; keyPair: { secretKey: string; publicKey: string } },
    invitees: { userId: string; keyPair: { publicKey: string } }[]
  ) {
    const slots = { slot_1: { startTime: "2026-08-10T10:00:00.000Z", endTime: "2026-08-10T11:00:00.000Z" } };
    const eventKey = generateSymmetricKey();
    const contentEnvelope = encryptEnvelope({ title: "Team offsite", slots }, eventKey, "group-event-key");
    const allParticipants = [
      { userId: organizer.userId, publicKey: organizer.keyPair.publicKey },
      ...invitees.map((i) => ({ userId: i.userId, publicKey: i.keyPair.publicKey })),
    ];
    const participants = allParticipants.map((p) => ({
      userId: p.userId,
      wrappedKey: wrapKey(eventKey, deriveSharedWrapKey(organizer.keyPair.secretKey, p.publicKey)),
    }));
    return { slotIds: Object.keys(slots), contentEnvelope, participants };
  }

  it("notifies invited participants (not the organizer) when a group event is created", async () => {
    const organizer = await registerUser(app, "orgpush1");
    const invitee = await registerUser(app, "inviteepush1");
    await subscribe(app, organizer.token, "https://push.example.com/organizer-device");
    await subscribe(app, invitee.token, "https://push.example.com/invitee-device");

    const { slotIds, contentEnvelope, participants } = buildGroupEventPayload(organizer, [invitee]);
    const response = await app.inject({
      method: "POST",
      url: "/group-events",
      headers: auth(organizer.token),
      payload: { slotIds, contentEnvelope, participants },
    });
    expect(response.statusCode).toBe(201);

    // Only the invitee gets notified, not the organizer.
    expect(sendNotificationMock).toHaveBeenCalledTimes(1);
    const [subscriptionArg, payloadArg] = sendNotificationMock.mock.calls[0]!;
    expect(subscriptionArg.endpoint).toBe("https://push.example.com/invitee-device");
    const payload = JSON.parse(payloadArg as string);
    expect(payload.title).toBeTruthy();
    // The push payload must never contain the real event title/content --
    // the server never has it, so it can't leak it even by accident.
    expect(JSON.stringify(payload)).not.toContain("Team offsite");
  });

  it("notifies all other participants when a group event is resolved", async () => {
    const organizer = await registerUser(app, "orgpush2");
    const voter = await registerUser(app, "voterpush2");
    await subscribe(app, voter.token, "https://push.example.com/voter-device");

    const { slotIds, contentEnvelope, participants } = buildGroupEventPayload(organizer, [voter]);
    const createResp = await app.inject({
      method: "POST",
      url: "/group-events",
      headers: auth(organizer.token),
      payload: { slotIds, contentEnvelope, participants },
    });
    const groupEventId = createResp.json().groupEvent.id;
    sendNotificationMock.mockClear(); // ignore the create-time invite notification

    await app.inject({
      method: "POST",
      url: `/group-events/${groupEventId}/votes`,
      headers: auth(voter.token),
      payload: { rankings: [{ slotId: "slot_1", rank: 1 }] },
    });

    const resolveResp = await app.inject({
      method: "POST",
      url: `/group-events/${groupEventId}/resolve`,
      headers: auth(organizer.token),
    });
    expect(resolveResp.statusCode).toBe(200);

    expect(sendNotificationMock).toHaveBeenCalledTimes(1);
    const [subscriptionArg] = sendNotificationMock.mock.calls[0]!;
    expect(subscriptionArg.endpoint).toBe("https://push.example.com/voter-device");
  });

  it("prunes a subscription that the push service reports as gone (410)", async () => {
    const organizer = await registerUser(app, "orgpush3");
    const invitee = await registerUser(app, "inviteepush3");
    const endpoint = "https://push.example.com/dead-device";
    await subscribe(app, invitee.token, endpoint);

    sendNotificationMock.mockRejectedValueOnce(Object.assign(new Error("gone"), { statusCode: 410 }));

    const { slotIds, contentEnvelope, participants } = buildGroupEventPayload(organizer, [invitee]);
    const response = await app.inject({
      method: "POST",
      url: "/group-events",
      headers: auth(organizer.token),
      payload: { slotIds, contentEnvelope, participants },
    });
    expect(response.statusCode).toBe(201); // the failed push must not break event creation

    // The dead subscription should now be gone -- re-unsubscribing it
    // should 404 rather than actually deleting a still-live row.
    const unsubResp = await app.inject({
      method: "DELETE",
      url: "/push-subscriptions",
      headers: auth(invitee.token),
      payload: { endpoint },
    });
    expect(unsubResp.statusCode).toBe(404);
  });
});
