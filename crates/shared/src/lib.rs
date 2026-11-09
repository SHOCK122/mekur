//! Shared types and validation for mekur.
//!
//! Takes over from `packages/shared` (Zod): each schema is a type with a
//! `parse(&serde_json::Value)` that applies the same rules and limits and,
//! on failure, reports the same issues Zod would (see [`issue`]), so the
//! Rust API, the WebAssembly client and the remaining TypeScript agree on
//! what is valid and say so in the same words. Types serialize to the same
//! JSON Zod's parsed output has.
//!
//! There is deliberately no `Deserialize` on the schema types: the only way
//! from JSON (a request body, decrypted content) to a typed value is
//! `parse`, so untrusted input cannot skip validation. Values built
//! directly in Rust are trusted code's responsibility, as constructing a
//! TypeScript object of the inferred type was: to check one before it is
//! encrypted or sent, `parse` its `serde_json::to_value`. Parity notes are in
//! `docs/RUST_MIGRATION.md`; `tests/fixtures/zod_parity.json` holds Zod's
//! own verdicts, which the tests replay.

pub mod datetime;
mod envelope;
mod event;
pub mod issue;
mod recurrence;
mod time_zone;
mod zod;

pub use envelope::{
    ENVELOPE_ALGO, ENVELOPE_VERSION, EncryptedEnvelope, KeyringEnvelope, MAX_EVENT_CIPHERTEXT,
    MAX_KEYRING_CIPHERTEXT, SealedEnvelope,
};
pub use event::{EventContent, MAX_OCCURRENCE_OVERRIDES, OccurrenceOverride};
pub use issue::{Issue, IssueKind, PathSegment, ValidationError};
pub use recurrence::{RecurrenceFrequency, RecurrenceRule, Weekday};
pub use time_zone::is_valid_time_zone;
