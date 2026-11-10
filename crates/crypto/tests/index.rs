//! Port of `packages/crypto/test/index.test.ts`, test for test, plus the
//! Rust-only edge cases (key lengths, low-order points, malformed sealed
//! bodies) the TS suite didn't reach.

use mekur_crypto::*;
use mekur_shared::{EncryptedEnvelope, SealedEnvelope};
use serde_json::{Value, json};

/// Every field, for comparing derivations (the types deliberately have no
/// `PartialEq`).
fn fields(k: &AuthAndEncryptionKeys) -> [&str; 5] {
    [
        &k.auth_key,
        &k.encryption_key,
        &k.identity_key_pair.public_key,
        &k.identity_key_pair.secret_key,
        &k.salt,
    ]
}

fn key_pair() -> KeyPair {
    generate_key_pair().unwrap()
}

// --- base64 round-trip ---

#[test]
fn base64_round_trip_is_lossless() {
    let bytes = random_bytes(32).unwrap();
    assert_eq!(from_base64(&to_base64(&bytes)).unwrap(), bytes);
}

// --- generate_key_pair ---

#[test]
fn key_pair_has_distinct_32_byte_halves() {
    let pair = key_pair();
    assert_eq!(from_base64(&pair.public_key).unwrap().len(), 32);
    assert_eq!(from_base64(&pair.secret_key).unwrap().len(), 32);
    assert_ne!(pair.public_key, *pair.secret_key);
}

#[test]
fn key_pair_differs_every_call() {
    assert_ne!(*key_pair().secret_key, *key_pair().secret_key);
}

#[test]
fn debug_output_redacts_secrets() {
    let pair = key_pair();
    let shown = format!("{pair:?}");
    assert!(!shown.contains(pair.secret_key.as_str()));
    assert!(shown.contains(&pair.public_key));
}

// --- derive_auth_and_encryption_keys ---
// One scrypt run is ~128 MiB, so derivations share a few calls.

#[test]
fn derivation_is_deterministic_distinct_and_password_dependent() {
    let salt = random_bytes(16).unwrap();
    let a = derive_auth_and_encryption_keys("hunter2", Some(&salt)).unwrap();
    let b = derive_auth_and_encryption_keys("hunter2", Some(&salt)).unwrap();
    let c = derive_auth_and_encryption_keys("password two", Some(&salt)).unwrap();

    // distinct authKey and encryptionKey, 32 bytes each
    assert_ne!(a.auth_key, a.encryption_key);
    assert_eq!(from_base64(&a.auth_key).unwrap().len(), 32);
    assert_eq!(from_base64(&a.encryption_key).unwrap().len(), 32);
    // deterministic given the same password and salt, identity included
    assert_eq!(fields(&a), fields(&b));
    assert_eq!(
        from_base64(&a.identity_key_pair.public_key).unwrap().len(),
        32
    );
    assert_eq!(a.salt, to_base64(&salt));
    // different passwords, different keys
    assert_ne!(a.auth_key, c.auth_key);
    assert_ne!(a.encryption_key, c.encryption_key);
    assert_ne!(
        a.identity_key_pair.public_key,
        c.identity_key_pair.public_key
    );

    let shown = format!("{a:?}");
    assert!(!shown.contains(a.auth_key.as_str()) && !shown.contains(a.encryption_key.as_str()));
    assert!(!shown.contains(a.identity_key_pair.secret_key.as_str()));
}

#[test]
fn derivation_generates_a_fresh_16_byte_salt() {
    let alice = derive_auth_and_encryption_keys("alice's password", None).unwrap();
    let bob = derive_auth_and_encryption_keys("bob's password", None).unwrap();
    assert_eq!(from_base64(&alice.salt).unwrap().len(), 16);
    assert_ne!(alice.salt, bob.salt);

    // the derived identity keypair can receive sealed envelopes
    let sealed = seal_to_recipient(
        &json!({ "hello": "bob" }),
        &bob.identity_key_pair.public_key,
        Some(&alice.identity_key_pair),
    )
    .unwrap();
    let opened = open_sealed(&sealed, &bob.identity_key_pair.secret_key).unwrap();
    assert_eq!(opened.payload, json!({ "hello": "bob" }));
    assert_eq!(
        opened.sender_public_key.as_deref(),
        Some(alice.identity_key_pair.public_key.as_str())
    );
}

// --- sha256_base64 ---

