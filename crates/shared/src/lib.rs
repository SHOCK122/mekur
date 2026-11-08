//! Shared types and validation for mekur.
//!
//! Takes over from `packages/shared` (Zod): serde types plus explicit
//! validation functions with the same rules and limits, so the Rust API,
//! the WebAssembly client and the remaining TypeScript agree on what is
//! valid. Nothing is ported yet; see `docs/RUST_MIGRATION.md` for the
//! order and the parity rules (UTF-16 string lengths, Zod's datetime
//! format, millisecond instants).
