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
 * subset (FREQ/INTERVAL/BYDAY/COUNT/UNTIL) rather than a bespoke format,
 * so arbitrary intervals ("every 37 minutes"), daily/weekly repeats, and
 * "every weekday" (BYDAY=MO,TU,WE,TH,FR) are all expressible with one
 * well-understood shape. Expansion into actual occurrences happens
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

export const RecurrenceRuleSchema = z.object({
  freq: RecurrenceFrequencySchema,
  interval: z.number().int().positive().default(1), // e.g. every 37 minutes -> freq MINUTELY, interval 37
  byDay: z.array(WeekdaySchema).optional(), // e.g. every weekday -> [MO,TU,WE,TH,FR]
  count: z.number().int().positive().optional(), // stop after N occurrences
  until: z.string().datetime().optional(), // stop after this date (mutually used with count, not both)
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
