import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { sha256Base64 } from "@schedule-app/crypto";
import { UsernameTakenError, type UserRepository } from "../repositories/userRepository.js";
import { RegisterRequestSchema, LoginRequestSchema } from "../schemas.js";

// Session tokens previously never expired, meaning a stolen token stayed
// valid forever. 30 days balances that against not forcing constant
// re-logins on a personal calendar; agent clients should use API keys
// (which are individually revocable) rather than long-lived JWTs.
const TOKEN_TTL = "30d";

function publicUser(user: { id: string; username: string; displayName: string; publicKey: string; createdAt: string }) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    publicKey: user.publicKey,
    createdAt: user.createdAt,
  };
}

export function registerAuthRoutes(
  app: FastifyInstance,
  users: UserRepository,
  authRateLimitMax: number
) {
  // Login and registration get a much tighter rate limit than the rest of
  // the API: an unthrottled login endpoint is directly brute-forceable,
  // and registration is the obvious spam/enumeration target.
  const authRateLimit = {
    config: {
      rateLimit: { max: authRateLimitMax, timeWindow: "1 minute" },
    },
  };

  app.post("/users", authRateLimit, async (request, reply) => {
    const parsed = RegisterRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid request", details: parsed.error.issues });
    }
    const { username, displayName, publicKey, authKey, authSalt } = parsed.data;

    // The server hashes the received authKey itself; it never trusts or
    // stores a value the client claims is already hashed. This ensures a
    // leaked stored hash isn't, by itself, a replayable credential.
    const authHash = sha256Base64(authKey);

    try {
      const user = await users.create({ username, displayName, publicKey, authSalt, authHash });
      const token = app.jwt.sign({ userId: user.id }, { expiresIn: TOKEN_TTL });
      return reply.code(201).send({ user: publicUser(user), token });
    } catch (err) {
      if (err instanceof UsernameTakenError) {
        return reply.code(409).send({ error: "Username already taken" });
      }
      throw err;
    }
  });

  app.post("/sessions", authRateLimit, async (request, reply) => {
    const parsed = LoginRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid request", details: parsed.error.issues });
    }
    const { username, authKey } = parsed.data;

    const user = await users.findByUsername(username);
    if (!user || sha256Base64(authKey) !== user.authHash) {
      // Same error for "no such user" and "wrong key" so login can't be
      // used to enumerate valid usernames.
      return reply.code(401).send({ error: "Invalid username or password" });
    }

    const token = app.jwt.sign({ userId: user.id }, { expiresIn: TOKEN_TTL });
    return reply.send({ user: publicUser(user), token });
  });

  // Directory lookup: find a contact's public key to invite them to a
  // group event. Requires auth (must be a registered user of this
  // instance) to reduce casual enumeration/scraping, even though the
  // data itself is meant to be shared -- a modest, cheap mitigation.
  app.get<{ Params: { username: string } }>(
    "/users/:username",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const user = await users.findByUsername(request.params.username);
      if (!user) return reply.code(404).send({ error: "Not found" });
      return reply.send({ user: publicUser(user) });
    }
  );

  // Lets a client repair its own stored public key when it detects that
  // the server's copy doesn't match what its password actually derives.
  // Scoped to the authenticated user only -- you can never rewrite someone
  // else's key, which would let you hijack events wrapped to them.
  app.put(
    "/users/me/public-key",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const parsed = z.object({ publicKey: z.string().min(1).max(200) }).safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Invalid request", details: parsed.error.issues });
      }
      const updated = await users.updatePublicKey(request.userId!, parsed.data.publicKey);
      if (!updated) return reply.code(404).send({ error: "Not found" });
      return reply.code(204).send();
    }
  );

  // Returns the auth salt for a username, so a client can re-derive its
  // keys before attempting login. Deliberately public (no auth required)
  // since a user needs it before they have a token — but note this does
  // confirm whether a username exists, a small, accepted trade-off.
  app.get<{ Params: { username: string } }>(
    "/users/:username/salt",
    async (request, reply) => {
      const user = await users.findByUsername(request.params.username);
      if (!user) return reply.code(404).send({ error: "Not found" });
      return reply.send({ authSalt: user.authSalt });
    }
  );
}
