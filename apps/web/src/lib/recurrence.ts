import { RRule, Weekday as RRuleWeekday } from "rrule";
import {
  MAX_OCCURRENCE_OVERRIDES,
  RecurrenceRuleSchema,
  isValidTimeZone,
  type OccurrenceOverride,
  type RecurrenceRule,
  type Weekday,
} from "@schedule-app/shared";
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
  /** The start the series rule gives this occurrence, which identifies it
   * (iCalendar RECURRENCE-ID). Equal to `start` unless it was moved. Skips
   * and moves are recorded against this, not against `start`. */
  recurrenceId: Date;
  /** True when this occurrence was moved to other times (see
   * occurrenceOverrides). */
  moved: boolean;
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
 * occurrence can be skipped (skippedOccurrences) or moved to other times
 * (occurrenceOverrides). A moved occurrence is shown where it was moved
 * to, whether or not its original slot is in the window, and only while
 * the series still occurs at its original time: an override left behind
 * by a change to the series is ignored. A skip wins over a move.
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
/** What expansion reads from an event. */
export interface SeriesFields {
  startTime: string;
  /** Absent for open-ended events. */
  endTime?: string;
  recurrence?: RecurrenceRule;
  skippedOccurrences?: string[];
  occurrenceOverrides?: OccurrenceOverride[];
}

export function expandOccurrences(
  event: SeriesFields,
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
    if (!overlapsWindow(start, end, rangeStart, rangeEnd)) return [];
    return [{ start, end, skipped: isSkipped(start), recurrenceId: start, moved: false }].filter(keep);
  }

  // How long before the window an occurrence may start and still be in
  // progress at its start.
  const lookbackMs = durationMs !== null && durationMs > 0 ? durationMs : 0;

  const series = seriesRule(event.recurrence, start);
  if (!series) return [];
  const { recurrence, ruleOptions, toRule, fromRule } = series;

  const rule = new RRule({
    ...ruleOptions,
    // Start the rule near the window instead of at the series' real
    // beginning. Without this, viewing an hour of a minutely series that
    // began years ago walks every intervening occurrence -- measured at
    // over two minutes for a single expansion.
    dtstart: advancedStart(series.dtstart, recurrence, toRule(rangeStart), lookbackMs),
  });

  // Skipped occurrences stay where the rule puts them (so they can be
  // shown dimmed there), even if they were also moved.
  const moves = new Map([...usableOverrides(event.occurrenceOverrides)].filter(([id]) => !skipped.has(id)));
  const isMoved = (date: Date) => moves.has(date.getTime());

  const { inProgress, inside } = collectBounded(rule, rangeStart, rangeEnd, lookbackMs, isSkipped, isMoved, fromRule);
  const before = [inProgress.latest, options.includeSkipped ? inProgress.latestSkipped : null].filter(
    (d): d is Date => d !== null
  );

  const fromRuleOccurrences = [...before, ...inside].map((occurrenceStart) => ({
    start: occurrenceStart,
    end: durationMs === null ? null : new Date(occurrenceStart.getTime() + durationMs),
    skipped: isSkipped(occurrenceStart),
    recurrenceId: occurrenceStart,
    moved: false,
  }));

  const moved: Occurrence[] = [];
  for (const [id, move] of moves) {
    if (!overlapsWindow(move.start, move.end, rangeStart, rangeEnd)) continue;
    if (!seriesOccursAt(series, id, event.occurrenceOverrides)) continue;
    moved.push({ start: move.start, end: move.end, skipped: false, recurrenceId: new Date(id), moved: true });
  }

  return [...fromRuleOccurrences, ...moved]
    .filter(keep)
    .sort((a, b) => a.start.getTime() - b.start.getTime())
    .slice(0, MAX_OCCURRENCES_PER_EVENT);
}

/** Whether something from `start` to `end` belongs in the window: it
 * starts inside it, or is in progress at its start. Open-ended ones only
 * while starting inside, or every one that ever began would count. */
function overlapsWindow(start: Date, end: Date | null, rangeStart: Date, rangeEnd: Date): boolean {
  const startsInside = start >= rangeStart && start <= rangeEnd;
  const inProgress = start < rangeStart && end !== null && end > rangeStart;
  return startsInside || inProgress;
}

