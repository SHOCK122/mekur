import { RRule, Weekday as RRuleWeekday } from "rrule";
import { RecurrenceRuleSchema, isValidTimeZone, type RecurrenceRule, type Weekday } from "@schedule-app/shared";
import { wallClockAsUtc, wallClockConverter } from "./zonedTime.js";

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

/** How far back, in repetitions of a fixed-length series, to look for an
 * occurrence still in progress at the start of the window. Only the latest
 * such occurrence is needed (see expandOccurrences), so this only matters
 * when the most recent ones were all skipped; it bounds the walk for a
 * long event repeating far more often than it lasts (a day-long event
 * every minute would otherwise walk 1,440 repeats per expansion). */
const IN_PROGRESS_LOOKBACK_PERIODS = 100;

/**
 * Expands a single event + its optional recurrence rule into the concrete
 * occurrences that overlap [rangeStart, rangeEnd]: those starting inside
 * it, plus one still in progress at rangeStart. All occurrences share the
 * same underlying event id: edits act on the whole series, and a single
 * occurrence can only be skipped (see skippedOccurrences). Per-occurrence
 * overrides are roadmap Phase 8.
 *
 * Of the occurrences in progress at rangeStart, only the latest is
 * returned. Repeats of one series share a duration, so the latest-starting
 * one also ends last, and every earlier one in progress is drawn entirely
 * underneath it in the series' single row. Skipped repeats don't count:
 * with `includeSkipped`, a later skipped one is returned as well as (not
 * instead of) the latest one actually taking place.
 *
 * Open-ended occurrences have no end to overlap with, so they are kept
 * only while their start is in the window -- otherwise every open-ended
 * repeat that ever began would count as "in progress" forever.
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
    const startsInside = start >= rangeStart && start <= rangeEnd;
    const inProgress = start < rangeStart && end !== null && end > rangeStart;
    if (!startsInside && !inProgress) return [];
    return [{ start, end, skipped: isSkipped(start) }].filter(keep);
  }

  // How long before the window an occurrence may start and still be in
  // progress at its start.
  const lookbackMs = durationMs !== null && durationMs > 0 ? durationMs : 0;

  const recurrence = usableRule(event.recurrence);
  // A rule with a time zone is evaluated on that zone's wall clock: rrule
  // only knows UTC, so it is handed wall-clock readings dressed as UTC
  // ("floating" times) and each result is mapped back to a real instant.
  // Without one, the rule runs in UTC as it always has.
  const tz = recurrence.tzid;
  const toRule = tz ? (d: Date) => wallClockAsUtc(d, tz) : (d: Date) => d;
  const fromRule = tz ? wallClockConverter(tz) : (d: Date) => d;

  const ruleOptions = {
    freq: FREQ_MAP[recurrence.freq],
    interval: recurrence.interval,
    byweekday: recurrence.byDay?.map((d) => WEEKDAY_MAP[d]),
    bymonthday: recurrence.byMonthDay,
    bymonth: recurrence.byMonth,
    bysetpos: recurrence.bySetPos,
    count: recurrence.count,
    until: recurrence.until ? toRule(new Date(recurrence.until)) : undefined,
  };
  if (!everOccurs(ruleOptions, toRule(start))) return [];

  const rule = new RRule({
    ...ruleOptions,
    // Start the rule near the window instead of at the series' real
    // beginning. Without this, viewing an hour of a minutely series that
    // began years ago walks every intervening occurrence -- measured at
    // over two minutes for a single expansion.
    dtstart: advancedStart(toRule(start), recurrence, toRule(rangeStart), lookbackMs),
  });

  const { inProgress, inside } = collectBounded(rule, rangeStart, rangeEnd, lookbackMs, isSkipped, fromRule);
  const before = [inProgress.latest, options.includeSkipped ? inProgress.latestSkipped : null]
    .filter((d): d is Date => d !== null)
    .sort((a, b) => a.getTime() - b.getTime());

  return [...before, ...inside]
    .map((occurrenceStart) => ({
      start: occurrenceStart,
      end: durationMs === null ? null : new Date(occurrenceStart.getTime() + durationMs),
      skipped: isSkipped(occurrenceStart),
    }))
    .filter(keep)
    .slice(0, MAX_OCCURRENCES_PER_EVENT);
}

/** The fields that describe which days a monthly or yearly rule falls
 * on, plus the zone they are read in. */
const CALENDAR_KEYS = ["byDay", "byMonthDay", "byMonth", "bySetPos", "tzid"] as const;

const usableRules = new WeakMap<RecurrenceRule, RecurrenceRule>();

