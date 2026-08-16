import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  KeyringVersionConflictError,
  type KeyringRepository,
} from "../repositories/keyringRepository.js";

const PutKeyringSchema = z.object({
  envelope: z.unknown(),
  expectedVersion: z.number().int().min(0),
});

export function registerKeyringRoutes(app: FastifyInstance, keyrings: KeyringRepository) {
  app.register(async (scoped) => {
    scoped.addHook("preHandler", scoped.authenticate);

    scoped.get("/keyring", async (request, reply) => {
      const keyring = await keyrings.get(request.userId!);
      // A missing keyring is normal for a new account, not an error.
      if (!keyring) return reply.send({ keyring: null, version: 0 });
      return reply.send({ keyring: keyring.envelope, version: keyring.version });
    });

    scoped.put("/keyring", async (request, reply) => {
      const parsed = PutKeyringSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Invalid request", details: parsed.error.issues });
      }
      try {
        const saved = await keyrings.put(
          request.userId!,
          parsed.data.envelope,
          parsed.data.expectedVersion
        );
        return reply.send({ version: saved.version });
      } catch (err) {
        if (err instanceof KeyringVersionConflictError) {
          // 409 rather than a silent overwrite: losing a keyring write means
          // permanently losing access to whatever events it was adding.
          return reply.code(409).send({
            error: "Your keyring changed on another device. Reload and try again.",
          });
        }
        throw err;
      }
    });
  });
}
