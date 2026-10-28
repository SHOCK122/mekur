import { z } from "zod";

// Usernames are login handles and invite tags; keep them simple and
// predictable to validate.
const usernameSchema = z
  .string()
  .min(3)
  .max(64)
  .regex(/^[a-z0-9_.-]+$/, "username must be lowercase letters, numbers, _ . -");

export const RegisterRequestSchema = z.object({
  username: usernameSchema,
  displayName: z.string().min(1).max(200),
  publicKey: z.string().min(1).max(64),
  authKey: z.string().min(1), // base64 — server hashes this itself before storing
  authSalt: z.string().min(1), // base64 scrypt salt, so the client can re-derive later
});
export type RegisterRequest = z.infer<typeof RegisterRequestSchema>;

export const LoginRequestSchema = z.object({
  username: usernameSchema,
  authKey: z.string().min(1),
  /** The identity public key the client derived from this password. If it
   * differs from the stored one, the stored one is replaced -- see the
   * login route for why that's safe only here. */
  publicKey: z.string().min(1).max(64).optional(),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;
