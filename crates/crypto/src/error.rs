//! The one error type. Messages that the TypeScript implementation
//! surfaced (`"Sender proof does not verify"`, the key-length messages) are
//! kept word for word.

/// Why a cryptographic operation failed. None of these carry key material
/// or plaintext.
#[derive(Debug, thiserror::Error)]
pub enum CryptoError {
    /// A base64 field could not be decoded under the browser's
    /// (`atob`'s) rules.
    #[error("Invalid base64")]
    InvalidBase64,
    #[error("Encryption key must be {expected} bytes", expected = crate::KEY_LENGTH)]
    EncryptionKeyLength,
    #[error("Decryption key must be {expected} bytes", expected = crate::KEY_LENGTH)]
    DecryptionKeyLength,
    #[error("Nonce must be {expected} bytes", expected = crate::NONCE_LENGTH)]
    NonceLength,
    /// X25519 keys (public or secret) are exactly 32 bytes.
    #[error("X25519 keys must be 32 bytes")]
    X25519KeyLength,
    /// The X25519 shared secret came out all zero: the other side's public
    /// key is a low-order point, so the "secret" is known to everyone.
    #[error("X25519 shared secret is all zero")]
    NonContributory,
    /// Wrong key, or the ciphertext / nonce was tampered with.
    #[error("Decryption failed: wrong key or tampered data")]
    Decrypt,
    /// The plaintext was not the JSON this crate encrypts.
    #[error("Decrypted payload is not valid JSON")]
    PlaintextNotJson,
    /// A sealed envelope opened, but its inner `{ body, sender? }` is not
    /// shaped the way `seal_to_recipient` writes it.
    #[error("Sealed envelope has a malformed body")]
    MalformedSealedBody,
    /// A named sender's proof does not verify: a forged identity is an
    /// error, never silently dropped.
    #[error("Sender proof does not verify")]
    SenderProof,
    /// The plaintext is too long for XChaCha20-Poly1305 (~256 GiB).
    #[error("Encryption failed")]
    Encrypt,
    /// The payload could not be serialized to JSON.
    #[error("Payload cannot be serialized to JSON")]
    Serialize,
    /// The platform's secure random source failed.
    #[error("Secure random source unavailable")]
    Random,
}
