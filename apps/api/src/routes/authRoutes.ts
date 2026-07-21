import type { FastifyInstance } from "fastify";
import { sha256Base64 } from "@schedule-app/crypto";
import { UsernameTakenError, type UserRepository } from "../repositories/userRepository.js";
import { RegisterRequestSchema, LoginRequestSchema } from "../schemas.js";

function publicUser(user: { id: string; username: string; displayName: string; publicKey: string; createdAt: string }) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    publicKey: user.publicKey,
    createdAt: user.createdAt,
  };
}

export function registerAuthRoutes(app: FastifyInstance, users: UserRepository) {
  app.post("/users", async (request, reply) => {
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
      const token = app.jwt.sign({ userId: user.id });
      return reply.code(201).send({ user: publicUser(user), token });
    } catch (err) {
      if (err instanceof UsernameTakenError) {
        return reply.code(409).send({ error: "Username already taken" });
      }
      throw err;
    }
  });

  app.post("/sessions", async (request, reply) => {
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

    const token = app.jwt.sign({ userId: user.id });
    return reply.send({ user: publicUser(user), token });
  });

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
