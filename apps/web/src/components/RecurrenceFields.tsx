import { useState } from "react";
import type { RecurrenceRule } from "@schedule-app/shared";

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
}

/**
 * The repeat editor, shared by the create form and the edit panel so both
 * offer exactly the same options. A single toggle reveals the interval,
 * unit and optional end date; turning it off clears the rule.
 *
 * Fields this editor doesn't expose (`byDay`, `count`) are carried through
 * untouched, so editing the interval of an existing "every weekday" rule
 * doesn't silently drop its weekdays.
 */
export function RecurrenceFields({ value, onChange }: RecurrenceFieldsProps) {
  const enabled = value !== undefined;

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
            <select
              value={value.freq}
              onChange={(e) => onChange({ ...value, freq: e.target.value as Unit })}
              aria-label="Repeat unit"
            >
              {UNITS.map((unit) => (
                <option key={unit.value} value={unit.value}>
                  {unit.label}
                </option>
              ))}
            </select>
          </label>
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
