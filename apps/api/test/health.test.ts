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

  beforeAll(async () => {
    ({ app, db } = await setupTestApp());
  });

  afterAll(async () => {
    await app.close();
    await db.end();
  });

  it("returns a valid-looking OpenAPI document describing the real routes", async () => {
    const response = await app.inject({ method: "GET", url: "/openapi.json" });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.openapi).toBe("3.0.3");
    expect(body.paths).toHaveProperty("/events");
    expect(body.paths).toHaveProperty("/events/{id}");
    expect(body.paths).toHaveProperty("/users");
    expect(body.paths).toHaveProperty("/sessions");
    expect(body.paths).toHaveProperty("/keyring");
    expect(body.paths).toHaveProperty("/inbox");
  });
});
