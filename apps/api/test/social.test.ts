import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
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

async function registerUser(app: FastifyInstance, username: string) {
  const keys = await deriveAuthAndEncryptionKeys("some strong password");
  const keyPair = generateKeyPair();
  const response = await app.inject({
    method: "POST",
    url: "/users",
    payload: {
      username,
      displayName: `Display ${username}`,
      publicKey: keyPair.publicKey,
      authKey: keys.authKey,
      authSalt: keys.salt,
    },
  });
  const body = response.json();
  return { userId: body.user.id as string, token: body.token as string, keyPair, username };
}

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

async function getCode(app: FastifyInstance, token: string): Promise<string> {
  const response = await app.inject({ method: "GET", url: "/friend-code", headers: auth(token) });
  return response.json().friendCode.code as string;
}

async function resolveTag(app: FastifyInstance, token: string, tag: string) {
  return app.inject({ method: "POST", url: "/tags/resolve", headers: auth(token), payload: { tag } });
}

describe("social layer", () => {
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

  describe("friend codes", () => {
    it("issues a stable active code and returns the same one until it's used", async () => {
      const alice = await registerUser(app, "alice");
      const first = await getCode(app, alice.token);
      const second = await getCode(app, alice.token);
      expect(first).toBe(second);
      expect(first).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/);
    }, 20_000);

    it("rotates to a different code on request", async () => {
      const alice = await registerUser(app, "alice");
      const before = await getCode(app, alice.token);
      const rotated = await app.inject({
        method: "POST",
        url: "/friend-code/rotate",
        headers: auth(alice.token),
      });
      expect(rotated.statusCode).toBe(200);
      expect(rotated.json().friendCode.code).not.toBe(before);
    }, 20_000);

    it("consumes the code on use and issues the owner a fresh one", async () => {
      const alice = await registerUser(app, "alice");
      const bob = await registerUser(app, "bob");
      const code = await getCode(app, alice.token);

      const used = await resolveTag(app, bob.token, code);
      expect(used.statusCode).toBe(200);
      expect(used.json().target.userId).toBe(alice.userId);

      // Alice's active code must have rotated -- a code is single-use.
      expect(await getCode(app, alice.token)).not.toBe(code);
    }, 20_000);

    it("refuses to redeem the same code twice", async () => {
      const alice = await registerUser(app, "alice");
      const bob = await registerUser(app, "bob");
      const carol = await registerUser(app, "carol");
      const code = await getCode(app, alice.token);

      expect((await resolveTag(app, bob.token, code)).statusCode).toBe(200);
      expect((await resolveTag(app, carol.token, code)).statusCode).toBe(404);
    }, 20_000);

    it("does not reveal the owner's username or real display name when resolved by code", async () => {
      const alice = await registerUser(app, "alice");
      const bob = await registerUser(app, "bob");
      const code = await getCode(app, alice.token);

      const resolved = await resolveTag(app, bob.token, code);
      const target = resolved.json().target;
      // The whole point of an anonymous code: using it tells you nothing
      // about who you reached beyond a key to encrypt to.
      expect(target.username).toBeUndefined();
      expect(target.displayName).not.toContain("alice");
      expect(target.viaCode).toBe(true);
      expect(target.publicKey).toBeTruthy();
      expect(JSON.stringify(resolved.json())).not.toContain("Display alice");
    }, 20_000);

    it("refuses a code redeemed by its own owner", async () => {
      const alice = await registerUser(app, "alice");
      const code = await getCode(app, alice.token);
      expect((await resolveTag(app, alice.token, code)).statusCode).toBe(404);
    }, 20_000);
  });

  describe("tag resolution by username", () => {
    it("resolves a username and does expose identity (unlike a code)", async () => {
      const alice = await registerUser(app, "alice");
      const bob = await registerUser(app, "bob");
      const resolved = await resolveTag(app, bob.token, "alice");
      expect(resolved.statusCode).toBe(200);
      const target = resolved.json().target;
      expect(target.userId).toBe(alice.userId);
      expect(target.username).toBe("alice");
      expect(target.viaCode).toBe(false);
    }, 20_000);

    it("returns a clear 404 for an unknown username", async () => {
      const bob = await registerUser(app, "bob");
      expect((await resolveTag(app, bob.token, "nobody-here")).statusCode).toBe(404);
    }, 20_000);
  });

  describe("blocking", () => {
    it("makes a blocker unreachable by username, indistinguishably from not existing", async () => {
      const alice = await registerUser(app, "alice");
      const bob = await registerUser(app, "bob");

      await app.inject({
        method: "PUT",
        url: "/relationships",
        headers: auth(alice.token),
        payload: { otherUserId: bob.userId, state: "blocked" },
      });

      const blocked = await resolveTag(app, bob.token, "alice");
      const nonexistent = await resolveTag(app, bob.token, "ghostuser");
      expect(blocked.statusCode).toBe(404);
      // Identical responses: a different message would tell Bob he's been
      // blocked, which is exactly what blocking should not announce.
      expect(blocked.json()).toEqual(nonexistent.json());
    }, 20_000);

    it("makes a blocker unreachable by friend code too", async () => {
      const alice = await registerUser(app, "alice");
      const bob = await registerUser(app, "bob");
      const code = await getCode(app, alice.token);

      await app.inject({
        method: "PUT",
        url: "/relationships",
        headers: auth(alice.token),
        payload: { otherUserId: bob.userId, state: "blocked" },
      });

      expect((await resolveTag(app, bob.token, code)).statusCode).toBe(404);
    }, 20_000);

    it("lists and removes relationships, and refuses self-relationships", async () => {
      const alice = await registerUser(app, "alice");
      const bob = await registerUser(app, "bob");

      await app.inject({
        method: "PUT",
        url: "/relationships",
        headers: auth(alice.token),
        payload: { otherUserId: bob.userId, state: "connected" },
      });

      const listed = await app.inject({
        method: "GET",
        url: "/relationships",
        headers: auth(alice.token),
      });
      expect(listed.json().relationships).toHaveLength(1);
      expect(listed.json().relationships[0].state).toBe("connected");

      const self = await app.inject({
        method: "PUT",
        url: "/relationships",
        headers: auth(alice.token),
        payload: { otherUserId: alice.userId, state: "connected" },
      });
      expect(self.statusCode).toBe(400);

      const removed = await app.inject({
        method: "DELETE",
        url: `/relationships/${bob.userId}`,
        headers: auth(alice.token),
      });
      expect(removed.statusCode).toBe(204);
    }, 20_000);

    it("switching from blocked to connected replaces rather than duplicating", async () => {
      const alice = await registerUser(app, "alice");
      const bob = await registerUser(app, "bob");
      for (const state of ["blocked", "connected"]) {
        await app.inject({
          method: "PUT",
          url: "/relationships",
          headers: auth(alice.token),
          payload: { otherUserId: bob.userId, state },
        });
      }
      const listed = await app.inject({
        method: "GET",
        url: "/relationships",
        headers: auth(alice.token),
      });
      expect(listed.json().relationships).toHaveLength(1);
      expect(listed.json().relationships[0].state).toBe("connected");
    }, 20_000);
  });

  describe("invitations", () => {
    function buildGroupEvent(
      organizer: { userId: string; keyPair: { secretKey: string; publicKey: string } },
      invitees: { userId: string; keyPair: { publicKey: string }; viaCode?: boolean }[]
    ) {
      const slots = {
        slot_1: { startTime: "2026-08-10T10:00:00.000Z", endTime: "2026-08-10T11:00:00.000Z" },
      };
      const eventKey = generateSymmetricKey();
      const contentEnvelope = encryptEnvelope({ title: "Offsite", slots }, eventKey, "group-event-key");
      const participants = [
        {
          userId: organizer.userId,
          wrappedKey: wrapKey(
            eventKey,
            deriveSharedWrapKey(organizer.keyPair.secretKey, organizer.keyPair.publicKey)
          ),
        },
        ...invitees.map((i) => ({
          userId: i.userId,
          wrappedKey: wrapKey(
            eventKey,
            deriveSharedWrapKey(organizer.keyPair.secretKey, i.keyPair.publicKey)
          ),
          invitedViaCode: i.viaCode ?? false,
        })),
      ];
      return { slotIds: Object.keys(slots), contentEnvelope, participants };
    }

    it("starts invitees as pending and the organizer as already accepted", async () => {
      const organizer = await registerUser(app, "organizer");
      const invitee = await registerUser(app, "invitee");
      const payload = buildGroupEvent(organizer, [invitee]);

      const created = await app.inject({
        method: "POST",
        url: "/group-events",
        headers: auth(organizer.token),
        payload,
      });
      expect(created.statusCode).toBe(201);
      // The organizer never has to accept their own invitation.
      expect(created.json().groupEvent.myInviteStatus).toBe("accepted");

      const inviteeView = await app.inject({
        method: "GET",
        url: "/group-events",
        headers: auth(invitee.token),
      });
      expect(inviteeView.json().groupEvents[0].myInviteStatus).toBe("pending");
    }, 20_000);

    it("lets an invitee accept or reject", async () => {
      const organizer = await registerUser(app, "organizer");
      const invitee = await registerUser(app, "invitee");
      const created = await app.inject({
        method: "POST",
        url: "/group-events",
        headers: auth(organizer.token),
        payload: buildGroupEvent(organizer, [invitee]),
      });
      const id = created.json().groupEvent.id;

      const accepted = await app.inject({
        method: "POST",
        url: `/group-events/${id}/respond`,
        headers: auth(invitee.token),
        payload: { status: "accepted" },
      });
      expect(accepted.statusCode).toBe(204);

      const after = await app.inject({
        method: "GET",
        url: `/group-events/${id}`,
        headers: auth(invitee.token),
      });
      expect(after.json().groupEvent.myInviteStatus).toBe("accepted");

      const rejected = await app.inject({
        method: "POST",
        url: `/group-events/${id}/respond`,
        headers: auth(invitee.token),
        payload: { status: "rejected" },
      });
      expect(rejected.statusCode).toBe(204);
    }, 20_000);

    it("rejects a bogus response status and a non-participant responding", async () => {
      const organizer = await registerUser(app, "organizer");
      const invitee = await registerUser(app, "invitee");
      const outsider = await registerUser(app, "outsider");
      const created = await app.inject({
        method: "POST",
        url: "/group-events",
        headers: auth(organizer.token),
        payload: buildGroupEvent(organizer, [invitee]),
      });
      const id = created.json().groupEvent.id;

      const bogus = await app.inject({
        method: "POST",
        url: `/group-events/${id}/respond`,
        headers: auth(invitee.token),
        payload: { status: "maybe" },
      });
      expect(bogus.statusCode).toBe(400);

      const stranger = await app.inject({
        method: "POST",
        url: `/group-events/${id}/respond`,
        headers: auth(outsider.token),
        payload: { status: "accepted" },
      });
      expect(stranger.statusCode).toBe(404);
    }, 20_000);

    it("records invitedViaCode so the UI can bar connecting to an anonymous inviter", async () => {
      const organizer = await registerUser(app, "organizer");
      const invitee = await registerUser(app, "invitee");
      const created = await app.inject({
        method: "POST",
        url: "/group-events",
        headers: auth(organizer.token),
        payload: buildGroupEvent(organizer, [{ ...invitee, viaCode: true }]),
      });
      expect(created.statusCode).toBe(201);

      const inviteeView = await app.inject({
        method: "GET",
        url: "/group-events",
        headers: auth(invitee.token),
      });
      expect(inviteeView.json().groupEvents[0].invitedViaCode).toBe(true);
    }, 20_000);
  });
});
