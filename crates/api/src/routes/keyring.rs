//! The account's encrypted keyring -- a port of
//! `apps/api/src/routes/keyringRoutes.ts`. Both routes need a signed-in
//! user, who only ever reads and writes their own keyring.
//!
//! Order, as in Fastify: `PUT` reads its body (400/413/415), then the
//! account is checked (401), then the body validated (400). `GET` reads no
//! body.

use axum::{
    extract::{Request, State},
    http::{HeaderMap, StatusCode},
    response::Response,
};
use mekur_shared::PutKeyringRequest;
use serde::Serialize;
use serde_json::value::RawValue;

use crate::{
    AppState,
    app::{internal_error, invalid_request, json, json_value},
    auth::{authenticate, body_then_account},
    keyrings::PutKeyringError,
};

/// The keyring is the one payload allowed past the global body limit: it
/// holds every capability the account has (see
/// `mekur_shared::MAX_KEYRING_CIPHERTEXT`).
pub const KEYRING_BODY_LIMIT: usize = 1536 * 1024;

/// `GET /keyring`: the account's keyring and its version.
pub async fn read(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let user = match authenticate(&state, &headers).await {
        Ok(user) => user,
        Err(reply) => return reply,
    };
    #[derive(Serialize)]
    struct Stored<'a> {
        keyring: Option<&'a RawValue>,
        version: i32,
    }
    match state.keyrings.get(&user.user_id).await {
        Ok(Some(keyring)) => json_value(
            StatusCode::OK,
            &Stored {
                keyring: Some(&keyring.envelope),
                version: keyring.version,
            },
        ),
        // A missing keyring is normal for a new account, not an error.
        Ok(None) => json_value(
            StatusCode::OK,
            &Stored {
                keyring: None,
                version: 0,
            },
        ),
        Err(err) => internal_error(&err),
    }
}

/// `PUT /keyring`: replace the keyring, if it is still at
/// `expectedVersion`.
pub async fn replace(State(state): State<AppState>, request: Request) -> Response {
    let (parts, body) = request.into_parts();
    let (body, user) = match body_then_account(&state, &parts, body, KEYRING_BODY_LIMIT).await {
        Ok(read) => read,
        Err(reply) => return reply,
    };
    let request = match PutKeyringRequest::parse_optional(body.as_ref()) {
        Ok(request) => request,
        Err(err) => return invalid_request(&err),
    };
    #[derive(Serialize)]
    struct Saved {
        version: i32,
    }
    match state
        .keyrings
        .put(&user.user_id, &request.envelope, request.expected_version)
        .await
    {
        Ok(version) => json_value(StatusCode::OK, &Saved { version }),
        // 409 rather than a silent overwrite: losing a keyring write means
        // permanently losing access to whatever events it was adding.
        Err(PutKeyringError::VersionConflict) => json(
            StatusCode::CONFLICT,
            r#"{"error":"Your keyring changed on another device. Reload and try again."}"#,
        ),
        Err(err) => internal_error(&err),
    }
}
