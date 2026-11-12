//! The users repository -- a port of
//! `apps/api/src/repositories/userRepository.ts`.

use chrono::{DateTime, SecondsFormat, Utc};
use sqlx::{FromRow, PgPool};
use thiserror::Error;
use uuid::Uuid;

/// An account as stored. `auth_hash` is base64(sha256(authKey)), never a
/// password or an encryption key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UserRecord {
    pub id: String,
    pub username: String,
    pub display_name: String,
    pub public_key: String,
    pub auth_salt: String,
    pub auth_hash: String,
    /// `Date.prototype.toISOString` form: UTC, milliseconds, `Z`.
    pub created_at: String,
}

#[derive(FromRow)]
struct UserRow {
    id: Uuid,
    username: String,
    display_name: String,
    public_key: String,
    auth_salt: String,
    auth_hash: String,
    created_at: DateTime<Utc>,
}

impl From<UserRow> for UserRecord {
    fn from(row: UserRow) -> Self {
        Self {
            id: row.id.to_string(),
            username: row.username,
            display_name: row.display_name,
            public_key: row.public_key,
            auth_salt: row.auth_salt,
            auth_hash: row.auth_hash,
            // node-pg reads `timestamptz` into a millisecond `Date`
            // (truncating microseconds); `toISOString` then prints it.
            created_at: row.created_at.to_rfc3339_opts(SecondsFormat::Millis, true),
        }
    }
}

pub struct NewUser<'a> {
    pub username: &'a str,
    pub display_name: &'a str,
    pub public_key: &'a str,
    pub auth_salt: &'a str,
    pub auth_hash: &'a str,
}

#[derive(Debug, Error)]
pub enum CreateUserError {
    #[error("username already taken")]
    UsernameTaken,
    #[error(transparent)]
    Database(#[from] sqlx::Error),
}

macro_rules! columns {
    () => {
        "id, username, display_name, public_key, auth_salt, auth_hash, created_at"
    };
}

#[derive(Clone)]
pub struct UserRepository {
    db: PgPool,
}

impl UserRepository {
    pub fn new(db: PgPool) -> Self {
        Self { db }
    }

    pub async fn create(&self, user: NewUser<'_>) -> Result<UserRecord, CreateUserError> {
        let row: UserRow = sqlx::query_as(concat!(
            "INSERT INTO users (username, display_name, public_key, auth_salt, auth_hash)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING ",
            columns!()
        ))
        .bind(user.username)
        .bind(user.display_name)
        .bind(user.public_key)
        .bind(user.auth_salt)
        .bind(user.auth_hash)
        .fetch_one(&self.db)
        .await
        .map_err(|err| {
            if err.as_database_error().and_then(|e| e.code()).as_deref() == Some("23505") {
                CreateUserError::UsernameTaken
            } else {
                CreateUserError::Database(err)
            }
        })?;
        Ok(row.into())
    }

    pub async fn find_by_username(
        &self,
        username: &str,
    ) -> Result<Option<UserRecord>, sqlx::Error> {
        let row: Option<UserRow> = sqlx::query_as(concat!(
            "SELECT ",
            columns!(),
            " FROM users WHERE username = $1"
        ))
        .bind(username)
        .fetch_optional(&self.db)
        .await?;
        Ok(row.map(Into::into))
    }

    /// `None` for a string that isn't a UUID: no such user (the TS
    /// repository's query would have failed on the cast instead; every
    /// caller passes an id it got from the database or a token).
    pub async fn find_by_id(&self, id: &str) -> Result<Option<UserRecord>, sqlx::Error> {
        let Ok(id) = Uuid::parse_str(id) else {
            return Ok(None);
        };
        let row: Option<UserRow> =
            sqlx::query_as(concat!("SELECT ", columns!(), " FROM users WHERE id = $1"))
                .bind(id)
                .fetch_optional(&self.db)
                .await?;
        Ok(row.map(Into::into))
    }

    /// Replaces a user's stored public key. Only ever called from login,
    /// after the password has been proven -- see `routes::auth`.
    pub async fn update_public_key(&self, id: &str, public_key: &str) -> Result<bool, sqlx::Error> {
        let Ok(id) = Uuid::parse_str(id) else {
            return Ok(false);
        };
        let result = sqlx::query("UPDATE users SET public_key = $2 WHERE id = $1")
            .bind(id)
            .bind(public_key)
            .execute(&self.db)
            .await?;
        Ok(result.rows_affected() > 0)
    }
}
