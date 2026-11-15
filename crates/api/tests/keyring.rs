//! Port of the keyring tests of `apps/api/test/keyringAndInbox.test.ts`,
//! `security.test.ts` (the keyring's own body limit) and `apiKeys.test.ts`
//! (a key reads and writes its account's keyring), plus what they didn't
//! cover: what a stale write leaves behind, two devices racing, what the
//! row holds, the size caps on both sides, and replies byte for byte.

mod common;

use common::{Registered, TestApp, register_user, request_with};
use serde_json::{Value, json};

const CONFLICT: &str =
    r#"{"error":"Your keyring changed on another device. Reload and try again."}"#;

/// A structurally valid envelope. The server never decrypts, so its
/// contents don't matter here.
fn envelope(key_id: &str) -> Value {
    json!({
        "v": 1,
        "algo": "xchacha20poly1305",
        "keyId": key_id,
        "nonce": "bm9uY2U=",
        "ciphertext": "Y2lwaGVydGV4dA==",
    })
}

async fn get(t: &TestApp, bearer: &str) -> common::Reply {
    let authorization = format!("Bearer {bearer}");
    t.send(request_with(
        "GET",
        "/keyring",
        &[("authorization", &authorization)],
        None,
    ))
    .await
}

async fn put_raw(t: &TestApp, bearer: &str, body: Vec<u8>) -> common::Reply {
    let authorization = format!("Bearer {bearer}");
    t.send(request_with(
        "PUT",
        "/keyring",
        &[
            ("authorization", &authorization),
            ("content-type", "application/json"),
        ],
        Some(body),
    ))
    .await
}

async fn put(t: &TestApp, bearer: &str, envelope: &Value, expected_version: u64) -> common::Reply {
    let body = json!({ "envelope": envelope, "expectedVersion": expected_version });
    put_raw(t, bearer, body.to_string().into_bytes()).await
}

