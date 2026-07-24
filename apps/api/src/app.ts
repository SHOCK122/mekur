import Fastify, { type FastifyInstance } from "fastify";
import type { Database } from "./db/pool.js";
import { authPlugin } from "./plugins/auth.js";
import { createUserRepository } from "./repositories/userRepository.js";
import { createEventRepository } from "./repositories/eventRepository.js";
import { createGroupEventRepository } from "./repositories/groupEventRepository.js";
import { createVoteRepository } from "./repositories/voteRepository.js";
import { registerAuthRoutes } from "./routes/authRoutes.js";
import { registerEventRoutes } from "./routes/eventRoutes.js";
import { registerGroupEventRoutes } from "./routes/groupEventRoutes.js";
import { openApiSpec } from "./openapi.js";

export interface BuildAppOptions {
  db: Database;
  jwtSecret: string;
}

export function buildApp(opts: BuildAppOptions): FastifyInstance {
  const app = Fastify({ logger: false });

  app.register(authPlugin, { secret: opts.jwtSecret });

  const users = createUserRepository(opts.db);
  const events = createEventRepository(opts.db);
  const groupEvents = createGroupEventRepository(opts.db);
  const votes = createVoteRepository(opts.db);

  app.get("/health", async () => ({ status: "ok" }));
  app.get("/openapi.json", async () => openApiSpec);

  app.register(async (instance) => {
    registerAuthRoutes(instance, users);
    registerEventRoutes(instance, events);
    registerGroupEventRoutes(instance, groupEvents, votes);
  });

  return app;
}
