import { z } from "zod";

/**
 * EncryptedEnvelope is the ONLY shape in which user content (event titles,
 * descriptions, times, locations, etc.) ever leaves the client or is stored
 * server-side. The server persists and relays these opaquely; it never has
 * the key required to open them.
 */
export const EncryptedEnvelopeSchema = z.object({
  v: z.literal(1), // envelope format version, for future crypto migration
  algo: z.literal("xchacha20poly1305"),
  keyId: z.string().min(1).max(64), // identifies which key (user key or event key) encrypted this
  nonce: z.string().min(1).max(128), // base64
  // Bounded so a client can't store arbitrarily large blobs. 128KB of
  // base64 is far beyond any realistic event's encrypted content while
  // keeping worst-case row size and response size predictable.
  ciphertext: z.string().min(1).max(128 * 1024), // base64
});
export type EncryptedEnvelope = z.infer<typeof EncryptedEnvelopeSchema>;

/**
 * A recurrence rule, modeled after the widely-used iCalendar RRULE
 * subset (FREQ/INTERVAL/BYDAY/BYMONTHDAY/BYMONTH/BYSETPOS/COUNT/UNTIL)
 * rather than a bespoke format, so arbitrary intervals ("every 37
 * minutes"), "every weekday" (BYDAY=MO,TU,WE,TH,FR) and "the first Monday
 * of every month" (FREQ=MONTHLY;BYDAY=MO;BYSETPOS=1) are all expressible
 * with one well-understood shape. Expansion into actual occurrences happens
 * client-side (see apps/web/src/lib/recurrence.ts) using the `rrule`
 * library; the server never interprets this -- it's just more content
 * inside the EncryptedEnvelope.
 */
export const RecurrenceFrequencySchema = z.enum([
  "MINUTELY",
  "HOURLY",
  "DAILY",
  "WEEKLY",
  "MONTHLY",
  "YEARLY",
]);
export type RecurrenceFrequency = z.infer<typeof RecurrenceFrequencySchema>;

export const WeekdaySchema = z.enum(["MO", "TU", "WE", "TH", "FR", "SA", "SU"]);
export type Weekday = z.infer<typeof WeekdaySchema>;

/** Frequencies whose repeats are calendar months or years. Only these
 * take the calendar parts below (`byMonthDay`, `byMonth`, `bySetPos`). */
const CALENDAR_FREQUENCIES: ReadonlySet<RecurrenceFrequency> = new Set(["MONTHLY", "YEARLY"]);

/** Longest each month can be, leap years included (index 0 = January). */
const MAX_DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

const nonZeroInt = (min: number, max: number) =>
  z
    .number()
    .int()
    .min(min)
    .max(max)
    .refine((n) => n !== 0, "must not be 0");

/** True when `timeZone` names an IANA zone this runtime knows. */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

export const RecurrenceRuleSchema = z
  .object({
    freq: RecurrenceFrequencySchema,
    interval: z.number().int().positive().default(1), // e.g. every 37 minutes -> freq MINUTELY, interval 37
    byDay: z.array(WeekdaySchema).max(7).optional(), // e.g. every weekday -> [MO,TU,WE,TH,FR]
    /** Days of the month; negative counts from the end (-1 = last day).
     * BYMONTHDAY. Monthly and yearly rules only. */
    byMonthDay: z.array(nonZeroInt(-31, 31)).min(1).max(31).optional(),
    /** Months of the year, 1 = January. BYMONTH. Monthly and yearly rules
     * only. */
    byMonth: z.array(z.number().int().min(1).max(12)).min(1).max(12).optional(),
    /** Which of each month's (or year's) matching days to keep: with
     * byDay [MO], 1 = first Monday, -1 = last. BYSETPOS. Monthly and
     * yearly rules only, and only together with byDay or byMonthDay. */
    bySetPos: z.array(nonZeroInt(-366, 366)).min(1).max(10).optional(),
    /** IANA zone the rule is evaluated in ("first Monday" depends on where
     * you are: 08:00 on a Monday in Sydney is a Sunday in UTC). Without it
     * the rule is evaluated in UTC, as rules always were. */
    tzid: z.string().min(1).max(64).refine(isValidTimeZone, "unknown time zone").optional(),
    count: z.number().int().positive().optional(), // stop after N occurrences
    until: z.string().datetime().optional(), // stop after this date (mutually used with count, not both)
  })
  .superRefine((rule, ctx) => {
    const calendar = CALENDAR_FREQUENCIES.has(rule.freq);
    for (const part of ["byMonthDay", "byMonth", "bySetPos"] as const) {
      if (rule[part] !== undefined && !calendar) {
        ctx.addIssue({ code: "custom", path: [part], message: `${part} needs a monthly or yearly rule` });
      }
    }
    if (rule.bySetPos !== undefined && rule.byDay === undefined && rule.byMonthDay === undefined) {
      ctx.addIssue({ code: "custom", path: ["bySetPos"], message: "bySetPos needs byDay or byMonthDay" });
    }
    // A day no allowed month has (February 30th) would never occur, and
    // expanding a rule that never matches walks to the year 9999.
    if (rule.byMonthDay !== undefined) {
      const longest = rule.byMonth ? Math.max(...rule.byMonth.map((m) => MAX_DAYS_IN_MONTH[m - 1] ?? 31)) : 31;
      rule.byMonthDay.forEach((day, i) => {
        if (Math.abs(day) > longest) {
          ctx.addIssue({ code: "custom", path: ["byMonthDay", i], message: "that day never occurs in these months" });
        }
      });
    }
  });
