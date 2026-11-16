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
//! - `fixtures/ts_api_key_responses.json`: the API-key routes' replies
//!   (step 3c) -- every way the TS server's auth check accepted or refused
//!   a bearer token or key -- frozen likewise. Each case ran on a fresh app
//!   with the production limits and the `seed` accounts and keys; what
//!   varies between runs (new ids, keys, timestamps) is normalised away;
//! - `fixtures/ts_event_responses.json`: the event and capability routes'
//!   replies (step 3d), frozen likewise, with the events and capabilities
//!   left in the database afterwards. Each case ran on a fresh app with the
//!   production limits and the `seed` accounts, events and capabilities;
//!   new ids, tokens, hashes and timestamps are normalised away, and runs
//!   of 64+ identical characters are written `⟪c×n⟫`;
//! - `fixtures/ts_keyring_responses.json`: the keyring routes' replies
//!   (step 3e), frozen likewise, with the keyrings left in the database
//!   afterwards and which API keys were marked used. Each case ran on a
//!   fresh app with the production limits and the `seed` accounts, API keys
//!   and keyring (Bob's, at version 3; Ada has none); a keyring written
//!   during the case has `updatedAt: "<now>"`, and long runs are squeezed
//!   as above;
//! - `fixtures/node_base64.json`: what Node's base64 decoder makes of
//!   tricky strings, which stored auth hashes depend on.

mod common;

use axum::{body::Body, http::Request};
use common::{TestApp, request, request_with};
use mekur_api::api_keys::hash_api_key;
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

/// Replaces what varies between runs with placeholders, as the recorder
/// did: new keys, prefixes, ids and timestamps (seeded values are kept).
fn normalise(value: &Value, seeded: &[&str]) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(|v| normalise(v, seeded)).collect()),
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(k, v)| (k.clone(), normalise(v, seeded)))
                .collect(),
        ),
        Value::String(s) if !seeded.contains(&s.as_str()) => {
            let tail = |n: usize| {
                s.len() == 4 + n
                    && s.starts_with("sak_")
                    && s[4..]
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
            };
            let iso = s.len() == 24
                && s.ends_with('Z')
                && chrono::DateTime::parse_from_rfc3339(s).is_ok()
                && s.as_bytes()[19] == b'.';
            let uuid = mekur_shared::is_zod_uuid(s) && s.to_lowercase() == *s;
            Value::String(
                if tail(32) {
                    "<rawKey>"
                } else if tail(8) {
                    "<keyPrefix>"
                } else if iso {
                    "<now>"
                } else if uuid {
                    "<uuid>"
                } else {
                    s
                }
                .to_owned(),
            )
        }
        other => other.clone(),
    }
}

