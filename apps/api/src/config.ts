/**
 * Parses TRUST_PROXY: which reverse proxies may set the client IP via
 * X-Forwarded-For. A comma-separated list of addresses, CIDR ranges, or the
 * named groups `loopback`, `linklocal` and `uniquelocal` (private ranges).
 * Unset or empty trusts no proxy.
 *
 * A bare hop count ("1") is rejected rather than accepted: since Fastify
 * 5.12 a numeric trustProxy trusts *nothing* (a hop count can't tell the
 * real proxy from a client faking the header), so a leftover "1" would
 * silently put every user behind nginx in one rate-limit bucket.
 */
export function parseTrustProxy(value: string | undefined): string[] | false {
  const entries = (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length === 0) return false;
  if (entries.some((entry) => /^\d+$/.test(entry))) {
    throw new Error(
      `TRUST_PROXY no longer takes a hop count (got "${value}"). List the proxy's address or ` +
        `range instead, e.g. "uniquelocal" behind the bundled nginx.`
    );
  }
  return entries;
}

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? "0.0.0.0",
  databaseUrl: required(
    "DATABASE_URL",
    "postgres://postgres:postgres@localhost:5432/scheduleapp"
  ),
  // In production this MUST be set to a long random secret via the
  // environment (see .env.example). The fallback exists only so local
  // development doesn't require extra setup, and is intentionally obvious
  // if it ever leaks into a real deployment.
  jwtSecret: process.env.JWT_SECRET ?? "dev-only-insecure-secret-do-not-use-in-production",
  nodeEnv: process.env.NODE_ENV ?? "development",
  // Proxies trusted to report the client IP (see parseTrustProxy). Behind
  // nginx this must include nginx's address, or every request appears to
  // come from nginx and all users share one rate-limit bucket -- ten failed
  // logins anywhere would lock everyone out for a minute.
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
  // Same dev-only-fallback pattern as jwtSecret: a real, valid VAPID
  // keypair so local development works out of the box, but guarded
  // against production use below since it's public in this repo's
  // history and offers no security in a real deployment.
  vapidPublicKey:
    process.env.VAPID_PUBLIC_KEY ??
    "BAHQnCgvhlb0-G5wOocrFTe7zK7ewUJ7AR7ZCYGA2rfaGlueYTazRM-fTiZUrkJUlM2SmKbdUALS1FzUnSiFbUI",
  vapidPrivateKey: process.env.VAPID_PRIVATE_KEY ?? "qUFTF3lXxouxuo_n0kPvwpMn2Ehl3W51M8Aw3vap5QQ",
  vapidSubject: process.env.VAPID_SUBJECT ?? "mailto:dev-only@example.com",
};

if (config.nodeEnv === "production" && config.jwtSecret.startsWith("dev-only-")) {
  throw new Error(
    "JWT_SECRET must be set to a real secret in production (NODE_ENV=production)"
  );
}

if (
  config.nodeEnv === "production" &&
  config.vapidPrivateKey === "qUFTF3lXxouxuo_n0kPvwpMn2Ehl3W51M8Aw3vap5QQ"
) {
  throw new Error(
    "VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY must be set to a real, privately-generated keypair in " +
      "production (NODE_ENV=production) -- the built-in fallback is public in this repo's history. " +
      "Generate one with: npx web-push generate-vapid-keys"
  );
}
