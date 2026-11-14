//! Events under the capability model: capability tokens and the event
//! repository -- a port of `apps/api/src/lib/capability.ts` and
//! `apps/api/src/repositories/eventRepository.ts`.
//!
//! Nothing here takes a user id. Authorisation is proven by presenting a
//! token, never by matching an identity against an access list, so the
//! database holds no link between an account and the events it can reach
//! (`docs/ARCHITECTURE.md`).

use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use chrono::{DateTime, Utc};
use mekur_shared::{BATCH_READ_LIMIT, CapabilityLevel, PresentedCapability};
use serde::Serialize;
use serde_json::value::RawValue;
use sha2::{Digest, Sha256};
use sqlx::{FromRow, PgPool};
use uuid::Uuid;

use crate::app::{iso_millis, minify_json};

/// A new capability token: 32 random bytes from the OS (256 bits),
/// base64url without padding, as `randomBytes(32).toString("base64url")`
/// made them. Holding one *is* the authorisation, so they are treated as
/// sensitive as passwords; only their hash is stored.
pub fn generate_capability_token() -> Result<String, getrandom::Error> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes)?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

/// base64(sha256(the token's UTF-8 bytes)) -- the stored form. A database
/// breach yields values that cannot be replayed.
pub fn hash_capability_token(token: &str) -> String {
    STANDARD.encode(Sha256::digest(token.as_bytes()))
}

/// A voter's per-event pseudonym: base64(sha256(
/// `schedule-app:pseudonym:v1:{eventId}:{token}`)). Derived from the
/// capability token plus the event id, so one person voting on two events
/// yields two unlinkable pseudonyms; deterministic, so re-voting updates
/// rather than duplicates. Not used by any route yet (group scheduling is
/// Phase 10); ported with its format so it can't drift.
pub fn derive_pseudonym(capability_token: &str, event_id: &str) -> String {
    let input = format!("schedule-app:pseudonym:v1:{event_id}:{capability_token}");
    STANDARD.encode(Sha256::digest(input.as_bytes()))
}

/// An event as a capability holder sees it. The envelope is opaque here:
/// the server never holds a key that opens it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventRecord {
    pub id: String,
    /// The stored JSON as `JSON.stringify(JSON.parse(jsonb text))` wrote it
    /// (jsonb's key order, no whitespace), so replies are byte-for-byte the
    /// TS server's.
    pub envelope: Box<RawValue>,
    /// `Date.prototype.toISOString` form: UTC, milliseconds, `Z`.
    pub created_at: String,
    pub updated_at: String,
}

#[derive(FromRow)]
struct EventRow {
    id: Uuid,
    envelope: String,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

impl TryFrom<EventRow> for EventRecord {
    type Error = sqlx::Error;

    fn try_from(row: EventRow) -> Result<Self, Self::Error> {
        let envelope = RawValue::from_string(minify_json(&row.envelope))
            .map_err(|err| sqlx::Error::Decode(Box::new(err)))?;
        Ok(Self {
            id: row.id.to_string(),
            envelope,
            created_at: iso_millis(row.created_at),
            updated_at: iso_millis(row.updated_at),
        })
    }
}

fn records(rows: Vec<EventRow>) -> Result<Vec<EventRecord>, sqlx::Error> {
    rows.into_iter().map(EventRecord::try_from).collect()
}

/// A created event and its two capabilities. The tokens are returned
/// exactly once: the client keeps them in its keyring, and the server,
/// holding only hashes, cannot re-issue them.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedEvent {
    pub event: EventRecord,
    pub view_token: String,
    pub edit_token: String,
}