/** A series' rule, ready to run. */
interface SeriesRule {
  recurrence: RecurrenceRule;
  ruleOptions: Partial<ConstructorParameters<typeof RRule>[0]>;
  /** The series' start, as the rule sees it. */
  dtstart: Date;
  /** Maps an instant to the rule's clock, and back. */
  toRule: (date: Date) => Date;
  fromRule: (date: Date) => Date;
}

/** The rule for a series starting at `start`, or null when it never
 * occurs. */
function seriesRule(rule: RecurrenceRule, start: Date): SeriesRule | null {
  const recurrence = usableRule(rule);
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
  const dtstart = toRule(start);
  if (!everOccurs(ruleOptions, dtstart)) return null;
  return { recurrence, ruleOptions, dtstart, toRule, fromRule };
}

/** An override's times, parsed. */
interface Move {
  start: Date;
  end: Date | null;
  override: OccurrenceOverride;
}

/** The overrides that can be read, keyed by the occurrence they move: at
 * most MAX_OCCURRENCE_OVERRIDES, with readable times that end after they
 * start. Decrypted content isn't schema-checked, so it is checked here
 * instead of trusted. The first override of an occurrence wins. */
function usableOverrides(overrides: OccurrenceOverride[] | undefined): Map<number, Move> {
  const moves = new Map<number, Move>();
  if (!Array.isArray(overrides)) return moves;
  for (const override of overrides.slice(0, MAX_OCCURRENCE_OVERRIDES)) {
    if (typeof override !== "object" || override === null) continue;
    const id = new Date(override.occurrence).getTime();
    const start = new Date(override.startTime);
    const end = override.endTime === undefined ? null : new Date(override.endTime);
    if (Number.isNaN(id) || Number.isNaN(start.getTime())) continue;
    if (end !== null && !(end > start)) continue;
    if (moves.has(id)) continue;
    moves.set(id, { start, end, override });
  }
  return moves;
}

/** The overrides that move an occurrence the series actually has: those
 * expansion applies (a skip aside). Readable ones that a change to the
 * series has left behind, and unreadable ones, are left out. */
export function activeOverrides(event: SeriesFields): OccurrenceOverride[] {
  if (!event.recurrence) return [];
  const series = seriesRule(event.recurrence, new Date(event.startTime));
  if (!series) return [];
  return [...usableOverrides(event.occurrenceOverrides)]
    .filter(([id]) => seriesOccursAt(series, id, event.occurrenceOverrides))
    .map(([, move]) => move.override);
}

/** Whether the series occurs at exactly `at` (ms). Asked on every pan
 * frame for each moved occurrence in view, so the answers are remembered
 * alongside the overrides list they were asked for, for as long as the
 * series' rule and start stay the same. The walk starts a period before
 * `at` where the frequency allows (see advancedStart), as expansion's
 * does. */
const occursAtCache = new WeakMap<object, { key: string; known: Map<number, boolean> }>();

