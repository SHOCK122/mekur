//! The router and the behaviour every response shares -- the port of
//! `buildApp` in `apps/api/src/app.ts`, route group by route group.

use std::{sync::Arc, sync::LazyLock, time::Duration};

use axum::{
    Router,
    body::Body,
    extract::{OriginalUri, Request},
    http::{HeaderName, HeaderValue, Method, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{delete, get, post},
};
use mekur_shared::ValidationError;
use serde::Serialize;
use sqlx::PgPool;

use crate::{
    api_keys::ApiKeyRepository,
    rate_limit::{self, RateLimiter},
    routes,
    users::UserRepository,
};

/// What the routes share. Route groups take their repositories from here
/// as they are ported.
#[derive(Clone)]
pub struct AppState {
    pub db: PgPool,
    pub users: UserRepository,
    pub api_keys: ApiKeyRepository,
    pub jwt_secret: Arc<str>,
    pub limits: Limits,
}

/// The rate limiters. Each keeps its own per-client counts, as each
/// `@fastify/rate-limit` store did.
#[derive(Clone)]
pub struct Limits {
    /// Every route without a limit of its own.
    pub global: Arc<RateLimiter>,
    /// `POST /users`.
    pub register: Arc<RateLimiter>,
    /// `POST /sessions`.
    pub login: Arc<RateLimiter>,
}

/// The settings `buildApp` took besides the database (`BuildAppOptions`).
pub struct AppOptions {
    pub jwt_secret: String,
    /// Requests per client per minute on routes without their own limit:
    /// a backstop against abuse and runaway agent clients.
    pub rate_limit_max: u64,
    /// Requests per client per minute on login and registration, each:
    /// an unthrottled login endpoint is brute-forceable, and registration
    /// is the obvious spam target.
    pub auth_rate_limit_max: u64,
    /// Reverse-proxy hops to trust when deriving the client IP.
    pub trust_proxy: u32,
}

impl AppOptions {
    /// The production limits (300 and 10 a minute) and no trusted proxy.
    pub fn new(jwt_secret: impl Into<String>) -> Self {
        Self {
            jwt_secret: jwt_secret.into(),
            rate_limit_max: 300,
            auth_rate_limit_max: 10,
            trust_proxy: 0,
        }
    }
}

impl AppState {
    pub fn new(db: PgPool, options: AppOptions) -> Self {
        let minute = Duration::from_secs(60);
        let limiter = |max| RateLimiter::new(max, minute, options.trust_proxy);
        Self {
            users: UserRepository::new(db.clone()),
            api_keys: ApiKeyRepository::new(db.clone()),
            db,
            jwt_secret: options.jwt_secret.into(),
            limits: Limits {
                global: limiter(options.rate_limit_max),
                register: limiter(options.auth_rate_limit_max),
                login: limiter(options.auth_rate_limit_max),
            },
        }
    }
}

/// Paths and methods this server answers (beyond 404s), with path
/// parameters in OpenAPI's `{name}` form. Everything else is still served
/// by the TS server: nginx and the Vite dev proxy send exactly these paths
/// here, and `apps/api/test/openapi.test.ts` checks that the two servers'
/// routes together are what `openapi.json` documents.
pub const ROUTES: &[(&str, &str)] = &[
    ("get", "/health"),
    ("get", "/openapi.json"),
    ("post", "/users"),
    ("post", "/sessions"),
    ("get", "/users/{username}/salt"),
    ("post", "/api-keys"),
    ("get", "/api-keys"),
    ("delete", "/api-keys/{id}"),
];

pub fn build_app(state: AppState) -> Router {
    let limited = |limiter: &Arc<RateLimiter>| {
        middleware::from_fn_with_state(limiter.clone(), rate_limit::limit)
    };
    let limits = state.limits.clone();
    let salt = get(routes::auth::salt).route_layer(limited(&limits.global));
    let revoke_api_key = delete(routes::api_keys::revoke).route_layer(limited(&limits.global));
    let routes = Router::new()
        // `/health` and `/openapi.json` were never rate-limited.
        .route("/health", get(health))
        .route("/openapi.json", get(openapi))
        .route(
            "/users",
            post(routes::auth::register).route_layer(limited(&limits.register)),
        )
        .route(
            "/sessions",
            post(routes::auth::login).route_layer(limited(&limits.login)),
        )
        .route("/users/{username}/salt", salt.clone())
        // Fastify's parameters may be empty; axum's may not.
        .route("/users//salt", salt)
        .route(
            "/api-keys",
            post(routes::api_keys::create)
                .get(routes::api_keys::list)
                .route_layer(limited(&limits.global)),
        )
        .route("/api-keys/{id}", revoke_api_key.clone())
        .route("/api-keys/", revoke_api_key)
        // Fastify answers an unknown path *and* a known path with the wrong
        // method with the same 404 (never 405).
        .fallback(not_found)
        .method_not_allowed_fallback(not_found)
        .with_state(state);
    // Wrapped as a whole, so these see responses after the per-route
    // `MethodRouter` has finished with them (it adds `Allow` to a
    // wrong-method reply after any layer applied with `Router::layer`).
    Router::new()
        .fallback_service(routes)
        .layer(middleware::map_response(drop_allow_on_404))
        .layer(middleware::map_response(security_headers))
        .layer(middleware::from_fn(reject_bad_url))
}

/// Fastify (find-my-way) refuses a path it can't percent-decode -- a `%`
/// not followed by two hex digits, or escapes that aren't UTF-8 -- before
/// routing, whatever the path or method, with this raw 400: plain
/// `application/json`, the request target (query included) in the message,
/// and none of the security headers or rate limiting other replies get.
async fn reject_bad_url(request: Request, next: Next) -> Response {
    if is_percent_decodable(request.uri().path()) {
        return next.run(request).await;
    }
    let target = request.uri().path_and_query().map_or_else(
        || request.uri().path().to_owned(),
        |pq| pq.as_str().to_owned(),
    );
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct BadUrl {
        error: &'static str,
        code: &'static str,
        message: String,
        status_code: u16,
    }
    let body = BadUrl {
        error: "Bad Request",
        code: "FST_ERR_BAD_URL",
        message: format!("'{target}' is not a valid url component"),
        status_code: 400,
    };
    let body = serde_json::to_string(&body).expect("serializes");
    let mut response = (StatusCode::BAD_REQUEST, body).into_response();
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    response.extensions_mut().insert(RawReply);
    response
}

/// Marks a reply Fastify wrote straight to the socket, bypassing its hooks
/// (so no security headers).
#[derive(Clone, Copy)]
struct RawReply;

/// Fastify's error reply body, keys in its order: `{ statusCode, code?,
/// error, message }`.
pub fn fastify_error(status: StatusCode, code: Option<&'static str>, message: &str) -> Response {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct FastifyError<'a> {
        status_code: u16,
        #[serde(skip_serializing_if = "Option::is_none")]
        code: Option<&'static str>,
        error: &'static str,
        message: &'a str,
    }
    json_value(
        status,
        &FastifyError {
            status_code: status.as_u16(),
            code,
            error: status.canonical_reason().unwrap_or("Error"),
            message,
        },
    )
}

/// Whether [`percent_decode`] succeeds, without allocating for the usual
/// path with no `%` in it.
fn is_percent_decodable(s: &str) -> bool {
    !s.contains('%') || percent_decode(s).is_some()
}

/// `decodeURIComponent`: every `%XX` escape decoded, `None` if an escape is
/// malformed or the bytes aren't UTF-8.
pub fn percent_decode(s: &str) -> Option<String> {
    if !s.contains('%') {
        return Some(s.to_owned());
    }
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = bytes.get(i + 1..i + 3)?;
            let hex = std::str::from_utf8(hex).ok()?;
            if !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
                return None;
            }
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// A JSON reply serialized from `value` (struct fields keep their order).
pub fn json_value(status: StatusCode, value: &impl Serialize) -> Response {
    json(
        status,
        serde_json::to_string(value).expect("reply bodies serialize"),
    )
}

/// The 400 every route sends for a body that fails its schema.
pub fn invalid_request(err: &ValidationError) -> Response {
    #[derive(Serialize)]
    struct Invalid<'a> {
        error: &'static str,
        details: &'a [mekur_shared::Issue],
    }
    json_value(
        StatusCode::BAD_REQUEST,
        &Invalid {
            error: "Invalid request",
            details: &err.issues,
        },
    )
}