/// Why a repository call failed.
#[derive(Debug, thiserror::Error)]
pub enum EventError {
    #[error(transparent)]
    Database(#[from] sqlx::Error),
    #[error("no randomness for a capability token: {0}")]
    Random(#[from] getrandom::Error),
}

macro_rules! columns {
    () => {
        "id, envelope::text AS envelope, created_at, updated_at"
    };
}

/// A capability counts only while unrevoked and unexpired. Shared by
/// every lookup so the rule can't drift between single and batch reads.
macro_rules! live {
    () => {
        "c.revoked_at IS NULL AND (c.expires_at IS NULL OR c.expires_at > now())"
    };
}

/// Event ids are bound as text and cast by Postgres, as node-pg sent them
/// (so an upper-case id still matches). Callers check them with Zod's UUID
/// rule first, so the cast never fails.
#[derive(Clone)]
pub struct EventRepository {
    db: PgPool,
}

impl EventRepository {
    pub fn new(db: PgPool) -> Self {
        Self { db }
    }

    /// Whether `token` is a live capability on `event_id` granting at least
    /// `required`.
    pub async fn resolve_capability(
        &self,
        event_id: &str,
        token: &str,
        required: CapabilityLevel,
    ) -> Result<bool, sqlx::Error> {
        let level: Option<String> = sqlx::query_scalar(concat!(
            "SELECT c.level FROM event_capabilities c
             WHERE c.event_id = $1::uuid AND c.token_hash = $2 AND ",
            live!()
        ))
        .bind(event_id)
        .bind(hash_capability_token(token))
        .fetch_optional(&self.db)
        .await?;
        Ok(match (level.as_deref(), required) {
            (None, _) => false,
            // An edit capability implies view; the reverse must never hold.
            (Some(_), CapabilityLevel::View) => true,
            (Some(level), CapabilityLevel::Edit) => level == "edit",
        })
    }

    /// Stores a new event with a view and an edit capability, in one
    /// transaction.
    pub async fn create(&self, envelope: &serde_json::Value) -> Result<CreatedEvent, EventError> {
        let view_token = generate_capability_token()?;
        let edit_token = generate_capability_token()?;
        let mut tx = self.db.begin().await?;
        let row: EventRow = sqlx::query_as(concat!(
            "INSERT INTO events (envelope) VALUES ($1::text::jsonb) RETURNING ",
            columns!()
        ))
        .bind(envelope.to_string())
        .fetch_one(&mut *tx)
        .await?;
        for (token, level) in [(&view_token, "view"), (&edit_token, "edit")] {
            sqlx::query(
                "INSERT INTO event_capabilities (event_id, token_hash, level) VALUES ($1, $2, $3)",
            )
            .bind(row.id)
            .bind(hash_capability_token(token))
            .bind(level)
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await?;
        Ok(CreatedEvent {
            event: row.try_into()?,
            view_token,
            edit_token,
        })
    }

    /// The event, if `token` grants view on it.
    pub async fn find_by_capability(
        &self,
        event_id: &str,
        token: &str,
    ) -> Result<Option<EventRecord>, sqlx::Error> {
        if !self
            .resolve_capability(event_id, token, CapabilityLevel::View)
            .await?
        {
            return Ok(None);
        }
        let row: Option<EventRow> = sqlx::query_as(concat!(
            "SELECT ",
            columns!(),
            " FROM events WHERE id = $1::uuid"
        ))
        .bind(event_id)
        .fetch_optional(&self.db)
        .await?;
        row.map(EventRecord::try_from).transpose()
    }

    /// Batch read for the timeline: the client presents the capabilities it
    /// holds from its keyring. One query however many are presented, and
    /// bounded (the first [`BATCH_READ_LIMIT`]) so one request can't ask for
    /// unlimited work. Entries whose capability is missing, revoked or
    /// expired are simply absent; each event appears once.
    pub async fn find_many_by_capabilities(
        &self,
        entries: &[PresentedCapability],
    ) -> Result<Vec<EventRecord>, sqlx::Error> {
        let bounded = &entries[..entries.len().min(BATCH_READ_LIMIT)];
        if bounded.is_empty() {
            return Ok(Vec::new());
        }
        let ids: Vec<&str> = bounded.iter().map(|e| e.event_id.as_str()).collect();
        let hashes: Vec<String> = bounded
            .iter()
            .map(|e| hash_capability_token(&e.token))
            .collect();
        let rows: Vec<EventRow> = sqlx::query_as(concat!(
            "SELECT DISTINCT e.id, e.envelope::text AS envelope, e.created_at, e.updated_at
             FROM unnest($1::text[]::uuid[], $2::text[]) AS presented(event_id, token_hash)
             JOIN event_capabilities c
               ON c.event_id = presented.event_id AND c.token_hash = presented.token_hash
             JOIN events e ON e.id = c.event_id
             WHERE ",
            live!()
        ))
        .bind(ids)
        .bind(hashes)
        .fetch_all(&self.db)
        .await?;
        records(rows)
    }

    /// Replaces the envelope, if `token` grants edit.
    pub async fn update(
        &self,
        event_id: &str,
        token: &str,
        envelope: &serde_json::Value,
    ) -> Result<Option<EventRecord>, sqlx::Error> {
        if !self
            .resolve_capability(event_id, token, CapabilityLevel::Edit)
            .await?
        {
            return Ok(None);
        }
        let row: Option<EventRow> = sqlx::query_as(concat!(
            "UPDATE events SET envelope = $2::text::jsonb, updated_at = now() WHERE id = $1::uuid
             RETURNING ",
            columns!()
        ))
        .bind(event_id)
        .bind(envelope.to_string())
        .fetch_optional(&self.db)
        .await?;
        row.map(EventRecord::try_from).transpose()
    }

    /// Deletes the event (and, by cascade, its capabilities), if `token`
    /// grants edit. Whether it did.
    pub async fn remove(&self, event_id: &str, token: &str) -> Result<bool, sqlx::Error> {
        if !self
            .resolve_capability(event_id, token, CapabilityLevel::Edit)
            .await?
        {
            return Ok(false);
        }
        let result = sqlx::query("DELETE FROM events WHERE id = $1::uuid")
            .bind(event_id)
            .execute(&self.db)
            .await?;
        Ok(result.rows_affected() > 0)
    }

    /// Mints an additional capability (e.g. a reusable join code), if
    /// `edit_token` grants edit. The new token, returned once.
    pub async fn mint_capability(
        &self,
        event_id: &str,
        edit_token: &str,
        level: CapabilityLevel,
        expires_at: Option<DateTime<Utc>>,
    ) -> Result<Option<String>, EventError> {
        if !self
            .resolve_capability(event_id, edit_token, CapabilityLevel::Edit)
            .await?
        {
            return Ok(None);
        }
        let token = generate_capability_token()?;
        sqlx::query(
            "INSERT INTO event_capabilities (event_id, token_hash, level, expires_at)
             VALUES ($1::uuid, $2, $3, $4)",
        )
        .bind(event_id)
        .bind(hash_capability_token(&token))
        .bind(level.as_str())
        .bind(expires_at)
        .execute(&self.db)
        .await?;
        Ok(Some(token))
    }

    /// Revokes the live-or-expired, unrevoked capability `target` on the
    /// event, if `edit_token` grants edit. Stops future use; it cannot
    /// retract a token already copied -- real revocation means re-keying the
    /// event. Whether a capability was revoked.
    pub async fn revoke_capability(
        &self,
        event_id: &str,
        edit_token: &str,
        target: &str,
    ) -> Result<bool, sqlx::Error> {
        if !self
            .resolve_capability(event_id, edit_token, CapabilityLevel::Edit)
            .await?
        {
            return Ok(false);
        }
        let result = sqlx::query(
            "UPDATE event_capabilities SET revoked_at = now()
             WHERE event_id = $1::uuid AND token_hash = $2 AND revoked_at IS NULL",
        )
        .bind(event_id)
        .bind(hash_capability_token(target))
        .execute(&self.db)
        .await?;
        Ok(result.rows_affected() > 0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_have_the_ts_format() {
        let a = generate_capability_token().unwrap();
        let b = generate_capability_token().unwrap();
        assert_ne!(a, b);
        for token in [&a, &b] {
            assert_eq!(token.len(), 43);
            assert!(
                token
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
            );
        }
    }

    #[test]
    fn hashes_match_node() {
        // createHash("sha256").update(t, "utf8").digest("base64") in Node.
        assert_eq!(
            hash_capability_token("abc"),
            "ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0="
        );
        assert_eq!(
            hash_capability_token("é"),
            STANDARD.encode(Sha256::digest("é".as_bytes()))
        );
    }

    #[test]
    fn pseudonyms_match_node() {
        // Node: derivePseudonym("tok", "ce000000-0000-4000-8000-000000000001").
        assert_eq!(
            derive_pseudonym("tok", "ce000000-0000-4000-8000-000000000001"),
            PSEUDONYM_FROM_NODE
        );
        assert_ne!(
            derive_pseudonym("tok", "ce000000-0000-4000-8000-000000000001"),
            derive_pseudonym("tok", "ce000000-0000-4000-8000-000000000002")
        );
    }

    const PSEUDONYM_FROM_NODE: &str = "RrgcWci1Azs1CI5ZXfs09zUVJmrc17yZOrfL2EJzETw=";
}
