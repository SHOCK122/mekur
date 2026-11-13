//! Who a request is from -- a port of `apps/api/src/plugins/auth.ts`.
//!
//! A request authenticates with `Authorization: Bearer <token>`, where the
//! token is either a session token (a JWT from login or registration) or an
//! API key (`sak_...`). There is no session store: a JWT is verified, an API
//! key is a hash lookup.
//!
//! Handlers call [`authenticate`] themselves, after reading the body,
//! rather than taking an extractor: Fastify parsed the body before its
//! `preHandler` hooks ran, so a malformed body is a 400 (or 415) even
//! without credentials, and the replies must keep that order.

use axum::{
    http::{HeaderMap, StatusCode, header},
    response::Response,
};

use crate::{
    AppState,
    api_keys::{hash_api_key, looks_like_api_key},
    app::{internal_error, json},
    body::is_js_whitespace,
    jwt,
};

/// How a request authenticated. Some actions (minting API keys) are
/// reserved for interactive sessions.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthMethod {
    Session,
    ApiKey,
}

/// An authenticated request's user.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthUser {
    /// As the token or key named it. From an API key it is a stored id; from
    /// a session token it is whatever the (verified) token says, which
    /// Postgres casts to a UUID where it is used.
    pub user_id: String,
    pub method: AuthMethod,
}

/// The user behind the request's `Authorization` header, or the reply to
/// send instead: 401 `{"error":"Unauthorized"}` for missing, malformed,
/// expired, forged or revoked credentials.
pub async fn authenticate(state: &AppState, headers: &HeaderMap) -> Result<AuthUser, Response> {
    // Node reads header bytes as Latin-1.
    let header = headers.get(header::AUTHORIZATION).map(|value| {
        value
            .as_bytes()
            .iter()
            .map(|&b| char::from(b))
            .collect::<String>()
    });
    let Some(header) = header else {
        return Err(unauthorized());
    };

    // An API key: exactly `Bearer ` (case-sensitive, one space) then the
    // key, everything after the space included.
    if let Some(token) = header.strip_prefix("Bearer ")
        && looks_like_api_key(token)
    {
        return match state
            .api_keys
            .find_user_id_by_hash(&hash_api_key(token))
            .await
        {
            Ok(Some(user_id)) => Ok(AuthUser {
                user_id,
                method: AuthMethod::ApiKey,
            }),
            Ok(None) => Err(unauthorized()),
            Err(err) => Err(internal_error(&err)),
        };
    }

    let user_id = session_token(&header)
        .and_then(|token| jwt::verify(&state.jwt_secret, token, jwt::now_ms()))
        .and_then(|claims| claims.get("userId")?.as_str().map(str::to_owned));
    match user_id {
        Some(user_id) => Ok(AuthUser {
            user_id,
            method: AuthMethod::Session,
        }),
        None => Err(unauthorized()),
    }
}

/// The token `@fastify/jwt` read from the header: it must match
/// `/^Bearer\s/i`, and split on `' '` into exactly two parts, the second
/// being the token. (So `bearer x` works, `Bearer  x` and `Bearer\tx`
/// don't.)
fn session_token(header: &str) -> Option<&str> {
    let mut chars = header.char_indices();
    let scheme_ok = header
        .get(..6)
        .is_some_and(|s| s.eq_ignore_ascii_case("bearer"))
        // JavaScript's regex `\s` is the same set as `trim`'s whitespace.
        && chars.nth(6).is_some_and(|(_, c)| is_js_whitespace(c));
    if !scheme_ok {
        return None;
    }
    let (_, token) = header.split_once(' ')?;
    (!token.contains(' ')).then_some(token)
}

fn unauthorized() -> Response {
    json(StatusCode::UNAUTHORIZED, r#"{"error":"Unauthorized"}"#)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_token_follows_fastify_jwt() {
        assert_eq!(session_token("Bearer abc"), Some("abc"));
        assert_eq!(session_token("bearer abc"), Some("abc"));
        assert_eq!(session_token("BeArEr abc"), Some("abc"));
        assert_eq!(session_token("Bearer "), Some(""));
        // `\s` then exactly one space somewhere: the token is what follows it.
        assert_eq!(session_token("Bearer\tx y"), Some("y"));
        for bad in [
            "",
            "Bearer",
            "Bearerabc",
            "Bearer  abc",
            "Bearer\tabc",
            "Bearer abc ",
            "Basic abc",
            "abc",
            "Bearér abc",
        ] {
            assert_eq!(session_token(bad), None, "{bad:?}");
        }
    }
}
