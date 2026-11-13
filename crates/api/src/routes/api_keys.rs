//! Minting, listing and revoking API keys -- a port of
//! `apps/api/src/routes/apiKeyRoutes.ts`. Every route needs a signed-in
//! user; a user only ever sees and revokes their own keys.

use axum::{
    body::Body,
    extract::{OriginalUri, Request, State},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use mekur_shared::CreateApiKeyRequest;
use serde::Serialize;

use crate::{
    AppState,
    api_keys::{ApiKeyRecord, generate_api_key, hash_api_key},
    app::{internal_error, invalid_request, json, json_value, percent_decode},
    auth::{AuthMethod, authenticate},
    body::{BODY_LIMIT, read_body},
};

/// `POST /api-keys`: mint a key. The raw key is in this reply and nowhere
/// else, ever: only its hash is stored.
pub async fn create(State(state): State<AppState>, request: Request) -> Response {
    let (parts, body) = request.into_parts();
    let body = match read_body(&parts.headers, body, BODY_LIMIT).await {
        Ok(body) => body,
        Err(reply) => return reply,
    };
    let user = match authenticate(&state, &parts.headers).await {
        Ok(user) => user,
        Err(reply) => return reply,
    };
    // An API key must not be able to mint further keys: one leaked key would
    // otherwise become an unbounded, self-renewing set that survives its own
    // revocation.
    if user.method != AuthMethod::Session {
        return json(
            StatusCode::FORBIDDEN,
            r#"{"error":"API keys can only be created from a signed-in session."}"#,
        );
    }
    let request = match CreateApiKeyRequest::parse_optional(body.as_ref()) {
        Ok(request) => request,
        Err(err) => return invalid_request(&err),
    };
    let generated = match generate_api_key() {
        Ok(generated) => generated,
        Err(err) => return internal_error(&err),
    };
    let created = state
        .api_keys
        .create(
            &user.user_id,
            &request.name,
            &generated.key_prefix,
            &hash_api_key(&generated.raw_key),
        )
        .await;
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Created<'a> {
        api_key: ApiKeyRecord,
        raw_key: &'a str,
    }
    match created {
        Ok(api_key) => json_value(
            StatusCode::CREATED,
            &Created {
                api_key,
                raw_key: &generated.raw_key,
            },
        ),
        Err(err) => internal_error(&err),
    }
}

/// `GET /api-keys`: the user's keys, newest first. (Fastify read no body
/// for a `GET`, so neither does this.)
pub async fn list(State(state): State<AppState>, request: Request) -> Response {
    let user = match authenticate(&state, request.headers()).await {
        Ok(user) => user,
        Err(reply) => return reply,
    };
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct List {
        api_keys: Vec<ApiKeyRecord>,
    }
    match state.api_keys.list_for_user(&user.user_id).await {
        Ok(api_keys) => json_value(StatusCode::OK, &List { api_keys }),
        Err(err) => internal_error(&err),
    }
}

/// `DELETE /api-keys/{id}`: revoke one of the user's keys; it stops
/// working at once. Someone else's key is "not found", as is an id that
/// isn't a UUID.
///
/// The id is read from the raw path and percent-decoded, as Fastify decoded
/// route parameters; it may be empty (`/api-keys/`), as in Fastify.
pub async fn revoke(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    request: Request,
) -> Response {
    let (parts, body) = request.into_parts();
    if let Err(reply) = read_body(&parts.headers, body, BODY_LIMIT).await {
        return reply;
    }
    let user = match authenticate(&state, &parts.headers).await {
        Ok(user) => user,
        Err(reply) => return reply,
    };
    let raw = uri.path().strip_prefix("/api-keys/").unwrap_or_default();
    // `reject_bad_url` has already refused undecodable paths.
    let id = percent_decode(raw).unwrap_or_default();
    if !is_zod_uuid(&id) {
        return not_found();
    }
    match state.api_keys.revoke_for_user(&id, &user.user_id).await {
        Ok(true) => (StatusCode::NO_CONTENT, Body::empty()).into_response(),
        Ok(false) => not_found(),
        Err(err) => internal_error(&err),
    }
}

fn not_found() -> Response {
    json(StatusCode::NOT_FOUND, r#"{"error":"Not found"}"#)
}

/// Zod 3's `z.string().uuid()`: 8-4-4-4-12 hex digits in either case, any
/// version or variant. Narrower than `Uuid::parse_str`, which also takes
/// braces, URNs and the unhyphenated form.
pub fn is_zod_uuid(s: &str) -> bool {
    s.len() == 36
        && s.bytes().enumerate().all(|(i, b)| match i {
            8 | 13 | 18 | 23 => b == b'-',
            _ => b.is_ascii_hexdigit(),
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uuids_as_zod_checks_them() {
        for ok in [
            "1a000000-0000-4000-8000-00000000000a",
            "FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF",
            "00000000-0000-0000-0000-000000000000",
        ] {
            assert!(is_zod_uuid(ok), "{ok}");
        }
        for bad in [
            "",
            "not-a-uuid",
            "1a00000000004000800000000000000a",
            "{1a000000-0000-4000-8000-00000000000a}",
            "urn:uuid:1a000000-0000-4000-8000-00000000000a",
            "1a000000-0000-4000-8000-00000000000a\n",
            "1a000000-0000-4000-8000-00000000000g",
            "1a0000000-000-4000-8000-00000000000a",
        ] {
            assert!(!is_zod_uuid(bad), "{bad:?}");
        }
    }
}
