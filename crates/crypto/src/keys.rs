//! Key derivation, key generation and hashing (`deriveAuthAndEncryptionKeys`,
//! `generateKeyPair`, `generateSymmetricKey`, `sha256Base64`, `randomBytes`).

use hkdf::Hkdf;
use sha2::{Digest, Sha256};
use unicode_normalization::UnicodeNormalization;
use x25519_dalek::{PublicKey, StaticSecret};
use zeroize::Zeroizing;

use crate::{CryptoError, KEY_LENGTH, SALT_LENGTH, from_base64, to_base64};

/// scrypt cost: N = 2^17, r = 8, p = 1, 32-byte output. Wire format: a
/// different value derives different keys and locks every account out.
const SCRYPT_LOG_N: u8 = 17;
const SCRYPT_R: u32 = 8;
const SCRYPT_P: u32 = 1;

// HKDF-SHA256 labels. Wire format: they keep the project's old name.
const AUTH_KEY_INFO: &[u8] = b"schedule-app:auth-key:v1";
const ENCRYPTION_KEY_INFO: &[u8] = b"schedule-app:encryption-key:v1";
const IDENTITY_KEY_INFO: &[u8] = b"schedule-app:identity-key:v1";

/// An X25519 key pair, both halves base64.
///
/// Secret fields are `Zeroizing` (wiped when dropped, wherever they are
/// moved to) rather than the struct being `ZeroizeOnDrop`, so callers can
/// move a field out without cloning it into an unprotected `String`. No
/// `PartialEq`: comparing secrets with `==` is not constant-time.
#[derive(Clone)]
pub struct KeyPair {
    pub public_key: String,
    /// NEVER sent to the server.
    pub secret_key: Zeroizing<String>,
}

impl std::fmt::Debug for KeyPair {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("KeyPair")
            .field("public_key", &self.public_key)
            .field("secret_key", &"<redacted>")
            .finish()
    }
}

/// Everything derived from one password (see
/// [`derive_auth_and_encryption_keys`]). All fields are base64; see
/// [`KeyPair`] for why secrets are `Zeroizing` fields.
#[derive(Clone)]
pub struct AuthAndEncryptionKeys {
    /// Sent to the server only at login, over TLS; the server stores its
    /// SHA-256.
    pub auth_key: Zeroizing<String>,
    /// Encrypts the keyring. Never leaves the client.
    pub encryption_key: Zeroizing<String>,
    /// The account's X25519 identity: the public half is registered with
    /// the server so others can seal invitations to it; the secret half
    /// never leaves the client.
    pub identity_key_pair: KeyPair,
    /// Must be stored to re-derive the same keys later.
    pub salt: String,
}

impl std::fmt::Debug for AuthAndEncryptionKeys {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AuthAndEncryptionKeys")
            .field("auth_key", &"<redacted>")
            .field("encryption_key", &"<redacted>")
            .field("identity_key_pair", &self.identity_key_pair)
            .field("salt", &self.salt)
            .finish()
    }
}

/// `length` bytes from the platform's secure random source
/// (`getrandom`; `crypto.getRandomValues` in the browser).
pub fn random_bytes(length: usize) -> Result<Vec<u8>, CryptoError> {
    let mut out = vec![0u8; length];
    getrandom::fill(&mut out).map_err(|_| CryptoError::Random)?;
    Ok(out)
}

pub(crate) fn random_array<const N: usize>() -> Result<Zeroizing<[u8; N]>, CryptoError> {
    let mut out = Zeroizing::new([0u8; N]);
    getrandom::fill(out.as_mut()).map_err(|_| CryptoError::Random)?;
    Ok(out)
}

/// The X25519 public key for a 32-byte secret. Any 32 bytes are a valid
/// secret: X25519 clamps the scalar on every use.
pub(crate) fn x25519_public(secret: &[u8; 32]) -> [u8; 32] {
    PublicKey::from(&StaticSecret::from(*secret)).to_bytes()
}

/// Decodes a base64 X25519 key (public or secret), which must be exactly
/// 32 bytes.
pub(crate) fn x25519_key(base64: &str) -> Result<Zeroizing<[u8; 32]>, CryptoError> {
    let bytes = Zeroizing::new(from_base64(base64)?);
    let mut out = Zeroizing::new([0u8; 32]);
    if bytes.len() != 32 {
        return Err(CryptoError::X25519KeyLength);
    }
    out.copy_from_slice(&bytes);
    Ok(out)
}

/// X25519 Diffie-Hellman. An all-zero result (the peer sent a low-order
/// point) is an error, as it is in `@noble/curves`.
pub(crate) fn x25519_shared(
    secret: &[u8; 32],
    their_public: &[u8; 32],
) -> Result<Zeroizing<[u8; 32]>, CryptoError> {
    let shared = StaticSecret::from(*secret).diffie_hellman(&PublicKey::from(*their_public));
    if !shared.was_contributory() {
        return Err(CryptoError::NonContributory);
    }
    Ok(Zeroizing::new(shared.to_bytes()))
}

