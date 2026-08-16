import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { EncryptedEnvelopeSchema } from "@schedule-app/shared";
import type { EventRepository } from "../repositories/eventRepository.js";
import { isValidUuid } from "../lib/params.js";

const CreateEventSchema = z.object({
  envelope: EncryptedEnvelopeSchema,
  slotIds: z.array(z.string().min(1)).max(50).optional(),
});
const UpdateEventSchema = z.object({ envelope: EncryptedEnvelopeSchema });
const BatchReadSchema = z.object({
  events: z.array(z.object({ eventId: z.string().uuid(), token: z.string().min(1) })).max(500),
});
const MintSchema = z.object({
  level: z.enum(["view", "edit"]),
  expiresAt: z.string().datetime().nullable().optional(),
});

/**
 * Every route here authorises by capability token, never by identity.
 * Requests still require a logged-in account (to rate-limit and to stop
 * the API being an open relay), but *which* account is irrelevant to
 * whether access is granted -- that is what keeps the server ignorant of
 * who can reach which event.
 *
 * A missing or wrong capability always yields 404, never 403: distinguishing
 * "exists but you may not" from "does not exist" would confirm an event's
 * existence to anyone probing ids.
 */
export function registerEventRoutes(app: FastifyInstance, events: EventRepository) {
  app.register(async (scoped) => {
    scoped.addHook("preHandler", scoped.authenticate);

    function capabilityFrom(request: { headers: Record<string, unknown> }): string | null {
      const header = request.headers["x-event-capability"];
      return typeof header === "string" && header.length > 0 ? header : null;
    }

    scoped.post("/events", async (request, reply) => {
      const parsed = CreateEventSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Invalid request", details: parsed.error.issues });
      }
      const created = await events.create(parsed.data.envelope, parsed.data.slotIds ?? []);
      // The tokens are returned exactly once. The client stores them in its
      // keyring; the server keeps only hashes and cannot re-issue them.
      return reply.code(201).send(created);
    });

    // Batch read, because the server cannot answer "list my events" -- the
    // client presents the capabilities it holds.
    scoped.post("/events/batch-read", async (request, reply) => {
      const parsed = BatchReadSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Invalid request", details: parsed.error.issues });
      }
      const found = await events.findManyByCapabilities(parsed.data.events);
      return reply.send({ events: found });
    });

    scoped.get<{ Params: { id: string } }>("/events/:id", async (request, reply) => {
      const token = capabilityFrom(request);
      if (!isValidUuid(request.params.id) || !token) {
        return reply.code(404).send({ error: "Not found" });
      }
      const event = await events.findByCapability(request.params.id, token);
      if (!event) return reply.code(404).send({ error: "Not found" });
      return reply.send({ event });
    });

    scoped.put<{ Params: { id: string } }>("/events/:id", async (request, reply) => {
      const token = capabilityFrom(request);
      if (!isValidUuid(request.params.id) || !token) {
        return reply.code(404).send({ error: "Not found" });
      }
      const parsed = UpdateEventSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Invalid request", details: parsed.error.issues });
      }
      const updated = await events.update(request.params.id, token, parsed.data.envelope);
      if (!updated) return reply.code(404).send({ error: "Not found" });
      return reply.send({ event: updated });
    });

    scoped.delete<{ Params: { id: string } }>("/events/:id", async (request, reply) => {
      const token = capabilityFrom(request);
      if (!isValidUuid(request.params.id) || !token) {
        return reply.code(404).send({ error: "Not found" });
      }
      const removed = await events.remove(request.params.id, token);
      if (!removed) return reply.code(404).send({ error: "Not found" });
      return reply.code(204).send();
    });

    // Mint an additional capability -- this is how a reusable join code is
    // created. Requires an edit capability.
    scoped.post<{ Params: { id: string } }>("/events/:id/capabilities", async (request, reply) => {
      const token = capabilityFrom(request);
      if (!isValidUuid(request.params.id) || !token) {
        return reply.code(404).send({ error: "Not found" });
      }
      const parsed = MintSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Invalid request", details: parsed.error.issues });
      }
      const minted = await events.mintCapability(
        request.params.id,
        token,
        parsed.data.level,
        parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : null
      );
      if (!minted) return reply.code(404).send({ error: "Not found" });
      return reply.code(201).send({ token: minted });
    });

    scoped.post<{ Params: { id: string } }>(
      "/events/:id/capabilities/revoke",
      async (request, reply) => {
        const token = capabilityFrom(request);
        if (!isValidUuid(request.params.id) || !token) {
          return reply.code(404).send({ error: "Not found" });
        }
        const parsed = z.object({ token: z.string().min(1) }).safeParse(request.body);
        if (!parsed.success) {
          return reply.code(400).send({ error: "Invalid request", details: parsed.error.issues });
        }
        const revoked = await events.revokeCapability(
          request.params.id,
          token,
          parsed.data.token
        );
        if (!revoked) return reply.code(404).send({ error: "Not found" });
        return reply.code(204).send();
      }
    );
  });
}
