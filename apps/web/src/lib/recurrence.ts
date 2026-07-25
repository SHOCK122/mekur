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
  end: Date;
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
  event: { startTime: string; endTime: string; recurrence?: RecurrenceRule },
  rangeStart: Date,
  rangeEnd: Date
): Occurrence[] {
  const start = new Date(event.startTime);
  const end = new Date(event.endTime);
  const durationMs = end.getTime() - start.getTime();

  if (!event.recurrence) {
    return start >= rangeStart && start <= rangeEnd ? [{ start, end }] : [];
  }

  const rule = new RRule({
    freq: FREQ_MAP[event.recurrence.freq],
    interval: event.recurrence.interval,
    byweekday: event.recurrence.byDay?.map((d) => WEEKDAY_MAP[d]),
    count: event.recurrence.count,
    until: event.recurrence.until ? new Date(event.recurrence.until) : undefined,
    dtstart: start,
  });

  return collectBounded(rule, rangeStart, rangeEnd).map((occurrenceStart) => ({
    start: occurrenceStart,
    end: new Date(occurrenceStart.getTime() + durationMs),
  }));
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
