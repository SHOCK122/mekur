//! The router and the behaviour every response shares -- the port of
//! `buildApp` in `apps/api/src/app.ts`, route group by route group.

use std::sync::LazyLock;

use axum::{
    Router,
    body::Body,
    extract::OriginalUri,
    http::{HeaderName, HeaderValue, Method, StatusCode, header},
    middleware,
    response::{IntoResponse, Response},
    routing::get,
};
use sqlx::PgPool;

/// What the routes share. Route groups take their repositories from here
/// as they are ported.
#[derive(Clone)]
pub struct AppState {
    pub db: PgPool,
}

/// Paths and methods this server answers (beyond 404s). Everything else is
/// still served by the TS server: nginx and the Vite dev proxy send exactly
/// these paths here, and `apps/api/test/openapi.test.ts` checks that the
/// two servers' routes together are what `openapi.json` documents.
pub const ROUTES: &[(&str, &str)] = &[("get", "/health"), ("get", "/openapi.json")];

pub fn build_app(state: AppState) -> Router {
    let routes = Router::new()
        .route("/health", get(health))
        .route("/openapi.json", get(openapi))
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