#[test]
fn sha256_base64_is_deterministic_and_input_dependent() {
    let a = to_base64(&random_bytes(32).unwrap());
    let b = to_base64(&random_bytes(32).unwrap());
    assert_eq!(sha256_base64(&a).unwrap(), sha256_base64(&a).unwrap());
    assert_ne!(sha256_base64(&a).unwrap(), sha256_base64(&b).unwrap());
    // Known answer: SHA-256 of the empty string.
    assert_eq!(
        sha256_base64("").unwrap(),
        "47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU="
    );
}

// --- generate_symmetric_key ---

#[test]
fn symmetric_key_is_32_random_bytes() {
    let a = generate_symmetric_key().unwrap();
    assert_eq!(from_base64(&a).unwrap().len(), 32);
    assert_ne!(a, generate_symmetric_key().unwrap());
}

// --- seal_to_recipient / open_sealed ---

#[test]
fn anonymous_envelope_opens_with_only_the_recipients_key() {
    let recipient = key_pair();
    let sealed =
        seal_to_recipient(&json!({ "eventId": "e1" }), &recipient.public_key, None).unwrap();
    assert_eq!(sealed.key_id, "sealed");
    let opened = open_sealed(&sealed, &recipient.secret_key).unwrap();
    assert_eq!(opened.payload, json!({ "eventId": "e1" }));
    assert_eq!(opened.sender_public_key, None);
}

#[test]
fn fresh_ephemeral_key_per_message_and_no_sender_outside_the_ciphertext() {
    let recipient = key_pair();
    let sender = key_pair();
    let a = seal_to_recipient(&json!({ "n": 1 }), &recipient.public_key, Some(&sender)).unwrap();
    let b = seal_to_recipient(&json!({ "n": 1 }), &recipient.public_key, Some(&sender)).unwrap();
    assert_ne!(a.epk, b.epk);
    let wire = serde_json::to_string(&a).unwrap();
    assert!(!wire.contains(&sender.public_key));
    // Wire shape is exactly the TS one.
    let v: Value = serde_json::from_str(&wire).unwrap();
    let mut keys: Vec<_> = v.as_object().unwrap().keys().cloned().collect();
    keys.sort();
    assert_eq!(keys, ["algo", "ciphertext", "epk", "keyId", "nonce", "v"]);
    assert_eq!(SealedEnvelope::parse(&v).unwrap(), a);
}

#[test]
fn sealed_envelope_cannot_be_opened_by_anyone_else() {
    let recipient = key_pair();
    let eavesdropper = key_pair();
    let sealed =
        seal_to_recipient(&json!({ "secret": true }), &recipient.public_key, None).unwrap();
    assert!(matches!(
        open_sealed(&sealed, &eavesdropper.secret_key),
        Err(CryptoError::Decrypt)
    ));
}

#[test]
fn verifies_a_named_sender() {
    let recipient = key_pair();
    let sender = key_pair();
    let sealed = seal_to_recipient(&"hi", &recipient.public_key, Some(&sender)).unwrap();
    let opened = open_sealed(&sealed, &recipient.secret_key).unwrap();
    assert_eq!(opened.payload, json!("hi"));
    assert_eq!(opened.sender_public_key, Some(sender.public_key.clone()));
}

#[test]
fn rejects_a_sender_identity_claimed_without_the_private_key() {
    let recipient = key_pair();
    let victim = key_pair();
    let forger = key_pair();
    let claimed = KeyPair {
        public_key: victim.public_key.clone(),
        secret_key: forger.secret_key.clone(),
    };
    let sealed = seal_to_recipient(&"trust me", &recipient.public_key, Some(&claimed)).unwrap();
    let err = open_sealed(&sealed, &recipient.secret_key).unwrap_err();
    assert!(matches!(err, CryptoError::SenderProof));
    assert!(err.to_string().contains("Sender proof"));
}

#[test]
fn rejects_a_tampered_sealed_envelope() {
    let recipient = key_pair();
    let mut sealed = seal_to_recipient(&"x", &recipient.public_key, None).unwrap();
    let mut bytes = from_base64(&sealed.ciphertext).unwrap();
    bytes[0] ^= 1;
    sealed.ciphertext = to_base64(&bytes);
    assert!(open_sealed(&sealed, &recipient.secret_key).is_err());
}

#[test]
fn rejects_low_order_points() {
    // An all-zero public key makes every shared secret zero; noble refuses
    // it and so must we, on both sides.
    let zero = to_base64(&[0u8; 32]);
    assert!(matches!(
        seal_to_recipient(&1, &zero, None),
        Err(CryptoError::NonContributory)
    ));
    let recipient = key_pair();
    let mut sealed = seal_to_recipient(&1, &recipient.public_key, None).unwrap();
    sealed.epk = zero;
    assert!(matches!(
        open_sealed(&sealed, &recipient.secret_key),
        Err(CryptoError::NonContributory)
    ));
}