#[tokio::test]
async fn reproduces_the_ts_servers_api_key_replies() {
    let fixture: Value = serde_json::from_str(include_str!("fixtures/ts_api_key_responses.json"))
        .expect("fixture parses");
    assert_eq!(fixture["secret"], common::JWT_SECRET);
    let uncompared: Vec<&str> = fixture["uncomparedHeaders"]
        .as_array()
        .unwrap()
        .iter()
        .map(|h| h.as_str().unwrap())
        .collect();
    let seed = &fixture["seed"];
    let users = seed["users"].as_array().unwrap();
    let keys = seed["apiKeys"].as_array().unwrap();
    let mut seeded: Vec<&str> = users.iter().map(|u| u["id"].as_str().unwrap()).collect();
    for key in keys {
        let raw = key["rawKey"].as_str().unwrap();
        seeded.extend([
            key["id"].as_str().unwrap(),
            raw,
            &raw[..12],
            key["createdAt"].as_str().unwrap(),
        ]);
    }

    let cases = fixture["cases"].as_array().unwrap();
    assert!(cases.len() > 90);
    for case in cases {
        let what = case["name"].as_str().unwrap();
        let t = TestApp::with_options(AppOptions::new(common::JWT_SECRET)).await;
        for user in users {
            sqlx::query(
                "INSERT INTO users (id, username, display_name, public_key, auth_salt, auth_hash)
                 VALUES ($1::uuid, $2, $2, 'cGs=', 'c2FsdA==', 'aGFzaA==')",
            )
            .bind(user["id"].as_str())
            .bind(user["username"].as_str())
            .execute(&t.db)
            .await
            .unwrap();
        }
        for key in keys {
            let raw = key["rawKey"].as_str().unwrap();
            sqlx::query(
                "INSERT INTO api_keys (id, user_id, name, key_prefix, key_hash, created_at)
                 VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::timestamptz)",
            )
            .bind(key["id"].as_str())
            .bind(key["userId"].as_str())
            .bind(key["name"].as_str())
            .bind(&raw[..12])
            .bind(hash_api_key(raw))
            .bind(key["createdAt"].as_str())
            .execute(&t.db)
            .await
            .unwrap();
        }
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
            // V8's JSON.parse message can't be reproduced.
            let actual = reply.json();
            assert_eq!(actual["statusCode"], 400, "{what}");
            assert_eq!(actual["error"], "Bad Request", "{what}");
            assert!(actual["message"].is_string(), "{what}");
            assert_eq!(reply.header("connection"), Some("close"), "{what}");
        } else if body.is_empty() {
            assert!(reply.body.is_empty(), "{what}: body");
        } else {
            let expected_body: Value = serde_json::from_str(body).unwrap();
            assert_eq!(
                normalise(&reply.json(), &seeded),
                expected_body,
                "{what}: body"
            );
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

        // Which keys are left, and which an API-key request marked used.
        let rows: Vec<(String, bool)> =
            sqlx::query_as("SELECT id::text, last_used_at IS NOT NULL FROM api_keys ORDER BY id")
                .fetch_all(&t.db)
                .await
                .unwrap();
        // Sorted after normalising: a new key's random id sorts anywhere.
        let by_id = |mut keys: Vec<Value>| {
            keys.sort_by_key(|k| k["id"].as_str().unwrap().to_owned());
            keys
        };
        let actual = by_id(
            rows.into_iter()
                .map(|(id, used)| {
                    serde_json::json!({ "id": normalise(&Value::String(id), &seeded), "used": used })
                })
                .collect(),
        );
        let expected = by_id(case["keysAfter"].as_array().unwrap().clone());
        assert_eq!(actual, expected, "{what}: keys afterwards");
    }
}

// --- Shared by the event and keyring replays -----------------------------------

/// Inserts a fixture's `seed.users` and `seed.apiKeys`.
async fn seed_accounts(t: &TestApp, seed: &Value) {
    for user in seed["users"].as_array().unwrap() {
        sqlx::query(
            "INSERT INTO users (id, username, display_name, public_key, auth_salt, auth_hash)
             VALUES ($1::uuid, $2, $2, 'cGs=', 'c2FsdA==', 'aGFzaA==')",
        )
        .bind(user["id"].as_str())
        .bind(user["username"].as_str())
        .execute(&t.db)
        .await
        .unwrap();
    }
    for key in seed["apiKeys"].as_array().unwrap() {
        let raw = key["rawKey"].as_str().unwrap();
        sqlx::query(
            "INSERT INTO api_keys (id, user_id, name, key_prefix, key_hash)
             VALUES ($1::uuid, $2::uuid, 'k', $3, $4)",
        )
        .bind(key["id"].as_str())
        .bind(key["userId"].as_str())
        .bind(&raw[..12])
        .bind(hash_api_key(raw))
        .execute(&t.db)
        .await
        .unwrap();
    }
}

/// The reply has exactly the recorded headers: the case's own, the
/// fixture's security headers when the case says so, and nothing else but
/// the ones that vary per connection.
fn assert_headers(
    reply: &common::Reply,
    expected: &Value,
    security: &serde_json::Map<String, Value>,
    uncompared: &[&str],
    what: &str,
) {
    let mut headers = expected["headers"].as_object().unwrap().clone();
    if expected["securityHeaders"] == true {
        headers.extend(security.clone());
    }
    for (name, value) in &headers {
        assert_eq!(reply.header(name), value.as_str(), "{what}: header {name}");
    }
    for name in reply.headers.keys() {
        assert!(
            headers.contains_key(name.as_str()) || uncompared.contains(&name.as_str()),
            "{what}: extra header {name}"
        );
    }
}

// --- Events and capabilities (step 3d) -----------------------------------------

/// Runs of 64 or more of one character, written `⟪c×n⟫` in
/// `ts_event_responses.json` to keep it small (the 128 KB ciphertexts).
fn squeeze(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < chars.len() {
        let run = chars[i..].iter().take_while(|&&c| c == chars[i]).count();
        if run >= 64 {
            out.push_str(&format!("\u{27ea}{}\u{d7}{run}\u{27eb}", chars[i]));
        } else {
            out.extend(&chars[i..i + run]);
        }
        i += run;
    }
    out
}