/** The rule as it can safely be expanded. Decrypted content is whatever a
 * holder of the edit capability wrote, so its calendar fields are checked
 * here rather than trusted, and the ones that fail are dropped: an
 * unknown zone leaves the rule in UTC, an impossible day leaves the rest.
 * (A rule that can never match would make rrule walk to the year 9999 --
 * seconds, for a daily one.) Other fields are left as they are, as they
 * always were. Remembered per rule object: this runs on every render. */
function usableRule(recurrence: RecurrenceRule): RecurrenceRule {
  const known = usableRules.get(recurrence);
  if (known) return known;
  const rule: RecurrenceRule = { ...recurrence };
  // Each pass drops the fields that failed; refinements across fields only
  // run once every field parses on its own, so this can take a few.
  for (let pass = 0; pass <= CALENDAR_KEYS.length; pass++) {
    const { freq, byDay, byMonthDay, byMonth, bySetPos, tzid } = rule;
    const check = RecurrenceRuleSchema.safeParse({ freq, interval: 1, byDay, byMonthDay, byMonth, bySetPos, tzid });
    if (check.success) break;
    const failing = new Set(check.error.issues.map((issue) => issue.path[0]));
    if (!CALENDAR_KEYS.some((key) => failing.has(key))) break;
    for (const key of CALENDAR_KEYS) if (failing.has(key)) delete rule[key];
    // Without its position, "the third Tuesday" would be every Tuesday.
    if (failing.has("bySetPos")) delete rule.byDay;
  }
  usableRules.set(recurrence, rule);
  return rule;
}

/** Whether a rule produces anything at all, remembered per rule and start.
 * Validation rejects the impossible rules a person could pick (February
 * 30th), but not every one: "the sixth Monday" passes and never occurs,
 * and rrule would walk to the year 9999 looking for it on every render.
 * This pays that walk at most once per distinct rule. Only rules with
 * calendar parts are checked; every other rule matches immediately. */
const occursCache = new Map<string, boolean>();
const OCCURS_CACHE_LIMIT = 500;

