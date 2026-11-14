//! Port of the "capability-based events" tests of
//! `apps/api/test/capabilities.test.ts` and the event tests of
//! `apps/api/test/security.test.ts` (payload caps, malformed ids), plus what
//! they didn't cover: what the database holds (no account linked to an
//! event, only token hashes), expiry, and envelopes round-tripping byte for
//! byte. Every reply the TS routes gave is also replayed from
//! `fixtures/ts_event_responses.json` by `tests/ts_parity.rs`.

mod common;

use common::{Registered, TestApp, register_user, request_with};
use mekur_api::events::hash_capability_token;
use serde_json::{Value, json};

/// The TS suite's `ENVELOPE`: structurally valid; the server never
/// decrypts, so its contents don't matter.
fn envelope() -> Value {
    json!({
        "v": 1,
        "algo": "xchacha20poly1305",
        "keyId": "k",
        "nonce": "bm9uY2U=",
        "ciphertext": "Y2lwaGVydGV4dA==",
    })
}

/// A request as the account `token`, presenting `capability` if given.
async fn send(
    t: &TestApp,
    method: &str,
    path: &str,
    token: &str,
    capability: Option<&str>,
    body: Option<&Value>,
) -> common::Reply {
    let bearer = format!("Bearer {token}");
    let mut headers = vec![("authorization", bearer.as_str())];
    if let Some(capability) = capability {
        headers.push(("x-event-capability", capability));
    }
    if body.is_some() {
        headers.push(("content-type", "application/json"));
    }
    t.send(request_with(
        method,
        path,
        &headers,
        body.map(|b| b.to_string().into_bytes()),
    ))
    .await
}

struct Created {
    id: String,
    view_token: String,
    edit_token: String,
}

async fn create_event(t: &TestApp, user: &Registered) -> Created {
    let reply = send(
        t,
        "POST",
        "/events",
        &user.token,
        None,
        Some(&json!({ "envelope": envelope() })),
    )
    .await;
    assert_eq!(reply.status, 201, "{}", reply.text());
    let body = reply.json();
    Created {
        id: body["event"]["id"].as_str().unwrap().to_owned(),
        view_token: body["viewToken"].as_str().unwrap().to_owned(),
        edit_token: body["editToken"].as_str().unwrap().to_owned(),
    }
}

async fn mint(t: &TestApp, user: &Registered, event: &Created, body: Value) -> common::Reply {
    let path = format!("/events/{}/capabilities", event.id);
    send(
        t,
        "POST",
        &path,
        &user.token,
        Some(&event.edit_token),
        Some(&body),
    )
    .await
}

#[tokio::test]
async fn returns_view_and_edit_tokens_exactly_once_on_creation() {
    let t = TestApp::new().await;
    let alice = register_user(&t, "alice").await;
    let created = create_event(&t, &alice).await;
    assert!(!created.view_token.is_empty());
    assert!(!created.edit_token.is_empty());
    assert_ne!(created.view_token, created.edit_token);
}

#[tokio::test]
async fn grants_read_to_anyone_holding_the_view_token() {
    let t = TestApp::new().await;
    let alice = register_user(&t, "alice").await;
    let bob = register_user(&t, "bob").await;
    let created = create_event(&t, &alice).await;

    // Bob has no relationship to this event in any table -- the capability
    // alone is the authorisation. That is the whole point of the model.
    let path = format!("/events/{}", created.id);
    let reply = send(
        &t,
        "GET",
        &path,
        &bob.token,
        Some(&created.view_token),
        None,
    )
    .await;
    assert_eq!(reply.status, 200);
    assert_eq!(reply.json()["event"]["id"], created.id.as_str());
}

#[tokio::test]
async fn refuses_access_without_a_capability_even_to_the_creator() {
    let t = TestApp::new().await;
    let alice = register_user(&t, "alice").await;
    let created = create_event(&t, &alice).await;
    // There is no notion of ownership: creating an event grants no standing
    // access. Alice keeps her tokens in her keyring, not in the database.
    let path = format!("/events/{}", created.id);
    let reply = send(&t, "GET", &path, &alice.token, None, None).await;
    assert_eq!(reply.status, 404);
}

