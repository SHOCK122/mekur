//! Test harness: a real PostgreSQL, as the TS suite uses (never mocks).
//!
//! Tests read `RUST_TEST_DATABASE_URL` (default
//! `postgres://postgres:postgres@localhost:5432/scheduleapp_rust_test`),
//! not the TS suite's `TEST_DATABASE_URL`, so both suites can run at once.
//! The database is created if missing. Tests that share it hold
//! [`TestApp`]'s lock for their whole run, so they never truncate each
//! other's rows.

#![allow(dead_code)] // Each test binary uses a different part of this.

use axum::{
    Router,
    body::{Body, Bytes},
    http::{HeaderMap, Request, StatusCode},
};
use http_body_util::BodyExt;
use mekur_api::{
    AppState, build_app,
    db::{create_pool, run_migrations},
};
use sqlx::{AssertSqlSafe, Connection, Executor, PgConnection, PgPool};
use tokio::sync::{Mutex, MutexGuard};
use tower::ServiceExt;

const DEFAULT_DATABASE_URL: &str =
    "postgres://postgres:postgres@localhost:5432/scheduleapp_rust_test";

static SHARED_DATABASE: Mutex<()> = Mutex::const_new(());

pub fn database_url() -> String {
    std::env::var("RUST_TEST_DATABASE_URL").unwrap_or_else(|_| DEFAULT_DATABASE_URL.to_owned())
}

/// `url` with its database name replaced by `name`.
pub fn with_database(url: &str, name: &str) -> String {
    let (server, rest) = url.rsplit_once('/').expect("a database URL has a path");
    let query = rest
        .split_once('?')
        .map(|(_, q)| format!("?{q}"))
        .unwrap_or_default();
    format!("{server}/{name}{query}")
}

/// The maintenance database on the same server, for creating and dropping
/// test databases.
pub fn admin_url() -> String {
    std::env::var("RUST_TEST_ADMIN_DATABASE_URL")
        .unwrap_or_else(|_| with_database(&database_url(), "postgres"))
}

async fn admin() -> PgConnection {
    PgConnection::connect(&admin_url())
        .await
        .expect("connect to the admin database")
}

/// Creates `name` unless it exists.
pub async fn ensure_database(name: &str) {
    let mut admin = admin().await;
    let exists: bool =
        sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1)")
            .bind(name)
            .fetch_one(&mut admin)
            .await
            .expect("query pg_database");
    if !exists {
        // Another process may create it between the check and here.
        if let Err(err) = admin
            .execute(AssertSqlSafe(format!(r#"CREATE DATABASE "{name}""#)))
            .await
        {
            let duplicate =
                err.as_database_error().and_then(|e| e.code()).as_deref() == Some("42P04");
            assert!(duplicate, "create database {name}: {err}");
        }
    }
}

/// Drops `name` (if present) and creates it empty.
pub async fn recreate_database(name: &str) {
    let mut admin = admin().await;
    admin
        .execute(AssertSqlSafe(format!(
            r#"DROP DATABASE IF EXISTS "{name}" WITH (FORCE)"#
        )))
        .await
        .expect("drop database");
    admin
        .execute(AssertSqlSafe(format!(r#"CREATE DATABASE "{name}""#)))
        .await
        .expect("create database");
}

pub async fn drop_database(name: &str) {
    admin()
        .await
        .execute(AssertSqlSafe(format!(
            r#"DROP DATABASE IF EXISTS "{name}" WITH (FORCE)"#
        )))
        .await
        .expect("drop database");
}

/// An app on the shared, migrated, emptied test database.
pub struct TestApp {
    pub app: Router,
    pub db: PgPool,
    _exclusive: MutexGuard<'static, ()>,
}

impl TestApp {
    pub async fn new() -> Self {
        let exclusive = SHARED_DATABASE.lock().await;
        let url = database_url();
        let name = url
            .rsplit('/')
            .next()
            .and_then(|n| n.split('?').next())
            .unwrap_or_default();
        ensure_database(name).await;
        let db = create_pool(&url).expect("valid database URL");
        run_migrations(&db).await.expect("migrations apply");
        truncate_all(&db).await;
        TestApp {
            app: build_app(AppState { db: db.clone() }),
            db,
            _exclusive: exclusive,
        }
    }

    pub async fn send(&self, request: Request<Body>) -> Reply {
        send(&self.app, request).await
    }
}

/// The same tables the TS suite's `truncateAll` empties.
pub async fn truncate_all(db: &PgPool) {
    sqlx::query("TRUNCATE TABLE events, keyrings, inbox_messages, users RESTART IDENTITY CASCADE")
        .execute(db)
        .await
        .expect("truncate");
}

pub struct Reply {
    pub status: StatusCode,
    pub headers: HeaderMap,
    pub body: Bytes,
}

impl Reply {
    pub fn text(&self) -> &str {
        std::str::from_utf8(&self.body).expect("UTF-8 body")
    }

    pub fn json(&self) -> serde_json::Value {
        serde_json::from_slice(&self.body).expect("JSON body")
    }

    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .get(name)
            .map(|v| v.to_str().expect("visible ASCII header"))
    }
}

pub async fn send(app: &Router, request: Request<Body>) -> Reply {
    let response = app.clone().oneshot(request).await.expect("infallible");
    let (parts, body) = response.into_parts();
    let body = body.collect().await.expect("body reads").to_bytes();
    Reply {
        status: parts.status,
        headers: parts.headers,
        body,
    }
}

pub fn request(method: &str, uri: &str) -> Request<Body> {
    Request::builder()
        .method(method)
        .uri(uri)
        .body(Body::empty())
        .expect("valid request")
}
