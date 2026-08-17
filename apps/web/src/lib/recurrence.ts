import { RRule, Weekday as RRuleWeekday } from "rrule";
import type { RecurrenceRule, Weekday } from "@schedule-app/shared";

const FREQ_MAP: Record<RecurrenceRule["freq"], number> = {
  MINUTELY: RRule.MINUTELY,
  HOURLY: RRule.HOURLY,
  DAILY: RRule.DAILY,
  WEEKLY: RRule.WEEKLY,
  MONTHLY: RRule.MONTHLY,
  YEARLY: RRule.YEARLY,
};

const WEEKDAY_MAP: Record<Weekday, RRuleWeekday> = {
  MO: RRule.MO,
  TU: RRule.TU,
  WE: RRule.WE,
  TH: RRule.TH,
  FR: RRule.FR,
  SA: RRule.SA,
  SU: RRule.SU,
};

export interface Occurrence {
  start: Date;
  /** Null for open-ended events. */
  end: Date | null;
  /** True when this occurrence was skipped. Callers decide whether to
   * render it (dimmed, behind a "show skipped" toggle) or omit it. */
  skipped: boolean;
}

/** Hard ceiling on how many occurrences a single event can contribute to a
 * display window. Without this, a rule like "every 1 minute" expanded over
 * a multi-month window would generate hundreds of thousands of rows and
 * freeze the UI. 500 is generous for any real calendar use while staying
 * cheap to render. */
const MAX_OCCURRENCES_PER_EVENT = 500;

/**
 * Expands a single event + its optional recurrence rule into concrete
 * occurrences within [rangeStart, rangeEnd]. All occurrences share the
 * same underlying event id: editing or deleting acts on the whole
 * series, not a single occurrence -- a deliberate simplification for
 * now (see docs/ROADMAP.md).
 */
export function expandOccurrences(
  event: {
    startTime: string;
    /** Absent for open-ended events. */
    endTime?: string;
    recurrence?: RecurrenceRule;
    skippedOccurrences?: string[];
  },
  rangeStart: Date,
  rangeEnd: Date,
  options: { includeSkipped?: boolean } = {}
): Occurrence[] {
  const start = new Date(event.startTime);
  // An open-ended event has no duration to preserve across occurrences;
  // callers render it as extending to the edge of the view instead.
  const end = event.endTime ? new Date(event.endTime) : null;
  const durationMs = end ? end.getTime() - start.getTime() : null;

  // Compared by timestamp rather than string, so an exception recorded in
  // a different ISO format still matches the occurrence it refers to.
  const skipped = new Set((event.skippedOccurrences ?? []).map((iso) => new Date(iso).getTime()));
  const isSkipped = (date: Date) => skipped.has(date.getTime());

  const keep = (occurrence: Occurrence) =>
    options.includeSkipped ? true : !occurrence.skipped;

  if (!event.recurrence) {
    if (start < rangeStart || start > rangeEnd) return [];
    return [{ start, end, skipped: isSkipped(start) }].filter(keep);
  }

  const rule = new RRule({
    freq: FREQ_MAP[event.recurrence.freq],
    interval: event.recurrence.interval,
    byweekday: event.recurrence.byDay?.map((d) => WEEKDAY_MAP[d]),
    count: event.recurrence.count,
    until: event.recurrence.until ? new Date(event.recurrence.until) : undefined,
    // Start the rule near the window instead of at the series' real
    // beginning. Without this, viewing an hour of a minutely series that
    // began years ago walks every intervening occurrence -- measured at
    // over two minutes for a single expansion.
    dtstart: advancedStart(start, event.recurrence, rangeStart),
  });

  return collectBounded(rule, rangeStart, rangeEnd)
    .map((occurrenceStart) => ({
      start: occurrenceStart,
      end: durationMs === null ? null : new Date(occurrenceStart.getTime() + durationMs),
      skipped: isSkipped(occurrenceStart),
    }))
    .filter(keep);
}

