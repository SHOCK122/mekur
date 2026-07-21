import type { Database } from "../db/pool.js";

export interface UserRecord {
  id: string;
  username: string;
  displayName: string;
  publicKey: string;
  authSalt: string;
  authHash: string;
  createdAt: string;
}

interface UserRow {
  id: string;
  username: string;
  display_name: string;
  public_key: string;
  auth_salt: string;
  auth_hash: string;
  created_at: Date;
}

function toUserRecord(row: UserRow): UserRecord {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    publicKey: row.public_key,
    authSalt: row.auth_salt,
    authHash: row.auth_hash,
    createdAt: row.created_at.toISOString(),
  };
}

export class UsernameTakenError extends Error {
  constructor(username: string) {
    super(`Username already taken: ${username}`);
    this.name = "UsernameTakenError";
  }
}

export interface CreateUserInput {
  username: string;
  displayName: string;
  publicKey: string;
  authSalt: string;
  authHash: string;
}

export function createUserRepository(db: Database) {
  return {
    async create(input: CreateUserInput): Promise<UserRecord> {
      try {
        const result = await db.query<UserRow>(
          `INSERT INTO users (username, display_name, public_key, auth_salt, auth_hash)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id, username, display_name, public_key, auth_salt, auth_hash, created_at`,
          [input.username, input.displayName, input.publicKey, input.authSalt, input.authHash]
        );
        const row = result.rows[0];
        if (!row) throw new Error("Insert returned no row");
        return toUserRecord(row);
      } catch (err) {
        if (err instanceof Error && "code" in err && (err as { code?: string }).code === "23505") {
          throw new UsernameTakenError(input.username);
        }
        throw err;
      }
    },

    async findByUsername(username: string): Promise<UserRecord | null> {
      const result = await db.query<UserRow>(
        `SELECT id, username, display_name, public_key, auth_salt, auth_hash, created_at
         FROM users WHERE username = $1`,
        [username]
      );
      const row = result.rows[0];
      return row ? toUserRecord(row) : null;
    },

    async findById(id: string): Promise<UserRecord | null> {
      const result = await db.query<UserRow>(
        `SELECT id, username, display_name, public_key, auth_salt, auth_hash, created_at
         FROM users WHERE id = $1`,
        [id]
      );
      const row = result.rows[0];
      return row ? toUserRecord(row) : null;
    },
  };
}

export type UserRepository = ReturnType<typeof createUserRepository>;
