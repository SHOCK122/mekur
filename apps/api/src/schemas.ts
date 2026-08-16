import { z } from "zod";
import { EncryptedEnvelopeSchema } from "@schedule-app/shared";

// Usernames are login handles only (not shown to other users); keep them
// simple and predictable to validate.
const usernameSchema = z
  .string()
  .min(3)
  .max(64)
  .regex(/^[a-z0-9_.-]+$/, "username must be lowercase letters, numbers, _ . -");

export const RegisterRequestSchema = z.object({
  username: usernameSchema,
  displayName: z.string().min(1).max(200),
  publicKey: z.string().min(1),
  authKey: z.string().min(1), // base64 — server hashes this itself before storing
  authSalt: z.string().min(1), // base64 scrypt salt, so the client can re-derive later
});
export type RegisterRequest = z.infer<typeof RegisterRequestSchema>;

export const LoginRequestSchema = z.object({
  username: usernameSchema,
  authKey: z.string().min(1),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const CreateEventRequestSchema = z.object({
  envelope: EncryptedEnvelopeSchema,
});
export type CreateEventRequest = z.infer<typeof CreateEventRequestSchema>;

export const UpdateEventRequestSchema = CreateEventRequestSchema;
export type UpdateEventRequest = z.infer<typeof UpdateEventRequestSchema>;

const participantSchema = z.object({
  userId: z.string().uuid(),
  wrappedKey: EncryptedEnvelopeSchema,
  /** Set when this participant was reached via a one-time anonymous code,
   * which permanently bars turning the invite into a connection. */
  invitedViaCode: z.boolean().optional(),
});

export const CreateGroupEventRequestSchema = z.object({
  slotIds: z
    .array(z.string().min(1))
    .min(1)
    .refine((ids) => new Set(ids).size === ids.length, { message: "duplicate slotId" }),
  contentEnvelope: EncryptedEnvelopeSchema,
  // Must include the organizer themself (self-wrapped) -- see
  // docs/ARCHITECTURE.md and packages/shared's design note.
  participants: z
    .array(participantSchema)
    .min(1)
    .refine((ps) => new Set(ps.map((p) => p.userId)).size === ps.length, {
      message: "duplicate participant userId",
    }),
});
export type CreateGroupEventRequest = z.infer<typeof CreateGroupEventRequestSchema>;
