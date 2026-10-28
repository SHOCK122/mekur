import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Database } from "../src/db/pool.js";
import { setupTestApp, truncateAll } from "./testHelpers.js";

describe("GET /health", () => {
  let app: FastifyInstance;
  let db: Database;

  beforeAll(async () => {
    ({ app, db } = await setupTestApp());
  });

  beforeEach(async () => {
    await truncateAll(db);
  });

  afterAll(async () => {
    await app.close();
    await db.end();
  });

  it("returns 200 with status ok", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });
});

describe("GET /openapi.json", () => {
  let app: FastifyInstance;
  let db: Database;
  const routes: { method: string; url: string }[] = [];

  beforeAll(async () => {
    ({ app, db } = await setupTestApp());
    // Plugins load lazily on ready(), so a root-level hook added now still
    // sees every route.
    app.addHook("onRoute", (route) => {
      const methods = Array.isArray(route.method) ? route.method : [route.method];
      for (const method of methods) routes.push({ method: method.toLowerCase(), url: route.url });
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await db.end();
  });

  it("documents every registered route, and nothing that doesn't exist", async () => {
    const response = await app.inject({ method: "GET", url: "/openapi.json" });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.openapi).toBe("3.0.3");

    const toOpenApiPath = (url: string) => url.replace(/:(\w+)/g, "{$1}");
    // /health and /openapi.json are registered synchronously in buildApp,
    // before this hook exists.
    const registered = new Set([
      "get /health",
      "get /openapi.json",
      ...routes
        .filter((r) => r.method !== "head" && r.method !== "options")
        .map((r) => `${r.method} ${toOpenApiPath(r.url)}`),
    ]);
    const documented = new Set(
      Object.entries(body.paths as Record<string, Record<string, unknown>>).flatMap(([path, ops]) =>
        Object.keys(ops).map((method) => `${method} ${path}`)
      )
    );
    expect([...documented].sort()).toEqual([...registered].sort());
  });
});
