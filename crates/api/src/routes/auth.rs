//! Registration, login and the salt lookup -- a port of
//! `apps/api/src/routes/authRoutes.ts`.

use axum::{
    extract::{OriginalUri, Request, State},
    http::StatusCode,
    response::Response,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use mekur_shared::{LoginRequest, RegisterRequest};
use serde::Serialize;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

use crate::{
    AppState,
    app::{internal_error, invalid_request, json_value, percent_decode},
    body::{BODY_LIMIT, read_body},
    jwt::{issue_token, now},
    node_base64,
    users::{CreateUserError, NewUser, UserRecord},
};

/// What a client may see of an account: never the auth hash or salt.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PublicUser<'a> {
    id: &'a str,
    username: &'a str,
    display_name: &'a str,
    public_key: &'a str,
    created_at: &'a str,
}

impl<'a> From<&'a UserRecord> for PublicUser<'a> {
    fn from(user: &'a UserRecord) -> Self {
        Self {
            id: &user.id,
            username: &user.username,
            display_name: &user.display_name,
            public_key: &user.public_key,
            created_at: &user.created_at,
        }
    }
}

#[derive(Serialize)]
struct Session<'a> {
    user: PublicUser<'a>,
    token: String,
}

fn session<'a>(state: &AppState, user: &'a UserRecord) -> Session<'a> {
    Session {
        user: user.into(),
        token: issue_token(&state.jwt_secret, &user.id, now()),
    }
}

/// base64(sha256(the auth key's bytes)) -- the TS server's
/// `sha256Base64(authKey)`, decoding the key with Node's lenient base64
/// decoder, so every stored hash keeps verifying. The server hashes the
/// received auth key itself and never trusts a value the client claims is
/// already hashed, so a leaked stored hash is not, by itself, a replayable
/// credential.
fn auth_hash(auth_key: &str) -> String {
    STANDARD.encode(Sha256::digest(node_base64::decode(auth_key)))
}

fn error(status: StatusCode, message: &str) -> Response {
    json_value(status, &serde_json::json!({ "error": message }))
}

/// `POST /users`: create an account and start a session.
pub async fn register(State(state): State<AppState>, request: Request) -> Response {
    let (parts, body) = request.into_parts();
    let body = match read_body(&parts.headers, body, BODY_LIMIT).await {
        Ok(body) => body,
        Err(reply) => return reply,
    };
    let request = match RegisterRequest::parse_optional(body.as_ref()) {
        Ok(request) => request,
        Err(err) => return invalid_request(&err),
    };
    let created = state
        .users
        .create(NewUser {
            username: &request.username,
            display_name: &request.display_name,
            public_key: &request.public_key,
            auth_salt: &request.auth_salt,
            auth_hash: &auth_hash(&request.auth_key),
        })
        .await;
    match created {
        Ok(user) => json_value(StatusCode::CREATED, &session(&state, &user)),
        Err(CreateUserError::UsernameTaken) => {
            error(StatusCode::CONFLICT, "Username already taken")
        }
        Err(CreateUserError::Database(err)) => internal_error(&err),
    }
}

/// `POST /sessions`: log in with the auth key derived from the password.
pub async fn login(State(state): State<AppState>, request: Request) -> Response {
    let (parts, body) = request.into_parts();
    let body = match read_body(&parts.headers, body, BODY_LIMIT).await {
        Ok(body) => body,
        Err(reply) => return reply,
    };
    let request = match LoginRequest::parse_optional(body.as_ref()) {
        Ok(request) => request,
        Err(err) => return invalid_request(&err),
    };
    let mut user = match state.users.find_by_username(&request.username).await {
        Ok(user) => user,
        Err(err) => return internal_error(&err),
    };
    let proven = user.as_ref().is_some_and(|user| {
        bool::from(
            auth_hash(&request.auth_key)
                .as_bytes()
                .ct_eq(user.auth_hash.as_bytes()),
        )
    });
    let Some(user) = user.as_mut().filter(|_| proven) else {
        // The same reply for "no such user" and "wrong key", so login
        // can't be used to enumerate usernames.
        return error(StatusCode::UNAUTHORIZED, "Invalid username or password");
    };

    // Self-heal a stale public key. Accounts created before the identity
    // keypair was derived from the password registered a RANDOM key whose
    // private half was discarded, so nothing sealed to it can be opened.
    // The key the client derives is authoritative -- it's the only one
    // anyone holds the private half of.
    //
    // This lives here, not behind its own endpoint, because swapping an
    // account's public key redirects every future invitation to whoever
    // holds the new private key. Only a request that has just proven
    // knowledge of the password may do that; a stolen JWT or API key must
    // not.
    if let Some(public_key) = request.public_key
        && public_key != user.public_key
    {
        if let Err(err) = state.users.update_public_key(&user.id, &public_key).await {
            return internal_error(&err);
        }
        user.public_key = public_key;
    }
    json_value(StatusCode::OK, &session(&state, user))
}

/// `GET /users/{username}/salt`: the auth salt, so a client can re-derive
/// its keys before logging in. Deliberately public (a user needs it before
/// they have a token), which confirms whether a username exists -- a
/// small, accepted trade-off.
///
/// The username is read from the raw path and percent-decoded here, as
/// Fastify decoded route parameters (`a%2Fb` is the username `a/b`, which
/// doesn't exist). It may be empty (`/users//salt`), as in Fastify.
pub async fn salt(State(state): State<AppState>, OriginalUri(uri): OriginalUri) -> Response {
    let raw = uri
        .path()
        .strip_prefix("/users/")
        .and_then(|rest| rest.strip_suffix("/salt"))
        .unwrap_or_default();
    // `reject_bad_url` has already refused undecodable paths.
    let username = percent_decode(raw).unwrap_or_default();
    match state.users.find_by_username(&username).await {
        Ok(Some(user)) => json_value(
            StatusCode::OK,
            &serde_json::json!({ "authSalt": user.auth_salt }),
        ),
        Ok(None) => error(StatusCode::NOT_FOUND, "Not found"),
        Err(err) => internal_error(&err),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auth_hash_is_base64_sha256_of_the_decoded_key() {
        // sha256("") and sha256("abc"), base64-encoded: "YWJj" is "abc".
        assert_eq!(
            auth_hash(""),
            "47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU="
        );
        assert_eq!(
            auth_hash("YWJj"),
            "ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0="
        );
    }
}
