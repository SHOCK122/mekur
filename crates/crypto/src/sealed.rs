//! Sealed envelopes for the inbox (`sealToRecipient` / `openSealed`).
//!
//! A fresh ephemeral X25519 key per message; its public half travels in
//! the clear as `epk` and is linked to no account, so the inbox needs no
//! sender column. The key is HKDF(ECDH(ephemeral, recipient),
//! salt = epk || recipient public key, "schedule-app:seal:v1") -- the
//! construction libsodium's sealed boxes use. Inside the ciphertext is
//! `{ body, sender? }`: `body` is the payload's JSON *as a string*, and
//! `sender` (optional) is the sender's static public key plus an
//! HMAC-SHA256 proof keyed by HKDF(ECDH(sender, recipient), no salt,
//! "schedule-app:sender-proof:v1") over `epk || utf8(body)`. Only the real
//! sender or the recipient can compute it, so the recipient learns a
//! verified sender while the server learns nothing.

use hmac::{Hmac, KeyInit, Mac};
use mekur_shared::SealedEnvelope;
use serde::Serialize;
use serde_json::Value;
use sha2::Sha256;
use subtle::ConstantTimeEq;
use zeroize::Zeroizing;

use crate::envelope::{decrypt_bytes, encrypt_envelope, to_json};
use crate::keys::{hkdf32, random_array, x25519_key, x25519_public, x25519_shared};
use crate::{CryptoError, KeyPair, to_base64};

const SEAL_INFO: &[u8] = b"schedule-app:seal:v1";
const SENDER_PROOF_INFO: &[u8] = b"schedule-app:sender-proof:v1";
/// A sealed envelope's `keyId`: there is no named key, only the `epk`.
const SEALED_KEY_ID: &str = "sealed";

/// What [`open_sealed`] returns.
#[derive(Debug, Clone, PartialEq)]
pub struct OpenedEnvelope {
    pub payload: Value,
    /// The sender's *verified* static public key (base64), or `None` if the
    /// sender chose to stay anonymous. Never a value the sender merely
    /// claimed.
    pub sender_public_key: Option<String>,
}

#[derive(Serialize)]
struct Sender<'a> {
    #[serde(rename = "publicKey")]
    public_key: &'a str,
    proof: String,
}

#[derive(Serialize)]
struct Inner<'a> {
    body: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    sender: Option<Sender<'a>>,
}

fn seal_key(shared: &[u8; 32], epk: &[u8; 32], recipient_public: &[u8; 32]) -> String {
    let mut salt = [0u8; 64];
    salt[..32].copy_from_slice(epk);
    salt[32..].copy_from_slice(recipient_public);
    to_base64(hkdf32(shared, Some(&salt), SEAL_INFO).as_ref())
}

fn sender_proof(static_shared: &[u8; 32], epk: &[u8; 32], body: &str) -> String {
    let key = hkdf32(static_shared, None, SENDER_PROOF_INFO);
    let mut mac = <Hmac<Sha256> as KeyInit>::new_from_slice(key.as_ref())
        .expect("HMAC accepts any key length");
    mac.update(epk);
    mac.update(body.as_bytes());
    to_base64(&mac.finalize().into_bytes())
}

/// Encrypts a payload so only the holder of `recipient_public_key`'s
/// secret half can read it, without the envelope revealing who sent it.
/// With `sender`, a verifiable sender identity is added *inside* the
/// ciphertext; without it the invitation is anonymous.
pub fn seal_to_recipient(
    payload: &impl Serialize,
    recipient_public_key: &str,
    sender: Option<&KeyPair>,
) -> Result<SealedEnvelope, CryptoError> {
    let recipient_public = x25519_key(recipient_public_key)?;
    let ephemeral = random_array::<32>()?;
    let epk = x25519_public(&ephemeral);
    let key = Zeroizing::new(seal_key(
        &*x25519_shared(&ephemeral, &recipient_public)?,
        &epk,
        &recipient_public,
    ));

    let body_bytes = to_json(payload)?;
    let body = std::str::from_utf8(&body_bytes).expect("serde_json writes UTF-8");
    let sender = match sender {
        None => None,
        Some(pair) => {
            let static_shared = x25519_shared(&*x25519_key(&pair.secret_key)?, &recipient_public)?;
            Some(Sender {
                public_key: &pair.public_key,
                proof: sender_proof(&static_shared, &epk, body),
            })
        }
    };
    let envelope = encrypt_envelope(&Inner { body, sender }, &key, SEALED_KEY_ID)?;
    Ok(SealedEnvelope {
        key_id: envelope.key_id,
        nonce: envelope.nonce,
        ciphertext: envelope.ciphertext,
        epk: to_base64(&epk),
    })
}

