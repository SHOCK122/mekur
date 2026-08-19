/** Formats an instant for a `datetime-local` input, which wants local time
 * with no zone suffix. Pass `seconds: true` when the field needs to be
 * exact to the second (e.g. tracking "now" live); omitted otherwise. */
export function toLocalInputValue(
  date: Date | string | undefined,
  options: { seconds?: boolean } = {}
): string {
  if (!date) return "";
  const d = typeof date === "string" ? new Date(date) : date;
  const pad = (n: number) => String(n).padStart(2, "0");
  const base = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
  return options.seconds ? `${base}:${pad(d.getSeconds())}` : base;
}