#[tokio::test]
async fn stores_no_link_between_the_creating_account_and_the_event() {
    let t = TestApp::new().await;
    let alice = register_user(&t, "alice").await;
    let created = create_event(&t, &alice).await;
    // Inspect the raw rows: nothing in them may point back at Alice, and
    // the tokens themselves are never stored, only their hashes.
    let rows: Vec<String> = sqlx::query_scalar(
        "SELECT row_to_json(e)::text FROM events e
         UNION ALL SELECT row_to_json(c)::text FROM event_capabilities c",
    )
    .fetch_all(&t.db)
    .await
    .unwrap();
    assert_eq!(rows.len(), 3);
    for row in &rows {
        assert!(!row.contains(&alice.user_id), "{row}");
        assert!(!row.contains(&created.view_token), "{row}");
        assert!(!row.contains(&created.edit_token), "{row}");
    }
    let hashes: Vec<String> =
        sqlx::query_scalar("SELECT token_hash FROM event_capabilities ORDER BY level")
            .fetch_all(&t.db)
            .await
            .unwrap();
    assert_eq!(
        hashes,
        [
            hash_capability_token(&created.edit_token),
            hash_capability_token(&created.view_token)
        ]
    );
}

#[tokio::test]
async fn does_not_let_a_view_token_edit_delete_or_mint() {
    let t = TestApp::new().await;
    let alice = register_user(&t, "alice").await;
    let created = create_event(&t, &alice).await;
    let path = format!("/events/{}", created.id);
    let view = Some(created.view_token.as_str());
    let body = json!({ "envelope": envelope() });

    let edit = send(&t, "PUT", &path, &alice.token, view, Some(&body)).await;
    assert_eq!(edit.status, 404);
    let remove = send(&t, "DELETE", &path, &alice.token, view, None).await;
    assert_eq!(remove.status, 404);
    let mint_path = format!("{path}/capabilities");
    let minted = send(
        &t,
        "POST",
        &mint_path,
        &alice.token,
        view,
        Some(&json!({ "level": "edit" })),
    )
    .await;
    assert_eq!(minted.status, 404);
    let revoke_path = format!("{path}/capabilities/revoke");
    let revoked = send(
        &t,
        "POST",
        &revoke_path,
        &alice.token,
        view,
        Some(&json!({ "token": created.edit_token })),
    )
    .await;
    assert_eq!(revoked.status, 404);
    // Still there, unchanged.
    let read = send(&t, "GET", &path, &alice.token, view, None).await;
    assert_eq!(read.status, 200);
}

#[tokio::test]
async fn lets_an_edit_token_both_read_and_write() {
    let t = TestApp::new().await;
    let alice = register_user(&t, "alice").await;
    let created = create_event(&t, &alice).await;
    let path = format!("/events/{}", created.id);
    let edit = Some(created.edit_token.as_str());

    let read = send(&t, "GET", &path, &alice.token, edit, None).await;
    assert_eq!(read.status, 200);
    let before = read.json()["event"].clone();

    let mut changed = envelope();
    changed["ciphertext"] = json!("dXBkYXRlZA==");
    let write = send(
        &t,
        "PUT",
        &path,
        &alice.token,
        edit,
        Some(&json!({ "envelope": changed })),
    )
    .await;
    assert_eq!(write.status, 200);
    let after = write.json()["event"].clone();
    assert_eq!(after["envelope"], changed);
    assert_eq!(after["createdAt"], before["createdAt"]);
    assert!(after["updatedAt"].as_str() >= before["updatedAt"].as_str());

    let remove = send(&t, "DELETE", &path, &alice.token, edit, None).await;
    assert_eq!(remove.status, 204);
    assert!(remove.body.is_empty());
    let gone = send(&t, "GET", &path, &alice.token, edit, None).await;
    assert_eq!(gone.status, 404);
    // Its capabilities went with it.
    let left: i64 = sqlx::query_scalar("SELECT count(*) FROM event_capabilities")
        .fetch_one(&t.db)
        .await
        .unwrap();
    assert_eq!(left, 0);
}

