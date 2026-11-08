//! mekur's HTTP API (axum + sqlx against PostgreSQL).
//!
//! Takes over from `apps/api` route group by route group, with identical
//! paths, status codes, response bodies and database schema, so the two
//! servers can run side by side behind nginx during the migration.
//! Nothing is ported yet; see `docs/RUST_MIGRATION.md`.
