//! Friend codes -- a port of
//! `apps/api/src/repositories/friendCodeRepository.ts`.
//!
//! Each user has exactly one row: their current code. A spent code is
//! replaced in place, so nothing records who redeemed whose code -- that
//! would be a plaintext edge in the social graph the capability model
//! exists to avoid storing (see `docs/ARCHITECTURE.md`).

use serde::Serialize;
use sqlx::PgPool;

use crate::app::iso_millis;

/// Codes are shown to humans and retyped, so the alphabet deliberately
/// excludes characters that are easy to confuse (0/O, 1/I/l). 8 characters
/// from a 31-symbol alphabet is ~39 bits -- far beyond guessing range for a
/// value that is single-use, rate-limited, and replaced the moment it's
/// redeemed.
const ALPHABET: &[u8] = b"23456789ABCDEFGHJKMNPQRSTUVWXYZ";

/// Codes are uppercase from [`ALPHABET`] and usernames are lowercase, so a
/// tag can be told apart without asking which kind it is.
pub fn is_friend_code(s: &str) -> bool {
    s.len() == 8 && s.bytes().all(|b| ALPHABET.contains(&b))
}

fn generate_friend_code() -> Result<String, getrandom::Error> {
    let mut bytes = [0u8; 8];
    getrandom::fill(&mut bytes)?;
    Ok(bytes
        .iter()
        .map(|b| ALPHABET[usize::from(*b) % ALPHABET.len()] as char)
        .collect())
}

/// A user's current code, as sent to the client.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FriendCodeRecord {
    pub code: String,
    /// `Date.prototype.toISOString` form: UTC, milliseconds, `Z`.
    pub created_at: String,
}

#[derive(Debug, thiserror::Error)]
pub enum FriendCodeError {
    #[error(transparent)]
    Random(#[from] getrandom::Error),
    #[error(transparent)]
    Database(#[from] sqlx::Error),
}

/// User ids are bound as text and cast by Postgres, as node-pg sent them
/// (so an upper-case id from a token still matches, and one that is no UUID
/// is a database error -- every caller passes an id from a verified token).
#[derive(Clone)]
pub struct FriendCodeRepository {
    db: PgPool,
}

impl FriendCodeRepository {
    pub fn new(db: PgPool) -> Self {
        Self { db }
    }

    /// Returns the user's code, creating one on first use. Safe to call
    /// repeatedly.
    pub async fn get_or_create(&self, user_id: &str) -> Result<FriendCodeRecord, FriendCodeError> {
        // DO UPDATE with a no-op rather than DO NOTHING so RETURNING yields
        // the existing row too, keeping this a single round trip.
        let row: (String, chrono::DateTime<chrono::Utc>) = sqlx::query_as(
            "INSERT INTO friend_codes (user_id, code) VALUES ($1::uuid, $2)
             ON CONFLICT (user_id) DO UPDATE SET user_id = EXCLUDED.user_id
             RETURNING code, created_at",
        )
        .bind(user_id)
        .bind(generate_friend_code()?)
        .fetch_one(&self.db)
        .await?;
        Ok(FriendCodeRecord {
            code: row.0,
            created_at: iso_millis(row.1),
        })
    }

    /// Resolves a code to its owner and replaces it in one statement.
    /// Returns `None` if the code is unknown, already spent, or the
    /// redeemer's own -- callers must not distinguish those cases, or the
    /// endpoint becomes a code oracle.
    ///
    /// The conditional UPDATE is what makes this atomic: of two people
    /// racing to redeem the same code, only one matches.
    pub async fn redeem(
        &self,
        code: &str,
        redeemer_id: &str,
    ) -> Result<Option<String>, FriendCodeError> {
        let owner_id: Option<String> = sqlx::query_scalar(
            "UPDATE friend_codes SET code = $3, created_at = now()
             WHERE code = $1 AND user_id <> $2::uuid
             RETURNING user_id::text",
        )
        .bind(code)
        .bind(redeemer_id)
        .bind(generate_friend_code()?)
        .fetch_optional(&self.db)
        .await?;
        Ok(owner_id)
    }

    /// Replaces the current code, for when a user thinks it has leaked.
    pub async fn rotate(&self, user_id: &str) -> Result<FriendCodeRecord, FriendCodeError> {
        let row: (String, chrono::DateTime<chrono::Utc>) = sqlx::query_as(
            "INSERT INTO friend_codes (user_id, code) VALUES ($1::uuid, $2)
             ON CONFLICT (user_id) DO UPDATE SET code = EXCLUDED.code, created_at = now()
             RETURNING code, created_at",
        )
        .bind(user_id)
        .bind(generate_friend_code()?)
        .fetch_one(&self.db)
        .await?;
        Ok(FriendCodeRecord {
            code: row.0,
            created_at: iso_millis(row.1),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn friend_code_pattern_matches_the_alphabet_only() {
        assert!(is_friend_code("23456789"));
        assert!(is_friend_code("ABCDEFGH"));
        assert!(!is_friend_code("2345678")); // 7 chars
        assert!(!is_friend_code("234567890")); // 9 chars
        assert!(!is_friend_code("0123456I")); // excluded chars: 0, 1, I
        assert!(!is_friend_code("abcdefgh")); // lowercase
        assert!(!is_friend_code(""));
    }

    #[test]
    fn generated_codes_match_the_pattern() {
        for _ in 0..100 {
            let code = generate_friend_code().unwrap();
            assert!(is_friend_code(&code), "{code}");
        }
    }
}