export type RecurrenceRule = z.infer<typeof RecurrenceRuleSchema>;

/**
 * The plaintext shape of an event, as it exists only on the client after
 * decryption. This is what gets encrypted into an EncryptedEnvelope before
 * ever touching the network.
 */
export const EventContentSchema = z
  .object({
    title: z.string().min(1).max(500),
    description: z.string().max(10_000).optional(),
    location: z.string().max(500).optional(),
    startTime: z.string().datetime(),
    /** Optional: an event may be open-ended. On the timeline these extend
     * to the edge of the view and fade toward the future rather than
     * claiming a definite finish. */
    endTime: z.string().datetime().optional(),
    /** Fractional ordering rank. Determines how far from the timeline's
     * base an event stacks when it overlaps others. Unique per event, so
     * stacking order is never ambiguous. Optional so events created
     * before fractional ordering still parse; the timeline assigns one at
     * render time until the event is next saved. */
    rank: z.string().min(1).optional(),
    /** Importance is deliberately separate from rank: it changes styling
     * only, never position. Folding it into the sort key would reintroduce
     * ties inside each importance group. */
    important: z.boolean().optional(),
    recurrence: RecurrenceRuleSchema.optional(),
    /** Occurrences of a recurring series that have been skipped, by their
     * start time. This is the iCalendar EXDATE concept: the series rule is
     * unchanged and no extra rows are created -- specific occurrences are
     * simply excluded when the rule is expanded.
     *
     * It lives inside the encrypted envelope, so everyone holding the
     * event's key sees the same exceptions. A view-level override would be
     * cheaper but would let two people disagree about when a shared
     * meeting is. */
    skippedOccurrences: z.array(z.string().datetime()).optional(),
  })
  .refine(
    // Only meaningful when an end exists; an open-ended event cannot end
    // before it starts.
    (event) => event.endTime === undefined || new Date(event.endTime) > new Date(event.startTime),
    {
      message: "endTime must be after startTime",
      path: ["endTime"],
    }
  );
export type EventContent = z.infer<typeof EventContentSchema>;

/**
 * An envelope sealed to one recipient's X25519 public key with a fresh
 * ephemeral keypair (see packages/crypto's sealToRecipient). `epk` is the
 * ephemeral public key: needed to open the envelope, and linked to no
 * account, so the server relaying it learns nothing about the sender.
 * Used for inbox delivery, where the server deliberately records no sender.
 */
export const SealedEnvelopeSchema = EncryptedEnvelopeSchema.extend({
  epk: z.string().min(1).max(64),
});
export type SealedEnvelope = z.infer<typeof SealedEnvelopeSchema>;

/**
 * The keyring is one envelope holding every capability an account has, so
 * it outgrows the per-event ciphertext cap. 1MB of base64 comfortably fits
 * the 500-event batch-read limit with room to spare.
 */
export const KeyringEnvelopeSchema = EncryptedEnvelopeSchema.extend({
  ciphertext: z.string().min(1).max(1024 * 1024),
});