/// JavaScript truthiness, for `if (inner.sender)`: a falsy `sender` means
/// "anonymous", exactly as the TS client read it.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// Opens an envelope made by [`seal_to_recipient`] (or the TS
/// `sealToRecipient`). Fails if it wasn't sealed to this key, was tampered
/// with, or names a sender whose proof doesn't verify -- a forged sender
/// is an error, never silently dropped.
pub fn open_sealed(
    sealed: &SealedEnvelope,
    recipient_secret_key: &str,
) -> Result<OpenedEnvelope, CryptoError> {
    let recipient_secret = x25519_key(recipient_secret_key)?;
    let recipient_public = x25519_public(&recipient_secret);
    let epk = x25519_key(&sealed.epk)?;
    let key = Zeroizing::new(seal_key(
        &*x25519_shared(&recipient_secret, &epk)?,
        &epk,
        &recipient_public,
    ));
    let plaintext = decrypt_bytes(&sealed.nonce, &sealed.ciphertext, &key)?;
    let inner: Value =
        serde_json::from_slice(&plaintext).map_err(|_| CryptoError::PlaintextNotJson)?;

    let body = inner
        .get("body")
        .and_then(Value::as_str)
        .ok_or(CryptoError::MalformedSealedBody)?;
    let sender_public_key = match inner.get("sender") {
        Some(sender) if truthy(sender) => {
            let field = |name| {
                sender
                    .get(name)
                    .and_then(Value::as_str)
                    .ok_or(CryptoError::MalformedSealedBody)
            };
            let public_key = field("publicKey")?;
            let proof = field("proof")?;
            let static_shared = x25519_shared(&recipient_secret, &*x25519_key(public_key)?)?;
            let expected = sender_proof(&static_shared, &epk, body);
            if !bool::from(expected.as_bytes().ct_eq(proof.as_bytes())) {
                return Err(CryptoError::SenderProof);
            }
            Some(public_key.to_owned())
        }
        _ => None,
    };
    let payload = serde_json::from_str(body).map_err(|_| CryptoError::PlaintextNotJson)?;
    Ok(OpenedEnvelope {
        payload,
        sender_public_key,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truthiness_matches_javascript() {
        use serde_json::json;
        for falsy in [json!(null), json!(false), json!(0), json!(0.0), json!("")] {
            assert!(!truthy(&falsy), "{falsy}");
        }
        for t in [
            json!(true),
            json!(1),
            json!(-0.5),
            json!("x"),
            json!([]),
            json!({}),
        ] {
            assert!(truthy(&t), "{t}");
        }
    }

    /// Seals an arbitrary inner object, bypassing `seal_to_recipient`'s
    /// well-formed `{ body, sender? }`, as a hostile sender could.
    fn seal_raw(inner: &Value, recipient: &KeyPair) -> SealedEnvelope {
        let recipient_public = x25519_key(&recipient.public_key).unwrap();
        let ephemeral = random_array::<32>().unwrap();
        let epk = x25519_public(&ephemeral);
        let shared = x25519_shared(&ephemeral, &recipient_public).unwrap();
        let key = seal_key(&shared, &epk, &recipient_public);
        let e = encrypt_envelope(inner, &key, SEALED_KEY_ID).unwrap();
        SealedEnvelope {
            key_id: e.key_id,
            nonce: e.nonce,
            ciphertext: e.ciphertext,
            epk: to_base64(&epk),
        }
    }

    #[test]
    fn falsy_sender_reads_as_anonymous() {
        use serde_json::json;
        let recipient = crate::generate_key_pair().unwrap();
        for sender in [json!(null), json!(false), json!(0), json!("")] {
            let sealed = seal_raw(&json!({ "body": "[1]", "sender": sender }), &recipient);
            let opened = open_sealed(&sealed, &recipient.secret_key).unwrap();
            assert_eq!(opened.payload, json!([1]));
            assert_eq!(opened.sender_public_key, None);
        }
    }

    #[test]
    fn malformed_inner_bodies_are_errors() {
        use serde_json::json;
        let recipient = crate::generate_key_pair().unwrap();
        let other = crate::generate_key_pair().unwrap();
        for inner in [
            json!({}),
            json!({ "body": 5 }),
            json!({ "body": "1", "sender": true }),
            json!({ "body": "1", "sender": { "publicKey": other.public_key } }),
            json!({ "body": "1", "sender": { "proof": "x" } }),
            json!("not an object"),
        ] {
            let sealed = seal_raw(&inner, &recipient);
            assert!(
                matches!(
                    open_sealed(&sealed, &recipient.secret_key),
                    Err(CryptoError::MalformedSealedBody)
                ),
                "{inner}"
            );
        }
        let sealed = seal_raw(&json!({ "body": "{not json" }), &recipient);
        assert!(matches!(
            open_sealed(&sealed, &recipient.secret_key),
            Err(CryptoError::PlaintextNotJson)
        ));
    }
}
