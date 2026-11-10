//! Client-side cryptography for mekur.
//!
//! Takes over from `packages/crypto`. Built only from audited RustCrypto
//! crates -- no hand-rolled primitives -- and byte-for-byte compatible
//! with the TypeScript implementation (same scrypt parameters, HKDF
//! labels, envelope and sealed-envelope formats), proven by cross-language
//! test vectors (`tests/fixtures/`). Decryption stays client-side: this
//! crate is linked into the WebAssembly client, never used by the API to
//! open user content.
//!
//! Keys cross this crate's boundary as standard base64 strings, exactly as
//! they do in the TypeScript client (and as they are stored in the
//! keyring), so call sites port one-to-one.

mod base64;
mod envelope;
mod error;
mod keys;
mod sealed;

pub use base64::{from_base64, to_base64};
pub use envelope::{Envelope, decrypt_envelope, encrypt_envelope, encrypt_keyring_envelope};
pub use error::CryptoError;
pub use keys::{
    AuthAndEncryptionKeys, KeyPair, derive_auth_and_encryption_keys, generate_key_pair,
    generate_symmetric_key, random_bytes, sha256_base64,
};
pub use sealed::{OpenedEnvelope, open_sealed, seal_to_recipient};

/// Length in bytes of every symmetric key (256-bit).
pub const KEY_LENGTH: usize = 32;
/// Length in bytes of an XChaCha20-Poly1305 nonce.
pub const NONCE_LENGTH: usize = 24;
/// Length in bytes of the random scrypt salt.
pub const SALT_LENGTH: usize = 16;
