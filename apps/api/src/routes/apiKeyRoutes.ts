import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ApiKeyRepository } from "../repositories/apiKeyRepository.js";
import { generateApiKey, hashApiKey } from "../lib/apiKey.js";
import { isValidUuid } from "../lib/params.js";

const CreateApiKeyRequestSchema = z.object({ name: z.string().min(1).max(200) });

export function registerApiKeyRoutes(app: FastifyInstance, apiKeys: ApiKeyRepository) {
  app.register(async (scoped) => {
    scoped.addHook("preHandler", scoped.authenticate);

    scoped.post("/api-keys", async (request, reply) => {
      const parsed = CreateApiKeyRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Invalid request", details: parsed.error.issues });
      }
      const { rawKey, keyPrefix } = generateApiKey();
      const record = await apiKeys.create(request.userId!, parsed.data.name, keyPrefix, hashApiKey(rawKey));
      // rawKey is returned exactly once here -- it is never recoverable
      // again, since only its hash is stored.
      return reply.code(201).send({ apiKey: record, rawKey });
    });

    scoped.get("/api-keys", async (request, reply) => {
      const list = await apiKeys.listForUser(request.userId!);
      return reply.send({ apiKeys: list });
    });

    scoped.delete<{ Params: { id: string } }>("/api-keys/:id", async (request, reply) => {
      if (!isValidUuid(request.params.id)) return reply.code(404).send({ error: "Not found" });
      const revoked = await apiKeys.revokeForUser(request.params.id, request.userId!);
      if (!revoked) return reply.code(404).send({ error: "Not found" });
      return reply.code(204).send();
    });
  });
}