#[tokio::test]
async fn starts_empty_at_version_0_for_a_new_account() {
    let t = TestApp::new().await;
    let alice = register_user(&t, "alice").await;
    let reply = get(&t, &alice.token).await;
    assert_eq!(reply.status, 200);
    assert_eq!(reply.text(), r#"{"keyring":null,"version":0}"#);
}

#[tokio::test]
async fn round_trips_and_increments_version() {
    let t = TestApp::new().await;
    let alice = register_user(&t, "alice").await;

    let first = put(&t, &alice.token, &envelope("one"), 0).await;
    assert_eq!(first.status, 200, "{}", first.text());
    assert_eq!(first.text(), r#"{"version":1}"#);
    assert_eq!(
        get(&t, &alice.token).await.json(),
        json!({ "keyring": envelope("one"), "version": 1 })
    );

    let second = put(&t, &alice.token, &envelope("two"), 1).await;
    assert_eq!(second.text(), r#"{"version":2}"#);
    assert_eq!(
        get(&t, &alice.token).await.json(),
        json!({ "keyring": envelope("two"), "version": 2 })
    );
}

#[tokio::test]
async fn rejects_a_stale_write_rather_than_silently_clobbering_another_device() {
    // Losing a keyring write means permanently losing access to whatever
    // events it was adding, so this must never be last-write-wins.
    let t = TestApp::new().await;
    let alice = register_user(&t, "alice").await;
    assert_eq!(put(&t, &alice.token, &envelope("one"), 0).await.status, 200);

    // Another device that also believed there was no keyring yet...
    let stale = put(&t, &alice.token, &envelope("stale"), 0).await;
    assert_eq!(stale.status, 409);
    assert_eq!(stale.text(), CONFLICT);
    // ...one behind after the next write, and one that is ahead.
    assert_eq!(put(&t, &alice.token, &envelope("two"), 1).await.status, 200);
    for wrong in [1, 3, i32::MAX as u64] {
        let reply = put(&t, &alice.token, &envelope("stale"), wrong).await;
        assert_eq!(reply.status, 409, "{wrong}");
    }

    // The refused writes left the keyring exactly as it was.
    assert_eq!(
        get(&t, &alice.token).await.json(),
        json!({ "keyring": envelope("two"), "version": 2 })
    );
}

#[tokio::test]
async fn a_version_no_integer_column_holds_is_a_server_error_and_writes_nothing() {
    // As the TS server answered (Postgres refused the parameter). Not a
    // success and not a silent overwrite, which is what matters.
    let t = TestApp::new().await;
    let alice = register_user(&t, "alice").await;
    assert_eq!(put(&t, &alice.token, &envelope("one"), 0).await.status, 200);
    for wrong in [i32::MAX as u64 + 1, u64::MAX] {
        let reply = put(&t, &alice.token, &envelope("stale"), wrong).await;
        assert_eq!(reply.status, 500, "{wrong}");
        assert_eq!(
            reply.text(),
            r#"{"statusCode":500,"error":"Internal Server Error","message":"Internal Server Error"}"#
        );
    }
    assert_eq!(
        get(&t, &alice.token).await.json(),
        json!({ "keyring": envelope("one"), "version": 1 })
    );
}

#[tokio::test]
async fn a_version_without_a_keyring_is_a_conflict_not_a_create() {
    let t = TestApp::new().await;
    let alice = register_user(&t, "alice").await;
    let reply = put(&t, &alice.token, &envelope("one"), 1).await;
    assert_eq!(reply.status, 409);
    assert_eq!(
        get(&t, &alice.token).await.text(),
        r#"{"keyring":null,"version":0}"#
    );
}

#[tokio::test]
async fn of_two_devices_racing_with_the_same_version_exactly_one_wins() {
    let t = TestApp::new().await;
    let alice = register_user(&t, "alice").await;

    // Both believe there is no keyring; then both hold version 1.
    for expected in [0, 1] {
        let (device_a, device_b) = (envelope("device-a"), envelope("device-b"));
        let (a, b) = tokio::join!(
            put(&t, &alice.token, &device_a, expected),
            put(&t, &alice.token, &device_b, expected),
        );
        let mut statuses = [a.status.as_u16(), b.status.as_u16()];
        statuses.sort_unstable();
        assert_eq!(statuses, [200, 409], "expected version {expected}");
        let winner = if a.status == 200 {
            "device-a"
        } else {
            "device-b"
        };
        assert_eq!(
            get(&t, &alice.token).await.json(),
            json!({ "keyring": envelope(winner), "version": expected + 1 })
        );
    }
}

#[tokio::test]
async fn keeps_keyrings_private_to_their_account() {
    let t = TestApp::new().await;
    let alice = register_user(&t, "alice").await;
    let bob = register_user(&t, "bob").await;
    assert_eq!(
        put(&t, &alice.token, &envelope("hers"), 0).await.status,
        200
    );

    assert_eq!(
        get(&t, &bob.token).await.text(),
        r#"{"keyring":null,"version":0}"#
    );
    // Bob can't write over hers either: his version 1 is his own (missing)
    // keyring's, and his first write makes his own.
    assert_eq!(put(&t, &bob.token, &envelope("his"), 1).await.status, 409);
    assert_eq!(put(&t, &bob.token, &envelope("his"), 0).await.status, 200);
    assert_eq!(
        get(&t, &alice.token).await.json(),
        json!({ "keyring": envelope("hers"), "version": 1 })
    );
    assert_eq!(
        get(&t, &bob.token).await.json(),
        json!({ "keyring": envelope("his"), "version": 1 })
    );
}

#[tokio::test]
async fn requires_a_signed_in_account() {
    let t = TestApp::new().await;
    let anonymous = t.send(common::request("GET", "/keyring")).await;
    assert_eq!(anonymous.status, 401);
    assert_eq!(anonymous.text(), r#"{"error":"Unauthorized"}"#);
    assert_eq!(get(&t, "not-a-token").await.status, 401);
    assert_eq!(put(&t, "not-a-token", &envelope("k"), 0).await.status, 401);
    let stored: i64 = sqlx::query_scalar("SELECT count(*) FROM keyrings")
        .fetch_one(&t.db)
        .await
        .unwrap();
    assert_eq!(stored, 0);
}

#[tokio::test]
async fn an_api_key_reads_and_writes_its_accounts_keyring() {
    // Agentic clients sync the same keyring a signed-in session does.
    let t = TestApp::new().await;
    let bob = register_user(&t, "bob").await;
    let authorization = format!("Bearer {}", bob.token);
    let minted = t
        .send(request_with(
            "POST",
            "/api-keys",
            &[
                ("authorization", &authorization),
                ("content-type", "application/json"),
            ],
            Some(br#"{"name":"agent"}"#.to_vec()),
        ))
        .await;
    assert_eq!(minted.status, 201, "{}", minted.text());
    let raw_key = minted.json()["rawKey"].as_str().unwrap().to_owned();

    let written = put(&t, &raw_key, &envelope("k"), 0).await;
    assert_eq!(written.status, 200, "{}", written.text());
    let read = get(&t, &raw_key).await;
    assert_eq!(read.status, 200);
    assert_eq!(read.json()["version"], 1);
    // The same keyring the session sees.
    assert_eq!(get(&t, &bob.token).await.text(), read.text());

    let used: bool = sqlx::query_scalar("SELECT last_used_at IS NOT NULL FROM api_keys")
        .fetch_one(&t.db)
        .await
        .unwrap();
    assert!(used);
    assert_eq!(get(&t, "sak_not_a_real_key").await.status, 401);
}

#[tokio::test]
async fn the_row_holds_only_the_opaque_envelope_its_version_and_when_it_changed() {
    let t = TestApp::new().await;
    let alice = register_user(&t, "alice").await;
    let sent = json!({
        "envelope": {
            "v": 1,
            "algo": "xchacha20poly1305",
            "keyId": "k",
            "nonce": "n",
            "ciphertext": "c",
            // Zod stripped unknown keys before storing; so does this.
            "plaintextHint": "dentist on Tuesday",
        },
        "expectedVersion": 0,
        "eventIds": ["ce000000-0000-4000-8000-000000000001"],
    });
    let reply = put_raw(&t, &alice.token, sent.to_string().into_bytes()).await;
    assert_eq!(reply.status, 200, "{}", reply.text());

    let row: String = sqlx::query_scalar("SELECT row_to_json(k)::text FROM keyrings k")
        .fetch_one(&t.db)
        .await
        .unwrap();
    let row: Value = serde_json::from_str(&row).unwrap();
    let mut columns: Vec<&str> = row
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    columns.sort_unstable();
    assert_eq!(columns, ["envelope", "updated_at", "user_id", "version"]);
    assert_eq!(row["user_id"], alice.user_id.as_str());
    assert_eq!(row["version"], 1);
    assert_eq!(
        row["envelope"],
        json!({ "v": 1, "algo": "xchacha20poly1305", "keyId": "k", "nonce": "n", "ciphertext": "c" })
    );
}

#[tokio::test]
async fn accepts_a_keyring_larger_than_the_global_body_limit_up_to_its_own_cap() {
    let t = TestApp::new().await;
    let alice = register_user(&t, "bigkeyring").await;
    let sized = |n: usize| {
        let mut e = envelope("k");
        e["ciphertext"] = Value::String("A".repeat(n));
        e
    };

    // 400 KB of ciphertext: past the 256 KB every other route allows.
    let reply = put(&t, &alice.token, &sized(400 * 1024), 0).await;
    assert_eq!(reply.status, 200, "{}", reply.text());

    // The schema's cap is 1 MB of base64, to the character...
    let at_cap = put(&t, &alice.token, &sized(1024 * 1024), 1).await;
    assert_eq!(at_cap.status, 200, "{}", at_cap.text());
    let stored = get(&t, &alice.token).await.json();
    assert_eq!(stored["version"], 2);
    assert_eq!(
        stored["keyring"]["ciphertext"].as_str().unwrap().len(),
        1024 * 1024
    );
    let over = put(&t, &alice.token, &sized(1024 * 1024 + 1), 2).await;
    assert_eq!(over.status, 400);
    assert_eq!(over.json()["details"][0]["code"], "too_big");
    assert_eq!(over.json()["details"][0]["maximum"], 1024 * 1024);

    // ...and the route reads at most 1.5 MB, valid or not.
    let pad = |total: usize| {
        let mut body = json!({ "envelope": sized(16), "expectedVersion": 2 })
            .to_string()
            .into_bytes();
        body.resize(total, b' ');
        body
    };
    let at_limit = put_raw(&t, &alice.token, pad(1536 * 1024)).await;
    assert_eq!(at_limit.status, 200, "{}", at_limit.text());
    let too_large = put_raw(&t, &alice.token, pad(1536 * 1024 + 1)).await;
    assert_eq!(too_large.status, 413);
    assert_eq!(too_large.json()["code"], "FST_ERR_CTP_BODY_TOO_LARGE");
    assert_eq!(get(&t, &alice.token).await.json()["version"], 3);
}

#[tokio::test]
async fn the_larger_body_limit_is_the_keyrings_alone() {
    // An event still may not be keyring-sized.
    let t = TestApp::new().await;
    let alice: Registered = register_user(&t, "alice").await;
    let authorization = format!("Bearer {}", alice.token);
    let mut body = json!({ "envelope": envelope("k") })
        .to_string()
        .into_bytes();
    body.resize(256 * 1024 + 1, b' ');
    let reply = t
        .send(request_with(
            "POST",
            "/events",
            &[
                ("authorization", &authorization),
                ("content-type", "application/json"),
            ],
            Some(body),
        ))
        .await;
    assert_eq!(reply.status, 413);
}

#[tokio::test]
async fn rejects_a_body_that_is_not_a_keyring_write() {
    let t = TestApp::new().await;
    let alice = register_user(&t, "alice").await;
    for (body, path) in [
        (
            json!({ "envelope": envelope("k") }),
            json!(["expectedVersion"]),
        ),
        (json!({ "expectedVersion": 0 }), json!(["envelope"])),
        (
            json!({ "envelope": envelope("k"), "expectedVersion": -1 }),
            json!(["expectedVersion"]),
        ),
        (
            json!({ "envelope": envelope("k"), "expectedVersion": 0.5 }),
            json!(["expectedVersion"]),
        ),
        (
            json!({ "envelope": { "anything": "goes" }, "expectedVersion": 0 }),
            json!(["envelope", "v"]),
        ),
    ] {
        let reply = put_raw(&t, &alice.token, body.to_string().into_bytes()).await;
        assert_eq!(reply.status, 400, "{body}");
        let reply = reply.json();
        assert_eq!(reply["error"], "Invalid request", "{body}");
        assert_eq!(reply["details"][0]["path"], path, "{body}");
    }
    assert_eq!(
        get(&t, &alice.token).await.text(),
        r#"{"keyring":null,"version":0}"#
    );
}

#[tokio::test]
async fn each_keyring_request_counts_once_against_the_global_limit() {
    let t = TestApp::with_options(mekur_api::AppOptions {
        rate_limit_max: 3,
        ..common::test_options()
    })
    .await;
    let alice = register_user(&t, "alice").await;
    let first = get(&t, &alice.token).await;
    assert_eq!(first.header("x-ratelimit-limit"), Some("3"));
    assert_eq!(first.header("x-ratelimit-remaining"), Some("2"));
    let second = put(&t, &alice.token, &envelope("k"), 0).await;
    assert_eq!(second.header("x-ratelimit-remaining"), Some("1"));
    assert_eq!(get(&t, &alice.token).await.status, 200);
    // Reads and writes share the one count.
    assert_eq!(put(&t, &alice.token, &envelope("k"), 1).await.status, 429);
    assert_eq!(get(&t, &alice.token).await.status, 429);
}
