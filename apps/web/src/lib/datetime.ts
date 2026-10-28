const pad = (n: number) => String(n).padStart(2, "0");

/** Formats an instant for a datetime-local input, which wants local time
 * with no zone suffix. Seconds are optional so "now" can be exact. */
export function toLocalInput(date: Date, withSeconds = false): string {
  const base = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}`;
  return withSeconds ? `${base}:${pad(date.getSeconds())}` : base;
}

/** The ISO instant for a datetime-local value, or undefined when empty. */
export function fromLocalInput(value: string): string | undefined {
  return value ? new Date(value).toISOString() : undefined;
}

/**
 * Checks a start/end pair from a form. Returns an error message, or null
 * if valid. End is optional: an event may be open-ended.
 */
export function validateTimes(startIso: string | undefined, endIso: string | undefined): string | null {
  if (!startIso) return "An event needs a start time.";
  if (endIso && new Date(endIso) <= new Date(startIso)) return "End time must be after the start time.";
  return null;
}
