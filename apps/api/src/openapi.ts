/**
 * Hand-maintained OpenAPI description of the routes that actually exist.
 * Kept in sync manually rather than generated, since the API surface is
 * still small; revisit generation (e.g. from the Zod schemas in
 * schemas.ts) if this drifts or the surface grows significantly.
 */
export const openApiSpec = {
  openapi: "3.0.3",
  info: {
    title: "Schedule App API",
    version: "0.1.0",
    description:
      "Event content is end-to-end encrypted: the server only ever stores/relays opaque EncryptedEnvelope blobs and never sees plaintext titles, times, locations, or descriptions.",
  },
  servers: [{ url: "/api" }],
  components: {
    securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
      eventCapability: {
        type: "apiKey",
        in: "header",
        name: "X-Event-Capability",
        description:
          "A view or edit capability token for a specific event. Holding the token IS the authorization -- the server does not check identity/ownership. A missing or wrong token yields 404, never 403.",
      },
    },
    schemas: {
      EncryptedEnvelope: {
        type: "object",
        required: ["v", "algo", "keyId", "nonce", "ciphertext"],
        properties: {
          v: { type: "integer", enum: [1] },
          algo: { type: "string", enum: ["xchacha20poly1305"] },
          keyId: { type: "string" },
          nonce: { type: "string", description: "base64" },
          ciphertext: { type: "string", description: "base64" },
        },
      },
      User: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          username: { type: "string" },
          displayName: { type: "string" },
          publicKey: { type: "string", description: "base64 X25519 public key" },
          createdAt: { type: "string", format: "date-time" },
        },
      },
      EventRecord: {
        type: "object",
        description:
          "No owner/creator field: under the capability model, access is proven by holding a view or edit token, not by identity. See docs/ARCHITECTURE.md.",
        properties: {
          id: { type: "string", format: "uuid" },
          envelope: { $ref: "#/components/schemas/EncryptedEnvelope" },
          slotIds: {
            type: "array",
            items: { type: "string" },
            description: "Opaque candidate slot IDs, present only for events being scheduled.",
          },
          status: { type: "string", enum: ["open", "resolved"] },
          resolvedSlotId: { type: "string", nullable: true },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
        },
      },
    },
  },
  paths: {
    "/health": {
      get: {
        summary: "Liveness check",
        responses: { "200": { description: "OK" } },
      },
    },
    "/users": {
      post: {
        summary: "Register a new account",
        description:
          "The client derives authKey/encryptionKey from the password client-side. Only authKey is ever sent here; the server hashes it again before storing, so a leaked stored hash alone can't be replayed as a login credential.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["username", "displayName", "publicKey", "authKey", "authSalt"],
                properties: {
                  username: { type: "string" },
                  displayName: { type: "string" },
                  publicKey: { type: "string" },
                  authKey: { type: "string", description: "base64, never the password itself" },
                  authSalt: { type: "string", description: "base64 scrypt salt" },
                },
              },
            },
          },
        },
        responses: {
          "201": {
            description: "Created",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    user: { $ref: "#/components/schemas/User" },
                    token: { type: "string" },
                  },
                },
              },
            },
          },
          "409": { description: "Username already taken" },
        },
      },
    },
    "/users/{username}": {
      get: {
        summary: "Directory lookup: find a user's public profile/key to invite them",
        security: [{ bearerAuth: [] }],
        parameters: [{ name: "username", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": { description: "OK" },
          "401": { description: "Unauthorized" },
          "404": { description: "Not found" },
        },
      },
    },
    "/users/{username}/salt": {
      get: {
        summary: "Fetch a user's auth salt (needed to re-derive login keys)",
        parameters: [{ name: "username", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": {
            description: "OK",
            content: {
              "application/json": {
                schema: { type: "object", properties: { authSalt: { type: "string" } } },
              },
            },
          },
          "404": { description: "Not found" },
        },
      },
    },
    "/sessions": {
      post: {
        summary: "Log in",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["username", "authKey"],
                properties: { username: { type: "string" }, authKey: { type: "string" } },
              },
            },
          },
        },
        responses: {
          "200": { description: "OK" },
          "401": { description: "Invalid username or password" },
        },
      },
    },
    "/events": {
      post: {
        summary: "Create an event",
        description:
          "Returns freshly minted view/edit capability tokens, shown exactly once -- the server keeps only their hashes and cannot re-issue them. The client stores them in its keyring; there is no server-side way to list 'my events' after this.",
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["envelope"],
                properties: {
                  envelope: { $ref: "#/components/schemas/EncryptedEnvelope" },
                  slotIds: {
                    type: "array",
                    items: { type: "string" },
                    maxItems: 50,
                    description: "Opaque candidate slot IDs, if this event is being scheduled.",
                  },
                },
              },
            },
          },
        },
        responses: {
          "201": {
            description: "Created",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    id: { type: "string", format: "uuid" },
                    envelope: { $ref: "#/components/schemas/EncryptedEnvelope" },
                    slotIds: { type: "array", items: { type: "string" } },
                    status: { type: "string", enum: ["open", "resolved"] },
                    resolvedSlotId: { type: "string", nullable: true },
                    createdAt: { type: "string", format: "date-time" },
                    updatedAt: { type: "string", format: "date-time" },
                    viewToken: { type: "string" },
                    editToken: { type: "string" },
                  },
                },
              },
            },
          },
          "401": { description: "Unauthorized" },
        },
      },
    },
    "/events/batch-read": {
      post: {
        summary: "Read many events at once by presenting the capabilities held for each",
        description:
          "The server cannot answer 'list my events' -- the client presents the (eventId, token) pairs from its keyring instead. Entries beyond the first 500 are ignored.",
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["events"],
                properties: {
                  events: {
                    type: "array",
                    maxItems: 500,
                    items: {
                      type: "object",
                      required: ["eventId", "token"],
                      properties: {
                        eventId: { type: "string", format: "uuid" },
                        token: { type: "string" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "OK -- entries whose capability didn't resolve are silently omitted, not errored",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    events: { type: "array", items: { $ref: "#/components/schemas/EventRecord" } },
                  },
                },
              },
            },
          },
          "401": { description: "Unauthorized" },
        },
      },
    },
    "/events/{id}": {
      get: {
        summary: "Get one event",
        security: [{ bearerAuth: [] }, { eventCapability: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "200": { description: "OK" },
          "401": { description: "Unauthorized (not logged in)" },
          "404": { description: "Not found (missing/wrong/expired capability, or no such event)" },
        },
      },
      put: {
        summary: "Replace an event's content",
        description: "Requires an edit capability.",
        security: [{ bearerAuth: [] }, { eventCapability: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["envelope"],
                properties: { envelope: { $ref: "#/components/schemas/EncryptedEnvelope" } },
              },
            },
          },
        },
        responses: {
          "200": { description: "OK" },
          "401": { description: "Unauthorized (not logged in)" },
          "404": { description: "Not found (missing/wrong capability, or view-only token used to edit)" },
        },
      },
      delete: {
        summary: "Delete an event",
        description: "Requires an edit capability.",
        security: [{ bearerAuth: [] }, { eventCapability: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "204": { description: "Deleted" },
          "401": { description: "Unauthorized (not logged in)" },
          "404": { description: "Not found (missing/wrong capability, or no such event)" },
        },
      },
    },
    "/events/{id}/capabilities": {
      post: {
        summary: "Mint an additional capability token (e.g. a reusable join code)",
        description: "Requires an edit capability.",
        security: [{ bearerAuth: [] }, { eventCapability: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["level"],
                properties: {
                  level: { type: "string", enum: ["view", "edit"] },
                  expiresAt: { type: "string", format: "date-time", nullable: true },
                },
              },
            },
          },
        },
        responses: {
          "201": {
            description: "Created -- the raw token, shown exactly once",
            content: {
              "application/json": { schema: { type: "object", properties: { token: { type: "string" } } } },
            },
          },
          "401": { description: "Unauthorized (not logged in)" },
          "404": { description: "Not found (missing/wrong capability)" },
        },
      },
    },
    "/events/{id}/capabilities/revoke": {
      post: {
        summary: "Revoke a specific capability token",
        description:
          "Requires an edit capability. Stops future use of the revoked token; cannot retract a copy already in someone else's hands -- real revocation means re-keying the event.",
        security: [{ bearerAuth: [] }, { eventCapability: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["token"],
                properties: { token: { type: "string", description: "The token to revoke" } },
              },
            },
          },
        },
        responses: {
          "204": { description: "Revoked" },
          "401": { description: "Unauthorized (not logged in)" },
          "404": { description: "Not found (missing/wrong capability, or unknown token)" },
        },
      },
    },
    "/keyring": {
      get: {
        summary: "Fetch the authenticated user's encrypted keyring",
        description:
          "The keyring holds (eventId, viewToken, editToken, eventKey) for every event this account can reach -- the one thing that makes 'list my events' possible without the server knowing the answer.",
        security: [{ bearerAuth: [] }],
        responses: {
          "200": {
            description: "OK -- keyring is null with version 0 for a brand-new account",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    keyring: { allOf: [{ $ref: "#/components/schemas/EncryptedEnvelope" }], nullable: true },
                    version: { type: "integer" },
                  },
                },
              },
            },
          },
          "401": { description: "Unauthorized" },
        },
      },
      put: {
        summary: "Replace the authenticated user's keyring",
        description:
          "Optimistic concurrency: expectedVersion must match the server's current version, or the write is rejected with 409 rather than silently clobbering another device's concurrent write.",
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["envelope", "expectedVersion"],
                properties: { envelope: { type: "object" }, expectedVersion: { type: "integer", minimum: 0 } },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "OK",
            content: {
              "application/json": { schema: { type: "object", properties: { version: { type: "integer" } } } },
            },
          },
          "401": { description: "Unauthorized" },
          "409": { description: "Keyring changed on another device since expectedVersion was read" },
        },
      },
    },
    "/inbox": {
      get: {
        summary: "List messages (delivered capabilities/invites) in the authenticated user's inbox",
        security: [{ bearerAuth: [] }],
        responses: { "200": { description: "OK" }, "401": { description: "Unauthorized" } },
      },
    },
    "/inbox/deliver": {
      post: {
        summary: "Deliver an encrypted message (e.g. an event invite) to another user's inbox",
        description:
          "The sender's identity is deliberately not recorded against the message -- only that some authenticated account sent it. If the sender wants to be known, they say so inside the encrypted envelope. Triggers a generic push notification to the recipient.",
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["recipientId", "envelope"],
                properties: { recipientId: { type: "string", format: "uuid" }, envelope: { type: "object" } },
              },
            },
          },
        },
        responses: {
          "204": { description: "Delivered" },
          "401": { description: "Unauthorized" },
          "404": { description: "No such recipient" },
        },
      },
    },
    "/inbox/{id}": {
      delete: {
        summary: "Remove a message from the authenticated user's inbox",
        security: [{ bearerAuth: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "204": { description: "Removed" },
          "401": { description: "Unauthorized" },
          "404": { description: "Not found" },
        },
      },
    },
    "/friend-code": {
      get: {
        summary: "Get the authenticated user's current one-time friend code, creating one if needed",
        security: [{ bearerAuth: [] }],
        responses: { "200": { description: "OK" }, "401": { description: "Unauthorized" } },
      },
    },
    "/friend-code/rotate": {
      post: {
        summary: "Rotate the authenticated user's friend code, invalidating the previous one",
        security: [{ bearerAuth: [] }],
        responses: { "200": { description: "OK" }, "401": { description: "Unauthorized" } },
      },
    },
    "/tags/resolve": {
      post: {
        summary: "Resolve a username or one-time friend code to an invitable target",
        description:
          "POST because redeeming a friend code consumes it -- this mutates state and must not be retried blindly. A code's response deliberately withholds the owner's real identity.",
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { type: "object", required: ["tag"], properties: { tag: { type: "string", maxLength: 64 } } },
            },
          },
        },
        responses: {
          "200": { description: "OK" },
          "400": { description: "Invalid request" },
          "404": { description: "Unknown username, or code is invalid/already used" },
        },
      },
    },
    "/api-keys": {
      post: {
        summary: "Mint a new API key (for agentic/programmatic clients)",
        description:
          "The raw key is returned exactly once in the response and is never recoverable again -- only its hash is stored.",
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["name"],
                properties: { name: { type: "string", description: "Label to tell keys apart later" } },
              },
            },
          },
        },
        responses: { "201": { description: "Created" } },
      },
      get: {
        summary: "List the authenticated user's own API keys (prefix only, never the full key)",
        security: [{ bearerAuth: [] }],
        responses: { "200": { description: "OK" } },
      },
    },
    "/api-keys/{id}": {
      delete: {
        summary: "Revoke an API key",
        security: [{ bearerAuth: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: { "204": { description: "Revoked" }, "404": { description: "Not found" } },
      },
    },
    "/push/vapid-public-key": {
      get: {
        summary: "Get the VAPID public key, needed to call PushManager.subscribe()",
        responses: { "200": { description: "OK" } },
      },
    },
    "/push-subscriptions": {
      post: {
        summary: "Register a Web Push subscription for the current device",
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["endpoint", "keys"],
                properties: {
                  endpoint: { type: "string", format: "uri" },
                  keys: {
                    type: "object",
                    properties: { p256dh: { type: "string" }, auth: { type: "string" } },
                  },
                },
              },
            },
          },
        },
        responses: { "204": { description: "Subscribed" } },
      },
      delete: {
        summary: "Unregister a Web Push subscription",
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["endpoint"],
                properties: { endpoint: { type: "string", format: "uri" } },
              },
            },
          },
        },
        responses: { "204": { description: "Unsubscribed" }, "404": { description: "Not found" } },
      },
    },
  },
} as const;
