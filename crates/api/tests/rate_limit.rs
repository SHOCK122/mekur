//! Port of the rate-limit tests of `apps/api/test/security.test.ts`, with
//! production-like (low) limits rather than the raised test defaults.

mod common;

use std::net::SocketAddr;

use axum::extract::ConnectInfo;
use common::{TestApp, request_with, test_options};
use mekur_api::AppOptions;

fn login_attempt(forwarded_for: Option<&str>) -> axum::http::Request<axum::body::Body> {
    let mut headers = vec![("content-type", "application/json")];
    if let Some(client) = forwarded_for {
        headers.push(("x-forwarded-for", client));
    }
    let mut req = request_with(
        "POST",
        "/sessions",
        &headers,
        Some(br#"{"username":"victim","authKey":"d3JvbmctZ3Vlc3M="}"#.to_vec()),
    );
    // As from nginx, the one proxy hop in front.
    req.extensions_mut()
        .insert(ConnectInfo(SocketAddr::from(([172, 18, 0, 5], 41234))));
    req
}

#[tokio::test]
async fn throttles_repeated_login_attempts_so_the_endpoint_isnt_brute_forceable() {
    let t = TestApp::with_options(AppOptions {
        auth_rate_limit_max: 3,
        ..test_options()
    })
    .await;
    // Within the limit: rejected on the merits (401), not throttled.
    assert_eq!(t.send(login_attempt(None)).await.status, 401);
    // Keep hammering; the limiter must kick in rather than allowing
    // unlimited guesses.
    let mut saw_rate_limit = false;
    for _ in 0..10 {
        if t.send(login_attempt(None)).await.status == 429 {
            saw_rate_limit = true;
            break;
        }
    }
    assert!(saw_rate_limit);
}

#[tokio::test]
async fn limits_each_client_separately_behind_a_reverse_proxy() {
    // Without trusting the proxy, every request appears to come from
    // nginx, so one person's failed logins would lock out every user.
    let t = TestApp::with_options(AppOptions {
        auth_rate_limit_max: 2,
        trust_proxy: 1,
        ..test_options()
    })
    .await;
    for _ in 0..5 {
        t.send(login_attempt(Some("203.0.113.1"))).await;
    }
    assert_eq!(t.send(login_attempt(Some("203.0.113.1"))).await.status, 429);
    assert_eq!(t.send(login_attempt(Some("203.0.113.2"))).await.status, 401);
}

#[tokio::test]
async fn without_a_trusted_proxy_the_socket_address_is_the_client() {
    let t = TestApp::with_options(AppOptions {
        auth_rate_limit_max: 2,
        ..test_options()
    })
    .await;
    for i in 0..2 {
        t.send(login_attempt(Some(&format!("203.0.113.{i}")))).await;
    }
    // A client can't pick a fresh bucket by sending a new header.
    assert_eq!(
        t.send(login_attempt(Some("198.51.100.7"))).await.status,
        429
    );
}