/// The inverse of [`squeeze`], for request bodies.
fn expand(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(start) = rest.find('\u{27ea}') {
        out.push_str(&rest[..start]);
        let marker = &rest[start + '\u{27ea}'.len_utf8()..];
        let end = marker.find('\u{27eb}').expect("closed marker");
        let mut parts = marker[..end].splitn(2, '\u{d7}');
        let c = parts.next().unwrap();
        let n: usize = parts.next().unwrap().parse().unwrap();
        out.push_str(&c.repeat(n));
        rest = &marker[end + '\u{27eb}'.len_utf8()..];
    }
    out.push_str(rest);
    out
}

fn squeeze_value(value: &Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(squeeze_value).collect()),
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(k, v)| (k.clone(), squeeze_value(v)))
                .collect(),
        ),
        Value::String(s) => Value::String(squeeze(s)),
        other => other.clone(),
    }
}

/// Replaces what varies between runs with placeholders, as the recorder
/// did: new event ids, tokens, token hashes and timestamps of today.
fn normalise_event_value(value: &Value, keep: &[String]) -> Value {
    match value {
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|v| normalise_event_value(v, keep))
                .collect(),
        ),
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(k, v)| (k.clone(), normalise_event_value(v, keep)))
                .collect(),
        ),
        Value::String(s) if !keep.contains(s) => {
            let b64 = |c: u8, url: bool| {
                c.is_ascii_alphanumeric()
                    || if url {
                        b"-_".contains(&c)
                    } else {
                        b"+/".contains(&c)
                    }
            };
            let placeholder = if mekur_shared::is_zod_uuid(s) && s.to_lowercase() == *s {
                Some("<uuid>")
            } else if s.len() == 43 && s.bytes().all(|c| b64(c, true)) {
                Some("<token>")
            } else if s.len() == 44 && s.ends_with('=') && s[..43].bytes().all(|c| b64(c, false)) {
                Some("<hash>")
            } else if s.len() == 24
                && s.as_bytes()[19] == b'.'
                && s.ends_with('Z')
                && chrono::DateTime::parse_from_rfc3339(s).is_ok_and(|t| {
                    (t.with_timezone(&chrono::Utc) - chrono::Utc::now())
                        .num_seconds()
                        .abs()
                        < 86_400
                })
            {
                Some("<now>")
            } else {
                None
            };
            Value::String(placeholder.map_or_else(|| s.clone(), str::to_owned))
        }
        other => other.clone(),
    }
}

/// The events and capabilities in the database, as the recorder listed
/// them: normalised, long runs squeezed, in a canonical order.
async fn event_state(db: &sqlx::PgPool, keep: &[String]) -> (Vec<Value>, Vec<Value>) {
    // Timestamps as `toISOString` printed node-pg's millisecond `Date`s.
    const ISO: &str = r#"'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'"#;
    let rows = |sql: String| async move {
        sqlx::query_scalar::<_, String>(sqlx::AssertSqlSafe(sql))
            .fetch_all(db)
            .await
            .unwrap()
            .iter()
            .map(|row| serde_json::from_str::<Value>(row).unwrap())
            .collect::<Vec<_>>()
    };
    let events = rows(format!(
        "SELECT json_build_object('id', id::text, 'envelope', envelope,
           'createdAt', to_char(created_at AT TIME ZONE 'UTC', {ISO}),
           'updatedAt', to_char(updated_at AT TIME ZONE 'UTC', {ISO}))::text
         FROM events"
    ))
    .await;
    let capabilities = rows(format!(
        "SELECT json_build_object('eventId', event_id::text, 'tokenHash', token_hash,
           'level', level, 'expiresAt', to_char(expires_at AT TIME ZONE 'UTC', {ISO}),
           'revoked', revoked_at IS NOT NULL)::text
         FROM event_capabilities"
    ))
    .await;
    let canonical = |items: Vec<Value>| {
        let mut items: Vec<Value> = items
            .iter()
            .map(|v| squeeze_value(&normalise_event_value(v, keep)))
            .collect();
        items.sort_by_key(|v| v.to_string());
        items
    };
    (canonical(events), canonical(capabilities))
}

