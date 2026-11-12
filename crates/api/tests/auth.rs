//! Port of `apps/api/test/auth.test.ts`, the session-token test of
//! `security.test.ts`, and checks of what the TS tests didn't cover
//! (response shapes, the stored hash, the salt route).

mod common;

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use common::{JWT_SECRET, TestApp, json_request, register_user, request};
use mekur_api::jwt::{TOKEN_TTL_SECS, issue_token};
use serde_json::{Value, json};

fn register_payload(username: &str) -> Value {
    json!({
        "username": username,
        "displayName": "Ada Lovelace",
        "publicKey": mekur_crypto::generate_key_pair().unwrap().public_key,
        "authKey": mekur_crypto::to_base64(&mekur_crypto::random_bytes(32).unwrap()),
        "authSalt": mekur_crypto::to_base64(&mekur_crypto::random_bytes(16).unwrap()),
    })
}

/// A JWT's payload, unverified.
fn claims(token: &str) -> Value {
    let payload = token.split('.').nth(1).expect("a JWT has a payload");
    serde_json::from_slice(&URL_SAFE_NO_PAD.decode(payload).unwrap()).unwrap()
}

#[tokio::test]
async fn registers_a_new_user_and_returns_a_token() {
    let t = TestApp::new().await;
    let payload = register_payload("ada");
    let reply = t.send(json_request("POST", "/users", &payload)).await;
    assert_eq!(reply.status, 201);
    let body = reply.json();
    let user = body["user"].as_object().unwrap();
    assert_eq!(user["username"], "ada");
    assert_eq!(user["displayName"], "Ada Lovelace");
    assert_eq!(user["publicKey"], payload["publicKey"]);
    assert!(!user.contains_key("authHash"));
    assert!(!user.contains_key("authSalt"));
    // Exactly the TS server's fields, in its order.
    assert_eq!(
        user.keys().collect::<Vec<_>>(),
        ["createdAt", "displayName", "id", "publicKey", "username"]
    );
    let text = reply.text();
    let order = [
        "\"id\"",
        "\"username\"",
        "\"displayName\"",
        "\"publicKey\"",
        "\"createdAt\"",
        "\"token\"",
    ];
    let positions: Vec<usize> = order.iter().map(|k| text.find(k).unwrap()).collect();
    assert!(positions.is_sorted(), "{text}");
    // `Date.prototype.toISOString`: UTC, milliseconds.
    let created = user["createdAt"].as_str().unwrap();
    assert_eq!(created.len(), "2026-01-01T00:00:00.000Z".len(), "{created}");
    assert!(
        created.ends_with('Z') && created.as_bytes()[19] == b'.',
        "{created}"
    );
    assert!(body["token"].is_string());
    assert_eq!(
        claims(body["token"].as_str().unwrap())["userId"],
        user["id"]
    );
}

#[tokio::test]
async fn stores_the_hash_of_the_decoded_auth_key_and_the_salt_as_sent() {
    let t = TestApp::new().await;
    let payload = register_payload("ada");
    t.send(json_request("POST", "/users", &payload)).await;
    let (hash, salt): (String, String) =
        sqlx::query_as("SELECT auth_hash, auth_salt FROM users WHERE username = 'ada'")
            .fetch_one(&t.db)
            .await
            .unwrap();
    let auth_key = payload["authKey"].as_str().unwrap();
    assert_eq!(hash, mekur_crypto::sha256_base64(auth_key).unwrap());
    assert_ne!(hash, auth_key);
    assert_eq!(salt, payload["authSalt"]);
}

#[tokio::test]
async fn rejects_a_duplicate_username() {
    let t = TestApp::new().await;
    let payload = register_payload("ada");
    assert_eq!(
        t.send(json_request("POST", "/users", &payload))
            .await
            .status,
        201
    );
    let reply = t.send(json_request("POST", "/users", &payload)).await;
    assert_eq!(reply.status, 409);
    assert_eq!(reply.json(), json!({ "error": "Username already taken" }));
}

#[tokio::test]
async fn rejects_an_invalid_username() {
    let t = TestApp::new().await;
    let reply = t
        .send(json_request(
            "POST",
            "/users",
            &register_payload("Not Valid!"),
        ))
        .await;
    assert_eq!(reply.status, 400);
    let body = reply.json();
    assert_eq!(body["error"], "Invalid request");
    assert_eq!(body["details"][0]["validation"], "regex");
    assert_eq!(
        body["details"][0]["message"],
        "username must be lowercase letters, numbers, _ . -"
    );
}

#[tokio::test]
async fn logs_in_with_the_correct_password_and_rejects_the_wrong_one() {
    // The one test that runs real key derivation end to end.
    let t = TestApp::new().await;
    let keys = mekur_crypto::derive_auth_and_encryption_keys("correct horse battery staple", None)
        .unwrap();
    let mut payload = register_payload("ada");
    payload["authKey"] = json!(*keys.auth_key);
    payload["authSalt"] = json!(keys.salt);
    assert_eq!(
        t.send(json_request("POST", "/users", &payload))
            .await
            .status,
        201
    );

    // A real client fetches the salt first, then re-derives keys from it.
    let salt_reply = t.send(request("GET", "/users/ada/salt")).await;
    assert_eq!(salt_reply.status, 200);
    let salt = mekur_crypto::from_base64(salt_reply.json()["authSalt"].as_str().unwrap()).unwrap();
    let re_derived =
        mekur_crypto::derive_auth_and_encryption_keys("correct horse battery staple", Some(&salt))
            .unwrap();
    let ok = t
        .send(json_request(
            "POST",
            "/sessions",
            &json!({ "username": "ada", "authKey": *re_derived.auth_key }),
        ))
        .await;
    assert_eq!(ok.status, 200);
    let body = ok.json();
    assert!(body["token"].is_string());
    assert_eq!(body["user"]["username"], "ada");
    assert!(body["user"].get("authHash").is_none());

    let wrong =
        mekur_crypto::derive_auth_and_encryption_keys("wrong password", Some(&salt)).unwrap();
    let bad = t
        .send(json_request(
            "POST",
            "/sessions",
            &json!({ "username": "ada", "authKey": *wrong.auth_key }),
        ))
        .await;
    assert_eq!(bad.status, 401);
}

