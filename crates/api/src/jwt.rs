//! Session tokens: HS256 JWTs carrying `{ userId, iat, exp }`, exactly what
//! `@fastify/jwt` issued, so the TS server accepts the Rust server's tokens
//! and vice versa while both run (they share `JWT_SECRET`).

use jsonwebtoken::{Algorithm, EncodingKey, Header};
use serde::Serialize;

/// Session tokens expire after 30 days: a stolen token must not stay valid
/// forever, and a personal calendar shouldn't force constant re-logins.
/// Agent clients use API keys, which are individually revocable.
pub const TOKEN_TTL_SECS: i64 = 30 * 24 * 60 * 60;

/// The claims, in `@fastify/jwt`'s order.
#[derive(Serialize)]
struct Claims<'a> {
    #[serde(rename = "userId")]
    user_id: &'a str,
    iat: i64,
    exp: i64,
}

/// A session token for `user_id`, issued at `now` (Unix seconds).
pub fn issue_token(secret: &str, user_id: &str, now: i64) -> String {
    let claims = Claims {
        user_id,
        iat: now,
        exp: now + TOKEN_TTL_SECS,
    };
    jsonwebtoken::encode(
        &Header::new(Algorithm::HS256),
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .expect("HS256 signs with any key, and the claims always serialize")
}

/// The current time in Unix seconds.
pub fn now() -> i64 {
    chrono::Utc::now().timestamp()
}