/// HKDF-SHA256 to a 32-byte key. `salt: None` is RFC 5869's all-zero salt,
/// which is what `@noble/hashes`' `hkdf` uses for an `undefined` salt.
pub(crate) fn hkdf32(ikm: &[u8], salt: Option<&[u8]>, info: &[u8]) -> Zeroizing<[u8; KEY_LENGTH]> {
    let mut okm = Zeroizing::new([0u8; KEY_LENGTH]);
    Hkdf::<Sha256>::new(salt, ikm)
        .expand(info, okm.as_mut())
        .expect("32 bytes is a valid HKDF-SHA256 output length");
    okm
}

/// Generates a random X25519 key pair. Used for the ephemeral half of a
/// sealed envelope, and wherever the TS client called `generateKeyPair`.
pub fn generate_key_pair() -> Result<KeyPair, CryptoError> {
    let secret = random_array::<32>()?;
    Ok(KeyPair {
        public_key: to_base64(&x25519_public(&secret)),
        secret_key: Zeroizing::new(to_base64(secret.as_ref())),
    })
}

/// Derives three independent things from one password with a single
/// scrypt run, split by HKDF with distinct labels so none can be derived
/// from another: an `auth_key` (proves knowledge of the password to the
/// server), an `encryption_key` (encrypts the keyring; never sent
/// anywhere) and an X25519 `identity_key_pair` (re-derivable, so it never
/// needs separate backup).
///
/// The password is NFKC-normalised first, so the same password typed on
/// different keyboards derives the same keys. A fresh 16-byte salt is
/// generated when `salt` is `None`.
///
/// This costs ~128 MiB and seconds of CPU by design, synchronously. The
/// TS version was `async` and yielded to the event loop; in the browser
/// this must run in a dedicated Web Worker (see `docs/RUST_MIGRATION.md`,
/// step 4e), which also lets the 128 MiB of wasm memory -- which never
/// shrinks -- be released by ending the worker.
pub fn derive_auth_and_encryption_keys(
    password: &str,
    salt: Option<&[u8]>,
) -> Result<AuthAndEncryptionKeys, CryptoError> {
    let used_salt: Zeroizing<Vec<u8>> = match salt {
        Some(s) => Zeroizing::new(s.to_vec()),
        None => Zeroizing::new(random_bytes(SALT_LENGTH)?),
    };
    // Sized exactly before filling, so no partly written copy of the
    // password is left behind in a freed buffer by reallocation.
    let normalized_len = password.nfkc().map(char::len_utf8).sum();
    let mut normalized = Zeroizing::new(String::with_capacity(normalized_len));
    normalized.extend(password.nfkc());
    let params = scrypt::Params::new(SCRYPT_LOG_N, SCRYPT_R, SCRYPT_P)
        .expect("N = 2^17, r = 8, p = 1 are valid scrypt parameters");
    let mut master = Zeroizing::new([0u8; KEY_LENGTH]);
    scrypt::scrypt(normalized.as_bytes(), &used_salt, &params, master.as_mut())
        .expect("32 bytes is a valid scrypt output length");

    let auth_key = hkdf32(master.as_ref(), Some(&used_salt), AUTH_KEY_INFO);
    let encryption_key = hkdf32(master.as_ref(), Some(&used_salt), ENCRYPTION_KEY_INFO);
    let identity_seed = hkdf32(master.as_ref(), Some(&used_salt), IDENTITY_KEY_INFO);
    Ok(AuthAndEncryptionKeys {
        auth_key: Zeroizing::new(to_base64(auth_key.as_ref())),
        encryption_key: Zeroizing::new(to_base64(encryption_key.as_ref())),
        identity_key_pair: KeyPair {
            public_key: to_base64(&x25519_public(&identity_seed)),
            secret_key: Zeroizing::new(to_base64(identity_seed.as_ref())),
        },
        salt: to_base64(&used_salt),
    })
}

/// SHA-256 of a base64 key, base64-encoded: the auth verifier as the
/// server stores it.
pub fn sha256_base64(key_base64: &str) -> Result<String, CryptoError> {
    let bytes = Zeroizing::new(from_base64(key_base64)?);
    Ok(to_base64(&Sha256::digest(bytes.as_slice())))
}

/// A fresh random 32-byte symmetric key (e.g. a per-event key), base64.
pub fn generate_symmetric_key() -> Result<String, CryptoError> {
    Ok(to_base64(random_array::<KEY_LENGTH>()?.as_ref()))
}
