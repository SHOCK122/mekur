//! Minting, listing and revoking API keys -- a port of
//! `apps/api/src/routes/apiKeyRoutes.ts`. Every route needs a signed-in
//! user; a user only ever sees and revokes their own keys.

use axum::{
    extract::{OriginalUri, Request, State},
    http::StatusCode,
    response::Response,
};
use mekur_shared::{CreateApiKeyRequest, is_zod_uuid};
use serde::Serialize;

use crate::{
    AppState,
    api_keys::{ApiKeyRecord, generate_api_key, hash_api_key},
    app::{
        internal_error, invalid_request, json, json_value, no_content, path_param,
        resource_not_found,
    },
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
    let id = path_param(&uri, "/api-keys/", "");
    if !is_zod_uuid(&id) {
        return resource_not_found();
    }
    match state.api_keys.revoke_for_user(&id, &user.user_id).await {
        Ok(true) => no_content(),
        Ok(false) => resource_not_found(),
        Err(err) => internal_error(&err),
    }
}
