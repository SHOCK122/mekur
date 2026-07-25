import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Database } from "../src/db/pool.js";
import {
  deriveAuthAndEncryptionKeys,
  generateKeyPair,
  generateSymmetricKey,
  deriveSharedWrapKey,
  wrapKey,
  unwrapKey,
  encryptEnvelope,
  decryptEnvelope,
} from "@schedule-app/crypto";
import { setupTestApp, truncateAll } from "./testHelpers.js";

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
  return {
    userId: body.user.id as string,
    token: body.token as string,
    keyPair,
  };
}

describe("group event routes", () => {
  let app: FastifyInstance;
  let db: Database;

  beforeAll(async () => {
    ({ app, db } = await setupTestApp());
  });

  beforeEach(async () => {
    await truncateAll(db);
  });

  afterAll(async () => {
    await app.close();
    await db.end();
  });

  function auth(token: string) {
    return { authorization: `Bearer ${token}` };
  }

  /** Builds the create-group-event payload the way a real client would:
   * generate an event key, encrypt the real content under it, and wrap
   * a copy of the event key to every participant (including the organizer). */
  function buildGroupEventPayload(
    organizer: { userId: string; keyPair: { secretKey: string; publicKey: string } },
    invitees: { userId: string; keyPair: { publicKey: string } }[],
    slots: Record<string, { startTime: string; endTime: string }>
  ) {
    const eventKey = generateSymmetricKey();
    const contentEnvelope = encryptEnvelope(
      { title: "Team offsite", slots },
      eventKey,
      "group-event-key"
    );

    const allParticipants = [
      { userId: organizer.userId, publicKey: organizer.keyPair.publicKey },
      ...invitees.map((i) => ({ userId: i.userId, publicKey: i.keyPair.publicKey })),
    ];

    const participants = allParticipants.map((p) => ({
      userId: p.userId,
      wrappedKey: wrapKey(eventKey, deriveSharedWrapKey(organizer.keyPair.secretKey, p.publicKey)),
    }));

    return { slotIds: Object.keys(slots), contentEnvelope, participants, eventKey };
  }

  it("creates a group event, and every invitee can decrypt the real content via their own wrapped key", async () => {
    const organizer = await registerUser(app, "organizer1");
    const invitee = await registerUser(app, "invitee1");

    const slots = {
      slot_1: { startTime: "2026-08-10T10:00:00.000Z", endTime: "2026-08-10T11:00:00.000Z" },
      slot_2: { startTime: "2026-08-11T10:00:00.000Z", endTime: "2026-08-11T11:00:00.000Z" },
    };
    const { slotIds, contentEnvelope, participants } = buildGroupEventPayload(
      organizer,
      [invitee],
      slots
    );

    const createResp = await app.inject({
      method: "POST",
      url: "/group-events",
      headers: auth(organizer.token),
      payload: { slotIds, contentEnvelope, participants },
    });
    expect(createResp.statusCode).toBe(201);
    const created = createResp.json().groupEvent;
    expect(created.slotIds.sort()).toEqual(["slot_1", "slot_2"]);
    expect(created.status).toBe("open");

    // The invitee fetches the event and must be able to recover the real
    // content using ONLY their own wrapped key + their own private key +
    // the organizer's public key -- never anything the server derived.
    const getResp = await app.inject({
      method: "GET",
      url: `/group-events/${created.id}`,
      headers: auth(invitee.token),
    });
    expect(getResp.statusCode).toBe(200);
    const fetched = getResp.json().groupEvent;

    const inviteeWrapKey = deriveSharedWrapKey(invitee.keyPair.secretKey, organizer.keyPair.publicKey);
    const recoveredEventKey = unwrapKey(fetched.myWrappedKey, inviteeWrapKey);
    const recoveredContent = decryptEnvelope<{ title: string; slots: typeof slots }>(
      fetched.contentEnvelope,
      recoveredEventKey
    );
    expect(recoveredContent.title).toBe("Team offsite");
    expect(recoveredContent.slots).toEqual(slots);
  });

  it("rejects creating a group event that omits the organizer as a participant", async () => {
    const organizer = await registerUser(app, "organizer2");
    const invitee = await registerUser(app, "invitee2");
    const slots = { slot_1: { startTime: "2026-08-10T10:00:00.000Z", endTime: "2026-08-10T11:00:00.000Z" } };
    const { slotIds, contentEnvelope, participants } = buildGroupEventPayload(
      organizer,
      [invitee],
      slots
    );
    const withoutOrganizer = participants.filter((p) => p.userId !== organizer.userId);

    const response = await app.inject({
      method: "POST",
      url: "/group-events",
      headers: auth(organizer.token),
      payload: { slotIds, contentEnvelope, participants: withoutOrganizer },
    });
    expect(response.statusCode).toBe(400);
  });

  it("never lets a non-participant see or fetch the event", async () => {
    const organizer = await registerUser(app, "organizer3");
    const invitee = await registerUser(app, "invitee3");
    const outsider = await registerUser(app, "outsider3");
    const slots = { slot_1: { startTime: "2026-08-10T10:00:00.000Z", endTime: "2026-08-10T11:00:00.000Z" } };
    const { slotIds, contentEnvelope, participants } = buildGroupEventPayload(
      organizer,
      [invitee],
      slots
    );
    const createResp = await app.inject({
      method: "POST",
      url: "/group-events",
      headers: auth(organizer.token),
      payload: { slotIds, contentEnvelope, participants },
    });
    const created = createResp.json().groupEvent;

    const listResp = await app.inject({
      method: "GET",
      url: "/group-events",
      headers: auth(outsider.token),
    });
    expect(listResp.json().groupEvents).toHaveLength(0);

    const getResp = await app.inject({
      method: "GET",
      url: `/group-events/${created.id}`,
      headers: auth(outsider.token),
    });
    expect(getResp.statusCode).toBe(404);
  });

  it("resolves a group event to the slot with the lowest total rank, using only opaque slot IDs", async () => {
    const organizer = await registerUser(app, "organizer4");
    const voterA = await registerUser(app, "votera4");
    const voterB = await registerUser(app, "voterb4");

    const slots = {
      slot_1: { startTime: "2026-08-10T10:00:00.000Z", endTime: "2026-08-10T11:00:00.000Z" },
      slot_2: { startTime: "2026-08-11T10:00:00.000Z", endTime: "2026-08-11T11:00:00.000Z" },
    };
    const { slotIds, contentEnvelope, participants } = buildGroupEventPayload(
      organizer,
      [voterA, voterB],
      slots
    );
    const createResp = await app.inject({
      method: "POST",
      url: "/group-events",
      headers: auth(organizer.token),
      payload: { slotIds, contentEnvelope, participants },
    });
    const groupEventId = createResp.json().groupEvent.id;

    // Both voters prefer slot_1 (rank 1) over slot_2 (rank 2).
    for (const voter of [voterA, voterB]) {
      const voteResp = await app.inject({
        method: "POST",
        url: `/group-events/${groupEventId}/votes`,
        headers: auth(voter.token),
        payload: { rankings: [{ slotId: "slot_1", rank: 1 }, { slotId: "slot_2", rank: 2 }] },
      });
      expect(voteResp.statusCode).toBe(204);
    }

    const resolveResp = await app.inject({
      method: "POST",
      url: `/group-events/${groupEventId}/resolve`,
      headers: auth(organizer.token),
    });
    expect(resolveResp.statusCode).toBe(200);
    const resolved = resolveResp.json().groupEvent;
    expect(resolved.status).toBe("resolved");
    expect(resolved.resolvedSlotId).toBe("slot_1");
  });

  it("only the organizer can resolve; a voter cannot", async () => {
    const organizer = await registerUser(app, "organizer5");
    const voter = await registerUser(app, "voter5");
    const slots = { slot_1: { startTime: "2026-08-10T10:00:00.000Z", endTime: "2026-08-10T11:00:00.000Z" } };
    const { slotIds, contentEnvelope, participants } = buildGroupEventPayload(organizer, [voter], slots);
    const createResp = await app.inject({
      method: "POST",
      url: "/group-events",
      headers: auth(organizer.token),
      payload: { slotIds, contentEnvelope, participants },
    });
    const groupEventId = createResp.json().groupEvent.id;

    const response = await app.inject({
      method: "POST",
      url: `/group-events/${groupEventId}/resolve`,
      headers: auth(voter.token),
    });
    expect(response.statusCode).toBe(404);
  });

  it("rejects a vote for a slot ID that isn't part of the event", async () => {
    const organizer = await registerUser(app, "organizer6");
    const voter = await registerUser(app, "voter6");
    const slots = { slot_1: { startTime: "2026-08-10T10:00:00.000Z", endTime: "2026-08-10T11:00:00.000Z" } };
    const { slotIds, contentEnvelope, participants } = buildGroupEventPayload(organizer, [voter], slots);
    const createResp = await app.inject({
      method: "POST",
      url: "/group-events",
      headers: auth(organizer.token),
      payload: { slotIds, contentEnvelope, participants },
    });
    const groupEventId = createResp.json().groupEvent.id;

    const response = await app.inject({
      method: "POST",
      url: `/group-events/${groupEventId}/votes`,
      headers: auth(voter.token),
      payload: { rankings: [{ slotId: "not-a-real-slot", rank: 1 }] },
    });
    expect(response.statusCode).toBe(400);
  });

  it("resubmitting rankings replaces the previous vote, not adds to it", async () => {
    const organizer = await registerUser(app, "organizer7");
    const voter = await registerUser(app, "voter7");
    const slots = {
      slot_1: { startTime: "2026-08-10T10:00:00.000Z", endTime: "2026-08-10T11:00:00.000Z" },
      slot_2: { startTime: "2026-08-11T10:00:00.000Z", endTime: "2026-08-11T11:00:00.000Z" },
    };
    const { slotIds, contentEnvelope, participants } = buildGroupEventPayload(organizer, [voter], slots);
    const createResp = await app.inject({
      method: "POST",
      url: "/group-events",
      headers: auth(organizer.token),
      payload: { slotIds, contentEnvelope, participants },
    });
    const groupEventId = createResp.json().groupEvent.id;

    await app.inject({
      method: "POST",
      url: `/group-events/${groupEventId}/votes`,
      headers: auth(voter.token),
      payload: { rankings: [{ slotId: "slot_1", rank: 1 }, { slotId: "slot_2", rank: 2 }] },
    });
    // Voter changes their mind: now only ranks slot_2.
    await app.inject({
      method: "POST",
      url: `/group-events/${groupEventId}/votes`,
      headers: auth(voter.token),
      payload: { rankings: [{ slotId: "slot_2", rank: 1 }] },
    });

    const resolveResp = await app.inject({
      method: "POST",
      url: `/group-events/${groupEventId}/resolve`,
      headers: auth(organizer.token),
    });
    // Only slot_2 has a (surviving) vote, so it must win.
    expect(resolveResp.json().groupEvent.resolvedSlotId).toBe("slot_2");
  });

  it("returns 409 when resolving before anyone has voted", async () => {
    const organizer = await registerUser(app, "organizer8");
    const slots = { slot_1: { startTime: "2026-08-10T10:00:00.000Z", endTime: "2026-08-10T11:00:00.000Z" } };
    const { slotIds, contentEnvelope, participants } = buildGroupEventPayload(organizer, [], slots);
    const createResp = await app.inject({
      method: "POST",
      url: "/group-events",
      headers: auth(organizer.token),
      payload: { slotIds, contentEnvelope, participants },
    });
    const groupEventId = createResp.json().groupEvent.id;

    const response = await app.inject({
      method: "POST",
      url: `/group-events/${groupEventId}/resolve`,
      headers: auth(organizer.token),
    });
    expect(response.statusCode).toBe(409);
  });

  it("includes the organizer's public key and the requester's own votes on the record", async () => {
    const organizer = await registerUser(app, "organizer9");
    const voter = await registerUser(app, "voter9");
    const slots = {
      slot_1: { startTime: "2026-08-10T10:00:00.000Z", endTime: "2026-08-10T11:00:00.000Z" },
      slot_2: { startTime: "2026-08-11T10:00:00.000Z", endTime: "2026-08-11T11:00:00.000Z" },
    };
    const { slotIds, contentEnvelope, participants } = buildGroupEventPayload(organizer, [voter], slots);
    const createResp = await app.inject({
      method: "POST",
      url: "/group-events",
      headers: auth(organizer.token),
      payload: { slotIds, contentEnvelope, participants },
    });
    const groupEventId = createResp.json().groupEvent.id;
    expect(createResp.json().groupEvent.organizerPublicKey).toBe(organizer.keyPair.publicKey);

    // Before voting, myVotes is empty for the voter.
    const beforeVote = await app.inject({
      method: "GET",
      url: `/group-events/${groupEventId}`,
      headers: auth(voter.token),
    });
    expect(beforeVote.json().groupEvent.myVotes).toEqual([]);
    expect(beforeVote.json().groupEvent.organizerPublicKey).toBe(organizer.keyPair.publicKey);

    await app.inject({
      method: "POST",
      url: `/group-events/${groupEventId}/votes`,
      headers: auth(voter.token),
      payload: { rankings: [{ slotId: "slot_1", rank: 2 }, { slotId: "slot_2", rank: 1 }] },
    });

    const afterVote = await app.inject({
      method: "GET",
      url: `/group-events/${groupEventId}`,
      headers: auth(voter.token),
    });
    const myVotes = afterVote.json().groupEvent.myVotes;
    expect(myVotes).toHaveLength(2);
    expect(myVotes).toEqual(
      expect.arrayContaining([
        { slotId: "slot_1", rank: 2 },
        { slotId: "slot_2", rank: 1 },
      ])
    );

    // The organizer's own myVotes stays separate/empty -- votes are per-voter.
    const organizerView = await app.inject({
      method: "GET",
      url: `/group-events/${groupEventId}`,
      headers: auth(organizer.token),
    });
    expect(organizerView.json().groupEvent.myVotes).toEqual([]);
  });
});
