import { z } from "zod";

const uuidSchema = z.string().uuid();

/**
 * Validates a UUID path parameter before it reaches the database.
 *
 * Without this, a malformed id (e.g. /events/not-a-uuid) reaches Postgres,
 * which throws on the invalid uuid cast, and that surfaces as an
 * unhandled 500 -- both the wrong status code (the resource simply isn't
 * there, which is a 404) and a small information leak about internals.
 */
export function isValidUuid(value: string): boolean {
  return uuidSchema.safeParse(value).success;
}
