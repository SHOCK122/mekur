//! Events and their capabilities -- a port of
//! `apps/api/src/routes/eventRoutes.ts`.
//!
//! Every route here authorises by capability token, never by identity.
//! Requests still require a signed-in account (to rate-limit, and so the API
//! is no open relay), but *which* account is irrelevant to whether access is
//! granted -- that is what keeps the server ignorant of who can reach which
//! event. No handler passes the user id on.
//!
//! A missing or wrong capability always yields 404, never 403: telling
//! "exists but you may not" from "does not exist" would confirm an event's
//! existence to anyone probing ids.
//!
//! Order, as in Fastify: the body is read (400/413/415), then the account
//! checked (401), then the target -- a UUID id and a non-empty
//! `X-Event-Capability` -- (404), then the body validated (400), then the
//! capability resolved (404).

use axum::{
    body::Body,
    extract::{OriginalUri, Request, State},
    http::{HeaderMap, StatusCode, Uri, request::Parts},
    response::Response,
};
use mekur_shared::{
    BatchReadRequest, EventEnvelopeRequest, MintCapabilityRequest, RevokeCapabilityRequest,
    datetime::instant_millis, is_zod_uuid,
};
use serde::Serialize;
use serde_json::Value;

use crate::{
    AppState,
    app::{
        internal_error, invalid_request, json_value, no_content, path_param, resource_not_found,
    },
    auth::{authenticate, body_then_account},
    body::BODY_LIMIT,
    events::EventRecord,
};

/// The header a capability token is presented in.
const CAPABILITY_HEADER: &str = "x-event-capability";

/// What a per-event route acts on.
struct Target {
    event_id: String,
    token: String,
}

/// The event id (from the path) and the presented capability, or `None`
/// when either is missing or malformed -- answered with the same 404 as a
/// wrong capability.
fn target(uri: &Uri, headers: &HeaderMap, suffix: &str) -> Option<Target> {
    let event_id = path_param(uri, "/events/", suffix);
    let token = capability_header(headers)?;
    (is_zod_uuid(&event_id) && !token.is_empty()).then_some(Target { event_id, token })
}

/// `request.headers["x-event-capability"]` as Node gave it: each value's
/// bytes read as Latin-1, repeated headers joined with `", "`.
fn capability_header(headers: &HeaderMap) -> Option<String> {
    let mut values = headers.get_all(CAPABILITY_HEADER).iter().peekable();
    values.peek()?;
    let values: Vec<String> = values
        .map(|v| v.as_bytes().iter().map(|&b| char::from(b)).collect())
        .collect();
    Some(values.join(", "))
}

/// A validated `expiresAt` with no instant (the validator and the
/// conversion disagree): a bug, reported as a 500.
#[derive(Debug, thiserror::Error)]
#[error("validated expiry {0:?} names no instant")]
struct UnreadableExpiry(String);

/// Reads the body and authenticates, in Fastify's order. Returns the body
/// alone: which account it is must not matter to anything here.
async fn body_and_account(
    state: &AppState,
    parts: &Parts,
    body: Body,
) -> Result<Option<Value>, Response> {
    let (body, _) = body_then_account(state, parts, body, BODY_LIMIT).await?;
    Ok(body)
}

/// The validated envelope as stored: Zod's output (unknown keys stripped,
/// `v` and `algo` as their literals).
fn stored_envelope(request: &EventEnvelopeRequest) -> Value {
    serde_json::to_value(&request.envelope).expect("an envelope serializes")
}

#[derive(Serialize)]
struct One {
    event: EventRecord,
}

/// `POST /events`: store a new event. The reply carries its view and edit
/// tokens, exactly once.
pub async fn create(State(state): State<AppState>, request: Request) -> Result<Response, Response> {
    let (parts, body) = request.into_parts();
    let body = body_and_account(&state, &parts, body).await?;
    let request =
        EventEnvelopeRequest::parse_optional(body.as_ref()).map_err(|err| invalid_request(&err))?;
    match state.events.create(&stored_envelope(&request)).await {
        Ok(created) => Ok(json_value(StatusCode::CREATED, &created)),
        Err(err) => Err(internal_error(&err)),
    }
}

/// `POST /events/batch-read`: the events whose capabilities the client
/// presents -- the server cannot answer "list my events". At most 500, in
/// one query.
pub async fn batch_read(
    State(state): State<AppState>,
    request: Request,
) -> Result<Response, Response> {
    let (parts, body) = request.into_parts();
    let body = body_and_account(&state, &parts, body).await?;
    let request =
        BatchReadRequest::parse_optional(body.as_ref()).map_err(|err| invalid_request(&err))?;
    #[derive(Serialize)]
    struct Many {
        events: Vec<EventRecord>,
    }
    match state
        .events
        .find_many_by_capabilities(&request.events)
        .await
    {
        Ok(events) => Ok(json_value(StatusCode::OK, &Many { events })),
        Err(err) => Err(internal_error(&err)),
    }
}

/// `GET /events/{id}`: the event, with a view or edit capability. (Fastify
/// read no body for a `GET`, so neither does this.)
pub async fn read(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
) -> Response {
    if let Err(reply) = authenticate(&state, &headers).await {
        return reply;
    }
    let Some(t) = target(&uri, &headers, "") else {
        return resource_not_found();
    };
    match state.events.find_by_capability(&t.event_id, &t.token).await {
        Ok(Some(event)) => json_value(StatusCode::OK, &One { event }),
        Ok(None) => resource_not_found(),
        Err(err) => internal_error(&err),
    }
}

