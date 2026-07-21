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
};

if (config.nodeEnv === "production" && config.jwtSecret.startsWith("dev-only-")) {
  throw new Error(
    "JWT_SECRET must be set to a real secret in production (NODE_ENV=production)"
  );
}
