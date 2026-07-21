import type { FastifyInstance } from "fastify";
import type { EventRepository } from "../repositories/eventRepository.js";
import { CreateEventRequestSchema, UpdateEventRequestSchema } from "../schemas.js";

export function registerEventRoutes(app: FastifyInstance, events: EventRepository) {
  app.register(async (scoped) => {
    scoped.addHook("preHandler", scoped.authenticate);

    scoped.post("/events", async (request, reply) => {
      const parsed = CreateEventRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Invalid request", details: parsed.error.issues });
      }
      const event = await events.create(request.userId!, parsed.data.envelope);
      return reply.code(201).send({ event });
    });

    scoped.get("/events", async (request, reply) => {
      const list = await events.listByOwner(request.userId!);
      return reply.send({ events: list });
    });

    scoped.get<{ Params: { id: string } }>("/events/:id", async (request, reply) => {
      const event = await events.findByIdForOwner(request.params.id, request.userId!);
      if (!event) return reply.code(404).send({ error: "Not found" });
      return reply.send({ event });
    });

    scoped.put<{ Params: { id: string } }>("/events/:id", async (request, reply) => {
      const parsed = UpdateEventRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Invalid request", details: parsed.error.issues });
      }
      const event = await events.updateForOwner(
        request.params.id,
        request.userId!,
        parsed.data.envelope
      );
      if (!event) return reply.code(404).send({ error: "Not found" });
      return reply.send({ event });
    });

    scoped.delete<{ Params: { id: string } }>("/events/:id", async (request, reply) => {
      const deleted = await events.deleteForOwner(request.params.id, request.userId!);
      if (!deleted) return reply.code(404).send({ error: "Not found" });
      return reply.code(204).send();
    });
  });
}