fn sorted(items: &Value) -> Vec<Value> {
    let mut items = items.as_array().unwrap().clone();
    items.sort_by_key(|v| v.to_string());
    items
}

#[tokio::test]
async fn reproduces_the_ts_servers_event_replies() {
    let fixture: Value = serde_json::from_str(include_str!("fixtures/ts_event_responses.json"))
        .expect("fixture parses");
    assert_eq!(fixture["secret"], common::JWT_SECRET);
    let uncompared: Vec<&str> = fixture["uncomparedHeaders"]
        .as_array()
        .unwrap()
        .iter()
        .map(|h| h.as_str().unwrap())
        .collect();
    let security = fixture["securityHeaders"].as_object().unwrap();
    let seed = &fixture["seed"];

    // What the recorder kept as is: everything seeded.
    let mut keep: Vec<String> = Vec::new();
    for user in seed["users"].as_array().unwrap() {
        keep.push(user["id"].as_str().unwrap().to_owned());
    }
    for event in seed["events"].as_array().unwrap() {
        for field in ["id", "createdAt", "updatedAt"] {
            keep.push(event[field].as_str().unwrap().to_owned());
        }
    }
    for cap in seed["capabilities"].as_array().unwrap() {
        let token = cap["token"].as_str().unwrap();
        keep.push(token.to_owned());
        keep.push(mekur_api::events::hash_capability_token(token));
    }
    for key in seed["apiKeys"].as_array().unwrap() {
        keep.push(key["id"].as_str().unwrap().to_owned());
        keep.push(key["rawKey"].as_str().unwrap().to_owned());
    }
    let seed_events = sorted(&fixture["seedState"]["events"]);
    let seed_capabilities = sorted(&fixture["seedState"]["capabilities"]);

    let cases = fixture["cases"].as_array().unwrap();
    assert!(cases.len() > 180);
    for case in cases {
        let what = case["name"].as_str().unwrap();
        let t = TestApp::with_options(AppOptions::new(common::JWT_SECRET)).await;
        seed_accounts(&t, seed).await;
        for event in seed["events"].as_array().unwrap() {
            sqlx::query(
                "INSERT INTO events (id, envelope, created_at, updated_at)
                 VALUES ($1::uuid, $2::text::jsonb, $3::timestamptz, $4::timestamptz)",
            )
            .bind(event["id"].as_str())
            .bind(event["envelope"].to_string())
            .bind(event["createdAt"].as_str())
            .bind(event["updatedAt"].as_str())
            .execute(&t.db)
            .await
            .unwrap();
        }
        for cap in seed["capabilities"].as_array().unwrap() {
            sqlx::query(
                "INSERT INTO event_capabilities (event_id, token_hash, level, expires_at, revoked_at)
                 VALUES ($1::uuid, $2, $3, $4::timestamptz, $5::timestamptz)",
            )
            .bind(cap["eventId"].as_str())
            .bind(mekur_api::events::hash_capability_token(
                cap["token"].as_str().unwrap(),
            ))
            .bind(cap["level"].as_str())
            .bind(cap["expiresAt"].as_str())
            .bind(cap["revokedAt"].as_str())
            .execute(&t.db)
            .await
            .unwrap();
        }
        for before in case["before"].as_array().unwrap() {
            for _ in 0..before["times"].as_u64().unwrap() {
                t.send(auth_request(&before["request"])).await;
            }
        }
        let mut spec = case["request"].clone();
        if let Some(body) = spec["body"].as_str() {
            spec["body"] = Value::String(expand(body));
        }
        let reply = t.send(auth_request(&spec)).await;
        let expected = &case["response"];

        assert_eq!(
            u64::from(reply.status.as_u16()),
            expected["status"],
            "{what}: status"
        );
        if let Some(body) = expected["body"].as_str() {
            if body.contains("Expected property name") {
                // V8's JSON.parse message can't be reproduced.
                let actual = reply.json();
                assert_eq!(actual["statusCode"], 400, "{what}");
                assert_eq!(actual["error"], "Bad Request", "{what}");
                assert!(actual["message"].is_string(), "{what}");
                assert_eq!(reply.header("connection"), Some("close"), "{what}");
            } else if body.contains("\"details\"") {
                // Validation issues may list their keys in another order.
                let expected_body: Value = serde_json::from_str(&expand(body)).unwrap();
                assert_eq!(reply.json(), expected_body, "{what}: body");
            } else {
                assert_eq!(squeeze(reply.text()), body, "{what}: body");
            }
        } else {
            let mut actual = normalise_event_value(&reply.json(), &keep);
            if case["unordered"] == true
                && let Some(events) = actual["events"].as_array_mut()
            {
                events.sort_by_key(|e| e["id"].as_str().unwrap().to_owned());
            }
            assert_eq!(squeeze_value(&actual), expected["bodyJson"], "{what}: body");
        }

        assert_headers(&reply, expected, security, &uncompared, what);

        let after = &case["after"];
        let (events, capabilities) = event_state(&t.db, &keep).await;
        if after["unchanged"] == true {
            assert_eq!(events, seed_events, "{what}: events afterwards");
            assert_eq!(
                capabilities, seed_capabilities,
                "{what}: capabilities afterwards"
            );
        } else {
            assert_eq!(
                events,
                sorted(&after["events"]),
                "{what}: events afterwards"
            );
            assert_eq!(
                capabilities,
                sorted(&after["capabilities"]),
                "{what}: capabilities afterwards"
            );
        }
        let used: bool = sqlx::query_scalar("SELECT last_used_at IS NOT NULL FROM api_keys")
            .fetch_one(&t.db)
            .await
            .unwrap();
        assert_eq!(used, after["apiKeyUsed"], "{what}: API key marked used");
    }
}

