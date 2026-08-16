import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { FriendCodeRepository } from "../repositories/friendCodeRepository.js";
import type { UserRepository } from "../repositories/userRepository.js";

const ResolveTagRequestSchema = z.object({
  tag: z.string().min(1).max(64),
});

/** A tag is either a username or a one-time friend code. Codes come from a
 * fixed uppercase alphabet, usernames are lowercase -- so they can't be
 * confused, and we can tell which was meant without asking the person to
 * say which kind of thing they're typing. */
const FRIEND_CODE_PATTERN = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/;

/**
 * Blocking is deliberately absent here. Under the capability model the
 * server does not know who contacts whom, so it cannot filter on anyone's
 * behalf. Sender identity travels inside the encrypted invite envelope and
 * the recipient's client filters it -- which means the server never learns
 * a block list either. See docs/ARCHITECTURE.md.
 */
export function registerSocialRoutes(
  app: FastifyInstance,
  users: UserRepository,
  friendCodes: FriendCodeRepository
) {
  app.register(async (scoped) => {
    scoped.addHook("preHandler", scoped.authenticate);

    scoped.get("/friend-code", async (request, reply) => {
      const code = await friendCodes.getOrCreateActive(request.userId!);
      return reply.send({ friendCode: code });
    });

    scoped.post("/friend-code/rotate", async (request, reply) => {
      const code = await friendCodes.rotate(request.userId!);
      return reply.send({ friendCode: code });
    });

    /**
     * Resolves a tag (username or one-time code) to something invitable.
     *
     * Redeeming a code CONSUMES it, so this is deliberately a POST rather
     * than a GET -- it mutates state and must not be retried blindly.
     *
     * The response for a code deliberately withholds the owner's username
     * and real display name: the entire point of an anonymous code is that
     * using it doesn't tell you who you reached. `viaCode` is carried
     * forward so the invite can be marked accordingly.
     */
    scoped.post("/tags/resolve", async (request, reply) => {
      const parsed = ResolveTagRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Invalid request", details: parsed.error.issues });
      }
      const tag = parsed.data.tag.trim();

      if (FRIEND_CODE_PATTERN.test(tag)) {
        const redeemed = await friendCodes.redeem(tag, request.userId!);
        if (!redeemed) {
          // Unknown, already-spent, and own-code all return the same thing:
          // distinguishing them would turn this into an oracle for probing
          // which codes exist.
          return reply.code(404).send({ error: "That code isn't valid or has already been used." });
        }
        const owner = await users.findById(redeemed.ownerId);
        if (!owner) {
          return reply.code(404).send({ error: "That code isn't valid or has already been used." });
        }
        return reply.send({
          target: {
            userId: owner.id,
            publicKey: owner.publicKey,
            displayName: "Anonymous invitee",
            viaCode: true,
          },
        });
      }

      const user = await users.findByUsername(tag.toLowerCase());
      if (!user) return reply.code(404).send({ error: "No user with that username." });
      return reply.send({
        target: {
          userId: user.id,
          publicKey: user.publicKey,
          displayName: user.displayName,
          username: user.username,
          viaCode: false,
        },
      });
    });

  });
}