function seriesOccursAt(series: SeriesRule, at: number, cacheOwner: object | undefined): boolean {
  const { ruleOptions, dtstart, recurrence, toRule, fromRule } = series;
  // The zone is part of the key: dtstart is a wall-clock reading, the same
  // for 09:00 in any zone.
  const key = JSON.stringify([ruleOptions, dtstart.toISOString(), recurrence.tzid ?? null]);
  let entry = cacheOwner ? occursAtCache.get(cacheOwner) : undefined;
  if (!entry || entry.key !== key) {
    entry = { key, known: new Map() };
    if (cacheOwner) occursAtCache.set(cacheOwner, entry);
  }
  const cached = entry.known.get(at);
  if (cached !== undefined) return cached;
  let found = false;
  if (at >= fromRule(dtstart).getTime()) {
    const target = new Date(at);
    new RRule({ ...ruleOptions, dtstart: advancedStart(dtstart, recurrence, toRule(target), 0) }).all((ruleDate) => {
      const time = fromRule(ruleDate).getTime();
      if (time === at) found = true;
      return time < at;
    });
  }
  entry.known.set(at, found);
  return found;
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

/** How many occurrences a monthly or yearly series is walked, from its
 * start, to find which month or year a skip or move falls in and which of
 * that period's occurrences it is (see exceptionsFollowingStart):
 * centuries of any pattern the editor offers. Exceptions further out are
 * left where they are. */
export const MAX_CALENDAR_WALK = 10_000;

const DAY_MS = 86_400_000;

type Exceptions = Pick<SeriesFields, "skippedOccurrences" | "occurrenceOverrides">;

/**
 * A series' skips and moves, carried along when its start moves to
 * `startTime`, so a skipped or moved occurrence stays skipped or moved.
 * Returns only the fields that change.
 *
 * `recurrence` is the series' rule after the move. It must be the rule as
 * it was, or -- for a monthly or yearly series -- its pattern following
 * the start (see followStart: "the third Tuesday", moved a day, becomes
 * "the third Wednesday"; see followsStart). If the rule was changed in
 * any other way, nothing is changed: which occurrence each exception
 * meant is then a guess.
 *
 * Where each exception goes, all on the rule's own (wall) clock:
 * - A fixed-length repeat with no day filter: moved by as much as the
 *   start. Exact, also across a change of clocks.
 * - A repeat on chosen weekdays: moved by the whole weeks the start moved
 *   plus the change in its time of day. The weekdays are the rule's, not
 *   the start's, so moving Monday's start to Tuesday leaves Wednesday's
 *   skip on Wednesday. Every few weeks, by the calendar weeks between the
 *   starts, which decide which weeks it falls in.
 * - Monthly and yearly: to the same occurrence (see Slot) of the
 *   corresponding month or year -- September's third Tuesday to September's third Wednesday,
 *   the 31st of May to the 30th of May. Moving the start into another
 *   month moves them by as many months.
 *
 * A moved occurrence keeps the time of day it was moved to and follows its
 * occurrence by whole days. Exceptions that can't be placed -- not an
 * occurrence of the series, no counterpart in the moved one, or further
 * out than MAX_CALENDAR_WALK -- are left exactly as they are, so the
 * times someone chose aren't lost; unless the moved series has an
 * occurrence there, which they would wrongly start to apply to. Then
 * they are dropped.
 */
export function exceptionsFollowingStart(
  event: SeriesFields,
  startTime: string,
  recurrence: RecurrenceRule | undefined = event.recurrence
): Exceptions {
  const rule = event.recurrence;
  if (!rule || !recurrence) return {};
  const from = new Date(event.startTime);
  const to = new Date(startTime);
  const delta = to.getTime() - from.getTime();
  if (!delta || Number.isNaN(delta)) return {};
  if (!followsStart(rule, from, recurrence, to)) return {};

  const skips = Array.isArray(event.skippedOccurrences) ? event.skippedOccurrences : [];
  const overrides = Array.isArray(event.occurrenceOverrides) ? event.occurrenceOverrides : [];
  if (skips.length === 0 && overrides.length === 0) return {};

  const oldSeries = seriesRule(rule, from);
  const newSeries = seriesRule(recurrence, to);
  if (!oldSeries || !newSeries) return {};
  const ids = [...skips, ...overrides.map((o) => (typeof o === "object" && o !== null ? o.occurrence : ""))];
  const { place, occurs } = placement(oldSeries, newSeries, ids, event);

  // One that can't be placed stays, unless it would now apply to some
  // other occurrence of the moved series.
  const misplaced = (iso: string) => {
    const time = new Date(iso).getTime();
    return !Number.isNaN(time) && occurs(time);
  };
  const changes: Exceptions = {};
  if (skips.length > 0) {
    changes.skippedOccurrences = skips.flatMap((iso) => {
      const target = place(iso);
      if (target === undefined) return misplaced(iso) ? [] : [iso];
      return [new Date(target).toISOString()];
    });
  }
  if (overrides.length > 0) {
    changes.occurrenceOverrides = overrides.flatMap((o) => {
      if (typeof o !== "object" || o === null) return [o];
      const target = place(o.occurrence);
      if (target === undefined) return misplaced(o.occurrence) ? [] : [o];
      // Whole days the occurrence moved, rounded: a series nudged across
      // midnight hasn't moved its occurrences a day.
      const wallMove = newSeries.toRule(new Date(target)).getTime() - oldSeries.toRule(new Date(o.occurrence)).getTime();
      const days = Math.round(wallMove / DAY_MS);
      const moved: OccurrenceOverride = { ...o, occurrence: new Date(target).toISOString() };
      if (days) {
        moved.startTime = shiftWallDays(newSeries, o.startTime, days);
        if (o.endTime !== undefined) moved.endTime = shiftWallDays(newSeries, o.endTime, days);
      }
      return [moved];
    });
  }
  return changes;
}

/** Whether `after` is `before` carried from a start at `from` to one at
 * `to`: the same rule, or a monthly/yearly one whose pattern followed the
 * start -- to the same kind ("the third Tuesday" to "the third
 * Wednesday") or one followStart falls back to. Checked by kind rather
 * than against a single followStart so that the editor, which follows the
 * start one edit at a time (its fallbacks depend on the route), agrees; a
 * pattern deliberately changed to another kind is not carried over. */
function followsStart(before: RecurrenceRule, from: Date, after: RecurrenceRule, to: Date): boolean {
  if (JSON.stringify(before) === JSON.stringify(after)) return true;
  if (JSON.stringify(followStart(before, from, to)) === JSON.stringify(after)) return true;
  if (after.freq !== "MONTHLY" && after.freq !== "YEARLY") return false;
  const rest = (rule: RecurrenceRule) => {
    const copy: Partial<RecurrenceRule> = { ...rule };
    for (const key of CALENDAR_KEYS) delete copy[key];
    return JSON.stringify(copy);
  };
  if (rest(before) !== rest(after)) return false;
  const kind = repeatPatterns(before.freq, from, patternZone(before)).find((p) => usesPattern(before, p))?.key;
  if (!kind) return false;
  const next = repeatPatterns(after.freq, to, patternZone(after)).find((p) => usesPattern(after, p))?.key;
  return next !== undefined && [kind, ...FALLBACK[kind]].includes(next);
}

/** `iso` moved by `days` on the series' clock, keeping its time of day.
 * Unreadable times are left as they are. */
function shiftWallDays(series: SeriesRule, iso: string, days: number): string {
  const time = new Date(iso);
  if (Number.isNaN(time.getTime())) return iso;
  return series.fromRule(new Date(series.toRule(time).getTime() + days * DAY_MS)).toISOString();
}

/** Largest of `values`, without spreading them into arguments (lists
 * come from decrypted content and are unbounded). */
function maxOf(values: Iterable<number>): number {
  let max = -Infinity;
  for (const value of values) if (value > max) max = value;
  return max;
}

/** The ids that are readable and survive the round trip to the series'
 * clock and back, keyed by their reading on that clock. One that doesn't
 * survive (the second pass of a repeated hour) is never an occurrence.
 * Comparing on the rule's clock means only hits need converting back
 * through `Intl`, which costs several times the walk itself. */
function onRuleClock(series: SeriesRule, ids: Iterable<string>): Map<number, number> {
  const byRuleTime = new Map<number, number>();
  for (const iso of ids) {
    const time = new Date(iso).getTime();
    if (Number.isNaN(time)) continue;
    const ruleTime = series.toRule(new Date(time));
    if (series.fromRule(ruleTime).getTime() === time) byRuleTime.set(ruleTime.getTime(), time);
  }
  return byRuleTime;
}

/** Which of a period's occurrences one is: counted from the period's
 * start, except in the series' first period, which its start may cut
 * short; there, counted back from the period's end (-1 = the last). That
 * way the first periods of two series starting on different days still
 * line up ("the 15th" is the last of January's 1st-and-15th either way). */
interface Slot {
  period: number;
  rank: number;
}

/** Walks a monthly/yearly series from its start, handing each occurrence
 * (on the rule's clock) and its slot to `visit`, until `stop` says so or
 * MAX_CALENDAR_WALK occurrences have been seen. The first period is
 * always walked to its end, so its ranks can be counted back. */
function walkSlots(
  series: SeriesRule,
  period: (wall: number) => number,
  stop: (ruleTime: number, period: number) => boolean,
  visit: (ruleDate: Date, slot: Slot) => void
): void {
  let first: Date[] = [];
  let firstPeriod = Number.NaN;
  let current = Number.NaN;
  let rank = 0;
  let walked = 0;
  const flush = () => {
    first.forEach((date, i) => visit(date, { period: firstPeriod, rank: i - first.length }));
    first = [];
  };
  new RRule({ ...series.ruleOptions, dtstart: series.dtstart }).all((ruleDate) => {
    const ruleTime = ruleDate.getTime();
    const p = period(ruleTime);
    if (Number.isNaN(firstPeriod)) firstPeriod = p;
    if (p === firstPeriod) {
      first.push(ruleDate);
      return ++walked < MAX_CALENDAR_WALK;
    }
    flush();
    if (stop(ruleTime, p)) return false;
    rank = p === current ? rank + 1 : 0;
    current = p;
    visit(ruleDate, { period: p, rank });
    return ++walked < MAX_CALENDAR_WALK;
  });
  flush();
}

/** Where each exception goes (see exceptionsFollowingStart): `place`
 * maps an id to its new instant, or undefined to leave it; `occurs` says
 * whether the new series has an occurrence at an id `place` left. */
function placement(
  oldSeries: SeriesRule,
  newSeries: SeriesRule,
  ids: string[],
  cacheOwner: object
): { place: (iso: string) => number | undefined; occurs: (time: number) => boolean } {
  const { recurrence } = newSeries;
  const fromWall = oldSeries.dtstart.getTime();
  const toWall = newSeries.dtstart.getTime();
  const leave = { place: () => undefined, occurs: () => false };

  if (recurrence.freq !== "MONTHLY" && recurrence.freq !== "YEARLY") {
    // Calendar filters on a faster rule wouldn't move with the start, but
    // the usable rule never has them (the schema allows them only on
    // monthly and yearly rules); kept as a guard. Nor does a day-filtered
    // rule's phase when it repeats every few days. Both left alone.
    if (recurrence.byMonthDay !== undefined || recurrence.byMonth !== undefined || recurrence.bySetPos !== undefined) {
      return leave;
    }
    let shift = toWall - fromWall;
    if (recurrence.byDay?.length) {
      if (recurrence.freq !== "WEEKLY" && recurrence.interval > 1) return leave;
      const fromDay = Math.floor(fromWall / DAY_MS);
      const toDay = Math.floor(toWall / DAY_MS);
      // Whole weeks, plus the change in time of day. Every few weeks, the
      // calendar weeks (from Monday, rrule's default) between the starts,
      // since those decide which weeks the series falls in.
      const mondayWeek = (day: number) => Math.floor((day + 3) / 7); // 1970-01-01 was a Thursday.
      const weeks =
        recurrence.interval > 1 ? mondayWeek(toDay) - mondayWeek(fromDay) : Math.trunc((toDay - fromDay) / 7);
      shift = weeks * 7 * DAY_MS + (toWall - toDay * DAY_MS) - (fromWall - fromDay * DAY_MS);
    }
    // Every readable id is placed, so `occurs` is never asked.
    const place = (iso: string) => {
      const time = new Date(iso).getTime();
      if (Number.isNaN(time)) return undefined;
      return newSeries.fromRule(new Date(oldSeries.toRule(new Date(time)).getTime() + shift)).getTime();
    };
    return { place, occurs: () => false };
  }

  const yearly = recurrence.freq === "YEARLY";
  const period = (wall: number) => {
    const date = new Date(wall);
    return yearly ? date.getUTCFullYear() : date.getUTCFullYear() * 12 + date.getUTCMonth();
  };
  const periodShift = period(toWall) - period(fromWall);
  const old = calendarSlots(oldSeries, ids, period, cacheOwner);

  // The new series' occurrences wanted, by period and rank.
  const wanted = new Set<string>();
  const wantedPeriods: number[] = [];
  for (const { period: p, rank } of old.values()) {
    wanted.add(`${p + periodShift}:${rank}`);
    wantedPeriods.push(p + periodShift);
  }
  // Any id may go unplaced (its period may have no counterpart), so the
  // walk also notes which of them the new series occurs at. It must reach
  // the ones the old series doesn't have; those it has lie in periods no
  // later than their targets unless the start moved earlier.
  const unplaced = onRuleClock(newSeries, ids);
  const lastPeriod = maxOf(wantedPeriods);
  const lastUnplaced = maxOf(
    [...unplaced].filter(([, time]) => periodShift < 0 || !old.has(time)).map(([ruleTime]) => ruleTime)
  );

  // One walk answers both.
  const found = new Map<string, number>();
  const occurring = new Set<number>();
  walkSlots(
    newSeries,
    period,
    (ruleTime, p) => p > lastPeriod && ruleTime > lastUnplaced,
    (ruleDate, slot) => {
      const key = `${slot.period}:${slot.rank}`;
      if (wanted.has(key)) found.set(key, newSeries.fromRule(ruleDate).getTime());
      if (unplaced.has(ruleDate.getTime())) occurring.add(ruleDate.getTime());
    }
  );
  const place = (iso: string) => {
    const slot = old.get(new Date(iso).getTime());
    return slot ? found.get(`${slot.period + periodShift}:${slot.rank}`) : undefined;
  };
  // Past the walk, an id is assumed not to be an occurrence: kept.
  const occurs = (time: number) => occurring.has(newSeries.toRule(new Date(time)).getTime());
  return { place, occurs };
}

/** The slot (see Slot) of each id that is an occurrence of the series
 * within MAX_CALENDAR_WALK. Remembered per event for as long as its rule,
 * start and exceptions stay the same: a drag asks on every frame, for the
 * same saved event. */
const calendarSlotsCache = new WeakMap<object, { key: string; value: Map<number, Slot> }>();

function calendarSlots(
  series: SeriesRule,
  ids: string[],
  period: (wall: number) => number,
  cacheOwner: object
): Map<number, Slot> {
  const key = JSON.stringify([series.ruleOptions, series.dtstart.toISOString(), series.recurrence.tzid ?? null, ids]);
  const cached = calendarSlotsCache.get(cacheOwner);
  if (cached?.key === key) return cached.value;
  const value = new Map<number, Slot>();
  calendarSlotsCache.set(cacheOwner, { key, value });

  const byRuleTime = onRuleClock(series, ids);
  if (byRuleTime.size === 0) return value;
  const last = maxOf(byRuleTime.keys());
  walkSlots(
    series,
    period,
    (ruleTime) => ruleTime > last,
    (ruleDate, slot) => {
      const id = byRuleTime.get(ruleDate.getTime());
      if (id !== undefined) value.set(id, slot);
    }
  );
  return value;
}

/** The override moving the occurrence the series rule starts at
 * `occurrence`, if any. */
export function findOverride(
  overrides: OccurrenceOverride[] | undefined,
  occurrence: Date
): OccurrenceOverride | undefined {
  return overrides?.find((o) => new Date(o.occurrence).getTime() === occurrence.getTime());
}

/** Moves one occurrence to `times`, replacing any earlier move of it. */
export function withOverride(
  overrides: OccurrenceOverride[] | undefined,
  occurrence: Date,
  times: { startTime: string; endTime?: string }
): OccurrenceOverride[] {
  const override: OccurrenceOverride = { occurrence: occurrence.toISOString(), startTime: times.startTime };
  if (times.endTime !== undefined) override.endTime = times.endTime;
  return [...withoutOverride(overrides, occurrence), override];
}

/** Puts a moved occurrence back where the series has it. */
export function withoutOverride(
  overrides: OccurrenceOverride[] | undefined,
  occurrence: Date
): OccurrenceOverride[] {
  return (overrides ?? []).filter((o) => new Date(o.occurrence).getTime() !== occurrence.getTime());
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
  DAILY: DAY_MS,
  WEEKLY: 7 * DAY_MS,
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
  /** Moved occurrences are left out entirely: they are shown where they
   * were moved to, so they neither appear here nor count as in progress. */
  isMoved: (date: Date) => boolean,
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
    if (isMoved(date)) return true;
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