#[tokio::test]
async fn returns_the_same_error_for_an_unknown_username_as_for_a_wrong_password() {
    let t = TestApp::new().await;
    register_user(&t, "ada").await;
    let unknown = t
        .send(json_request(
            "POST",
            "/sessions",
            &json!({ "username": "does-not-exist", "authKey": mekur_crypto::to_base64(&[0; 32]) }),
        ))
        .await;
    let wrong = t
        .send(json_request(
            "POST",
            "/sessions",
            &json!({ "username": "ada", "authKey": mekur_crypto::to_base64(&[0; 32]) }),
        ))
        .await;
    assert_eq!(unknown.status, 401);
    assert_eq!(
        (wrong.status, wrong.body.clone()),
        (unknown.status, unknown.body.clone())
    );
    assert_eq!(
        unknown.json(),
        json!({ "error": "Invalid username or password" })
    );
}

/// Node's base64 decoder is lenient, so any spelling of the same bytes is
/// the same auth key -- as it was on the TS server.
#[tokio::test]
async fn accepts_the_auth_key_in_any_spelling_node_decodes_to_the_same_bytes() {
    let t = TestApp::new().await;
    let user = register_user(&t, "ada").await;
    let unpadded = user.auth_key.trim_end_matches('=');
    let url_safe = user.auth_key.replace('+', "-").replace('/', "_");
    for key in [
        unpadded.to_owned(),
        url_safe,
        format!(" {}\n", user.auth_key),
    ] {
        let reply = t
            .send(json_request(
                "POST",
                "/sessions",
                &json!({ "username": "ada", "authKey": key }),
            ))
            .await;
        assert_eq!(reply.status, 200, "{key:?}");
    }
}

#[tokio::test]
async fn salt_lookup_is_public_and_404s_for_an_unknown_user() {
    let t = TestApp::new().await;
    register_user(&t, "ada").await;
    let reply = t.send(request("GET", "/users/ada/salt")).await;
    assert_eq!(reply.status, 200);
    assert!(reply.json()["authSalt"].is_string());
    let missing = t.send(request("GET", "/users/bob/salt")).await;
    assert_eq!(missing.status, 404);
    assert_eq!(missing.json(), json!({ "error": "Not found" }));
}

#[tokio::test]
async fn no_longer_exposes_get_users_username_an_enumeration_surface() {
    let t = TestApp::new().await;
    let alice = register_user(&t, "alice").await;
    register_user(&t, "bob").await;
    let mut req = request("GET", "/users/bob");
    req.headers_mut().insert(
        "authorization",
        format!("Bearer {}", alice.token).parse().unwrap(),
    );
    assert_eq!(t.send(req).await.status, 404);
}

#[tokio::test]
async fn issues_session_tokens_that_actually_expire() {
    let t = TestApp::new().await;
    let user = register_user(&t, "expiryuser").await;
    // A JWT without an exp claim would be valid forever.
    let claims = claims(&user.token);
    let (iat, exp) = (
        claims["iat"].as_i64().unwrap(),
        claims["exp"].as_i64().unwrap(),
    );
    assert!(exp > chrono::Utc::now().timestamp());
    assert_eq!(exp - iat, 30 * 24 * 60 * 60);
    assert_eq!(claims["userId"], user.user_id.as_str());
    // Header and payload as @fastify/jwt wrote them.
    let header = user.token.split('.').next().unwrap();
    let header: Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(header).unwrap()).unwrap();
    assert_eq!(header, json!({ "alg": "HS256", "typ": "JWT" }));
    assert_eq!(
        claims.as_object().unwrap().keys().collect::<Vec<_>>(),
        ["exp", "iat", "userId"]
    );
}

/// A token signed at a fixed time, which `apps/api/test/rustParity.test.ts`
/// verifies with the TS server's `@fastify/jwt` (the side-by-side servers
/// must accept each other's tokens). Regenerate with `UPDATE_API_PARITY=1`.
#[test]
fn issues_tokens_the_ts_server_accepts() {
    const PATH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/rust_jwt.json");
    let user_id = "6f1d3c1e-8a52-4c1b-9a65-0b5f4bb9d1a2";
    let iat = 1_767_225_600; // 2026-01-01T00:00:00Z
    let token = issue_token(JWT_SECRET, user_id, iat);
    assert_eq!(claims(&token)["exp"], iat + TOKEN_TTL_SECS);
    let actual = json!({ "token": token, "userId": user_id, "iat": iat });
    if std::env::var_os("UPDATE_API_PARITY").is_some() {
        std::fs::write(PATH, serde_json::to_string_pretty(&actual).unwrap() + "\n").unwrap();
    }
    let stored: Value = serde_json::from_str(&std::fs::read_to_string(PATH).unwrap()).unwrap();
    assert_eq!(actual, stored);
}
