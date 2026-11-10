//! Symmetric envelopes (`encryptEnvelope` / `decryptEnvelope`):
//! XChaCha20-Poly1305 over the payload's JSON, random 24-byte nonce.

use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use mekur_shared::{EncryptedEnvelope, KeyringEnvelope, SealedEnvelope};
use serde::Serialize;
use serde_json::Value;
use zeroize::Zeroizing;

use crate::keys::random_array;
use crate::{CryptoError, KEY_LENGTH, NONCE_LENGTH, from_base64, to_base64};

/// Decodes a base64 symmetric key, which must be exactly
/// [`KEY_LENGTH`] bytes (`wrong_length` otherwise, so encryption and
/// decryption keep their own TS error messages).
fn symmetric_key(
    key_base64: &str,
    wrong_length: CryptoError,
) -> Result<Zeroizing<[u8; KEY_LENGTH]>, CryptoError> {
    let bytes = Zeroizing::new(from_base64(key_base64)?);
    let mut key = Zeroizing::new([0u8; KEY_LENGTH]);
    if bytes.len() != KEY_LENGTH {
        return Err(wrong_length);
    }
    key.copy_from_slice(&bytes);
    Ok(key)
}

fn cipher(key: &[u8; KEY_LENGTH]) -> XChaCha20Poly1305 {
    XChaCha20Poly1305::new(&(*key).into())
}

/// The JSON text of a payload, as `JSON.stringify` would carry it.
pub(crate) fn to_json(payload: &impl Serialize) -> Result<Zeroizing<Vec<u8>>, CryptoError> {
    serde_json::to_vec(payload)
        .map(Zeroizing::new)
        .map_err(|_| CryptoError::Serialize)
}

/// An envelope this crate can open: every envelope shape shares the
/// `{ nonce, ciphertext }` fields. Sealed envelopes are opened with
/// [`crate::open_sealed`], which derives their key first.
pub trait Envelope {
    fn nonce(&self) -> &str;
    fn ciphertext(&self) -> &str;
}

macro_rules! envelope {
    ($($t:ty),*) => {$(
        impl Envelope for $t {
            fn nonce(&self) -> &str { &self.nonce }
            fn ciphertext(&self) -> &str { &self.ciphertext }
        }
    )*};
}
envelope!(EncryptedEnvelope, KeyringEnvelope, SealedEnvelope);

/// `(nonce, ciphertext)`, both base64, under a raw key.
pub(crate) fn seal(
    payload: &impl Serialize,
    key: &[u8; KEY_LENGTH],
) -> Result<(String, String), CryptoError> {
    let cipher = cipher(key);
    let plaintext = to_json(payload)?;
    let nonce = random_array::<NONCE_LENGTH>()?;
    let ciphertext = cipher
        .encrypt(&XNonce::from(*nonce), plaintext.as_slice())
        .map_err(|_| CryptoError::Encrypt)?;
    Ok((to_base64(nonce.as_ref()), to_base64(&ciphertext)))
}

/// Encrypts the payload's JSON under a base64 32-byte key. `key_id` is
/// opaque metadata naming which key was used; it carries no key material.
pub fn encrypt_envelope(
    payload: &impl Serialize,
    key_base64: &str,
    key_id: &str,
) -> Result<EncryptedEnvelope, CryptoError> {
    let key = symmetric_key(key_base64, CryptoError::EncryptionKeyLength)?;
    let (nonce, ciphertext) = seal(payload, &key)?;
    Ok(EncryptedEnvelope {
        key_id: key_id.to_owned(),
        nonce,
        ciphertext,
    })
}

/// [`encrypt_envelope`] for the account keyring: the same format (the TS
/// client used `encryptEnvelope` for both), typed as a
/// [`KeyringEnvelope`] so it is checked against the keyring's larger size
/// limit, not the event one, when the API parses it. Like the TS
/// functions, neither constructor checks the schema's limits itself.
pub fn encrypt_keyring_envelope(
    payload: &impl Serialize,
    key_base64: &str,
    key_id: &str,
) -> Result<KeyringEnvelope, CryptoError> {
    let key = symmetric_key(key_base64, CryptoError::EncryptionKeyLength)?;
    let (nonce, ciphertext) = seal(payload, &key)?;
    Ok(KeyringEnvelope {
        key_id: key_id.to_owned(),
        nonce,
        ciphertext,
    })
}

/// Raw plaintext bytes of an envelope's ciphertext, under a raw key.
pub(crate) fn decrypt_bytes(
    nonce_base64: &str,
    ciphertext_base64: &str,
    key: &[u8; KEY_LENGTH],
) -> Result<Zeroizing<Vec<u8>>, CryptoError> {
    let cipher = cipher(key);
    let nonce = from_base64(nonce_base64)?;
    let nonce = XNonce::try_from(nonce.as_slice()).map_err(|_| CryptoError::NonceLength)?;
    let ciphertext = from_base64(ciphertext_base64)?;
    cipher
        .decrypt(&nonce, ciphertext.as_slice())
        .map(Zeroizing::new)
        .map_err(|_| CryptoError::Decrypt)
}

/// Opens an envelope made by [`encrypt_envelope`] (or the TS
/// `encryptEnvelope`) and returns its JSON payload. Fails on a wrong key
/// or any tampering (Poly1305 tag mismatch). The payload is not validated:
/// pass it to the matching `mekur_shared` type's `parse`.
pub fn decrypt_envelope(envelope: &impl Envelope, key_base64: &str) -> Result<Value, CryptoError> {
    let key = symmetric_key(key_base64, CryptoError::DecryptionKeyLength)?;
    let plaintext = decrypt_bytes(envelope.nonce(), envelope.ciphertext(), &key)?;
    serde_json::from_slice(&plaintext).map_err(|_| CryptoError::PlaintextNotJson)
}