#[tokio::test]
async fn returns_404_not_403_for_a_wrong_capability_so_ids_cant_be_probed() {
    let t = TestApp::new().await;
    let alice = register_user(&t, "alice").await;
    let created = create_event(&t, &alice).await;
    let wrong = Some("not-a-real-token");
    let wrong_token = send(
        &t,
        "GET",
        &format!("/events/{}", created.id),
        &alice.token,
        wrong,
        None,
    )
    .await;
    let missing_event = send(
        &t,
        "GET",
        "/events/6c84fb90-12c4-11e1-840d-7b25c5ee775a",
        &alice.token,
        wrong,
        None,
    )
    .await;
    // Identical responses: a different status would confirm the event
    // exists to someone guessing ids.
    assert_eq!(wrong_token.status, 404);
    assert_eq!(missing_event.status, 404);
    assert_eq!(wrong_token.body, missing_event.body);
}

#[tokio::test]
async fn mints_a_reusable_join_capability_and_revokes_it() {
    let t = TestApp::new().await;
    let alice = register_user(&t, "alice").await;
    let bob = register_user(&t, "bob").await;
    let created = create_event(&t, &alice).await;

    let minted = mint(&t, &alice, &created, json!({ "level": "view" })).await;
    assert_eq!(minted.status, 201);
    let join = minted.json()["token"].as_str().unwrap().to_owned();
    assert_eq!(join.len(), 43);

    // Reusable: works more than once, unlike a friend code.
    let path = format!("/events/{}", created.id);
    for _ in 0..3 {
        let used = send(&t, "GET", &path, &bob.token, Some(&join), None).await;
        assert_eq!(used.status, 200);
    }

    let revoke_path = format!("{path}/capabilities/revoke");
    let revoked = send(
        &t,
        "POST",
        &revoke_path,
        &alice.token,
        Some(&created.edit_token),
        Some(&json!({ "token": join })),
    )
    .await;
    assert_eq!(revoked.status, 204);
    let after = send(&t, "GET", &path, &bob.token, Some(&join), None).await;
    assert_eq!(after.status, 404);
    // Revoking it again finds nothing live to revoke.
    let again = send(
        &t,
        "POST",
        &revoke_path,
        &alice.token,
        Some(&created.edit_token),
        Some(&json!({ "token": join })),
    )
    .await;
    assert_eq!(again.status, 404);
}

#[tokio::test]
async fn an_expired_capability_stops_working() {
    let t = TestApp::new().await;
    let alice = register_user(&t, "alice").await;
    let created = create_event(&t, &alice).await;
    let path = format!("/events/{}", created.id);

    let future = mint(
        &t,
        &alice,
        &created,
        json!({ "level": "edit", "expiresAt": "2999-01-01T00:00:00.123456Z" }),
    )
    .await;
    assert_eq!(future.status, 201);
    let future = future.json()["token"].as_str().unwrap().to_owned();
    let read = send(&t, "GET", &path, &alice.token, Some(&future), None).await;
    assert_eq!(read.status, 200);
    // Stored to the millisecond, as `new Date()` read it.
    let expires: String = sqlx::query_scalar(
        "SELECT to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US')
         FROM event_capabilities WHERE token_hash = $1",
    )
    .bind(hash_capability_token(&future))
    .fetch_one(&t.db)
    .await
    .unwrap();
    assert_eq!(expires, "2999-01-01 00:00:00.123000");

    let past = mint(
        &t,
        &alice,
        &created,
        json!({ "level": "view", "expiresAt": "2001-01-01T00:00Z" }),
    )
    .await;
    assert_eq!(past.status, 201);
    let past = past.json()["token"].as_str().unwrap().to_owned();
    let read = send(&t, "GET", &path, &alice.token, Some(&past), None).await;
    assert_eq!(read.status, 404);
}

