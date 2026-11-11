//! mekur's HTTP API (axum + sqlx against PostgreSQL).
//!
//! Takes over from `apps/api` route group by route group, with identical
//! paths, status codes, response bodies and database schema, so the two
//! servers can run side by side behind nginx during the migration. Ported
//! so far: configuration, the pool and migration runner, `GET /health`,
//! `GET /openapi.json`, security headers and 404s (step 3a of
//! `docs/RUST_MIGRATION.md`).

pub mod app;
pub mod config;
pub mod db;

pub use app::{AppState, build_app};
