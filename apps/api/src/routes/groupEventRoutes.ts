import type { FastifyInstance } from "fastify";
import type { GroupEventRepository } from "../repositories/groupEventRepository.js";
import type { VoteRepository } from "../repositories/voteRepository.js";
import { minimizeSumOfRanks } from "../services/slotSelection.js";
import { CreateGroupEventRequestSchema } from "../schemas.js";
import { SubmitVotesRequestSchema } from "@schedule-app/shared";

export function registerGroupEventRoutes(
  app: FastifyInstance,
  groupEvents: GroupEventRepository,
  votes: VoteRepository
) {
  app.register(async (scoped) => {
    scoped.addHook("preHandler", scoped.authenticate);

    scoped.post("/group-events", async (request, reply) => {
      const parsed = CreateGroupEventRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Invalid request", details: parsed.error.issues });
      }
      const { slotIds, contentEnvelope, participants } = parsed.data;

      // The organizer must include themself as a participant (self-wrapped
      // key) -- see design note in packages/shared. Enforced here rather
      // than silently auto-adding, so the client's crypto step is never
      // skipped/assumed.
      if (!participants.some((p) => p.userId === request.userId)) {
        return reply
          .code(400)
          .send({ error: "participants must include the organizer's own self-wrapped key" });
      }

      const groupEvent = await groupEvents.create(
        request.userId!,
        slotIds,
        contentEnvelope,
        participants
      );
      return reply.code(201).send({ groupEvent });
    });

    scoped.get("/group-events", async (request, reply) => {
      const list = await groupEvents.listForUser(request.userId!);
      return reply.send({ groupEvents: list });
    });

    scoped.get<{ Params: { id: string } }>("/group-events/:id", async (request, reply) => {
      const groupEvent = await groupEvents.findByIdForUser(request.params.id, request.userId!);
      if (!groupEvent) return reply.code(404).send({ error: "Not found" });
      return reply.send({ groupEvent });
    });

    scoped.post<{ Params: { id: string } }>(
      "/group-events/:id/votes",
      async (request, reply) => {
        const parsed = SubmitVotesRequestSchema.safeParse(request.body);
        if (!parsed.success) {
          return reply.code(400).send({ error: "Invalid request", details: parsed.error.issues });
        }
        const groupEventId = request.params.id;
        const isParticipant = await groupEvents.isParticipant(groupEventId, request.userId!);
        if (!isParticipant) return reply.code(404).send({ error: "Not found" });

        const validSlotIds = await groupEvents.getSlotIds(groupEventId);
        if (!validSlotIds) return reply.code(404).send({ error: "Not found" });
        const unknownSlot = parsed.data.rankings.find((r) => !validSlotIds.includes(r.slotId));
        if (unknownSlot) {
          return reply.code(400).send({ error: `Unknown slotId: ${unknownSlot.slotId}` });
        }

        await votes.setVotesForVoter(groupEventId, request.userId!, parsed.data.rankings);
        return reply.code(204).send();
      }
    );

    scoped.post<{ Params: { id: string } }>(
      "/group-events/:id/resolve",
      async (request, reply) => {
        const groupEventId = request.params.id;
        const isOrganizer = await groupEvents.isOrganizer(groupEventId, request.userId!);
        if (!isOrganizer) return reply.code(404).send({ error: "Not found" });

        const slotIds = await groupEvents.getSlotIds(groupEventId);
        if (!slotIds) return reply.code(404).send({ error: "Not found" });

        const allVotes = await votes.listVotes(groupEventId);
        const winner = minimizeSumOfRanks(allVotes, slotIds);
        if (!winner) {
          return reply.code(409).send({ error: "No votes have been submitted yet" });
        }

        await groupEvents.resolve(groupEventId, winner);
        const resolved = await groupEvents.findByIdForUser(groupEventId, request.userId!);
        return reply.send({ groupEvent: resolved });
      }
    );
  });
}
