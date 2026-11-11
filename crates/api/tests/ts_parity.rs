//! Replays `tests/fixtures/ts_responses.json`, which
//! `apps/api/test/rustParity.test.ts` records from the TS server: the
//! replies that don't depend on any route group (404s and their headers).

mod common;

use common::{TestApp, request};
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
