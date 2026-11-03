import { useEffect, useRef, useState } from "react";
import type { RecurrenceRule } from "@schedule-app/shared";
import { describeRecurrence, followStart, patternZone, repeatPatterns, usesPattern, withPattern } from "../lib/recurrence.js";

type Unit = RecurrenceRule["freq"];

const UNITS: { value: Unit; label: string }[] = [
  { value: "MINUTELY", label: "Minutes" },
  { value: "HOURLY", label: "Hours" },
  { value: "DAILY", label: "Days" },
  { value: "WEEKLY", label: "Weeks" },
  { value: "MONTHLY", label: "Months" },
  { value: "YEARLY", label: "Years" },
];

/** "Repeat until" is picked as a date; the series runs through the end of
 * that day, local time. */
function untilFromDate(date: string): string | undefined {
  return date ? new Date(`${date}T23:59:59`).toISOString() : undefined;
}

function dateFromUntil(until: string | undefined): string {
  if (!until) return "";
  const d = new Date(until);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * The interval as typed. Kept as a draft string so the field can be
 * emptied while typing a new number; clamping on every keystroke made
 * "clear, type 2" produce 12.
 */
function IntervalInput({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  return (
    <input
      type="number"
      min={1}
      value={draft}
      onChange={(e) => {
        setDraft(e.target.value);
        const parsed = Math.floor(Number(e.target.value));
        if (parsed >= 1) onChange(parsed);
      }}
      // Leaving the field empty or invalid falls back to the last good value.
      onBlur={() => setDraft(String(value))}
      aria-label="Repeat interval"
    />
  );
}

interface RecurrenceFieldsProps {
  value: RecurrenceRule | undefined;
  onChange: (value: RecurrenceRule | undefined) => void;
  /** The event's start, which the monthly/yearly choices are derived
   * from ("the third Tuesday"). Null while the start field is unusable. */
  start: Date | null;
}

const CALENDAR_UNITS: ReadonlySet<Unit> = new Set(["MONTHLY", "YEARLY"]);

/**
 * The repeat editor, shared by the create form and the edit panel so both
 * offer exactly the same options. A single toggle reveals the interval,
 * unit and optional end date; turning it off clears the rule. Monthly and
 * yearly repeats also choose a pattern derived from the start: the same
 * date, "the third Tuesday", "the last Friday", "the last day".
 *
 * Fields this editor doesn't expose (`byDay` on other units, `count`) are
 * carried through untouched, so editing the interval of an existing "every
 * weekday" rule doesn't silently drop its weekdays. Changing the unit to or
 * from monthly/yearly does reset the pattern: "the third Tuesday" means
 * nothing weekly, and a weekly rule's weekdays would read as "every
 * Tuesday of the month".
 */
export function RecurrenceFields({ value, onChange, start }: RecurrenceFieldsProps) {
  const enabled = value !== undefined;
  // Read in the rule's own zone: editing someone else's "first Monday"
  // from another time zone still means their Monday.
  const patterns = value && start ? repeatPatterns(value.freq, start, patternZone(value)) : [];
  const chosen = value ? patterns.find((pattern) => usesPattern(value, pattern)) : undefined;

  // Moving the start keeps the kind of pattern (see followStart). Only a
  // usable start is remembered, so passing through an empty field on the
  // way to a new date still carries the pattern over.
  const latest = useRef({ value, onChange, start });
  latest.current = { value, onChange, start };
  const previousStart = useRef(start);
  const startMs = start?.getTime() ?? null;
  useEffect(() => {
    const { value: rule, onChange: change, start: now } = latest.current;
    if (!now) return;
    const before = previousStart.current;
    previousStart.current = now;
    if (!rule || !before) return;
    const next = followStart(rule, before, now);
    if (next !== rule) change(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startMs]);

  function changeUnit(freq: Unit) {
    if (!value || freq === value.freq) return;
    if (!CALENDAR_UNITS.has(freq) && !CALENDAR_UNITS.has(value.freq)) {
      onChange({ ...value, freq });
      return;
    }
    // A new monthly/yearly rule starts on the same date, read in this
    // device's zone (the date pattern needs no start to build).
    const fields = CALENDAR_UNITS.has(freq) ? { tzid: patternZone(undefined) } : {};
    onChange({ ...withPattern(value, fields), freq });
  }

  return (
    <div className="recurrence-fields">
      <button
        type="button"
        className="repeat-toggle"
        aria-expanded={enabled}
        onClick={() => onChange(enabled ? undefined : { freq: "DAILY", interval: 1 })}
      >
        {enabled ? "Repeating ▾" : "Repeat ▸"}
      </button>

      {value && (
        <div className="event-form-row repeat-panel">
          <label className="inline-label">
            Every
            <IntervalInput value={value.interval} onChange={(interval) => onChange({ ...value, interval })} />
          </label>
          <label className="inline-label">
            Unit
            <select value={value.freq} onChange={(e) => changeUnit(e.target.value as Unit)} aria-label="Repeat unit">
              {UNITS.map((unit) => (
                <option key={unit.value} value={unit.value}>
                  {unit.label}
                </option>
              ))}
            </select>
          </label>
          {patterns.length > 0 && (
            <label className="inline-label repeat-on">
              On
              <select
                value={chosen?.key ?? "current"}
                onChange={(e) => {
                  const pattern = patterns.find((p) => p.key === e.target.value);
                  if (pattern) onChange(withPattern(value, pattern.fields));
                }}
                aria-label="Repeat on"
              >
                {/* A rule from elsewhere (another client, or an older
                    start) that matches no offered pattern stays as it is
                    until another is picked. */}
                {!chosen && <option value="current">{describeRecurrence(value)}</option>}
                {patterns.map((pattern) => (
                  <option key={pattern.key} value={pattern.key}>
                    {pattern.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="inline-label">
            Until <span className="field-hint">(optional)</span>
            <input
              type="date"
              value={dateFromUntil(value.until)}
              onChange={(e) => onChange({ ...value, until: untilFromDate(e.target.value) })}
              aria-label="Repeat until"
            />
          </label>
        </div>
      )}
    </div>
  );
}
