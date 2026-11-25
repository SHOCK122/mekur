//! Port of `apps/api/test/social.test.ts`, plus what it didn't cover: of
//! two people racing to redeem the same code, exactly one succeeds, and a
//! tag surrounded by JavaScript's `trim`-removed whitespace still resolves.

mod common;

use common::{TestApp, register_user, request_with};
use mekur_api::friend_codes::is_friend_code;
use serde_json::json;

async fn get_friend_code(t: &TestApp, bearer: &str) -> common::Reply {
    let authorization = format!("Bearer {bearer}");
    t.send(request_with(
        "GET",
        "/friend-code",
        &[("authorization", &authorization)],
        None,
    ))
    .await
}

async fn rotate(t: &TestApp, bearer: &str) -> common::Reply {
    let authorization = format!("Bearer {bearer}");
    t.send(request_with(
        "POST",
        "/friend-code/rotate",
        &[("authorization", &authorization)],
        None,
    ))
    .await
}

async fn resolve(t: &TestApp, bearer: &str, tag: &str) -> common::Reply {
    let authorization = format!("Bearer {bearer}");
    t.send(request_with(
        "POST",
        "/tags/resolve",
        &[
            ("authorization", &authorization),
            ("content-type", "application/json"),
        ],
        Some(json!({ "tag": tag }).to_string().into_bytes()),
    ))
    .await
}

async fn code_of(t: &TestApp, bearer: &str) -> String {
    get_friend_code(t, bearer).await.json()["friendCode"]["code"]
        .as_str()
        .unwrap()
        .to_owned()
}

const UNRESOLVABLE: &str = r#"{"error":"That code isn't valid or has already been used."}"#;

