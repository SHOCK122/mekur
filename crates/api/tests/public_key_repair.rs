//! Port of `apps/api/test/publicKeyRepair.test.ts`.
//!
//! Accounts created before the identity keypair was derived from the
//! password registered a RANDOM public key whose private half was thrown
//! away. Anything sealed to it is unreadable (the original "invalid tag"
//! bug). Login repairs it -- and only login, because replacing a public key
//! redirects every future invitation. (The TS tests read the key back
//! through `POST /tags/resolve`, still a TS route; these read the row.)

mod common;

use common::{TestApp, json_request, register_user, request_with, stored_public_key};
use mekur_crypto::{generate_key_pair, open_sealed, seal_to_recipient};
use serde_json::json;

#[tokio::test]
async fn reproduces_the_original_failure_a_stale_stored_key_makes_sealed_envelopes_unreadable() {
    let t = TestApp::new().await;
    let stale = register_user(&t, "stale").await;
    let derived = generate_key_pair().unwrap(); // what the client actually holds
    let sealed = seal_to_recipient(&json!({ "hi": 1 }), &stale.public_key, None).unwrap();
    assert!(open_sealed(&sealed, &derived.secret_key).is_err());
}

#[tokio::test]
async fn replaces_a_stale_key_when_login_presents_the_derived_one() {
    let t = TestApp::new().await;
    let stale = register_user(&t, "stale").await;
    let derived = generate_key_pair().unwrap();
    let login = t
        .send(json_request(
            "POST",
            "/sessions",
            &json!({ "username": "stale", "authKey": stale.auth_key, "publicKey": derived.public_key }),
        ))
        .await;
    assert_eq!(login.status, 200);
    assert_eq!(
        login.json()["user"]["publicKey"],
        derived.public_key.as_str()
    );

    // Senders now seal to the repaired key, which the client can open.
    let key = stored_public_key(&t.db, "stale").await;
    assert_eq!(key, derived.public_key);
    let opened = open_sealed(
        &seal_to_recipient(&json!({ "hi": 1 }), &key, None).unwrap(),
        &derived.secret_key,
    )
    .unwrap();
    assert_eq!(opened.payload, json!({ "hi": 1 }));
}

#[tokio::test]
async fn keeps_the_key_when_login_presents_the_same_one_or_none() {
    let t = TestApp::new().await;
    let user = register_user(&t, "ada").await;
    for body in [
        json!({ "username": "ada", "authKey": user.auth_key }),
        json!({ "username": "ada", "authKey": user.auth_key, "publicKey": user.public_key }),
    ] {
        let login = t.send(json_request("POST", "/sessions", &body)).await;
        assert_eq!(login.status, 200);
        assert_eq!(login.json()["user"]["publicKey"], user.public_key.as_str());
    }
    assert_eq!(stored_public_key(&t.db, "ada").await, user.public_key);
}

#[tokio::test]
async fn does_not_replace_the_key_on_a_failed_login() {
    let t = TestApp::new().await;
    let victim = register_user(&t, "victim").await;
    let attacker = register_user(&t, "attacker").await;
    let attacker_key = generate_key_pair().unwrap();
    let login = t
        .send(json_request(
            "POST",
            "/sessions",
            &json!({ "username": "victim", "authKey": attacker.auth_key, "publicKey": attacker_key.public_key }),
        ))
        .await;
    assert_eq!(login.status, 401);
    assert_eq!(stored_public_key(&t.db, "victim").await, victim.public_key);
}

#[tokio::test]
async fn offers_no_other_way_to_rewrite_a_key_so_a_stolen_token_cant_redirect_invitations() {
    let t = TestApp::new().await;
    let victim = register_user(&t, "victim").await;
    let body = json!({ "publicKey": generate_key_pair().unwrap().public_key }).to_string();
    let authorization = format!("Bearer {}", victim.token);
    let reply = t
        .send(request_with(
            "PUT",
            "/users/me/public-key",
            &[
                ("authorization", &authorization),
                ("content-type", "application/json"),
            ],
            Some(body.into_bytes()),
        ))
        .await;
    assert_eq!(reply.status, 404);
    assert_eq!(stored_public_key(&t.db, "victim").await, victim.public_key);
}
