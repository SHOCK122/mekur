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
 * this is a personal attribute of a single event. Higher is more important;
 * no fixed range is enforced, so users/clients can adopt whatever scale suits them. */
export const EventPrioritySchema = z.number().int().default(0);
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
    priority: EventPrioritySchema,
    recurrence: RecurrenceRuleSchema.optional(),
  })
  .refine((event) => new Date(event.endTime) > new Date(event.startTime), {
    message: "endTime must be after startTime",
    path: ["endTime"],
  });
export type EventContent = z.infer<typeof EventContentSchema>;

/**
 * Group scheduling: the organizer proposes candidate time slots, invites
 * participants (including themselves -- see GroupEventParticipantSchema),
 * and everyone votes. The server only ever sees opaque slot IDs and
 * ranks -- never the real times, title, or description, which live only
 * inside GroupEventContent, encrypted under a per-event key that's
 * wrapped individually to each participant (see docs/ARCHITECTURE.md and
 * packages/crypto's wrapKey/unwrapKey/deriveSharedWrapKey).
 */
export const SlotSchema = z
  .object({
    startTime: z.string().datetime(),
    endTime: z.string().datetime(),
  })
  .refine((slot) => new Date(slot.endTime) > new Date(slot.startTime), {
    message: "endTime must be after startTime",
    path: ["endTime"],
  });
export type Slot = z.infer<typeof SlotSchema>;

/** The plaintext payload encrypted under the per-event key. Slot IDs here
 * are the same opaque strings the server tracks in the group_events row. */
export const GroupEventContentSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().max(10_000).optional(),
  location: z.string().max(500).optional(),
  slots: z.record(z.string(), SlotSchema).refine((slots) => Object.keys(slots).length > 0, {
    message: "at least one candidate slot is required",
  }),
});
export type GroupEventContent = z.infer<typeof GroupEventContentSchema>;

export const GroupEventStatusSchema = z.enum(["open", "resolved"]);
export type GroupEventStatus = z.infer<typeof GroupEventStatusSchema>;

/** One participant's wrapped copy of the event key. The organizer is a
 * participant of their own event too (self-wrapped), so there's no special
 * case for "am I the organizer" when fetching/decrypting -- everyone goes
 * through the same wrappedKey -> eventKey -> content pipeline. */
export const GroupEventParticipantSchema = z.object({
  userId: z.string().uuid(),
  wrappedKey: EncryptedEnvelopeSchema,
});
export type GroupEventParticipant = z.infer<typeof GroupEventParticipantSchema>;

/** One voter's ranking of the proposed slots (1 = most preferred). Ranks
 * need not be contiguous or cover every slot -- a voter can rank only the
 * slots they care about. */
export const VoteRankingSchema = z.object({
  slotId: z.string().min(1),
  rank: z.number().int().positive(),
});

export const GroupEventRecordSchema = z.object({
  id: z.string().uuid(),
  organizerId: z.string().uuid(),
  /** Denormalized onto the record so an invitee can derive the shared
   * wrap key without a separate lookup -- it's already public information
   * the server knows, and the invitee is already sharing an event with
   * this organizer, so there's no new exposure in including it here. */
  organizerPublicKey: z.string(),
  slotIds: z.array(z.string()).min(1),
  contentEnvelope: EncryptedEnvelopeSchema,
  status: GroupEventStatusSchema,
  resolvedSlotId: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  /** This requesting user's own wrapped copy of the event key. */
  myWrappedKey: EncryptedEnvelopeSchema,
  /** This requesting user's own current rankings, if they've voted. */
  myVotes: z.array(VoteRankingSchema),
});
export type GroupEventRecord = z.infer<typeof GroupEventRecordSchema>;

export const SubmitVotesRequestSchema = z.object({
  rankings: z
    .array(VoteRankingSchema)
    .min(1)
    .refine((rankings) => new Set(rankings.map((r) => r.slotId)).size === rankings.length, {
      message: "duplicate slotId in rankings",
    }),
});
export type SubmitVotesRequest = z.infer<typeof SubmitVotesRequestSchema>;
