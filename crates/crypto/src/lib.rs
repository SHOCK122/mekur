//! Client-side cryptography for mekur.
//!
//! Takes over from `packages/crypto`. Built only from audited RustCrypto
//! crates -- no hand-rolled primitives -- and byte-for-byte compatible
//! with the TypeScript implementation (same scrypt parameters, HKDF
//! labels, envelope and sealed-envelope formats), proven by cross-language
//! test vectors. Decryption stays client-side: this crate is linked into
//! the WebAssembly client, never used by the API to open user content.
//! Nothing is ported yet; see `docs/RUST_MIGRATION.md`.