/// `PUT /events/{id}`: replace the envelope, with an edit capability.
pub async fn update(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    request: Request,
) -> Result<Response, Response> {
    let (parts, body) = request.into_parts();
    let body = body_and_account(&state, &parts, body).await?;
    let t = target(&uri, &parts.headers, "").ok_or_else(resource_not_found)?;
    let request =
        EventEnvelopeRequest::parse_optional(body.as_ref()).map_err(|err| invalid_request(&err))?;
    match state
        .events
        .update(&t.event_id, &t.token, &stored_envelope(&request))
        .await
    {
        Ok(Some(event)) => Ok(json_value(StatusCode::OK, &One { event })),
        Ok(None) => Err(resource_not_found()),
        Err(err) => Err(internal_error(&err)),
    }
}

/// `DELETE /events/{id}`: delete the event, with an edit capability. A body
/// is read (and must be well-formed) but ignored.
pub async fn remove(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    request: Request,
) -> Result<Response, Response> {
    let (parts, body) = request.into_parts();
    body_and_account(&state, &parts, body).await?;
    let t = target(&uri, &parts.headers, "").ok_or_else(resource_not_found)?;
    match state.events.remove(&t.event_id, &t.token).await {
        Ok(true) => Ok(no_content()),
        Ok(false) => Err(resource_not_found()),
        Err(err) => Err(internal_error(&err)),
    }
}

/// `POST /events/{id}/capabilities`: mint another capability -- how a
/// reusable join code is made. Needs an edit capability.
pub async fn mint(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    request: Request,
) -> Result<Response, Response> {
    let (parts, body) = request.into_parts();
    let body = body_and_account(&state, &parts, body).await?;
    let t = target(&uri, &parts.headers, "/capabilities").ok_or_else(resource_not_found)?;
    let request = MintCapabilityRequest::parse_optional(body.as_ref())
        .map_err(|err| invalid_request(&err))?;
    // `new Date(expiresAt)`: a validated datetime, to the millisecond. Never
    // silently dropped: a validated expiry that names no instant is a bug,
    // answered with a 500, not a capability that never expires.
    let expires_at = match request.expires_at.as_deref() {
        None => None,
        Some(at) => Some(
            instant_millis(at)
                .and_then(chrono::DateTime::from_timestamp_millis)
                .ok_or_else(|| internal_error(&UnreadableExpiry(at.to_owned())))?,
        ),
    };
    match state
        .events
        .mint_capability(&t.event_id, &t.token, request.level, expires_at)
        .await
    {
        Ok(Some(token)) => Ok(json_value(
            StatusCode::CREATED,
            &serde_json::json!({ "token": token }),
        )),
        Ok(None) => Err(resource_not_found()),
        Err(err) => Err(internal_error(&err)),
    }
}

/// `POST /events/{id}/capabilities/revoke`: revoke one of the event's
/// capabilities. Needs an edit capability (which may revoke itself).
pub async fn revoke(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    request: Request,
) -> Result<Response, Response> {
    let (parts, body) = request.into_parts();
    let body = body_and_account(&state, &parts, body).await?;
    let t = target(&uri, &parts.headers, "/capabilities/revoke").ok_or_else(resource_not_found)?;
    let request = RevokeCapabilityRequest::parse_optional(body.as_ref())
        .map_err(|err| invalid_request(&err))?;
    match state
        .events
        .revoke_capability(&t.event_id, &t.token, &request.token)
        .await
    {
        Ok(true) => Ok(no_content()),
        Ok(false) => Err(resource_not_found()),
        Err(err) => Err(internal_error(&err)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    #[test]
    fn capability_header_as_node_reads_it() {
        let mut headers = HeaderMap::new();
        assert_eq!(capability_header(&headers), None);
        headers.insert(CAPABILITY_HEADER, HeaderValue::from_static(""));
        assert_eq!(capability_header(&headers).as_deref(), Some(""));
        headers.insert(CAPABILITY_HEADER, HeaderValue::from_static("a"));
        headers.append(CAPABILITY_HEADER, HeaderValue::from_static("b"));
        assert_eq!(capability_header(&headers).as_deref(), Some("a, b"));
        headers.insert(
            CAPABILITY_HEADER,
            HeaderValue::from_bytes(b"t\xe9").unwrap(),
        );
        assert_eq!(capability_header(&headers).as_deref(), Some("té"));
    }

    #[test]
    fn target_needs_a_uuid_and_a_token() {
        let id = "ce000000-0000-4000-8000-000000000001";
        let mut headers = HeaderMap::new();
        let uri = |s: &str| s.parse::<Uri>().unwrap();
        assert!(target(&uri(&format!("/events/{id}")), &headers, "").is_none());
        headers.insert(CAPABILITY_HEADER, HeaderValue::from_static("tok"));
        let t = target(&uri(&format!("/events/{id}")), &headers, "").unwrap();
        assert_eq!((t.event_id.as_str(), t.token.as_str()), (id, "tok"));
        let encoded = id.replace('-', "%2D");
        assert!(target(&uri(&format!("/events/{encoded}")), &headers, "").is_some());
        assert!(
            target(
                &uri(&format!("/events/{id}/capabilities")),
                &headers,
                "/capabilities"
            )
            .is_some()
        );
        for bad in ["/events/", "/events/nope", "/events/batch-read"] {
            assert!(target(&uri(bad), &headers, "").is_none(), "{bad}");
        }
        headers.insert(CAPABILITY_HEADER, HeaderValue::from_static(""));
        assert!(target(&uri(&format!("/events/{id}")), &headers, "").is_none());
    }
}
