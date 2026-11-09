//! Envelopes: the only shape in which user content leaves the client.
//!
//! The server persists and relays these opaquely; it never has the key
//! required to open them. Mirrors `EncryptedEnvelopeSchema`,
//! `SealedEnvelopeSchema` and `KeyringEnvelopeSchema`.

use serde::Serialize;
use serde_json::{Map, Value};

use crate::issue::ValidationError;
use crate::zod::{self, Ctx, StrChecks};

/// The only envelope format version.
pub const ENVELOPE_VERSION: u8 = 1;
/// The only envelope algorithm.
pub const ENVELOPE_ALGO: &str = "xchacha20poly1305";

/// Most UTF-16 code units of base64 ciphertext one event's envelope may
/// carry. Far beyond any realistic event while keeping row and response
/// sizes predictable.
pub const MAX_EVENT_CIPHERTEXT: usize = 128 * 1024;
/// The keyring holds every capability an account has, so it outgrows the
/// per-event cap; 1 MB of base64 comfortably fits the 500-event batch-read
/// limit.
pub const MAX_KEYRING_CIPHERTEXT: usize = 1024 * 1024;

/// Content encrypted with a symmetric key (`EncryptedEnvelopeSchema`).
/// Serializes with `v: 1` and `algo: "xchacha20poly1305"`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EncryptedEnvelope {
    /// Which key (account key or event key) encrypted this. 1-64 chars.
    pub key_id: String,
    /// Base64. 1-128 chars.
    pub nonce: String,
    /// Base64. 1 char up to [`MAX_EVENT_CIPHERTEXT`].
    pub ciphertext: String,
}

/// An envelope sealed to one recipient's X25519 public key with a fresh
/// ephemeral keypair (`SealedEnvelopeSchema`). `epk` is the ephemeral
/// public key: needed to open it, and linked to no account, so the server
/// relaying it learns nothing about the sender.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SealedEnvelope {
    pub key_id: String,
    pub nonce: String,
    pub ciphertext: String,
    /// 1-64 chars.
    pub epk: String,
}

/// An account's keyring (`KeyringEnvelopeSchema`): an encrypted envelope
/// whose ciphertext may reach [`MAX_KEYRING_CIPHERTEXT`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyringEnvelope(pub EncryptedEnvelope);

#[derive(Serialize)]
struct Wire<'a> {
    v: u8,
    algo: &'a str,
    #[serde(rename = "keyId")]
    key_id: &'a str,
    nonce: &'a str,
    ciphertext: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    epk: Option<&'a str>,
}

impl Serialize for EncryptedEnvelope {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        Wire {
            v: ENVELOPE_VERSION,
            algo: ENVELOPE_ALGO,
            key_id: &self.key_id,
            nonce: &self.nonce,
            ciphertext: &self.ciphertext,
            epk: None,
        }
        .serialize(s)
    }
}

impl Serialize for SealedEnvelope {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        Wire {
            v: ENVELOPE_VERSION,
            algo: ENVELOPE_ALGO,
            key_id: &self.key_id,
            nonce: &self.nonce,
            ciphertext: &self.ciphertext,
            epk: Some(&self.epk),
        }
        .serialize(s)
    }
}

impl Serialize for KeyringEnvelope {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        self.0.serialize(s)
    }
}

/// The fields every envelope shares, in schema order. `None` if any of
/// them aborted (a wrong type or literal).
fn base_fields(
    ctx: &mut Ctx,
    obj: &Map<String, Value>,
    max_ciphertext: usize,
) -> Option<(String, String, String)> {
    let v = zod::field(ctx, obj, "v", |ctx, v| {
        zod::literal(ctx, v, &Value::from(ENVELOPE_VERSION))
    });
    let algo = zod::field(ctx, obj, "algo", |ctx, v| {
        zod::literal(ctx, v, &Value::from(ENVELOPE_ALGO))
    });
    let key_id = zod::field(ctx, obj, "keyId", |ctx, v| zod::string(ctx, v, bounded(64)));
    let nonce = zod::field(ctx, obj, "nonce", |ctx, v| {
        zod::string(ctx, v, bounded(128))
    });
    let ciphertext = zod::field(ctx, obj, "ciphertext", |ctx, v| {
        zod::string(ctx, v, bounded(max_ciphertext))
    });
    v?;
    algo?;
    Some((key_id?, nonce?, ciphertext?))
}

fn bounded(max: usize) -> StrChecks {
    StrChecks {
        min: Some(1),
        max: Some(max),
        datetime: false,
    }
}

pub(crate) fn finish<T>(ctx: Ctx, value: Option<T>) -> Result<T, ValidationError> {
    match value {
        Some(v) if ctx.issues.is_empty() => Ok(v),
        _ => Err(ValidationError { issues: ctx.issues }),
    }
}

impl EncryptedEnvelope {
    /// Validates a JSON value. Unknown keys are ignored.
    pub fn parse(value: &Value) -> Result<Self, ValidationError> {
        let mut ctx = Ctx::new();
        let out = Self::parse_in(&mut ctx, Some(value), MAX_EVENT_CIPHERTEXT);
        finish(ctx, out)
    }

    pub(crate) fn parse_in(ctx: &mut Ctx, input: Option<&Value>, max: usize) -> Option<Self> {
        let obj = zod::object(ctx, input)?;
        let (key_id, nonce, ciphertext) = base_fields(ctx, obj, max)?;
        Some(Self {
            key_id,
            nonce,
            ciphertext,
        })
    }
}

impl SealedEnvelope {
    /// Validates a JSON value. Unknown keys are ignored.
    pub fn parse(value: &Value) -> Result<Self, ValidationError> {
        let mut ctx = Ctx::new();
        let out = Self::parse_in(&mut ctx, Some(value));
        finish(ctx, out)
    }

    pub(crate) fn parse_in(ctx: &mut Ctx, input: Option<&Value>) -> Option<Self> {
        let obj = zod::object(ctx, input)?;
        let base = base_fields(ctx, obj, MAX_EVENT_CIPHERTEXT);
        let epk = zod::field(ctx, obj, "epk", |ctx, v| zod::string(ctx, v, bounded(64)));
        let (key_id, nonce, ciphertext) = base?;
        Some(Self {
            key_id,
            nonce,
            ciphertext,
            epk: epk?,
        })
    }
}

impl KeyringEnvelope {
    /// Validates a JSON value. Unknown keys are ignored.
    pub fn parse(value: &Value) -> Result<Self, ValidationError> {
        let mut ctx = Ctx::new();
        let out = EncryptedEnvelope::parse_in(&mut ctx, Some(value), MAX_KEYRING_CIPHERTEXT);
        finish(ctx, out.map(Self))
    }
}
