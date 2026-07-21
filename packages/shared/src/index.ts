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
  keyId: z.string().min(1), // identifies which key (user key or event key) encrypted this
  nonce: z.string().min(1), // base64
  ciphertext: z.string().min(1), // base64
});
export type EncryptedEnvelope = z.infer<typeof EncryptedEnvelopeSchema>;

/**
 * Public account record. Only public-key material and non-sensitive
 * bookkeeping fields live here; everything else about a user's schedule
 * is stored as EncryptedEnvelope blobs elsewhere.
 */
export const UserPublicSchema = z.object({
  id: z.string().uuid(),
  displayName: z.string().min(1).max(200),
  publicKey: z.string().min(1), // base64 x25519 public key
  createdAt: z.string().datetime(),
});
export type UserPublic = z.infer<typeof UserPublicSchema>;

/**
 * A stored event record, from the server's point of view: an opaque
 * encrypted blob owned by a user. The server cannot read start/end times,
 * titles, or any other content in phase 1 (single-user, no sharing yet).
 */
export const EventRecordSchema = z.object({
  id: z.string().uuid(),
  ownerId: z.string().uuid(),
  envelope: EncryptedEnvelopeSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type EventRecord = z.infer<typeof EventRecordSchema>;

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

/** How important the user considers this event -- distinct from, and unrelated
 * to, the per-slot preference ranking used in group-scheduling (docs/ARCHITECTURE.md);
 * this is a personal attribute of a single event. */
export const EventPrioritySchema = z.enum(["low", "medium", "high"]);
export type EventPriority = z.infer<typeof EventPrioritySchema>;

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
    endTime: z.string().datetime(),
    priority: EventPrioritySchema.default("medium"),
    recurrence: RecurrenceRuleSchema.optional(),
  })
  .refine((event) => new Date(event.endTime) > new Date(event.startTime), {
    message: "endTime must be after startTime",
    path: ["endTime"],
  });
export type EventContent = z.infer<typeof EventContentSchema>;
