//! API keys: their format and the repository -- a port of
//! `apps/api/src/lib/apiKey.ts` and
//! `apps/api/src/repositories/apiKeyRepository.ts`.
//!
//! Agentic and programmatic clients authenticate with a long-lived API key
//! instead of a login-derived session token. Only the key's hash is stored,
//! so a database breach yields nothing that can be replayed.

use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use chrono::{DateTime, SecondsFormat, Utc};
use serde::Serialize;
use sha2::{Digest, Sha256};
use sqlx::{FromRow, PgPool};
use uuid::Uuid;

/// Every API key starts with this ("schedule app key"), which is how the
/// auth check tells one from a session token.
pub const PREFIX: &str = "sak_";

/// The stored, displayable start of a key: the prefix and 8 more
/// characters, enough for a user to tell their keys apart.
const KEY_PREFIX_LEN: usize = PREFIX.len() + 8;

/// A freshly minted key.
pub struct GeneratedApiKey {
    /// Shown to the user exactly once, never stored.
    pub raw_key: String,
    /// Safe to store and display.
    pub key_prefix: String,
}

impl std::fmt::Debug for GeneratedApiKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GeneratedApiKey")
            .field("raw_key", &"<redacted>")
            .field("key_prefix", &self.key_prefix)
            .finish()
    }
}

/// `sak_` and 24 random bytes from the OS, base64url without padding (32
/// characters), as `randomBytes(24).toString("base64url")` made them.
pub fn generate_api_key() -> Result<GeneratedApiKey, getrandom::Error> {
    let mut bytes = [0u8; 24];
    getrandom::fill(&mut bytes)?;
    let raw_key = format!("{PREFIX}{}", URL_SAFE_NO_PAD.encode(bytes));
    let key_prefix = raw_key[..KEY_PREFIX_LEN].to_owned();
    Ok(GeneratedApiKey {
        raw_key,
        key_prefix,
    })
}

/// base64(sha256(the key's UTF-8 bytes)) -- the stored form.
pub fn hash_api_key(raw_key: &str) -> String {
    STANDARD.encode(Sha256::digest(raw_key.as_bytes()))
}

/// Whether a bearer token is meant as an API key rather than a session
/// token.
pub fn looks_like_api_key(token: &str) -> bool {
    token.starts_with(PREFIX)
}

/// A key as a client may see it: never the raw key or its hash.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiKeyRecord {
    pub id: String,
    pub user_id: String,
    pub name: String,
    pub key_prefix: String,
    /// `Date.prototype.toISOString` form: UTC, milliseconds, `Z`.
    pub created_at: String,
    pub last_used_at: Option<String>,
}

#[derive(FromRow)]
struct ApiKeyRow {
    id: Uuid,
    user_id: Uuid,
    name: String,
    key_prefix: String,
    created_at: DateTime<Utc>,
    last_used_at: Option<DateTime<Utc>>,
}

/// node-pg read `timestamptz` into a millisecond `Date`; `toISOString`
/// printed it.
fn iso(at: DateTime<Utc>) -> String {
    at.to_rfc3339_opts(SecondsFormat::Millis, true)
}

impl From<ApiKeyRow> for ApiKeyRecord {
    fn from(row: ApiKeyRow) -> Self {
        Self {
            id: row.id.to_string(),
            user_id: row.user_id.to_string(),
            name: row.name,
            key_prefix: row.key_prefix,
            created_at: iso(row.created_at),
            last_used_at: row.last_used_at.map(iso),
        }
    }
}

macro_rules! columns {
    () => {
        "id, user_id, name, key_prefix, created_at, last_used_at"
    };
}

/// User ids are bound as text and cast by Postgres, as node-pg sent them:
/// an id that isn't a UUID is a database error, never a silent miss.
#[derive(Clone)]
pub struct ApiKeyRepository {
    db: PgPool,
}

impl ApiKeyRepository {
    pub fn new(db: PgPool) -> Self {
        Self { db }
    }

    pub async fn create(
        &self,
        user_id: &str,
        name: &str,
        key_prefix: &str,
        key_hash: &str,
    ) -> Result<ApiKeyRecord, sqlx::Error> {
        let row: ApiKeyRow = sqlx::query_as(concat!(
            "INSERT INTO api_keys (user_id, name, key_prefix, key_hash)
             VALUES ($1::uuid, $2, $3, $4)
             RETURNING ",
            columns!()
        ))
        .bind(user_id)
        .bind(name)
        .bind(key_prefix)
        .bind(key_hash)
        .fetch_one(&self.db)
        .await?;
        Ok(row.into())
    }

    /// The user a key's hash belongs to, bumping its `last_used_at`. `None`
    /// if there is no such key (revoked, or never existed): unauthenticated.
    pub async fn find_user_id_by_hash(
        &self,
        key_hash: &str,
    ) -> Result<Option<String>, sqlx::Error> {
        let user_id: Option<Uuid> = sqlx::query_scalar(
            "UPDATE api_keys SET last_used_at = now() WHERE key_hash = $1 RETURNING user_id",
        )
        .bind(key_hash)
        .fetch_optional(&self.db)
        .await?;
        Ok(user_id.map(|id| id.to_string()))
    }

    /// A user's keys, newest first. Not paged, as in TS: each one was
    /// minted by hand from a signed-in session.
    pub async fn list_for_user(&self, user_id: &str) -> Result<Vec<ApiKeyRecord>, sqlx::Error> {
        let rows: Vec<ApiKeyRow> = sqlx::query_as(concat!(
            "SELECT ",
            columns!(),
            " FROM api_keys WHERE user_id = $1::uuid ORDER BY created_at DESC"
        ))
        .bind(user_id)
        .fetch_all(&self.db)
        .await?;
        Ok(rows.into_iter().map(Into::into).collect())
    }

    /// Deletes key `id` if it belongs to `user_id`; whether it did.
    pub async fn revoke_for_user(&self, id: &str, user_id: &str) -> Result<bool, sqlx::Error> {
        let result = sqlx::query("DELETE FROM api_keys WHERE id = $1::uuid AND user_id = $2::uuid")
            .bind(id)
            .bind(user_id)
            .execute(&self.db)
            .await?;
        Ok(result.rows_affected() > 0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_keys_have_the_ts_format() {
        let a = generate_api_key().unwrap();
        let b = generate_api_key().unwrap();
        assert_ne!(a.raw_key, b.raw_key);
        for key in [&a, &b] {
            assert_eq!(key.raw_key.len(), 36);
            assert!(looks_like_api_key(&key.raw_key));
            assert!(
                key.raw_key[4..]
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
            );
            assert_eq!(key.key_prefix, key.raw_key[..12]);
        }
        assert!(!format!("{a:?}").contains(&a.raw_key));
    }

    #[test]
    fn hash_is_base64_sha256_of_the_text() {
        // sha256("abc"): the key's own characters, not a base64 decoding.
        assert_eq!(
            hash_api_key("abc"),
            "ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0="
        );
    }
}
