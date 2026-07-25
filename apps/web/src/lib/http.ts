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
