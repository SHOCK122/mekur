import fp from "fastify-plugin";
import jwt from "@fastify/jwt";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

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

export const authPlugin = fp(async function authPlugin(
  app: FastifyInstance,
  opts: { secret: string }
) {
  app.register(jwt, { secret: opts.secret });

  app.decorate("authenticate", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      await request.jwtVerify();
      request.userId = request.user.userId;
    } catch {
      reply.code(401).send({ error: "Unauthorized" });
    }
  });
});
