/**
 * Hand-maintained OpenAPI description of the routes that actually exist.
 * Kept in sync manually rather than generated, since the surface is small;
 * health.test.ts checks every registered route appears here, so drift
 * fails the suite rather than going unnoticed.
 */

type Schema = Record<string, unknown>;

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

function jsonBody(schema: Schema) {
  return { required: true, content: { "application/json": { schema } } };
}

function object(required: string[], properties: Record<string, Schema>): Schema {
  return { type: "object", required, properties };
}

const auth = [{ bearerAuth: [] }];
const capability = {
  name: "x-event-capability",
  in: "header",
  required: true,
  description: "A view or edit capability token for this event.",
  schema: { type: "string" },
};
const idParam = { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } };
const usernameParam = { name: "username", in: "path", required: true, schema: { type: "string" } };
const notFound = {
  "404": { description: "Not found -- also returned for a wrong capability, so existence isn't confirmed" },
};

export const openApiSpec = {
  openapi: "3.0.3",
  info: {
    title: "Schedule App API",
    version: "0.2.0",
    description:
      "End-to-end encrypted, capability-based scheduling. The server stores opaque envelopes and token hashes; it never sees event content and stores no user->event association. See docs/ARCHITECTURE.md.",
  },
  servers: [{ url: "/api" }],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        description: "A session JWT from /users or /sessions, or an API key (prefix `sak_`).",
      },
    },
    schemas: {
      EncryptedEnvelope: object(["v", "algo", "keyId", "nonce", "ciphertext"], {
        v: { type: "integer", enum: [1] },
        algo: { type: "string", enum: ["xchacha20poly1305"] },
        keyId: { type: "string" },
        nonce: { type: "string", description: "base64" },
        ciphertext: { type: "string", description: "base64" },
      }),
      SealedEnvelope: {
        allOf: [
          ref("EncryptedEnvelope"),
          object(["epk"], { epk: { type: "string", description: "Ephemeral X25519 public key, base64" } }),
        ],
      },
      User: object([], {
        id: { type: "string", format: "uuid" },
        username: { type: "string" },
        displayName: { type: "string" },
        publicKey: { type: "string", description: "base64 X25519 public key" },
        createdAt: { type: "string", format: "date-time" },
      }),
      Event: object([], {
        id: { type: "string", format: "uuid" },
        envelope: ref("EncryptedEnvelope"),
        createdAt: { type: "string", format: "date-time" },
        updatedAt: { type: "string", format: "date-time" },
      }),
      FriendCode: object([], { code: { type: "string" }, createdAt: { type: "string", format: "date-time" } }),
    },
  },
  paths: {
    "/health": { get: { summary: "Liveness check", responses: { "200": { description: "OK" } } } },
    "/openapi.json": { get: { summary: "This document", responses: { "200": { description: "OK" } } } },

    "/users": {
      post: {
        summary: "Register",
        description:
          "authKey is derived from the password client-side; the server hashes it again before storing, so a leaked hash isn't a replayable credential.",
        requestBody: jsonBody(
          object(["username", "displayName", "publicKey", "authKey", "authSalt"], {
            username: { type: "string", pattern: "^[a-z0-9_.-]{3,64}$" },
            displayName: { type: "string" },
            publicKey: { type: "string" },
            authKey: { type: "string", description: "base64, never the password" },
            authSalt: { type: "string", description: "base64 scrypt salt" },
          })
        ),
        responses: {
          "201": { description: "Created; returns { user, token }" },
          "409": { description: "Username already taken" },
        },
      },
    },
    "/users/{username}/salt": {
      get: {
        summary: "Fetch a user's auth salt, needed to re-derive login keys",
        parameters: [usernameParam],
        responses: { "200": { description: "{ authSalt }" }, "404": { description: "Not found" } },
      },
    },
    "/sessions": {
      post: {
        summary: "Log in",
        description:
          "If publicKey is given and differs from the stored key, the stored key is replaced. Only possible here, where the password has just been proven.",
        requestBody: jsonBody(
          object(["username", "authKey"], {
            username: { type: "string" },
            authKey: { type: "string" },
            publicKey: { type: "string" },
          })
        ),
        responses: {
          "200": { description: "{ user, token }" },
          "401": { description: "Invalid username or password" },
        },
      },
    },

    "/events": {
      post: {
        summary: "Create an event",
        description: "Returns view and edit tokens exactly once; only their hashes are stored.",
        security: auth,
        requestBody: jsonBody(object(["envelope"], { envelope: ref("EncryptedEnvelope") })),
        responses: { "201": { description: "{ event, viewToken, editToken }" } },
      },
    },
    "/events/batch-read": {
      post: {
        summary: "Read every event whose capability is presented (up to 500)",
        description: "Events with a missing, revoked or expired capability are omitted.",
        security: auth,
        requestBody: jsonBody(
          object(["events"], {
            events: {
              type: "array",
              maxItems: 500,
              items: object(["eventId", "token"], {
                eventId: { type: "string", format: "uuid" },
                token: { type: "string" },
              }),
            },
          })
        ),
        responses: { "200": { description: "{ events: Event[] }" } },
      },
    },
    "/events/{id}": {
      get: {
        summary: "Read an event (view capability)",
        security: auth,
        parameters: [idParam, capability],
        responses: { "200": { description: "{ event }" }, ...notFound },
      },
      put: {
        summary: "Replace an event's envelope (edit capability)",
        security: auth,
        parameters: [idParam, capability],
        requestBody: jsonBody(object(["envelope"], { envelope: ref("EncryptedEnvelope") })),
        responses: { "200": { description: "{ event }" }, ...notFound },
      },
      delete: {
        summary: "Delete an event for everyone (edit capability)",
        security: auth,
        parameters: [idParam, capability],
        responses: { "204": { description: "Deleted" }, ...notFound },
      },
    },
    "/events/{id}/capabilities": {
      post: {
        summary: "Mint an additional capability, e.g. a reusable event code (edit capability)",
        security: auth,
        parameters: [idParam, capability],
        requestBody: jsonBody(
          object(["level"], {
            level: { type: "string", enum: ["view", "edit"] },
            expiresAt: { type: "string", format: "date-time", nullable: true },
          })
        ),
        responses: { "201": { description: "{ token }" }, ...notFound },
      },
    },
    "/events/{id}/capabilities/revoke": {
      post: {
        summary: "Revoke a capability (edit capability)",
        description: "Stops future use. Cannot retract access from anyone who already copied the key.",
        security: auth,
        parameters: [idParam, capability],
        requestBody: jsonBody(object(["token"], { token: { type: "string" } })),
        responses: { "204": { description: "Revoked" }, ...notFound },
      },
    },

    "/keyring": {
      get: {
        summary: "Fetch this account's encrypted keyring",
        security: auth,
        responses: { "200": { description: "{ keyring: EncryptedEnvelope | null, version }" } },
      },
      put: {
        summary: "Replace the keyring (optimistic concurrency)",
        description: "expectedVersion must match the stored version; 0 means no keyring exists yet.",
        security: auth,
        requestBody: jsonBody(
          object(["envelope", "expectedVersion"], {
            envelope: ref("EncryptedEnvelope"),
            expectedVersion: { type: "integer", minimum: 0 },
          })
        ),
        responses: {
          "200": { description: "{ version }" },
          "409": { description: "Changed on another device; reload and re-apply" },
        },
      },
    },

    "/inbox/deliver": {
      post: {
        summary: "Deliver a sealed envelope to an account",
        description: "No sender is recorded. Triggers a generic push notification to the recipient.",
        security: auth,
        requestBody: jsonBody(
          object(["recipientId", "envelope"], {
            recipientId: { type: "string", format: "uuid" },
            envelope: ref("SealedEnvelope"),
          })
        ),
        responses: { "204": { description: "Delivered" }, "404": { description: "No such recipient" } },
      },
    },
    "/inbox": {
      get: {
        summary: "List this account's inbox (newest 200)",
        security: auth,
        responses: { "200": { description: "{ messages: { id, envelope, createdAt }[] }" } },
      },
    },
    "/inbox/{id}": {
      delete: {
        summary: "Remove an inbox message",
        security: auth,
        parameters: [idParam],
        responses: { "204": { description: "Removed" }, "404": { description: "Not found" } },
      },
    },

    "/friend-code": {
      get: {
        summary: "Get this account's one-time friend code",
        security: auth,
        responses: { "200": { description: "{ friendCode: FriendCode }" } },
      },
    },
    "/friend-code/rotate": {
      post: {
        summary: "Replace this account's friend code",
        security: auth,
        responses: { "200": { description: "{ friendCode: FriendCode }" } },
      },
    },
    "/tags/resolve": {
      post: {
        summary: "Resolve a username or one-time friend code to an invitable public key",
        description:
          "Resolving a friend code consumes it. A code-resolved target is anonymous: no username or display name is returned.",
        security: auth,
        requestBody: jsonBody(object(["tag"], { tag: { type: "string" } })),
        responses: {
          "200": { description: "{ target: { userId, publicKey, displayName, username?, viaCode } }" },
          "404": { description: "Unknown username, or a code that is invalid or spent" },
        },
      },
    },

    "/api-keys": {
      post: {
        summary: "Mint an API key (signed-in sessions only)",
        description: "The raw key is returned once and never again; only its hash is stored.",
        security: auth,
        requestBody: jsonBody(object(["name"], { name: { type: "string" } })),
        responses: {
          "201": { description: "{ apiKey, rawKey }" },
          "403": { description: "Called with an API key rather than a session" },
        },
      },
      get: {
        summary: "List this account's API keys (prefix only)",
        security: auth,
        responses: { "200": { description: "{ apiKeys }" } },
      },
    },
    "/api-keys/{id}": {
      delete: {
        summary: "Revoke an API key",
        security: auth,
        parameters: [idParam],
        responses: { "204": { description: "Revoked" }, "404": { description: "Not found" } },
      },
    },

    "/push/vapid-public-key": {
      get: { summary: "VAPID public key for PushManager.subscribe()", responses: { "200": { description: "{ publicKey }" } } },
    },
    "/push-subscriptions": {
      post: {
        summary: "Register a Web Push subscription for this device",
        security: auth,
        requestBody: jsonBody(
          object(["endpoint", "keys"], {
            endpoint: { type: "string", format: "uri" },
            keys: object(["p256dh", "auth"], { p256dh: { type: "string" }, auth: { type: "string" } }),
          })
        ),
        responses: { "204": { description: "Subscribed" } },
      },
      delete: {
        summary: "Unregister a Web Push subscription",
        security: auth,
        requestBody: jsonBody(object(["endpoint"], { endpoint: { type: "string", format: "uri" } })),
        responses: { "204": { description: "Unsubscribed" }, "404": { description: "Not found" } },
      },
    },
  },
} as const;
