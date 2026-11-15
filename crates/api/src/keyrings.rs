//! The keyring repository -- a port of
//! `apps/api/src/repositories/keyringRepository.ts`.
//!
//! The keyring holds, encrypted, the list of events an account can reach
//! and the capability tokens for each. Without it "list my events" is
//! unanswerable, because the server deliberately stores no user->event
//! association (`docs/ARCHITECTURE.md`). The server never holds the key
//! that opens it: all it learns is the blob's approximate size.

use mekur_shared::KeyringEnvelope;
use serde_json::value::RawValue;
use sqlx::PgPool;

use crate::app::minify_json;

/// An account's stored keyring.
#[derive(Debug)]
pub struct KeyringRecord {
    /// The stored JSON as `JSON.stringify(JSON.parse(jsonb text))` wrote it
    /// (jsonb's key order, no whitespace), so replies are byte-for-byte the
    /// TS server's.
    pub envelope: Box<RawValue>,
    pub version: i32,
}

/// Why a keyring write didn't happen.
#[derive(Debug, thiserror::Error)]
pub enum PutKeyringError {
    /// The stored keyring isn't at the version the caller read (or exists
    /// when the caller believed none did): another device wrote first.
    #[error("keyring was modified by another device")]
    VersionConflict,
    /// A version no `INTEGER` column can hold. node-pg sent it as text and
    /// Postgres refused it, which the TS server answered with a 500; kept.
    #[error("expected version {0} is out of range for type integer")]
    VersionOutOfRange(u64),
    #[error(transparent)]
    Database(#[from] sqlx::Error),
}

/// User ids are bound as text and cast by Postgres, as node-pg sent them
/// (so an upper-case id from a token still matches, and one that is no UUID
/// is a database error).
#[derive(Clone)]
pub struct KeyringRepository {
    db: PgPool,
}

impl KeyringRepository {
    pub fn new(db: PgPool) -> Self {
        Self { db }
    }

    /// The account's keyring, if it has saved one.
    pub async fn get(&self, user_id: &str) -> Result<Option<KeyringRecord>, sqlx::Error> {
        let row: Option<(String, i32)> =
            sqlx::query_as("SELECT envelope::text, version FROM keyrings WHERE user_id = $1::uuid")
                .bind(user_id)
                .fetch_optional(&self.db)
                .await?;
        row.map(|(envelope, version)| {
            let envelope = RawValue::from_string(minify_json(&envelope))
                .map_err(|err| sqlx::Error::Decode(Box::new(err)))?;
            Ok(KeyringRecord { envelope, version })
        })
        .transpose()
    }

    /// Replaces the account's keyring; the new version.
    ///
    /// Optimistic concurrency: the caller must present the version it read.
    /// Two devices writing concurrently must not silently clobber each
    /// other -- a lost keyring write means permanently losing access to
    /// whatever events that write was adding. Each write is one statement,
    /// so of two racing writers exactly one wins.
    ///
    /// `expected_version` of 0 means "I believe no keyring exists yet".
    pub async fn put(
        &self,
        user_id: &str,
        envelope: &KeyringEnvelope,
        expected_version: u64,
    ) -> Result<i32, PutKeyringError> {
        let envelope = serde_json::to_string(envelope).expect("an envelope serializes");
        let version: Option<i32> = if expected_version == 0 {
            sqlx::query_scalar(
                "INSERT INTO keyrings (user_id, envelope) VALUES ($1::uuid, $2::text::jsonb)
                 ON CONFLICT (user_id) DO NOTHING
                 RETURNING version",
            )
            .bind(user_id)
            .bind(envelope)
            .fetch_optional(&self.db)
            .await?
        } else {
            let expected = i32::try_from(expected_version)
                .map_err(|_| PutKeyringError::VersionOutOfRange(expected_version))?;
            sqlx::query_scalar(
                "UPDATE keyrings
                 SET envelope = $2::text::jsonb, version = version + 1, updated_at = now()
                 WHERE user_id = $1::uuid AND version = $3
                 RETURNING version",
            )
            .bind(user_id)
            .bind(envelope)
            .bind(expected)
            .fetch_optional(&self.db)
            .await?
        };
        version.ok_or(PutKeyringError::VersionConflict)
    }
}
