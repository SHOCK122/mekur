import fp from "fastify-plugin";
import jwt from "@fastify/jwt";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ApiKeyRepository } from "../repositories/apiKeyRepository.js";
import { hashApiKey, looksLikeApiKey } from "../lib/apiKey.js";

declare module "fastify" {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
  interface FastifyRequest {
    userId?: string;
  }
}

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: { userId: string };
  }
}

export interface AuthPluginOptions {
  secret: string;
  apiKeys: ApiKeyRepository;
}

export const authPlugin = fp(async function authPlugin(app: FastifyInstance, opts: AuthPluginOptions) {
  app.register(jwt, { secret: opts.secret });

  app.decorate("authenticate", async (request: FastifyRequest, reply: FastifyReply) => {
    const header = request.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;

    // Agentic/programmatic clients authenticate with a long-lived API key
    // instead of a human login-derived JWT. Same Authorization header,
    // distinguished by a fixed prefix.
    if (token && looksLikeApiKey(token)) {
      const userId = await opts.apiKeys.findUserIdByHash(hashApiKey(token));
      if (!userId) {
        reply.code(401).send({ error: "Unauthorized" });
        return;
      }
      request.userId = userId;
      return;
    }

    try {
      await request.jwtVerify();
      request.userId = request.user.userId;
    } catch {
      reply.code(401).send({ error: "Unauthorized" });
    }
  });
});
