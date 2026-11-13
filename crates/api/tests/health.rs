//! Port of `apps/api/test/health.test.ts`, and the security-header test from
//! `security.test.ts`.

mod common;

use common::{TestApp, request};
use mekur_api::app::{OPENAPI_SOURCE, ROUTES, SECURITY_HEADERS};

#[tokio::test]
async fn health_returns_200_with_status_ok() {
    let t = TestApp::new().await;
    let reply = t.send(request("GET", "/health")).await;
    assert_eq!(reply.status, 200);
    assert_eq!(reply.json(), serde_json::json!({ "status": "ok" }));
    assert_eq!(reply.text(), r#"{"status":"ok"}"#);
    assert_eq!(
        reply.header("content-type"),
        Some("application/json; charset=utf-8")
    );
}

#[tokio::test]
async fn health_ignores_a_query_string_and_answers_head() {
    let t = TestApp::new().await;
    assert_eq!(t.send(request("GET", "/health?x=1")).await.status, 200);
    let head = t.send(request("HEAD", "/health")).await;
    assert_eq!(head.status, 200);
    assert!(head.body.is_empty());
}

#[tokio::test]
async fn openapi_serves_the_document_compactly() {
    let t = TestApp::new().await;
    let reply = t.send(request("GET", "/openapi.json")).await;
    assert_eq!(reply.status, 200);
    assert_eq!(
        reply.header("content-type"),
        Some("application/json; charset=utf-8")
    );
    let body = reply.json();
    assert_eq!(body["openapi"], "3.0.3");
    let stored: serde_json::Value = serde_json::from_str(OPENAPI_SOURCE).unwrap();
    assert_eq!(body, stored);
    assert!(
        !reply.text().contains('\n'),
        "sent without layout, as JSON.stringify did"
    );
}

/// The other half of this check -- that every documented route is served by
/// one of the two servers -- is `apps/api/test/openapi.test.ts`, which reads
/// [`ROUTES`] from this crate's source.
#[tokio::test]
async fn every_route_this_server_answers_is_documented_and_answers() {
    let t = TestApp::new().await;
    let doc: serde_json::Value = serde_json::from_str(OPENAPI_SOURCE).unwrap();
    for &(method, path) in ROUTES {
        assert!(
            doc["paths"][path][method].is_object(),
            "{method} {path} is not documented"
        );
        // Answered by a route (whatever it makes of an empty request), not
        // by the not-found handler.
        // Each `{param}` filled in.
        let sample = path
            .split('/')
            .map(|segment| {
                if segment.starts_with('{') {
                    "ada"
                } else {
                    segment
                }
            })
            .collect::<Vec<_>>()
            .join("/");
        let reply = t.send(request(&method.to_uppercase(), &sample)).await;
        assert!(
            !reply.text().contains("\"error\":\"Not Found\""),
            "{method} {path}: {}",
            reply.text()
        );
        assert!(!sample.contains('{'), "{path}: fill in its parameters");
    }
}

#[tokio::test]
async fn sends_security_headers_that_mitigate_clickjacking_and_content_injection() {
    let t = TestApp::new().await;
    let reply = t.send(request("GET", "/health")).await;
    let csp = reply.header("content-security-policy").expect("a CSP");
    assert!(csp.contains("frame-ancestors 'none'"), "{csp}");
    assert_eq!(reply.header("x-content-type-options"), Some("nosniff"));
    for &(name, value) in SECURITY_HEADERS {
        assert_eq!(reply.header(name), Some(value), "{name}");
    }
}

#[tokio::test]
async fn sends_security_headers_on_a_404_too() {
    let t = TestApp::new().await;
    let reply = t.send(request("GET", "/nope")).await;
    assert_eq!(reply.status, 404);
    for &(name, value) in SECURITY_HEADERS {
        assert_eq!(reply.header(name), Some(value), "{name}");
    }
}

#[tokio::test]
async fn answers_a_wrong_method_on_a_known_path_with_fastifys_404_not_a_405() {
    let t = TestApp::new().await;
    for method in ["POST", "PUT", "DELETE", "PATCH", "OPTIONS"] {
        let reply = t.send(request(method, "/health")).await;
        assert_eq!(reply.status, 404, "{method}");
        assert_eq!(
            reply.text(),
            format!(
                r#"{{"message":"Route {method}:/health not found","error":"Not Found","statusCode":404}}"#
            )
        );
        assert!(reply.header("allow").is_none(), "{method}");
    }
}