#[tokio::test]
async fn returns_the_same_code_until_it_is_used_or_rotated() {
    let t = TestApp::new().await;
    let alice = register_user(&t, "alice").await;

    let first = code_of(&t, &alice.token).await;
    assert!(is_friend_code(&first), "{first}");
    assert_eq!(code_of(&t, &alice.token).await, first);

    let rotated = rotate(&t, &alice.token).await;
    assert_eq!(rotated.status, 200, "{}", rotated.text());
    let rotated_code = rotated.json()["friendCode"]["code"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_ne!(rotated_code, first);
    assert_eq!(code_of(&t, &alice.token).await, rotated_code);
}

#[tokio::test]
async fn resolves_a_code_anonymously_consumes_it_and_issues_a_replacement() {
    let t = TestApp::new().await;
    let alice = register_user(&t, "alice").await;
    let bob = register_user(&t, "bob").await;
    let code = code_of(&t, &alice.token).await;

    let resolved = resolve(&t, &bob.token, &code).await;
    assert_eq!(resolved.status, 200, "{}", resolved.text());
    let target = resolved.json()["target"].clone();
    assert_eq!(target["userId"], alice.user_id);
    assert_eq!(target["publicKey"], alice.public_key);
    assert_eq!(target["viaCode"], true);
    assert_eq!(target["displayName"], "Anonymous invitee");
    assert!(
        target.get("username").is_none(),
        "a code must not reveal the owner's username: {target}"
    );

    assert_eq!(resolve(&t, &bob.token, &code).await.status, 404);
    assert_ne!(code_of(&t, &alice.token).await, code);
}

#[tokio::test]
async fn records_nothing_about_who_redeemed_whose_code() {
    let t = TestApp::new().await;
    let alice = register_user(&t, "alice").await;
    let bob = register_user(&t, "bob").await;
    let code = code_of(&t, &alice.token).await;
    assert_eq!(resolve(&t, &bob.token, &code).await.status, 200);

    let rows: Vec<(String, String)> =
        sqlx::query_as("SELECT user_id::text, code FROM friend_codes")
            .fetch_all(&t.db)
            .await
            .unwrap();
    for (user_id, code) in &rows {
        assert_ne!(user_id, &bob.user_id);
        assert_ne!(code, &bob.user_id);
    }
}

#[tokio::test]
async fn wont_resolve_your_own_code_with_the_same_answer_as_an_unknown_one() {
    let t = TestApp::new().await;
    let alice = register_user(&t, "alice").await;
    let code = code_of(&t, &alice.token).await;

    let own = resolve(&t, &alice.token, &code).await;
    let unknown = resolve(&t, &alice.token, "ZZZZZZZZ").await;
    assert_eq!(own.status, 404);
    assert_eq!(own.text(), UNRESOLVABLE);
    assert_eq!(own.json(), unknown.json());
    // The code must still be usable by someone else: an own-code attempt
    // isn't a spend.
    assert_eq!(code_of(&t, &alice.token).await, code);
}

#[tokio::test]
async fn resolves_a_username_to_a_named_target() {
    let t = TestApp::new().await;
    let alice = register_user(&t, "alice").await;
    let bob = register_user(&t, "bob").await;

    let resolved = resolve(&t, &alice.token, "Bob").await;
    assert_eq!(resolved.status, 200, "{}", resolved.text());
    let target = resolved.json()["target"].clone();
    assert_eq!(target["userId"], bob.user_id);
    assert_eq!(target["username"], "bob");
    assert_eq!(target["publicKey"], bob.public_key);
    assert_eq!(target["viaCode"], false);
}

#[tokio::test]
async fn an_unknown_username_is_not_found() {
    let t = TestApp::new().await;
    let alice = register_user(&t, "alice").await;
    let reply = resolve(&t, &alice.token, "nobody").await;
    assert_eq!(reply.status, 404);
    assert_eq!(reply.text(), r#"{"error":"No user with that username."}"#);
}

/// A tag is trimmed (`String.prototype.trim`) before it is matched against
/// either the friend-code pattern or a username, so stray whitespace from
/// pasting doesn't turn a valid tag into an unknown one.
#[tokio::test]
async fn a_tag_is_trimmed_before_matching() {
    let t = TestApp::new().await;
    let alice = register_user(&t, "alice").await;
    let bob = register_user(&t, "bob").await;
    let code = code_of(&t, &bob.token).await;

    let by_code = resolve(&t, &alice.token, &format!(" {code}\t\n")).await;
    assert_eq!(by_code.status, 200, "{}", by_code.text());
    assert_eq!(by_code.json()["target"]["userId"], bob.user_id);

    let by_username = resolve(&t, &alice.token, " Bob ").await;
    assert_eq!(by_username.status, 200, "{}", by_username.text());
    assert_eq!(by_username.json()["target"]["userId"], bob.user_id);
}

#[tokio::test]
async fn of_two_people_racing_to_redeem_the_same_code_exactly_one_succeeds() {
    let t = TestApp::new().await;
    let alice = register_user(&t, "alice").await;
    let bob = register_user(&t, "bob").await;
    let carol = register_user(&t, "carol").await;
    let code = code_of(&t, &alice.token).await;

    let (a, b) = tokio::join!(
        resolve(&t, &bob.token, &code),
        resolve(&t, &carol.token, &code)
    );
    let mut statuses = [a.status.as_u16(), b.status.as_u16()];
    statuses.sort_unstable();
    assert_eq!(statuses, [200, 404]);
}

#[tokio::test]
async fn every_route_needs_a_signed_in_user() {
    let t = TestApp::new().await;
    assert_eq!(
        t.send(request_with("GET", "/friend-code", &[], None))
            .await
            .status,
        401
    );
    assert_eq!(
        t.send(request_with("POST", "/friend-code/rotate", &[], None))
            .await
            .status,
        401
    );
    assert_eq!(
        t.send(request_with(
            "POST",
            "/tags/resolve",
            &[("content-type", "application/json")],
            Some(json!({ "tag": "bob" }).to_string().into_bytes()),
        ))
        .await
        .status,
        401
    );
}
