import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import type { Database } from "../src/db/pool.js";
import { setupTestApp } from "./testHelpers.js";

// During the migration the API is split between two servers (nginx sends
// the Rust server's paths to it, everything else here), and one OpenAPI
// document -- crates/api/openapi.json, served by the Rust server --
// describes both. This checks that the two servers' routes together are
// exactly what it documents.
const here = dirname(fileURLToPath(import.meta.url));
const OPENAPI_PATH = resolve(here, "../../../crates/api/openapi.json");
const RUST_APP_PATH = resolve(here, "../../../crates/api/src/app.rs");
const NGINX_CONF_PATH = resolve(here, "../../../infra/nginx.conf");
const VITE_CONFIG_PATH = resolve(here, "../../web/vite.config.ts");

/** `ROUTES` in crates/api/src/app.rs, read from the source so the list
 * can't drift. Its Rust tests check each entry is served and documented. */
function rustRoutes(): string[] {
  const source = readFileSync(RUST_APP_PATH, "utf8");
  const list = /pub const ROUTES: [^=]*= &\[([^\]]*)\];/.exec(source);
  if (!list) throw new Error(`ROUTES not found in ${RUST_APP_PATH}`);
  const routes = [...list[1]!.matchAll(/\("(\w+)",\s*"([^"]+)"\)/g)].map((m) => `${m[1]} ${m[2]}`);
  expect(routes.length).toBeGreaterThan(0);
  return routes;
}

describe("OpenAPI document", () => {
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

  it("documents every route either server registers, and nothing that doesn't exist", () => {
    const body = JSON.parse(readFileSync(OPENAPI_PATH, "utf8"));
    expect(body.openapi).toBe("3.0.3");

    const toOpenApiPath = (url: string) => url.replace(/:(\w+)/g, "{$1}");
    const tsRoutes = routes
      .filter((r) => r.method !== "head" && r.method !== "options")
      .map((r) => `${r.method} ${toOpenApiPath(r.url)}`);
    const rust = rustRoutes();
    // A route is served by one server or the other, never both -- and
    // since nginx splits by path, a path moves with all its methods.
    const rustPaths = rust.map((r) => r.split(" ")[1]);
    expect(tsRoutes.filter((r) => rustPaths.includes(r.split(" ")[1]))).toEqual([]);

    const registered = new Set([...tsRoutes, ...rust]);
    const documented = new Set(
      Object.entries(body.paths as Record<string, Record<string, unknown>>).flatMap(([path, ops]) =>
        Object.keys(ops).map((method) => `${method} ${path}`)
      )
    );
    expect([...documented].sort()).toEqual([...registered].sort());
  });
});

describe("the proxies' route split", () => {
  const rustPaths = () => [...new Set(rustRoutes().map((r) => r.split(" ")[1]!))].sort();

  it("nginx sends exactly the Rust server's paths to it", () => {
    const conf = readFileSync(NGINX_CONF_PATH, "utf8");
    const proxied = [...conf.matchAll(/location = \/api(\/\S+)\s*\{\s*proxy_pass http:\/\/api_rs(\/\S+);/g)];
    // Each location forwards to the same path on the Rust server.
    for (const [, from, to] of proxied) expect(to).toBe(from);
    expect(proxied.map((m) => m[1]).sort()).toEqual(rustPaths());
    // ...and nothing else reaches it.
    expect(conf.match(/api_rs/g)?.length).toBe(proxied.length + 1); // + the upstream block
  });

  it("the Vite dev proxy makes the same split", () => {
    const source = readFileSync(VITE_CONFIG_PATH, "utf8");
    const key = /^\s*"(\^\/api\/[^"]+)": \{\s*target: "http:\/\/localhost:3001"/m.exec(source);
    if (!key) throw new Error(`Rust proxy entry not found in ${VITE_CONFIG_PATH}`);
    // The key as written in the source is a JS string literal.
    const pattern = new RegExp(JSON.parse(`"${key[1]}"`));
    for (const path of rustPaths()) {
      expect(pattern.test(`/api${path}`), path).toBe(true);
      expect(pattern.test(`/api${path}?x=1`), path).toBe(true);
      expect(pattern.test(`/api${path}/more`), path).toBe(false);
    }
    expect(pattern.test("/api/keyring")).toBe(false);
    expect(pattern.test("/api/healthz")).toBe(false);
  });
});