#[tokio::test]
async fn batch_reads_only_the_events_whose_capabilities_are_presented() {
    let t = TestApp::new().await;
    let alice = register_user(&t, "alice").await;
    let mine = create_event(&t, &alice).await;
    let other = create_event(&t, &alice).await;
    let reply = send(
        &t,
        "POST",
        "/events/batch-read",
        &alice.token,
        None,
        Some(&json!({ "events": [
            { "eventId": mine.id, "token": mine.view_token },
            // Correct id, wrong token -- must be silently omitted.
            { "eventId": other.id, "token": "wrong-token" },
        ] })),
    )
    .await;
    assert_eq!(reply.status, 200);
    let body = reply.json();
    let ids: Vec<&str> = body["events"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, [mine.id.as_str()]);
}

#[tokio::test]
async fn batch_read_omits_revoked_capabilities_and_deduplicates_events() {
    let t = TestApp::new().await;
    let alice = register_user(&t, "alice").await;
    let created = create_event(&t, &alice).await;
    let join = mint(&t, &alice, &created, json!({ "level": "view" }))
        .await
        .json()["token"]
        .as_str()
        .unwrap()
        .to_owned();
    let revoke_path = format!("/events/{}/capabilities/revoke", created.id);
    let revoked = send(
        &t,
        "POST",
        &revoke_path,
        &alice.token,
        Some(&created.edit_token),
        Some(&json!({ "token": join })),
    )
    .await;
    assert_eq!(revoked.status, 204);

    let batch = |entries: Value| {
        let token = alice.token.clone();
        let t = &t;
        async move {
            send(
                t,
                "POST",
                "/events/batch-read",
                &token,
                None,
                Some(&json!({ "events": entries })),
            )
            .await
            .json()["events"]
                .as_array()
                .unwrap()
                .len()
        }
    };
    assert_eq!(
        batch(json!([{ "eventId": created.id, "token": join }])).await,
        0
    );
    assert_eq!(
        batch(json!([
            { "eventId": created.id, "token": created.view_token },
            { "eventId": created.id, "token": created.edit_token },
        ]))
        .await,
        1
    );
}

#[tokio::test]
async fn batch_read_is_bounded() {
    let t = TestApp::new().await;
    let alice = register_user(&t, "alice").await;
    let created = create_event(&t, &alice).await;
    let entry = json!({ "eventId": created.id, "token": created.view_token });
    let at_limit = send(
        &t,
        "POST",
        "/events/batch-read",
        &alice.token,
        None,
        Some(&json!({ "events": vec![entry.clone(); 500] })),
    )
    .await;
    assert_eq!(at_limit.status, 200);
    assert_eq!(at_limit.json()["events"].as_array().unwrap().len(), 1);
    let over = send(
        &t,
        "POST",
        "/events/batch-read",
        &alice.token,
        None,
        Some(&json!({ "events": vec![entry; 501] })),
    )
    .await;
    assert_eq!(over.status, 400);
    assert_eq!(over.json()["details"][0]["code"], "too_big");
}

#[tokio::test]
async fn accepts_a_delete_that_declares_json_but_sends_no_body() {
    // Regression: the client sent Content-Type: application/json on DELETE
    // with no body, and Fastify rejected it outright -- surfacing to the
    // user as a bare "Bad Request" when they tried to delete an event.
    let t = TestApp::new().await;
    let alice = register_user(&t, "alice").await;
    let created = create_event(&t, &alice).await;
    let bearer = format!("Bearer {}", alice.token);
    let reply = t
        .send(request_with(
            "DELETE",
            &format!("/events/{}", created.id),
            &[
                ("authorization", &bearer),
                ("x-event-capability", &created.edit_token),
                ("content-type", "application/json"),
            ],
            None,
        ))
        .await;
    assert_eq!(reply.status, 204);
}

#[tokio::test]
async fn still_rejects_malformed_json_rather_than_treating_it_as_empty() {
    let t = TestApp::new().await;
    let alice = register_user(&t, "alice").await;
    let bearer = format!("Bearer {}", alice.token);
    let reply = t
        .send(request_with(
            "POST",
            "/events",
            &[
                ("authorization", &bearer),
                ("content-type", "application/json"),
            ],
            Some(b"{not valid json".to_vec()),
        ))
        .await;
    assert_eq!(reply.status, 400);
}