/// An unexpected failure (the database is down, say): logged here, and
/// answered in Fastify's 500 shape without the underlying message, which
/// the TS server echoed to the client.
pub fn internal_error(err: &dyn std::error::Error) -> Response {
    eprintln!("internal error: {err}");
    fastify_error(
        StatusCode::INTERNAL_SERVER_ERROR,
        None,
        "Internal Server Error",
    )
}

async fn health() -> Response {
    json(StatusCode::OK, r#"{"status":"ok"}"#)
}

/// The OpenAPI document, sent as `JSON.stringify` sent it: without
/// whitespace. The file is kept pretty-printed for review.
static OPENAPI_JSON: LazyLock<String> = LazyLock::new(|| minify_json(OPENAPI_SOURCE));

/// The document as stored, for tests.
pub const OPENAPI_SOURCE: &str = include_str!("../openapi.json");

async fn openapi() -> Response {
    json(StatusCode::OK, OPENAPI_JSON.as_str())
}

/// Fastify's default not-found reply, byte for byte: the method and the
/// request target as sent (query string included), keys in Fastify's order.
async fn not_found(method: Method, OriginalUri(uri): OriginalUri) -> Response {
    let message = format!("Route {method}:{uri} not found");
    let message = serde_json::to_string(&message).expect("a string serialises");
    json(
        StatusCode::NOT_FOUND,
        format!(r#"{{"message":{message},"error":"Not Found","statusCode":404}}"#),
    )
}

/// axum adds `Allow` to a method-not-allowed reply even when its fallback
/// turns it into a 404; Fastify's 404 has no such header, and listing the
/// methods a path takes is more than a 404 should say.
async fn drop_allow_on_404(mut response: Response) -> Response {
    if response.status() == StatusCode::NOT_FOUND {
        response.headers_mut().remove(header::ALLOW);
    }
    response
}

/// A JSON response with Fastify's content type.
pub fn json(status: StatusCode, body: impl Into<Body>) -> Response {
    (
        status,
        [(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/json; charset=utf-8"),
        )],
        body.into(),
    )
        .into_response()
}

/// The headers `@fastify/helmet` sends, with the CSP directives
/// `apps/api/src/app.ts` configured merged into helmet's defaults. Values
/// are exactly helmet's (checked against the TS server by
/// `tests/fixtures/ts_responses.json`).
pub const SECURITY_HEADERS: &[(&str, &str)] = &[
    (
        "content-security-policy",
        "default-src 'self';base-uri 'self';font-src 'self' https: data:;form-action 'self';\
         frame-ancestors 'none';img-src 'self' data:;object-src 'none';script-src 'self';\
         script-src-attr 'none';style-src 'self' 'unsafe-inline';upgrade-insecure-requests;\
         connect-src 'self'",
    ),
    ("cross-origin-opener-policy", "same-origin"),
    ("cross-origin-resource-policy", "same-origin"),
    ("origin-agent-cluster", "?1"),
    ("referrer-policy", "no-referrer"),
    (
        "strict-transport-security",
        "max-age=31536000; includeSubDomains",
    ),
    ("x-content-type-options", "nosniff"),
    ("x-dns-prefetch-control", "off"),
    ("x-download-options", "noopen"),
    ("x-frame-options", "SAMEORIGIN"),
    ("x-permitted-cross-domain-policies", "none"),
    ("x-xss-protection", "0"),
];

/// Adds [`SECURITY_HEADERS`] to every response, 404s included, as helmet's
/// global `onRequest` hook does. A header a handler set itself is kept.
async fn security_headers(mut response: Response) -> Response {
    if response.extensions().get::<RawReply>().is_some() {
        return response;
    }
    let headers = response.headers_mut();
    for &(name, value) in SECURITY_HEADERS {
        headers
            .entry(HeaderName::from_static(name))
            .or_insert(HeaderValue::from_static(value));
    }
    response
}

/// Drops the whitespace between JSON tokens, leaving strings untouched. For
/// a document written by `JSON.stringify(value, null, 2)` this gives exactly
/// `JSON.stringify(value)`.
fn minify_json(source: &str) -> String {
    let mut out = String::with_capacity(source.len());
    let (mut in_string, mut escaped) = (false, false);
    for c in source.chars() {
        if in_string {
            out.push(c);
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                in_string = false;
            }
        } else if c == '"' {
            in_string = true;
            out.push(c);
        } else if !matches!(c, ' ' | '\n' | '\r' | '\t') {
            out.push(c);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn minify_keeps_strings_and_drops_layout() {
        let source = "{\n  \"a b\": [\n    1,\n    \"x \\\" y\\\\\"\n  ],\n  \"c\": {}\n}\n";
        assert_eq!(minify_json(source), r#"{"a b":[1,"x \" y\\"],"c":{}}"#);
    }

    #[test]
    fn served_openapi_is_the_stored_document() {
        let served: serde_json::Value = serde_json::from_str(&OPENAPI_JSON).unwrap();
        let stored: serde_json::Value = serde_json::from_str(OPENAPI_SOURCE).unwrap();
        assert_eq!(served, stored);
        assert!(!OPENAPI_JSON.contains('\n'));
    }
}
