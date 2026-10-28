import type { Session } from "./session.js";

export const API_BASE = "/api";

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

/** An API error that keeps the HTTP status, so callers can branch on it
 * (e.g. a keyring 409) without string-matching messages. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "ApiError";
  }
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
    throw new ApiError(details ? `${baseMessage}: ${details}` : baseMessage, response.status);
  }
  return body;
}

export interface ApiRequest {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  /** Sent as `x-event-capability`, for routes authorised by capability. */
  capability?: string;
  /** Statuses that count as success despite being errors, e.g. a 404 on
   * an unsubscribe that the server already pruned. */
  allow?: number[];
}

/**
 * The one place requests are built. Content-Type is sent only when there
 * is a body: declaring JSON with no body makes Fastify reject the request
 * outright, which is what once broke DELETE.
 */
export async function apiFetch(
  session: Session | null,
  path: string,
  { method = "GET", body, capability, allow = [] }: ApiRequest = {}
): Promise<any> {
  const headers: Record<string, string> = {};
  if (session) headers.authorization = `Bearer ${session.token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (capability) headers["x-event-capability"] = capability;

  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status === 204 || allow.includes(response.status)) return {};
  return parseJsonOrThrow(response);
}