#[test]
fn rejects_x25519_keys_of_the_wrong_length() {
    let recipient = key_pair();
    let short = to_base64(&[9u8; 31]);
    assert!(matches!(
        seal_to_recipient(&1, &short, None),
        Err(CryptoError::X25519KeyLength)
    ));
    let sealed = seal_to_recipient(&1, &recipient.public_key, None).unwrap();
    assert!(matches!(
        open_sealed(&sealed, &short),
        Err(CryptoError::X25519KeyLength)
    ));
}

// --- encrypt_envelope / decrypt_envelope ---

#[test]
fn envelope_round_trips_arbitrary_json() {
    let key = generate_symmetric_key().unwrap();
    let payload = json!({ "title": "Team sync", "startTime": "2026-08-01T10:00:00.000Z",
                          "nested": [1, 2.5, null, { "ü": "\u{1F600}" }] });
    let envelope = encrypt_envelope(&payload, &key, "user-key-1").unwrap();
    assert_eq!(envelope.key_id, "user-key-1");
    assert_eq!(from_base64(&envelope.nonce).unwrap().len(), NONCE_LENGTH);
    // Valid by the shared schema, so the API will accept it.
    let wire = serde_json::to_value(&envelope).unwrap();
    assert_eq!(EncryptedEnvelope::parse(&wire).unwrap(), envelope);
    assert_eq!(decrypt_envelope(&envelope, &key).unwrap(), payload);
}

#[test]
fn keyring_envelope_round_trips() {
    let key = generate_symmetric_key().unwrap();
    let envelope = encrypt_keyring_envelope(&json!({ "events": [] }), &key, "account").unwrap();
    assert_eq!(
        decrypt_envelope(&envelope, &key).unwrap(),
        json!({ "events": [] })
    );
}

#[test]
fn envelope_fails_with_the_wrong_key() {
    let envelope = encrypt_envelope(
        &json!({ "secret": true }),
        &generate_symmetric_key().unwrap(),
        "k",
    )
    .unwrap();
    assert!(matches!(
        decrypt_envelope(&envelope, &generate_symmetric_key().unwrap()),
        Err(CryptoError::Decrypt)
    ));
}

#[test]
fn envelope_fails_if_ciphertext_is_tampered_with() {
    let key = generate_symmetric_key().unwrap();
    let mut envelope = encrypt_envelope(&json!({ "secret": true }), &key, "k").unwrap();
    let len = from_base64(&envelope.ciphertext).unwrap().len();
    envelope.ciphertext = to_base64(&random_bytes(len).unwrap());
    assert!(decrypt_envelope(&envelope, &key).is_err());
}

#[test]
fn envelope_never_leaks_plaintext() {
    let key = generate_symmetric_key().unwrap();
    let marker = "MY_SECRET_MARKER_VALUE";
    let envelope = encrypt_envelope(&json!({ "note": marker }), &key, "k").unwrap();
    assert!(!serde_json::to_string(&envelope).unwrap().contains(marker));
}

#[test]
fn envelope_key_and_nonce_lengths_are_checked() {
    let short = to_base64(&[1u8; 16]);
    let err = encrypt_envelope(&1, &short, "k").unwrap_err();
    assert_eq!(err.to_string(), "Encryption key must be 32 bytes");

    let key = generate_symmetric_key().unwrap();
    let mut envelope = encrypt_envelope(&1, &key, "k").unwrap();
    let err = decrypt_envelope(&envelope, &short).unwrap_err();
    assert_eq!(err.to_string(), "Decryption key must be 32 bytes");

    envelope.nonce = to_base64(&[0u8; 12]);
    assert!(matches!(
        decrypt_envelope(&envelope, &key),
        Err(CryptoError::NonceLength)
    ));
    envelope.nonce = "not base64!".into();
    assert!(matches!(
        decrypt_envelope(&envelope, &key),
        Err(CryptoError::InvalidBase64)
    ));
}

#[test]
fn known_divergence_lone_surrogates_are_not_json() {
    // JSON.stringify("\ud800") writes this escape and JSON.parse reads it
    // back; serde_json refuses it. Recorded in docs/RUST_MIGRATION.md
    // (step 2); this test fails if that ever changes, so the note can go.
    assert!(serde_json::from_str::<Value>(r#""\ud800""#).is_err());
    assert!(serde_json::from_str::<Value>(r#""😀""#).is_ok());
}
