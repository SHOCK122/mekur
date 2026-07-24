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
        properties: {
          id: { type: "string", format: "uuid" },
          ownerId: { type: "string", format: "uuid" },
          envelope: { $ref: "#/components/schemas/EncryptedEnvelope" },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
        },
      },
      GroupEventRecord: {
        type: "object",
        description:
          "The server only ever sees opaque slotIds -- real times/title/description live in contentEnvelope, encrypted under a per-event key wrapped individually to each participant.",
        properties: {
          id: { type: "string", format: "uuid" },
          organizerId: { type: "string", format: "uuid" },
          slotIds: { type: "array", items: { type: "string" } },
          contentEnvelope: { $ref: "#/components/schemas/EncryptedEnvelope" },
          status: { type: "string", enum: ["open", "resolved"] },
          resolvedSlotId: { type: "string", nullable: true },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
          myWrappedKey: {
            allOf: [{ $ref: "#/components/schemas/EncryptedEnvelope" }],
            description: "This requesting user's own wrapped copy of the event key.",
          },
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
        security: [{ bearerAuth: [] }],
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
        responses: { "201": { description: "Created" }, "401": { description: "Unauthorized" } },
      },
      get: {
        summary: "List the authenticated user's events",
        security: [{ bearerAuth: [] }],
        responses: { "200": { description: "OK" }, "401": { description: "Unauthorized" } },
      },
    },
    "/events/{id}": {
      get: {
        summary: "Get one event (owner only)",
        security: [{ bearerAuth: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "200": { description: "OK" },
          "401": { description: "Unauthorized" },
          "404": { description: "Not found" },
        },
      },
      put: {
        summary: "Replace an event's content (owner only)",
        security: [{ bearerAuth: [] }],
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
          "401": { description: "Unauthorized" },
          "404": { description: "Not found" },
        },
      },
      delete: {
        summary: "Delete an event (owner only)",
        security: [{ bearerAuth: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "204": { description: "Deleted" },
          "401": { description: "Unauthorized" },
          "404": { description: "Not found" },
        },
      },
    },
    "/group-events": {
      post: {
        summary: "Create a group event with candidate slots and invite participants",
        description:
          "The organizer must include themselves in `participants` (self-wrapped via ECDH with their own keypair) -- see docs/ARCHITECTURE.md.",
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["slotIds", "contentEnvelope", "participants"],
                properties: {
                  slotIds: { type: "array", items: { type: "string" } },
                  contentEnvelope: { $ref: "#/components/schemas/EncryptedEnvelope" },
                  participants: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        userId: { type: "string", format: "uuid" },
                        wrappedKey: { $ref: "#/components/schemas/EncryptedEnvelope" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        responses: { "201": { description: "Created" }, "400": { description: "Invalid request" } },
      },
      get: {
        summary: "List group events the authenticated user organizes or is invited to",
        security: [{ bearerAuth: [] }],
        responses: { "200": { description: "OK" } },
      },
    },
    "/group-events/{id}": {
      get: {
        summary: "Get one group event (participants only)",
        security: [{ bearerAuth: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: { "200": { description: "OK" }, "404": { description: "Not found" } },
      },
    },
    "/group-events/{id}/votes": {
      post: {
        summary: "Submit (replacing any previous) ranked slot preferences",
        security: [{ bearerAuth: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["rankings"],
                properties: {
                  rankings: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        slotId: { type: "string" },
                        rank: { type: "integer", minimum: 1 },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        responses: {
          "204": { description: "Recorded" },
          "400": { description: "Invalid request or unknown slotId" },
          "404": { description: "Not found" },
        },
      },
    },
    "/group-events/{id}/resolve": {
      post: {
        summary: "Resolve the event to a winning slot (organizer only)",
        description:
          "Runs the default selection strategy (minimize total rank sum) over all submitted votes.",
        security: [{ bearerAuth: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "200": { description: "OK" },
          "404": { description: "Not found (not the organizer)" },
          "409": { description: "No votes submitted yet" },
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
  },
} as const;
