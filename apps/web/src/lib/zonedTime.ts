/**
 * Wall-clock conversions for one IANA time zone, using only `Intl`.
 *
 * rrule computes in UTC. To evaluate a rule in a zone, its inputs are
 * converted to "floating" times -- Dates whose UTC fields hold the zone's
 * wall-clock reading -- and its outputs are converted back. That is what
 * makes "the first Monday at 09:00" mean Monday 09:00 *there*, including
 * across daylight-saving changes.
 */

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/** The wall-clock reading in `timeZone` at `instant`, as a Date whose UTC
 * fields hold it. */
export function wallClockAsUtc(instant: Date, timeZone: string): Date {
  const parts: Partial<Record<Intl.DateTimeFormatPartTypes, number>> = {};
  for (const part of formatterFor(timeZone).formatToParts(instant)) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  const { year = 1970, month = 1, day = 1, minute = 0, second = 0 } = parts;
  // Some engines print midnight as 24 even with h23.
  const hour = parts.hour === 24 ? 0 : (parts.hour ?? 0);
  const wall = new Date(0);
  wall.setUTCFullYear(year, month - 1, day);
  wall.setUTCHours(hour, minute, second, instant.getUTCMilliseconds());
  return wall;
}

/** How far `timeZone`'s clock is ahead of UTC at `instant`, in ms. */
function offsetAt(instant: number, timeZone: string): number {
  return wallClockAsUtc(new Date(instant), timeZone).getTime() - instant;
}

const HALF_DAY_MS = 12 * 3_600_000;

/**
 * The instant at which `timeZone`'s clock reads `wall` (a floating time,
 * see wallClockAsUtc). A reading that happens twice, when clocks go back,
 * resolves to the earlier one. A reading that never happens, when clocks
 * go forward, is moved forward by the size of the gap (02:30 on the night
 * clocks jump from 02:00 to 03:00 becomes 03:30), as iCalendar specifies.
 */
export function instantFromWallClock(wall: Date, timeZone: string): Date {
  const reading = wall.getTime();
  // The offsets in force on either side of any change near this reading.
  const before = offsetAt(reading - HALF_DAY_MS, timeZone);
  const after = offsetAt(reading + HALF_DAY_MS, timeZone);
  const candidates = [reading - before, reading - after].filter(
    (instant) => instant + offsetAt(instant, timeZone) === reading
  );
  if (candidates.length > 0) return new Date(Math.min(...candidates));
  return new Date(reading - before);
}

/**
 * instantFromWallClock for many readings in one zone, in order -- a
 * series' occurrences. The offset rarely changes between consecutive
 * readings, so the last one is tried first and confirmed with a single
 * lookup; only readings near a change pay for the full search.
 */
export function wallClockConverter(timeZone: string): (wall: Date) => Date {
  let offset: number | null = null;
  return (wall) => {
    const reading = wall.getTime();
    if (offset !== null) {
      const instant = reading - offset;
      // Confirming the reading isn't enough: right after clocks go back it
      // also matches the later of two instants, and the earlier is wanted.
      if (offsetAt(instant, timeZone) === offset && offsetAt(instant - HALF_DAY_MS, timeZone) === offset) {
        return new Date(instant);
      }
    }
    const instant = instantFromWallClock(wall, timeZone);
    offset = offsetAt(instant.getTime(), timeZone);
    return instant;
  };
}
