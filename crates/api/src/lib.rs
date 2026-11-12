//! mekur's HTTP API (axum + sqlx against PostgreSQL).
//!
//! Takes over from `apps/api` route group by route group, with identical
//! paths, status codes, response bodies and database schema, so the two
//! servers can run side by side behind nginx during the migration. Ported
//! so far: configuration, the pool and migration runner, `GET /health`,
//! `GET /openapi.json`, security headers and 404s (step 3a of
//! `docs/RUST_MIGRATION.md`); registration, login, the salt lookup, rate
//! limiting and request bodies (step 3b).

pub mod app;
pub mod body;
pub mod config;
pub mod db;
pub mod jwt;
pub mod node_base64;
pub mod rate_limit;
pub mod routes;
pub mod users;

pub use app::{AppOptions, AppState, build_app};
