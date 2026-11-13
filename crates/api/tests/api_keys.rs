//! Port of `apps/api/test/apiKeys.test.ts`, plus what it didn't cover: the
//! stored form of a key, `last_used_at`, and tokens the TS server handled
//! by accident (see `docs/RUST_MIGRATION.md`, step 3c). The TS tests used
//! `/events` and `/keyring` (still TS) to show a key authenticates; here
//! `GET /api-keys` does, and the TS suite keeps a test that its own routes
//! accept a key minted with this format.

mod common;

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use common::{JWT_SECRET, Registered, TestApp, json_request, register_user, request_with};
use hmac::{Hmac, KeyInit, Mac};
use mekur_api::api_keys::hash_api_key;
use serde_json::{Value, json};
use sha2::Sha256;

async fn mint(t: &TestApp, token: &str, name: &str) -> common::Reply {
    let mut request = json_request("POST", "/api-keys", &json!({ "name": name }));
    request
        .headers_mut()
        .insert("authorization", format!("Bearer {token}").parse().unwrap());
    t.send(request).await
}

async fn get(t: &TestApp, path: &str, token: &str) -> common::Reply {
    let bearer = format!("Bearer {token}");
    t.send(request_with(
        "GET",
        path,
        &[("authorization", &bearer)],
        None,
    ))
    .await
}

async fn delete(t: &TestApp, path: &str, token: &str) -> common::Reply {
    let bearer = format!("Bearer {token}");
    t.send(request_with(
        "DELETE",
        path,
        &[("authorization", &bearer)],
        None,
    ))
    .await
}

async fn minted(t: &TestApp, user: &Registered, name: &str) -> (String, Value) {
    let reply = mint(t, &user.token, name).await;
    assert_eq!(reply.status, 201, "{}", reply.text());
    let body = reply.json();
    (
        body["rawKey"].as_str().unwrap().to_owned(),
        body["apiKey"].clone(),
    )
}

#[tokio::test]
async fn mints_a_key_and_returns_the_raw_value_exactly_once() {
    let t = TestApp::new().await;
    let alice = register_user(&t, "alice").await;
    let reply = mint(&t, &alice.token, "my agent").await;
    assert_eq!(reply.status, 201);
    let body = reply.json();
    let raw_key = body["rawKey"].as_str().unwrap();
    assert!(raw_key.starts_with("sak_"));
    let prefix = body["apiKey"]["keyPrefix"].as_str().unwrap();
    assert_eq!(prefix, &raw_key[..prefix.len()]);
    // The stored record never includes the raw key or its hash.
    let api_key = body["apiKey"].as_object().unwrap();
    assert!(!api_key.contains_key("rawKey"));
    assert!(!api_key.contains_key("keyHash"));
    assert_eq!(api_key["userId"], alice.user_id.as_str());
    assert_eq!(api_key["name"], "my agent");
    assert_eq!(api_key["lastUsedAt"], Value::Null);

    // ...and the list never shows the raw key again.
    let list = get(&t, "/api-keys", &alice.token).await;
    assert_eq!(list.status, 200);
    assert!(!list.text().contains(raw_key));
    assert_eq!(list.json()["apiKeys"], json!([body["apiKey"]]));
}

#[tokio::test]
async fn stores_only_the_hash_in_the_ts_format() {
    let t = TestApp::new().await;
    let alice = register_user(&t, "alice").await;
    let (raw_key, api_key) = minted(&t, &alice, "k").await;
    // `sak_` + base64url(24 random bytes), as the TS server made them.
    assert_eq!(raw_key.len(), 36);
    assert_eq!(URL_SAFE_NO_PAD.decode(&raw_key[4..]).unwrap().len(), 24);
    let (prefix, hash): (String, String) =
        sqlx::query_as("SELECT key_prefix, key_hash FROM api_keys WHERE id = $1::uuid")
            .bind(api_key["id"].as_str())
            .fetch_one(&t.db)
            .await
            .unwrap();
    assert_eq!(prefix, raw_key[..12]);
    assert_eq!(hash, hash_api_key(&raw_key));
    // base64(sha256(utf8 key)), which the TS auth check looks up.
    use sha2::Digest;
    assert_eq!(
        hash,
        base64::engine::general_purpose::STANDARD.encode(Sha256::digest(raw_key.as_bytes()))
    );
}

#[tokio::test]
async fn authenticates_requests_with_a_minted_key_and_marks_it_used() {
    let t = TestApp::new().await;
    let bob = register_user(&t, "bob").await;
    let (raw_key, api_key) = minted(&t, &bob, "agent key").await;

    let reply = get(&t, "/api-keys", &raw_key).await;
    assert_eq!(reply.status, 200);
    let listed = &reply.json()["apiKeys"][0];
    assert_eq!(listed["id"], api_key["id"]);
    assert_eq!(listed["userId"], bob.user_id.as_str());
    // The lookup bumps last_used_at before the list is read.
    assert!(listed["lastUsedAt"].is_string());
}

