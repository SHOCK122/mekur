//! Replays what the TS server did, recorded by
//! `apps/api/test/rustParity.test.ts`:
//!
//! - `fixtures/ts_responses.json`: replies that don't depend on any route
//!   group (404s, undecodable paths) and their headers;
//! - `fixtures/ts_auth_responses.json`: the auth routes' replies (step 3b),
//!   recorded before those routes were deleted from the TS server, so now
//!   a frozen record. Each case ran on a fresh app with the production rate
//!   limits and a database holding only the `seed` account; `before`
//!   requests were sent first, unrecorded;
//! - `fixtures/node_base64.json`: what Node's base64 decoder makes of
//!   tricky strings, which stored auth hashes depend on.

mod common;

use axum::{body::Body, http::Request};
use common::{TestApp, request, request_with};
use mekur_api::{AppOptions, node_base64};
use serde_json::Value;

#[tokio::test]
async fn reproduces_the_ts_servers_replies() {
    let fixture: Value =
        serde_json::from_str(include_str!("fixtures/ts_responses.json")).expect("fixture parses");
    let uncompared: Vec<&str> = fixture["uncomparedHeaders"]
        .as_array()
        .unwrap()
        .iter()
        .map(|h| h.as_str().unwrap())
        .collect();
    let t = TestApp::new().await;

    let cases = fixture["cases"].as_array().unwrap();
    assert!(!cases.is_empty());
    for case in cases {
        let (method, url) = (
            case["method"].as_str().unwrap(),
            case["url"].as_str().unwrap(),
        );
        let reply = t.send(request(method, url)).await;
        let what = format!("{method} {url}");

        assert_eq!(
            u64::from(reply.status.as_u16()),
            case["status"],
            "{what}: status"
        );
        if method == "HEAD" {
            // Fastify's `inject` reports the body it generated; on the wire
            // a HEAD reply has none, from either server.
            assert!(reply.body.is_empty(), "{what}: body");
        } else {
            assert_eq!(reply.text(), case["body"].as_str().unwrap(), "{what}: body");
        }

        let expected = case["headers"].as_object().unwrap();
        for (name, value) in expected {
            assert_eq!(reply.header(name), value.as_str(), "{what}: header {name}");
        }
        for name in reply.headers.keys() {
            assert!(
                expected.contains_key(name.as_str()) || uncompared.contains(&name.as_str()),
                "{what}: extra header {name}"
            );
        }
    }
}

fn auth_request(spec: &Value) -> Request<Body> {
    let headers: Vec<(&str, &str)> = spec["headers"]
        .as_object()
        .map(|h| {
            h.iter()
                .map(|(k, v)| (k.as_str(), v.as_str().unwrap()))
                .collect()
        })
        .unwrap_or_default();
    let body = match (&spec["body"], &spec["bodyRepeat"]) {
        (Value::String(body), _) => Some(body.clone().into_bytes()),
        (_, Value::Array(repeat)) => Some(
            repeat[0]
                .as_str()
                .unwrap()
                .repeat(usize::try_from(repeat[1].as_u64().unwrap()).unwrap())
                .into_bytes(),
        ),
        _ => None,
    };
    request_with(
        spec["method"].as_str().unwrap(),
        spec["url"].as_str().unwrap(),
        &headers,
        body,
    )
}

#[tokio::test]
async fn reproduces_the_ts_servers_auth_replies() {
    let fixture: Value = serde_json::from_str(include_str!("fixtures/ts_auth_responses.json"))
        .expect("fixture parses");
    let uncompared: Vec<&str> = fixture["uncomparedHeaders"]
        .as_array()
        .unwrap()
        .iter()
        .map(|h| h.as_str().unwrap())
        .collect();
    let seed = &fixture["seed"];
    let cases = fixture["cases"].as_array().unwrap();
    assert!(cases.len() > 30);
    for case in cases {
        let what = case["name"].as_str().unwrap();
        // The production limits, as recorded.
        let t = TestApp::with_options(AppOptions::new(common::JWT_SECRET)).await;
        sqlx::query(
            "INSERT INTO users (username, display_name, public_key, auth_salt, auth_hash)
             VALUES ($1, $2, $3, $4, $5)",
        )
        .bind(seed["username"].as_str())
        .bind(seed["displayName"].as_str())
        .bind(seed["publicKey"].as_str())
        .bind(seed["authSalt"].as_str())
        .bind(mekur_crypto::sha256_base64(seed["authKey"].as_str().unwrap()).unwrap())
        .execute(&t.db)
        .await
        .unwrap();
        for before in case["before"].as_array().unwrap() {
            for _ in 0..before["times"].as_u64().unwrap() {
                t.send(auth_request(&before["request"])).await;
            }
        }
        let reply = t.send(auth_request(&case["request"])).await;
        let expected = &case["response"];

        assert_eq!(
            u64::from(reply.status.as_u16()),
            expected["status"],
            "{what}: status"
        );
        let body = expected["body"].as_str().unwrap();
        if body.contains("Expected property name") {
            // V8's JSON.parse message can't be reproduced (see
            // docs/RUST_MIGRATION.md): same shape, serde_json's text.
            let actual = reply.json();
            assert_eq!(actual["statusCode"], 400, "{what}");
            assert_eq!(actual["error"], "Bad Request", "{what}");
            assert!(actual["message"].is_string(), "{what}");
            assert_eq!(reply.header("connection"), Some("close"), "{what}");
        } else if body.is_empty() {
            assert!(reply.body.is_empty(), "{what}: body");
        } else {
            // Same JSON; validation issues may list keys in another order.
            let expected_body: Value = serde_json::from_str(body).unwrap();
            assert_eq!(reply.json(), expected_body, "{what}: body");
            if !body.contains("\"details\"") {
                assert_eq!(reply.text(), body, "{what}: body text");
            }
        }

        let headers = expected["headers"].as_object().unwrap();
        for (name, value) in headers {
            assert_eq!(reply.header(name), value.as_str(), "{what}: header {name}");
        }
        for name in reply.headers.keys() {
            assert!(
                headers.contains_key(name.as_str()) || uncompared.contains(&name.as_str()),
                "{what}: extra header {name}"
            );
        }
    }
}

#[test]
fn decodes_base64_exactly_as_node_does() {
    let fixture: Value =
        serde_json::from_str(include_str!("fixtures/node_base64.json")).expect("fixture parses");
    let cases = fixture["cases"].as_array().unwrap();
    assert!(cases.len() > 2000);
    for case in cases {
        let input = case["input"].as_str().unwrap();
        let hex: String = node_base64::decode(input)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        assert_eq!(hex, case["hex"].as_str().unwrap(), "{input:?}");
    }
}
