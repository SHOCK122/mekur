import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { PushSubscriptionRepository } from "../repositories/pushSubscriptionRepository.js";

const SubscribeRequestSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
});

const UnsubscribeRequestSchema = z.object({
  endpoint: z.string().url(),
});

export function registerPushRoutes(
  app: FastifyInstance,
  pushSubscriptions: PushSubscriptionRepository,
  vapidPublicKey: string
) {
  // Public: the client needs this to call PushManager.subscribe() before
  // it has anywhere else to get it from.
  app.get("/push/vapid-public-key", async () => ({ publicKey: vapidPublicKey }));

  app.register(async (scoped) => {
    scoped.addHook("preHandler", scoped.authenticate);

    scoped.post("/push-subscriptions", async (request, reply) => {
      const parsed = SubscribeRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Invalid request", details: parsed.error.issues });
      }
      const { endpoint, keys } = parsed.data;
      await pushSubscriptions.upsert(request.userId!, endpoint, keys.p256dh, keys.auth);
      return reply.code(204).send();
    });

    scoped.delete("/push-subscriptions", async (request, reply) => {
      const parsed = UnsubscribeRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Invalid request", details: parsed.error.issues });
      }
      const deleted = await pushSubscriptions.deleteForUser(parsed.data.endpoint, request.userId!);
      if (!deleted) return reply.code(404).send({ error: "Not found" });
      return reply.code(204).send();
    });
  });
}