#[test]
fn squeeze_and_expand_are_inverses() {
    let long = format!("ab{}c\n{}", "A".repeat(70), "😀".repeat(64));
    let squeezed = squeeze(&long);
    assert_eq!(
        squeezed,
        "ab\u{27ea}A\u{d7}70\u{27eb}c\n\u{27ea}😀\u{d7}64\u{27eb}"
    );
    assert_eq!(expand(&squeezed), long);
    assert_eq!(squeeze("short"), "short");
}

// --- Keyring (step 3e) ---------------------------------------------------------

/// The keyrings in the database, as the recorder listed them: by user id,
/// long runs squeezed, and a write from the last day as `<now>`.
async fn keyring_state(db: &sqlx::PgPool) -> Vec<Value> {
    let rows: Vec<(String, String, i32, chrono::DateTime<chrono::Utc>)> = sqlx::query_as(
        "SELECT user_id::text, envelope::text, version, updated_at FROM keyrings ORDER BY user_id",
    )
    .fetch_all(db)
    .await
    .unwrap();
    rows.into_iter()
        .map(|(user_id, envelope, version, updated_at)| {
            let recent = (chrono::Utc::now() - updated_at).num_seconds().abs() < 86_400;
            let updated_at = if recent {
                "<now>".to_owned()
            } else {
                mekur_api::app::iso_millis(updated_at)
            };
            let envelope: Value = serde_json::from_str(&envelope).unwrap();
            squeeze_value(&serde_json::json!({
                "userId": user_id,
                "envelope": envelope,
                "version": version,
                "updatedAt": updated_at,
            }))
        })
        .collect()
}

/// The 500 this server sends: Fastify's shape without the database's error
/// code and message, which the TS server echoed (see step 3b's divergences).
const INTERNAL_ERROR: &str =
    r#"{"statusCode":500,"error":"Internal Server Error","message":"Internal Server Error"}"#;