#[tokio::test]
async fn rejects_an_oversized_encrypted_payload() {
    // From security.test.ts: unbounded blobs are never stored.
    let t = TestApp::new().await;
    let alice = register_user(&t, "bigpayload").await;
    let mut big = envelope();
    big["ciphertext"] = json!("A".repeat(200 * 1024)); // over the 128 KB event cap
    let reply = send(
        &t,
        "POST",
        "/events",
        &alice.token,
        None,
        Some(&json!({ "envelope": big })),
    )
    .await;
    assert_eq!(reply.status, 400);
    assert_eq!(reply.json()["details"][0]["code"], "too_big");
    let mut huge = envelope();
    huge["ciphertext"] = json!("A".repeat(300 * 1024)); // over the body limit
    let reply = send(
        &t,
        "POST",
        "/events",
        &alice.token,
        None,
        Some(&json!({ "envelope": huge })),
    )
    .await;
    assert_eq!(reply.status, 413);
    let stored: i64 = sqlx::query_scalar("SELECT count(*) FROM events")
        .fetch_one(&t.db)
        .await
        .unwrap();
    assert_eq!(stored, 0);
}

#[tokio::test]
async fn returns_404_not_500_for_a_malformed_uuid_path_param() {
    // From security.test.ts (found during a bughunt): a malformed id that
    // reached Postgres threw on the uuid cast, surfacing as a 500.
    let t = TestApp::new().await;
    let alice = register_user(&t, "uuidguard").await;
    let get = send(
        &t,
        "GET",
        "/events/not-a-uuid",
        &alice.token,
        Some("anything"),
        None,
    )
    .await;
    assert_eq!(get.status, 404);
    for (method, path) in [
        ("DELETE", "/events/also-not-a-uuid"),
        ("PUT", "/events/nope"),
        ("POST", "/events/nope/capabilities"),
        ("POST", "/events/nope/capabilities/revoke"),
    ] {
        let reply = send(
            &t,
            method,
            path,
            &alice.token,
            Some("anything"),
            Some(&json!({})),
        )
        .await;
        assert_eq!(reply.status, 404, "{method} {path}");
    }
}

#[tokio::test]
async fn round_trips_an_envelope_byte_for_byte_as_the_ts_server_wrote_it() {
    // Unicode, escapes and unknown keys: the reply is what
    // `JSON.stringify(JSON.parse(jsonb text))` gave -- jsonb's key order,
    // unknown keys stripped, control characters escaped, the rest raw.
    let t = TestApp::new().await;
    let alice = register_user(&t, "alice").await;
    let body = r#"{"envelope":{"extra":1,"ciphertext":"\u007f<>&' ","nonce":"a\/b\u0001\t\"q\\","keyId":"ké😀","algo":"xchacha20poly1305","v":1.0}}"#;
    let bearer = format!("Bearer {}", alice.token);
    let created = t
        .send(request_with(
            "POST",
            "/events",
            &[
                ("authorization", &bearer),
                ("content-type", "application/json"),
            ],
            Some(body.as_bytes().to_vec()),
        ))
        .await;
    assert_eq!(created.status, 201, "{}", created.text());
    let created = created.json();
    let id = created["event"]["id"].as_str().unwrap();
    let view = created["viewToken"].as_str().unwrap();
    let reply = send(
        &t,
        "GET",
        &format!("/events/{id}"),
        &alice.token,
        Some(view),
        None,
    )
    .await;
    let expected_envelope = "{\"v\":1,\"algo\":\"xchacha20poly1305\",\"keyId\":\"ké😀\",\
                             \"nonce\":\"a/b\\u0001\\t\\\"q\\\\\",\"ciphertext\":\"\u{7f}<>&'\u{2028}\"}";
    let text = reply.text();
    assert!(
        text.contains(&format!("\"envelope\":{expected_envelope},")),
        "{text}"
    );
}