function everOccurs(options: Partial<ConstructorParameters<typeof RRule>[0]>, dtstart: Date): boolean {
  if (!options?.bymonthday && !options?.bymonth && !options?.bysetpos) return true;
  const key = JSON.stringify([options, dtstart.toISOString()]);
  const cached = occursCache.get(key);
  if (cached !== undefined) return cached;
  // `until` and `count` don't bound rrule's walk (it only checks them
  // against matches), so they are left out: this asks whether the pattern
  // matches ever, which is what decides how long the walk can take.
  const { until: _until, count: _count, ...pattern } = options;
  let occurs = false;
  new RRule({ ...pattern, dtstart }).all(() => {
    occurs = true;
    return false;
  });
  if (occursCache.size >= OCCURS_CACHE_LIMIT) occursCache.clear();
  occursCache.set(key, occurs);
  return occurs;
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

/** Length of one repetition (interval included), for frequencies of fixed
 * length; undefined for months and years. */
function fixedPeriodMs(recurrence: RecurrenceRule): number | undefined {
  const period = FIXED_PERIOD_MS[recurrence.freq];
  return period === undefined ? undefined : period * Math.max(1, recurrence.interval);
}

/**
 * Moves a series' start forward, by a whole number of repetitions, to just
 * before the requested window -- or before `lookbackMs` ahead of it, so an
 * occurrence still in progress at the window's start is produced too. The
 * look-back is capped at IN_PROGRESS_LOOKBACK_PERIODS repetitions.
 *
 * Advancing by whole periods preserves the phase of the series, so the
 * occurrences generated are exactly those the original rule would have
 * produced -- it just skips the ones nobody asked for. A weekly rule with
 * BYDAY keeps its weekday pattern for the same reason.
 *
 * Deliberately skipped when `count` is set: a count limits the series as a
 * whole, so dropping earlier occurrences would change which ones remain.
 */
function advancedStart(
  start: Date,
  recurrence: RecurrenceRule,
  rangeStart: Date,
  lookbackMs: number
): Date {
  if (recurrence.count !== undefined) return start;
  const periodMs = fixedPeriodMs(recurrence);
  if (periodMs === undefined) return start;

  const from = rangeStart.getTime() - Math.min(lookbackMs, IN_PROGRESS_LOOKBACK_PERIODS * periodMs);
  const behindBy = from - start.getTime();
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
 * dates synchronously can visibly freeze the UI.
 *
 * Dates before the window are not collected. Of those still in progress
 * at rangeStart (started less than `durationMs` before it), only the
 * latest one taking place and the latest skipped one are remembered, in
 * constant space. */
function collectBounded(
  rule: RRule,
  rangeStart: Date,
  rangeEnd: Date,
  durationMs: number,
  isSkipped: (date: Date) => boolean,
  /** Maps a date the rule produced to the instant it stands for. */
  fromRule: (date: Date) => Date
): { inProgress: { latest: Date | null; latestSkipped: Date | null }; inside: Date[] } {
  const inside: Date[] = [];
  const inProgress: { latest: Date | null; latestSkipped: Date | null } = {
    latest: null,
    latestSkipped: null,
  };
  const inProgressFrom = rangeStart.getTime() - durationMs;
  rule.all((ruleDate) => {
    const date = fromRule(ruleDate);
    if (date > rangeEnd) return false;
    if (date >= rangeStart) {
      inside.push(date);
    } else if (date.getTime() > inProgressFrom) {
      if (isSkipped(date)) inProgress.latestSkipped = date;
      else inProgress.latest = date;
    }
    return inside.length < MAX_OCCURRENCES_PER_EVENT;
  });
  return { inProgress, inside };
}

const WEEKDAY_NAMES: Record<Weekday, string> = {
  MO: "Monday",
  TU: "Tuesday",
  WE: "Wednesday",
  TH: "Thursday",
  FR: "Friday",
  SA: "Saturday",
  SU: "Sunday",
};
/** Indexed by `Date#getDay()`. */
const WEEKDAYS_FROM_SUNDAY: Weekday[] = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function monthName(month: number): string {
  return MONTH_NAMES[month - 1] ?? String(month);
}

function ordinal(n: number): string {
  if (n === -1) return "last";
  if (n < 0) return `${ordinal(-n)}-to-last`;
  const words = ["first", "second", "third", "fourth", "fifth"];
  const word = words[n - 1];
  if (word) return word;
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th";
  return `${n}${suffix}`;
}

function list(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** The calendar fields a monthly or yearly pattern sets. Choosing a
 * pattern replaces all of them, so none outlive the pattern they were part
 * of. */
const PATTERN_FIELDS = CALENDAR_KEYS;
type PatternFields = Pick<RecurrenceRule, (typeof PATTERN_FIELDS)[number]>;

export type PatternKind = "date" | "nth-weekday" | "last-weekday" | "last-day";

export interface RepeatPattern {
  key: PatternKind;
  label: string;
  fields: PatternFields;
}

/** The zone a rule's patterns are read in: its own, or else this
 * device's. A zone this runtime doesn't know (decrypted content is
 * untrusted) counts as none, as in expansion, rather than throwing. */
export function patternZone(rule: RecurrenceRule | undefined): string {
  return rule?.tzid && isValidTimeZone(rule.tzid) ? rule.tzid : Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * The ways a monthly or yearly series can repeat, derived from its start
 * as read on `timeZone`'s clock: on the same date, on the same weekday of
 * the month ("the third Tuesday"), on the last such weekday when the start
 * is in a month's final week, and on the last day when it is a month's
 * last. Offering choices derived from the start, rather than free-form day
 * and month pickers, keeps the start itself an occurrence of the series.
 *
 * Every pattern carries the zone, so "the first Monday" -- or "day 31" --
 * is read where it was set, for everyone who sees it. (In UTC, an evening
 * start west of Greenwich falls on the next day.)
 */
export function repeatPatterns(freq: RecurrenceRule["freq"], start: Date, timeZone: string): RepeatPattern[] {
  if (freq !== "MONTHLY" && freq !== "YEARLY") return [];
  const yearly = freq === "YEARLY";
  const wall = wallClockAsUtc(start, timeZone);
  const day = wall.getUTCDate();
  const month = wall.getUTCMonth() + 1;
  const daysInMonth = new Date(Date.UTC(wall.getUTCFullYear(), month, 0)).getUTCDate();
  const weekday = WEEKDAYS_FROM_SUNDAY[wall.getUTCDay()] ?? "MO";
  const nth = Math.ceil(day / 7);
  const ofMonth = yearly ? ` of ${monthName(month)}` : "";
  const inMonth: PatternFields = yearly ? { byMonth: [month] } : {};

  const patterns: RepeatPattern[] = [
    {
      key: "date",
      label: yearly
        ? `On ${monthName(month)} ${day}${month === 2 && day === 29 ? " (leap years only)" : ""}`
        : `On day ${day}${day > 28 ? " (skips months without one)" : ""}`,
      fields: { tzid: timeZone },
    },
  ];
  if (nth <= 4) {
    patterns.push({
      key: "nth-weekday",
      label: `On the ${ordinal(nth)} ${WEEKDAY_NAMES[weekday]}${ofMonth}`,
      fields: { ...inMonth, byDay: [weekday], bySetPos: [nth], tzid: timeZone },
    });
  }
  if (day > daysInMonth - 7) {
    patterns.push({
      key: "last-weekday",
      label: `On the last ${WEEKDAY_NAMES[weekday]}${ofMonth}`,
      fields: { ...inMonth, byDay: [weekday], bySetPos: [-1], tzid: timeZone },
    });
  }
  // Yearly, the last day of any month but February is a fixed date, the
  // same as the plain pattern.
  if (day === daysInMonth && (!yearly || month === 2)) {
    patterns.push({
      key: "last-day",
      label: `On the last day${ofMonth}`,
      fields: { ...inMonth, byMonthDay: [-1], tzid: timeZone },
    });
  }
  return patterns;
}

/** Whether `rule` uses exactly `pattern`'s calendar fields. */
export function usesPattern(rule: RecurrenceRule, pattern: RepeatPattern): boolean {
  return PATTERN_FIELDS.every(
    (field) => JSON.stringify(rule[field]) === JSON.stringify(pattern.fields[field])
  );
}

/** `rule` with its calendar fields replaced by `pattern`'s. */
export function withPattern(rule: RecurrenceRule, fields: PatternFields): RecurrenceRule {
  const next: RecurrenceRule = { ...rule };
  for (const field of PATTERN_FIELDS) delete next[field];
  return { ...next, ...fields };
}

/** What a kind of pattern becomes on a date that doesn't offer it. */
const FALLBACK: Record<PatternKind, PatternKind[]> = {
  date: [],
  "nth-weekday": ["last-weekday"],
  "last-weekday": ["nth-weekday"],
  "last-day": [],
};

/**
 * A monthly/yearly rule, carried over to a series that now starts at `to`
 * instead of `from`. The kind of pattern is kept: "the third Tuesday",
 * moved to a Wednesday, becomes "the third Wednesday", so the start stays
 * an occurrence of its own series (rrule doesn't produce a start that
 * doesn't match, so it would otherwise vanish). A kind the new date
 * doesn't offer becomes the nearest one that it does: the fifth Tuesday is
 * the last one; the last day, moved to the 12th, is the 12th.
 *
 * Returns the rule itself when nothing changes, including for rules that
 * match none of the offered patterns (written elsewhere): those are kept
 * as they are rather than guessed at.
 */
export function followStart(rule: RecurrenceRule, from: Date, to: Date): RecurrenceRule {
  if (rule.freq !== "MONTHLY" && rule.freq !== "YEARLY") return rule;
  const zone = patternZone(rule);
  const kind = repeatPatterns(rule.freq, from, zone).find((pattern) => usesPattern(rule, pattern))?.key;
  if (!kind) return rule;
  const options = repeatPatterns(rule.freq, to, zone);
  const next =
    [kind, ...FALLBACK[kind], "date"].map((key) => options.find((p) => p.key === key)).find(Boolean) ??
    options[0];
  return next && !usesPattern(rule, next) ? withPattern(rule, next.fields) : rule;
}

/** The calendar part of a monthly/yearly summary: "on the third Tuesday",
 * "on the last day of March". Empty when there is none. */
function describeCalendarPattern(recurrence: RecurrenceRule): string {
  const { byDay, byMonthDay, byMonth, bySetPos } = recurrence;
  const parts: string[] = [];
  const days = byDay?.map((d) => WEEKDAY_NAMES[d]) ?? [];
  if (bySetPos && byDay && !byMonthDay) {
    parts.push(`on the ${list(bySetPos.map(ordinal))} ${list(days)}`);
  } else {
    if (byMonthDay) {
      const named = byMonthDay.map((d) => (d === -1 ? "the last day" : d < 0 ? `the ${ordinal(d)} day` : `day ${d}`));
      parts.push(`on ${list(named)}`);
    }
    if (days.length > 0) parts.push(`${byMonthDay ? "if a" : "on"} ${list(days)}`);
    if (bySetPos) parts.push(`(${list(bySetPos.map(ordinal))} match)`);
  }
  if (byMonth) parts.push(`${parts.length > 0 ? "of" : "in"} ${list(byMonth.map(monthName))}`);
  return parts.join(" ");
}

/** Short human-readable summary of a recurrence rule, for display. */
export function describeRecurrence(recurrence: RecurrenceRule): string {
  const { freq, interval, byDay } = recurrence;
  const calendar = freq === "MONTHLY" || freq === "YEARLY";
  if (!calendar && byDay && byDay.length > 0) {
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
  const every = interval === 1 ? `Repeats every ${unitLabel}` : `Repeats every ${interval} ${unitLabel}`;
  const pattern = calendar ? describeCalendarPattern(recurrence) : "";
  const described = pattern ? `${every} ${pattern}` : every;
  return recurrence.until
    ? `${described} until ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(recurrence.until))}`
    : described;
}
