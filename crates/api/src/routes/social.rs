//! Friend codes and tag resolution -- a port of
//! `apps/api/src/routes/socialRoutes.ts`. Every route needs a signed-in
//! user, who only ever sees or spends their own code.
//!
//! Blocking is deliberately absent here. Under the capability model the
//! server does not know who contacts whom, so it cannot filter on anyone's
//! behalf. Sender identity travels inside the encrypted invite envelope and
//! the recipient's client filters it -- which means the server never learns
//! a block list either. See `docs/ARCHITECTURE.md`.

use axum::{
    extract::{Request, State},
    http::{HeaderMap, StatusCode},
    response::Response,
};
use mekur_shared::ResolveTagRequest;
use serde::Serialize;

use crate::{
    AppState,
    app::{internal_error, invalid_request, json, json_value},
    auth::{authenticate, body_then_account},
    body::{BODY_LIMIT, is_js_whitespace},
    friend_codes::{FriendCodeRecord, is_friend_code},
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FriendCodeReply {
    friend_code: FriendCodeRecord,
}

/// `GET /friend-code`: the account's current code, creating one on first
/// use. (Fastify read no body for a `GET`, so neither does this.)
pub async fn friend_code(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let user = match authenticate(&state, &headers).await {
        Ok(user) => user,
        Err(reply) => return reply,
    };
    match state.friend_codes.get_or_create(&user.user_id).await {
        Ok(code) => json_value(StatusCode::OK, &FriendCodeReply { friend_code: code }),
        Err(err) => internal_error(&err),
    }
}

/// `POST /friend-code/rotate`: replace the code, for when a user thinks it
/// has leaked. A body is read (and must be well-formed) but ignored, as
/// Fastify parsed it before this route's handler ran.
pub async fn rotate_friend_code(State(state): State<AppState>, request: Request) -> Response {
    let (parts, body) = request.into_parts();
    let user = match body_then_account(&state, &parts, body, BODY_LIMIT).await {
        Ok((_, user)) => user,
        Err(reply) => return reply,
    };
    match state.friend_codes.rotate(&user.user_id).await {
        Ok(code) => json_value(StatusCode::OK, &FriendCodeReply { friend_code: code }),
        Err(err) => internal_error(&err),
    }
}

/// The reply for `POST /tags/resolve`. Field order matches the TS server's
/// object literals exactly (`serde` serializes struct fields in declaration
/// order): `username` is present only for a resolved username, never a code.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Target {
    user_id: String,
    public_key: String,
    display_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    username: Option<String>,
    via_code: bool,
}

#[derive(Serialize)]
struct Resolved {
    target: Target,
}

fn invalid_tag() -> Response {
    // Unknown, already-spent, and own-code all return the same thing:
    // distinguishing them would turn this into an oracle for probing which
    // codes exist.
    json(
        StatusCode::NOT_FOUND,
        r#"{"error":"That code isn't valid or has already been used."}"#,
    )
}

/// `POST /tags/resolve`: resolves a tag (a username or a one-time code) to
/// something invitable.
///
/// Redeeming a code CONSUMES it, so this is deliberately a POST rather than
/// a GET -- it mutates state and must not be retried blindly.
///
/// The reply for a code deliberately withholds the owner's username and
/// real display name: the entire point of an anonymous code is that using
/// it doesn't tell you who you reached.
pub async fn resolve_tag(State(state): State<AppState>, request: Request) -> Response {
    let (parts, body) = request.into_parts();
    let (body, user) = match body_then_account(&state, &parts, body, BODY_LIMIT).await {
        Ok(read) => read,
        Err(reply) => return reply,
    };
    let request = match ResolveTagRequest::parse_optional(body.as_ref()) {
        Ok(request) => request,
        Err(err) => return invalid_request(&err),
    };
    let tag = request.tag.trim_matches(is_js_whitespace);

    if is_friend_code(tag) {
        let owner_id = match state.friend_codes.redeem(tag, &user.user_id).await {
            Ok(Some(owner_id)) => owner_id,
            Ok(None) => return invalid_tag(),
            Err(err) => return internal_error(&err),
        };
        return match state.users.find_by_id(&owner_id).await {
            Ok(Some(owner)) => json_value(
                StatusCode::OK,
                &Resolved {
                    target: Target {
                        user_id: owner.id,
                        public_key: owner.public_key,
                        display_name: "Anonymous invitee".to_owned(),
                        username: None,
                        via_code: true,
                    },
                },
            ),
            Ok(None) => invalid_tag(),
            Err(err) => internal_error(&err),
        };
    }

    match state.users.find_by_username(&tag.to_lowercase()).await {
        Ok(Some(target)) => json_value(
            StatusCode::OK,
            &Resolved {
                target: Target {
                    user_id: target.id,
                    public_key: target.public_key,
                    display_name: target.display_name,
                    username: Some(target.username),
                    via_code: false,
                },
            },
        ),
        Ok(None) => json(
            StatusCode::NOT_FOUND,
            r#"{"error":"No user with that username."}"#,
        ),
        Err(err) => internal_error(&err),
    }
}