#[tokio::test]
async fn rejects_an_unknown_or_malformed_api_key() {
    let t = TestApp::new().await;
    let reply = get(&t, "/api-keys", "sak_not_a_real_key").await;
    assert_eq!(reply.status, 401);
    assert_eq!(reply.text(), r#"{"error":"Unauthorized"}"#);
}

#[tokio::test]
async fn stops_working_immediately_after_revocation() {
    let t = TestApp::new().await;
    let carol = register_user(&t, "carol").await;
    let (raw_key, api_key) = minted(&t, &carol, "temp key").await;

    assert_eq!(get(&t, "/api-keys", &raw_key).await.status, 200);
    let path = format!("/api-keys/{}", api_key["id"].as_str().unwrap());
    let revoked = delete(&t, &path, &carol.token).await;
    assert_eq!(revoked.status, 204);
    assert!(revoked.body.is_empty());
    assert_eq!(get(&t, "/api-keys", &raw_key).await.status, 401);
    // Gone, not merely disabled.
    assert_eq!(delete(&t, &path, &carol.token).await.status, 404);
}

#[tokio::test]
async fn lists_only_the_users_own_keys_and_cannot_revoke_someone_elses() {
    let t = TestApp::new().await;
    let alice = register_user(&t, "alice2").await;
    let bob = register_user(&t, "bob2").await;
    let (_, alice_key) = minted(&t, &alice, "alice's key").await;

    let bob_list = get(&t, "/api-keys", &bob.token).await;
    assert_eq!(bob_list.json()["apiKeys"], json!([]));

    let path = format!("/api-keys/{}", alice_key["id"].as_str().unwrap());
    let attempt = delete(&t, &path, &bob.token).await;
    assert_eq!(attempt.status, 404);
    assert_eq!(attempt.text(), r#"{"error":"Not found"}"#);
    // Still there for Alice.
    let alice_list = get(&t, "/api-keys", &alice.token).await;
    assert_eq!(alice_list.json()["apiKeys"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn will_not_mint_a_new_key_when_authenticated_with_a_key() {
    // Otherwise one leaked key becomes a self-renewing set that survives
    // its own revocation.
    let t = TestApp::new().await;
    let dave = register_user(&t, "dave").await;
    let (raw_key, _) = minted(&t, &dave, "agent").await;
    let attempt = mint(&t, &raw_key, "escalation").await;
    assert_eq!(attempt.status, 403);
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM api_keys")
        .fetch_one(&t.db)
        .await
        .unwrap();
    assert_eq!(count, 1);
}

#[tokio::test]
async fn lists_newest_first() {
    let t = TestApp::new().await;
    let erin = register_user(&t, "erin").await;
    for name in ["first", "second", "third"] {
        minted(&t, &erin, name).await;
    }
    let list = get(&t, "/api-keys", &erin.token).await.json();
    let names: Vec<&str> = list["apiKeys"]
        .as_array()
        .unwrap()
        .iter()
        .map(|k| k["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["third", "second", "first"]);
}

/// An HS256 token over any payload, signed with the test secret.
fn token(payload: &Value) -> String {
    let segment = |v: &Value| URL_SAFE_NO_PAD.encode(v.to_string());
    let input = format!(
        "{}.{}",
        segment(&json!({ "alg": "HS256", "typ": "JWT" })),
        segment(payload)
    );
    let mut mac = Hmac::<Sha256>::new_from_slice(JWT_SECRET.as_bytes()).unwrap();
    mac.update(input.as_bytes());
    format!(
        "{input}.{}",
        URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
    )
}

#[tokio::test]
async fn session_tokens_without_exp_never_expire() {
    // Parity with fast-jwt, which only checks `exp` when present: tokens
    // from before expiry was added stay valid on both servers.
    let t = TestApp::new().await;
    let frank = register_user(&t, "frank").await;
    let reply = get(&t, "/api-keys", &token(&json!({ "userId": frank.user_id }))).await;
    assert_eq!(reply.status, 200);
}

#[tokio::test]
async fn tokens_whose_user_id_is_not_a_string_are_refused() {
    // Divergence: the TS server copied any `userId` into the request and
    // let the query fail (500) or match nothing (200, empty list). Only a
    // holder of JWT_SECRET can sign such a token; neither server does.
    let t = TestApp::new().await;
    for payload in [
        json!({}),
        json!({ "userId": null }),
        json!({ "userId": 5 }),
        json!({ "userId": ["0a000000-0000-4000-8000-000000000001"] }),
        json!(["not", "an", "object"]),
    ] {
        let reply = get(&t, "/api-keys", &token(&payload)).await;
        assert_eq!(reply.status, 401, "{payload}");
    }
}

#[tokio::test]
async fn a_token_user_id_that_is_not_a_uuid_is_a_server_error_not_a_match() {
    // As on the TS server (where the uuid cast failed too); the reply no
    // longer carries the database's message.
    let t = TestApp::new().await;
    let reply = get(&t, "/api-keys", &token(&json!({ "userId": "nope" }))).await;
    assert_eq!(reply.status, 500);
    assert!(!reply.text().contains("uuid"));
}
