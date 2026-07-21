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

  return rule.between(rangeStart, rangeEnd, true).map((occurrenceStart) => ({
    start: occurrenceStart,
    end: new Date(occurrenceStart.getTime() + durationMs),
  }));
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
