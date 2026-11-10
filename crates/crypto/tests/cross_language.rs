//! Cross-language vectors: the other half of
//! `packages/crypto/test/crossLanguage.test.ts`.
//!
//! `fixtures/ts_vectors.json` was made by the TypeScript package: this
//! test derives the same keys from the same passwords and salts and opens
//! every envelope in it. `fixtures/rust_vectors.json` is made here (with
//! `UPDATE_CRYPTO_VECTORS=1`) and opened by the TS test, so both
//! directions are proven on every CI run while the TS package exists, and
//! the TS-made file stays behind as the record once it's gone.

use std::path::PathBuf;

use mekur_crypto::*;
use mekur_shared::{EncryptedEnvelope, SealedEnvelope};
use serde_json::{Value, json};

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name)
}

fn load(name: &str) -> Value {
    serde_json::from_str(&std::fs::read_to_string(fixture(name)).unwrap()).unwrap()
}

fn s<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key]
        .as_str()
        .unwrap_or_else(|| panic!("{key} missing in {v}"))
}

fn arr<'a>(v: &'a Value, key: &str) -> &'a Vec<Value> {
    v[key].as_array().unwrap()
}

/// Checks every envelope in a vectors file opens to its recorded payload,
/// and every forged one is rejected.
fn open_all(vectors: &Value) {
    for v in arr(vectors, "envelopes") {
        let envelope = EncryptedEnvelope::parse(&v["envelope"]).unwrap();
        assert_eq!(
            decrypt_envelope(&envelope, s(v, "key")).unwrap(),
            v["payload"]
        );
    }
    for v in arr(vectors, "sealed") {
        let sealed = SealedEnvelope::parse(&v["sealed"]).unwrap();
        let opened = open_sealed(&sealed, s(v, "recipientSecretKey")).unwrap();
        assert_eq!(opened.payload, v["payload"]);
        assert_eq!(
            opened.sender_public_key.as_deref(),
            v["senderPublicKey"].as_str()
        );
    }
    for v in arr(vectors, "forged") {
        let sealed = SealedEnvelope::parse(&v["sealed"]).unwrap();
        assert!(matches!(
            open_sealed(&sealed, s(v, "recipientSecretKey")),
            Err(CryptoError::SenderProof)
        ));
    }
}

#[test]
fn derives_the_same_keys_as_typescript() {
    let vectors = load("ts_vectors.json");
    let derivations = arr(&vectors, "derivations");
    assert!(derivations.len() >= 5);
    for d in derivations {
        let salt = from_base64(s(d, "salt")).unwrap();
        let keys = derive_auth_and_encryption_keys(s(d, "password"), Some(&salt)).unwrap();
        let password = s(d, "password");
        assert_eq!(keys.auth_key, s(d, "authKey"), "{password:?}");
        assert_eq!(keys.encryption_key, s(d, "encryptionKey"), "{password:?}");
        assert_eq!(keys.identity_key_pair.public_key, s(d, "identityPublicKey"));
        assert_eq!(keys.identity_key_pair.secret_key, s(d, "identitySecretKey"));
        assert_eq!(keys.salt, s(d, "salt"));
        assert_eq!(sha256_base64(&keys.auth_key).unwrap(), s(d, "authKeyHash"));
    }
}

#[test]
fn opens_every_typescript_envelope() {
    let vectors = load("ts_vectors.json");
    assert!(!arr(&vectors, "envelopes").is_empty());
    assert!(!arr(&vectors, "sealed").is_empty());
    assert!(!arr(&vectors, "forged").is_empty());
    open_all(&vectors);
}

/// Makes `rust_vectors.json` when `UPDATE_CRYPTO_VECTORS` is set, from the
/// TS file's keys and payloads; otherwise checks the committed file still
/// opens here too (the TS test opens it on the other side).
#[test]
fn rust_vectors() {
    if std::env::var_os("UPDATE_CRYPTO_VECTORS").is_some() {
        let ts = load("ts_vectors.json");
        let d = arr(&ts, "derivations");
        let pair = |d: &Value| KeyPair {
            public_key: s(d, "identityPublicKey").to_owned(),
            secret_key: s(d, "identitySecretKey").to_owned(),
        };
        let (alice, bob, mallory) = (&d[0], &d[4], &d[1]);
        let payloads: Vec<Value> = arr(&ts, "envelopes")
            .iter()
            .map(|v| v["payload"].clone())
            .collect();

        let envelopes: Vec<Value> = payloads
            .iter()
            .enumerate()
            .map(|(i, payload)| {
                let key = s(if i % 2 == 1 { alice } else { bob }, "encryptionKey");
                let envelope = encrypt_envelope(payload, key, &format!("key-{i}")).unwrap();
                json!({ "key": key, "envelope": envelope, "payload": payload })
            })
            .collect();
        let bob_public = s(bob, "identityPublicKey");
        let bob_secret = s(bob, "identitySecretKey");
        let sealed: Vec<Value> = payloads
            .iter()
            .flat_map(|payload| {
                [
                    json!({
                        "recipientSecretKey": bob_secret,
                        "sealed": seal_to_recipient(payload, bob_public, None).unwrap(),
                        "payload": payload,
                        "senderPublicKey": null,
                    }),
                    json!({
                        "recipientSecretKey": bob_secret,
                        "sealed": seal_to_recipient(payload, bob_public, Some(&pair(alice))).unwrap(),
                        "payload": payload,
                        "senderPublicKey": s(alice, "identityPublicKey"),
                    }),
                ]
            })
            .collect();
        let forger = KeyPair {
            public_key: s(alice, "identityPublicKey").to_owned(),
            secret_key: s(mallory, "identitySecretKey").to_owned(),
        };
        let forged = vec![json!({
            "recipientSecretKey": bob_secret,
            "sealed": seal_to_recipient(&"trust me", bob_public, Some(&forger)).unwrap(),
        })];
        let out = json!({ "envelopes": envelopes, "sealed": sealed, "forged": forged });
        std::fs::write(
            fixture("rust_vectors.json"),
            serde_json::to_string_pretty(&out).unwrap() + "\n",
        )
        .unwrap();
    }
    open_all(&load("rust_vectors.json"));
}