/** Adds an occurrence to a series' skip list, without duplicating it. */
export function withSkippedOccurrence(
  skippedOccurrences: string[] | undefined,
  occurrenceStart: Date
): string[] {
  const iso = occurrenceStart.toISOString();
  const existing = skippedOccurrences ?? [];
  return existing.some((s) => new Date(s).getTime() === occurrenceStart.getTime())
    ? existing
    : [...existing, iso];
}

/** Restores a previously skipped occurrence. */
export function withoutSkippedOccurrence(
  skippedOccurrences: string[] | undefined,
  occurrenceStart: Date
): string[] {
  return (skippedOccurrences ?? []).filter(
    (s) => new Date(s).getTime() !== occurrenceStart.getTime()
  );
}

/** Milliseconds in one repetition, for frequencies of fixed length.
 * Months and years vary, so they are excluded and handled by walking --
 * they are infrequent enough that walking is cheap. */
const FIXED_PERIOD_MS: Partial<Record<RecurrenceRule["freq"], number>> = {
  MINUTELY: 60_000,
  HOURLY: 3_600_000,
  DAILY: 86_400_000,
  WEEKLY: 604_800_000,
};

/**
 * Moves a series' start forward, by a whole number of repetitions, to just
 * before the requested window.
 *
 * Advancing by whole periods preserves the phase of the series, so the
 * occurrences generated are exactly those the original rule would have
 * produced -- it just skips the ones nobody asked for. A weekly rule with
 * BYDAY keeps its weekday pattern for the same reason.
 *
 * Deliberately skipped when `count` is set: a count limits the series as a
 * whole, so dropping earlier occurrences would change which ones remain.
 */
function advancedStart(start: Date, recurrence: RecurrenceRule, rangeStart: Date): Date {
  if (recurrence.count !== undefined) return start;
  const period = FIXED_PERIOD_MS[recurrence.freq];
  if (period === undefined) return start;

  const periodMs = period * Math.max(1, recurrence.interval);
  const behindBy = rangeStart.getTime() - start.getTime();
  if (behindBy <= 0) return start;

  // Step back one period so an occurrence straddling the window edge is
  // still produced.
  const periods = Math.max(0, Math.floor(behindBy / periodMs) - 1);
  return new Date(start.getTime() + periods * periodMs);
}

/** Iterates the rule in chronological order and stops as soon as either the
 * window is exhausted or MAX_OCCURRENCES_PER_EVENT matches are found --
 * unlike RRule.between(), which always fully enumerates before returning,
 * this bounds the actual computation cost, not just the result size. That
 * matters on low-end devices, where enumerating hundreds of thousands of
 * dates synchronously can visibly freeze the UI. */
function collectBounded(rule: RRule, rangeStart: Date, rangeEnd: Date): Date[] {
  const results: Date[] = [];
  rule.all((date) => {
    if (date > rangeEnd) return false;
    if (date >= rangeStart) results.push(date);
    return results.length < MAX_OCCURRENCES_PER_EVENT;
  });
  return results;
}

/** Short human-readable summary of a recurrence rule, for display. */
export function describeRecurrence(recurrence: RecurrenceRule): string {
  const { freq, interval, byDay } = recurrence;
  if (byDay && byDay.length > 0) {
    const isWeekdays = ["MO", "TU", "WE", "TH", "FR"].every((d) => byDay.includes(d as Weekday)) && byDay.length === 5;
    if (isWeekdays) return "Repeats every weekday";
    return `Repeats weekly on ${byDay.join(", ")}`;
  }
  const unit: Record<RecurrenceRule["freq"], string> = {
    MINUTELY: "minute",
    HOURLY: "hour",
    DAILY: "day",
    WEEKLY: "week",
    MONTHLY: "month",
    YEARLY: "year",
  };
  const unitLabel = interval === 1 ? unit[freq] : `${unit[freq]}s`;
  return interval === 1 ? `Repeats every ${unitLabel}` : `Repeats every ${interval} ${unitLabel}`;
}
