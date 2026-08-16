import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { InboxRepository } from "../repositories/inboxRepository.js";
import type { UserRepository } from "../repositories/userRepository.js";
import type { NotificationService } from "../services/notificationService.js";
import { isValidUuid } from "../lib/params.js";

const DeliverSchema = z.object({
  recipientId: z.string().uuid(),
  envelope: z.unknown(),
});

/**
 * Capability delivery. Requests are authenticated so the endpoint is not an
 * open relay, but the sender's identity is deliberately NOT recorded
 * against the message -- doing so would rebuild the social graph the
 * capability model exists to avoid. If a sender wants to be known, they say
 * so inside the encrypted envelope.
 */
export function registerInboxRoutes(
  app: FastifyInstance,
  inbox: InboxRepository,
  users: UserRepository,
  notifications: NotificationService
) {
  app.register(async (scoped) => {
    scoped.addHook("preHandler", scoped.authenticate);

    scoped.post("/inbox/deliver", async (request, reply) => {
      const parsed = DeliverSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Invalid request", details: parsed.error.issues });
      }
      const recipient = await users.findById(parsed.data.recipientId);
      if (!recipient) return reply.code(404).send({ error: "Not found" });
      await inbox.deliver(parsed.data.recipientId, parsed.data.envelope);
      // Delivery is the only point where the server legitimately knows a
      // specific recipient, so it is the only place a push can originate.
      // The payload stays generic -- the server cannot read the envelope
      // and so cannot say what the invitation is for even if it wanted to.
      await notifications.notifyUser(parsed.data.recipientId, {
        title: "New invitation",
        body: "Someone shared an event with you.",
      });
      return reply.code(204).send();
    });

    scoped.get("/inbox", async (request, reply) => {
      return reply.send({ messages: await inbox.list(request.userId!) });
    });

    scoped.delete<{ Params: { id: string } }>("/inbox/:id", async (request, reply) => {
      if (!isValidUuid(request.params.id)) return reply.code(404).send({ error: "Not found" });
      const removed = await inbox.remove(request.userId!, request.params.id);
      if (!removed) return reply.code(404).send({ error: "Not found" });
      return reply.code(204).send();
    });
  });
}
