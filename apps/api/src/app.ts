import Fastify, { type FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import helmet from "@fastify/helmet";
import type { Database } from "./db/pool.js";
import { authPlugin } from "./plugins/auth.js";
import { createUserRepository } from "./repositories/userRepository.js";
import { createEventRepository } from "./repositories/eventRepository.js";
import { createApiKeyRepository } from "./repositories/apiKeyRepository.js";
import { createPushSubscriptionRepository } from "./repositories/pushSubscriptionRepository.js";
import { createFriendCodeRepository } from "./repositories/friendCodeRepository.js";
import { createKeyringRepository } from "./repositories/keyringRepository.js";
import { createInboxRepository } from "./repositories/inboxRepository.js";
import { createNotificationService } from "./services/notificationService.js";
import { registerAuthRoutes } from "./routes/authRoutes.js";
import { registerEventRoutes } from "./routes/eventRoutes.js";
import { registerApiKeyRoutes } from "./routes/apiKeyRoutes.js";
import { registerPushRoutes } from "./routes/pushRoutes.js";
import { registerSocialRoutes } from "./routes/socialRoutes.js";
import { registerKeyringRoutes } from "./routes/keyringRoutes.js";
import { registerInboxRoutes } from "./routes/inboxRoutes.js";
import { openApiSpec } from "./openapi.js";

export interface BuildAppOptions {
  db: Database;
  jwtSecret: string;
  vapidPublicKey: string;
  vapidPrivateKey: string;
  vapidSubject: string;
  /** Overridable so tests can raise it -- the default would otherwise
   * throttle a fast-running suite and cause confusing flakes. */
  rateLimitMax?: number;
  /** Tighter limit for auth endpoints (login/registration). */
  authRateLimitMax?: number;
}

export function buildApp(opts: BuildAppOptions): FastifyInstance {
  const app = Fastify({
    logger: false,
    // Encrypted envelopes are small; without a cap, a client could store
    // arbitrarily large blobs. 256KB is far more than any real event needs
    // while bounding what a single request can cost us.
    bodyLimit: 256 * 1024,
  });

  // Security headers. The PWA serves its own assets and talks only to its
  // own origin, so a restrictive CSP costs nothing here.
  app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"], // Vite inlines critical CSS
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
  });

  // Global rate limit as a backstop against abuse and runaway agent
  // clients. Auth endpoints get a much tighter limit registered below --
  // an unthrottled login endpoint is brute-forceable.
  app.register(rateLimit, {
    max: opts.rateLimitMax ?? 300,
    timeWindow: "1 minute",
  });

  const users = createUserRepository(opts.db);
  const events = createEventRepository(opts.db);
  const apiKeys = createApiKeyRepository(opts.db);
  const pushSubscriptions = createPushSubscriptionRepository(opts.db);
  const friendCodes = createFriendCodeRepository(opts.db);
  const keyrings = createKeyringRepository(opts.db);
  const inbox = createInboxRepository(opts.db);
  const notifications = createNotificationService(pushSubscriptions, {
    vapidPublicKey: opts.vapidPublicKey,
    vapidPrivateKey: opts.vapidPrivateKey,
    vapidSubject: opts.vapidSubject,
  });

  app.register(authPlugin, { secret: opts.jwtSecret, apiKeys });

  app.get("/health", async () => ({ status: "ok" }));
  app.get("/openapi.json", async () => openApiSpec);

  app.register(async (instance) => {
    registerAuthRoutes(instance, users, opts.authRateLimitMax ?? 10);
    registerEventRoutes(instance, events);
    registerApiKeyRoutes(instance, apiKeys);
    registerPushRoutes(instance, pushSubscriptions, opts.vapidPublicKey);
    registerSocialRoutes(instance, users, friendCodes);
    registerKeyringRoutes(instance, keyrings);
    registerInboxRoutes(instance, inbox, users, notifications);
  });

  return app;
}
