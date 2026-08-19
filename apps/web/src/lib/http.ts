import type { Session } from "./session.js";

/** `hasBody` matters: sending Content-Type: application/json with no body
 * makes Fastify reject the request outright (FST_ERR_CTP_EMPTY_JSON_BODY),
 * which is what broke DELETE. `capability` adds the per-event capability
 * token header (see docs/ARCHITECTURE.md's capability model) when set. */
export function authHeaders(
  session: Session,
  opts: { capability?: string; hasBody?: boolean } = {}
): Record<string, string> {
  const { capability, hasBody = true } = opts;
  const headers: Record<string, string> = {
    authorization: `Bearer ${session.token}`,
  };
  if (hasBody) headers["Content-Type"] = "application/json";
  if (capability) headers["x-event-capability"] = capability;
  return headers;
}

/** Extracts a human-readable message from a caught value, falling back to a
 * generic message for non-Error throws (e.g. a rejected promise with a
 * string or object reason). */
export function getErrorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

interface ZodIssueLike {
  path?: (string | number)[];
  message?: string;
}

function formatDetails(details: unknown): string {
  if (!Array.isArray(details)) return "";
  const messages = (details as ZodIssueLike[])
    .map((issue) => {
      const path = issue.path?.length ? `${issue.path.join(".")}: ` : "";
      return issue.message ? `${path}${issue.message}` : null;
    })
    .filter((m): m is string => Boolean(m));
  return messages.join("; ");
}

/**
 * Parses a fetch Response as JSON, throwing a descriptive Error if the
 * request failed. Includes any validation `details` the API returned
 * (e.g. "username: must be lowercase letters, numbers, _ . -") rather
 * than just a generic "Invalid request" -- a bare error code isn't
 * enough for a person to know what to fix.
 */
export async function parseJsonOrThrow(response: Response): Promise<any> {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const baseMessage = body.error ?? `Request failed with status ${response.status}`;
    const details = formatDetails(body.details);
    throw new Error(details ? `${baseMessage}: ${details}` : baseMessage);
  }
  return body;
}