#[tokio::test]
async fn reproduces_the_ts_servers_keyring_replies() {
    let fixture: Value = serde_json::from_str(include_str!("fixtures/ts_keyring_responses.json"))
        .expect("fixture parses");
    assert_eq!(fixture["secret"], common::JWT_SECRET);
    let uncompared: Vec<&str> = fixture["uncomparedHeaders"]
        .as_array()
        .unwrap()
        .iter()
        .map(|h| h.as_str().unwrap())
        .collect();
    let security = fixture["securityHeaders"].as_object().unwrap();
    let seed = &fixture["seed"];
    let seed_keyrings = fixture["seedState"]["keyrings"].as_array().unwrap();

    let cases = fixture["cases"].as_array().unwrap();
    assert!(cases.len() > 110);
    let (mut internal_errors, mut diverging) = (0, 0);
    for case in cases {
        let what = case["name"].as_str().unwrap();
        let t = TestApp::with_options(AppOptions::new(common::JWT_SECRET)).await;
        seed_accounts(&t, seed).await;
        for keyring in seed["keyrings"].as_array().unwrap() {
            sqlx::query(
                "INSERT INTO keyrings (user_id, envelope, version, updated_at)
                 VALUES ($1::uuid, $2::text::jsonb, $3, $4::timestamptz)",
            )
            .bind(keyring["userId"].as_str())
            .bind(keyring["envelope"].to_string())
            .bind(i32::try_from(keyring["version"].as_i64().unwrap()).unwrap())
            .bind(keyring["updatedAt"].as_str())
            .execute(&t.db)
            .await
            .unwrap();
        }
        assert_eq!(&keyring_state(&t.db).await, seed_keyrings, "{what}: seed");

        let expanded = |spec: &Value| {
            let mut spec = spec.clone();
            if let Some(body) = spec["body"].as_str() {
                spec["body"] = Value::String(expand(body));
            }
            spec
        };
        for before in case["before"].as_array().unwrap() {
            for _ in 0..before["times"].as_u64().unwrap() {
                t.send(auth_request(&expanded(&before["request"]))).await;
            }
        }
        let reply = t.send(auth_request(&expanded(&case["request"]))).await;
        let expected = &case["response"];
        let body = expected["body"].as_str().unwrap();

        // The two replies that knowingly differ (docs/RUST_MIGRATION.md):
        // both servers refuse or ignore the request, in different words.
        let divergence = match what {
            // `JSON.parse` reads 1e400 as Infinity, which Zod then calls a
            // float; `serde_json` refuses the number, so the body is
            // malformed JSON. A 400 either way.
            "put: expectedVersion 1e400" => Some(400),
            // Fastify routed on the percent-decoded path; axum routes on the
            // raw one (step 3b), so this is an unknown path.
            "route: GET /%6beyring" => Some(404),
            _ => None,
        };
        if let Some(status) = divergence {
            diverging += 1;
            assert_eq!(reply.status.as_u16(), status, "{what}: status");
            let actual = reply.json();
            assert_eq!(actual["statusCode"], status, "{what}: {actual}");
            assert!(actual.get("details").is_none(), "{what}: {actual}");
            assert_eq!(&keyring_state(&t.db).await, seed_keyrings, "{what}");
            continue;
        }

        assert_eq!(
            u64::from(reply.status.as_u16()),
            expected["status"],
            "{what}: status"
        );
        if case["request"]["method"] == "HEAD" {
            assert!(reply.body.is_empty(), "{what}: body");
        } else if expected["status"] == 500 {
            internal_errors += 1;
            assert_eq!(reply.text(), INTERNAL_ERROR, "{what}: body");
        } else if body.contains("Expected property name") {
            // V8's JSON.parse message can't be reproduced.
            let actual = reply.json();
            assert_eq!(actual["statusCode"], 400, "{what}");
            assert_eq!(actual["error"], "Bad Request", "{what}");
            assert!(actual["message"].is_string(), "{what}");
            assert_eq!(reply.header("connection"), Some("close"), "{what}");
        } else if body.contains("\"details\"") {
            // Validation issues may list their keys in another order.
            let expected_body: Value = serde_json::from_str(&expand(body)).unwrap();
            assert_eq!(reply.json(), expected_body, "{what}: body");
        } else {
            // Byte for byte: nothing in a keyring reply varies between runs.
            assert_eq!(squeeze(reply.text()), body, "{what}: body");
        }

        assert_headers(&reply, expected, security, &uncompared, what);

        let after = &case["after"];
        let keyrings = keyring_state(&t.db).await;
        if after["unchanged"] == true {
            assert_eq!(&keyrings, seed_keyrings, "{what}: keyrings afterwards");
        } else {
            assert_eq!(
                &keyrings,
                after["keyrings"].as_array().unwrap(),
                "{what}: keyrings afterwards"
            );
        }
        let used: Vec<String> = sqlx::query_scalar(
            "SELECT id::text FROM api_keys WHERE last_used_at IS NOT NULL ORDER BY id",
        )
        .fetch_all(&t.db)
        .await
        .unwrap();
        assert_eq!(
            serde_json::json!(used),
            after["apiKeysUsed"],
            "{what}: API keys marked used"
        );
    }
    // The fixture really exercised the special cases above.
    assert_eq!(diverging, 2);
    assert!(internal_errors >= 6, "{internal_errors}");
}
