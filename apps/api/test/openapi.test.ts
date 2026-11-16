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
const RUST_KEYRING_ROUTE_PATH = resolve(here, "../../../crates/api/src/routes/keyring.rs");
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

/** `KEYRING_BODY_LIMIT` in the Rust keyring route, in bytes, read from the
 * source so the proxy check below follows it. */
function rustKeyringBodyLimit(): number {
  const source = readFileSync(RUST_KEYRING_ROUTE_PATH, "utf8");
  const limit = /pub const KEYRING_BODY_LIMIT: usize = (\d+) \* 1024;/.exec(source);
  if (!limit) throw new Error(`KEYRING_BODY_LIMIT not found in ${RUST_KEYRING_ROUTE_PATH}`);
  return Number(limit[1]) * 1024;
}

/** An nginx size (`1536k`, `2m`, `4096`) in bytes. */
function nginxSize(size: string): number {
  const parsed = /^(\d+)([km]?)$/i.exec(size);
  if (!parsed) throw new Error(`Not an nginx size: ${size}`);
  const unit = { "": 1, k: 1024, m: 1024 * 1024 }[parsed[2]!.toLowerCase()]!;
  return Number(parsed[1]) * unit;
}

/** The TS server's route paths in OpenAPI form, filled in by the first
 * suite (which builds the app) for the proxy checks below. */
const tsRoutePaths: string[] = [];

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
    tsRoutePaths.push(...new Set(tsRoutes.map((r) => r.split(" ")[1]!)));
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

  /** A documented path with each `{param}` filled in, as a client sends it. */
  const sample = (path: string) => path.replace(/\{\w+\}/g, "ada");

  it("has the TS server's routes to compare against", () => {
    expect(tsRoutePaths.length).toBeGreaterThan(0);
  });

  it("nginx sends exactly the Rust server's paths to it", () => {
    const conf = readFileSync(NGINX_CONF_PATH, "utf8");
    // Fixed paths: `location = /api/X { proxy_pass http://api_rs/X; }`,
    // optionally with its own request-body limit first.
    const exact = [
      ...conf.matchAll(
        /location = \/api(\/\S+)\s*\{\s*(?:client_max_body_size (\S+);\s*)?proxy_pass http:\/\/api_rs(\/\S+);/g
      ),
    ];
    for (const [, from, , to] of exact) expect(to).toBe(from);
    // nginx refuses bodies over 1 MB unless told otherwise; the keyring
    // route alone reads more (1.5 MB), so it alone raises the limit: past
    // what the API reads, so the API's own 413 answers a body that is too
    // large, but by no more than 1 MB.
    const raised = exact.filter((m) => m[2]);
    expect(raised.map((m) => m[1])).toEqual(["/keyring"]);
    const proxyLimit = nginxSize(raised[0]![2]!);
    expect(proxyLimit).toBeGreaterThan(rustKeyringBodyLimit());
    expect(proxyLimit).toBeLessThanOrEqual(rustKeyringBodyLimit() + 1024 * 1024);
    expect(conf.match(/client_max_body_size/g)?.length).toBe(1);
    // Paths with parameters: a regex location that strips /api.
    const regexes = [
      ...conf.matchAll(
        /location ~ (\S+)\s*\{\s*rewrite \^\/api\(\/\.\*\)\$ \$1 break;\s*proxy_pass http:\/\/api_rs;\s*\}/g
      ),
    ].map((m) => new RegExp(m[1]!));

    const fixed = rustPaths().filter((p) => !p.includes("{"));
    const parametric = rustPaths().filter((p) => p.includes("{"));
    expect(exact.map((m) => m[1]).sort()).toEqual(fixed);
    for (const path of parametric) {
      expect(regexes.some((re) => re.test(`/api${sample(path)}`)), path).toBe(true);
      expect(regexes.some((re) => re.test(`/api${sample(path)}/more`)), path).toBe(false);
    }
    // Each regex is for some Rust path, and matches no TS route.
    for (const re of regexes) {
      expect(parametric.some((p) => re.test(`/api${sample(p)}`)), String(re)).toBe(true);
      for (const ts of tsRoutePaths) expect(re.test(`/api${sample(ts)}`), `${re} ${ts}`).toBe(false);
    }
    // ...and nothing else reaches it.
    expect(conf.match(/api_rs/g)?.length).toBe(exact.length + regexes.length + 1); // + the upstream block
  });

  it("the Vite dev proxy makes the same split", () => {
    const source = readFileSync(VITE_CONFIG_PATH, "utf8");
    const key = /^\s*"(\^\/api\/[^"]+)": \{\s*target: "http:\/\/localhost:3001"/m.exec(source);
    if (!key) throw new Error(`Rust proxy entry not found in ${VITE_CONFIG_PATH}`);
    // The key as written in the source is a JS string literal.
    const pattern = new RegExp(JSON.parse(`"${key[1]}"`));
    // A longer path is the Rust server's only if it is itself a Rust path
    // (`/api-keys/more` is `/api-keys/{id}`).
    const paths = rustPaths();
    const rustPathPatterns = paths.map(
      (p) => new RegExp(`^${p.replace(/\./g, "\\.").replace(/\{\w+\}/g, "[^/?]*")}$`)
    );
    const isRustPath = (path: string) => rustPathPatterns.some((re) => re.test(path));
    for (const path of paths.map(sample)) {
      expect(pattern.test(`/api${path}`), path).toBe(true);
      expect(pattern.test(`/api${path}?x=1`), path).toBe(true);
      expect(pattern.test(`/api${path}/more`), path).toBe(isRustPath(`${path}/more`));
      expect(pattern.test(`/api${path}/more/more`), path).toBe(false);
    }
    for (const ts of tsRoutePaths) expect(pattern.test(`/api${sample(ts)}`), ts).toBe(false);
    expect(pattern.test("/api/inbox")).toBe(false);
    expect(pattern.test("/api/keyrings")).toBe(false);
    expect(pattern.test("/api/healthz")).toBe(false);
  });
});
