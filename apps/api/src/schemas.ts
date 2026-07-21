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
