//! Session tokens: HS256 JWTs carrying `{ userId, iat, exp }`, exactly what
//! `@fastify/jwt` issued, so the TS server accepts the Rust server's tokens
//! and vice versa while both run (they share `JWT_SECRET`).
//!
//! [`verify`] accepts exactly the tokens `@fastify/jwt` 10 (`fast-jwt` 6)
//! accepted with the TS server's options -- recorded in
//! `tests/fixtures/ts_api_key_responses.json`.

use hmac::{Hmac, KeyInit, Mac};
use jsonwebtoken::{Algorithm, EncodingKey, Header};
use serde::Serialize;
use serde_json::Value;
use sha2::{Sha256, Sha384, Sha512};

use crate::node_base64;

/// Session tokens expire after 30 days: a stolen token must not stay valid
/// forever, and a personal calendar shouldn't force constant re-logins.
/// Agent clients use API keys, which are individually revocable.
pub const TOKEN_TTL_SECS: i64 = 30 * 24 * 60 * 60;

/// The claims, in `@fastify/jwt`'s order.
#[derive(Serialize)]
struct Claims<'a> {
    #[serde(rename = "userId")]
    user_id: &'a str,
    iat: i64,
    exp: i64,
}

/// A session token for `user_id`, issued at `now` (Unix seconds).
pub fn issue_token(secret: &str, user_id: &str, now: i64) -> String {
    let claims = Claims {
        user_id,
        iat: now,
        exp: now + TOKEN_TTL_SECS,
    };
    jsonwebtoken::encode(
        &Header::new(Algorithm::HS256),
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .expect("HS256 signs with any key, and the claims always serialize")
}

/// The current time in Unix seconds.
pub fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

/// The current time in Unix milliseconds, the clock `fast-jwt` checks
/// `exp` and `nbf` against.
pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// The claims of `token` if `fast-jwt` would have accepted it, signed with
/// `secret`, at `now_ms`:
///
/// - three dot-separated segments of base64url characters (no padding),
///   the header a JSON object and the payload a JSON object (or array);
/// - `alg` one of HS256/384/512 -- the HMAC family `fast-jwt` allows for
///   a string secret -- and a non-empty signature that matches;
/// - no `crit` header (none is understood, so any truthy value fails);
/// - `nbf`, if present, a number not after now; `exp`, if present, a
///   number not before now (both in seconds, compared in milliseconds,
///   fractions allowed). `typ` and `iat` aren't checked.
///
/// A token **without `exp` never expires**, as on the TS server: session
/// tokens issued before expiry was added are still accepted
/// (`docs/RUST_MIGRATION.md`, step 3c).
///
/// The signature is checked with RustCrypto's HMAC, compared in constant
/// time; segments are decoded with Node's decoder, as `fast-jwt` did.
pub fn verify(secret: &str, token: &str, now_ms: i64) -> Option<Value> {
    let first = token.find('.')?;
    let last = token.rfind('.')?;
    if first >= last {
        return None;
    }
    let (header, payload, signature) =
        (&token[..first], &token[first + 1..last], &token[last + 1..]);
    let base64url = |s: &str| {
        s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    };
    if !(base64url(header) && base64url(payload) && base64url(signature)) {
        return None;
    }
    let header = parse_segment(header)?;
    let header = header.as_object()?;
    let payload = parse_segment(payload)?;
    if !payload.is_object() && !payload.is_array() {
        return None;
    }
    if signature.is_empty() {
        return None;
    }
    let signed = &token.as_bytes()[..last];
    let signature = node_base64::decode(signature);
    let key = secret.as_bytes();
    let valid = match header.get("alg").and_then(Value::as_str)? {
        "HS256" => hmac_matches::<Hmac<Sha256>>(key, signed, &signature),
        "HS384" => hmac_matches::<Hmac<Sha384>>(key, signed, &signature),
        "HS512" => hmac_matches::<Hmac<Sha512>>(key, signed, &signature),
        _ => false,
    };
    if !valid || header.get("crit").is_some_and(js_truthy) {
        return None;
    }
    if let Some(claims) = payload.as_object() {
        // `None`: present but not a number, which fails.
        let millis = |claim: &str| -> Option<Option<f64>> {
            match claims.get(claim) {
                None => Some(None),
                Some(value) => Some(Some(value.as_f64()? * 1000.0)),
            }
        };
        let now = now_ms as f64;
        if millis("nbf")?.is_some_and(|nbf| now < nbf)
            || millis("exp")?.is_some_and(|exp| now > exp)
        {
            return None;
        }
    }
    Some(payload)
}

/// A segment as `fast-jwt` read it: Node's base64 decoding, UTF-8 with
/// replacement characters, `JSON.parse`.
fn parse_segment(segment: &str) -> Option<Value> {
    let bytes = node_base64::decode(segment);
    serde_json::from_str(&String::from_utf8_lossy(&bytes)).ok()
}

fn hmac_matches<M: Mac + KeyInit>(key: &[u8], message: &[u8], signature: &[u8]) -> bool {
    let Ok(mut mac) = <M as KeyInit>::new_from_slice(key) else {
        return false;
    };
    mac.update(message);
    mac.verify_slice(signature).is_ok()
}

/// JavaScript truthiness of a JSON value.
fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &str = "test-secret";

    #[test]
    fn verifies_its_own_tokens_until_they_expire() {
        let token = issue_token(SECRET, "u", 1_000);
        let claims = verify(SECRET, &token, 1_000_000).unwrap();
        assert_eq!(claims["userId"], "u");
        let exp_ms = (1_000 + TOKEN_TTL_SECS) * 1000;
        assert!(verify(SECRET, &token, exp_ms).is_some());
        assert!(verify(SECRET, &token, exp_ms + 1).is_none());
        assert!(verify("other", &token, 1_000_000).is_none());
    }

    #[test]
    fn rejects_truncated_and_reshaped_tokens() {
        let token = issue_token(SECRET, "u", 1_000);
        let (signed, _) = token.rsplit_once('.').unwrap();
        for bad in [
            "",
            ".",
            "..",
            "a.b",
            signed,
            &format!("{signed}."),
            &format!("{token}="),
            &format!("{token}.x"),
            &format!(" {token}"),
        ] {
            assert!(verify(SECRET, bad, 1_000_000).is_none(), "{bad:?}");
        }
    }

    #[test]
    fn truthiness() {
        for falsy in [Value::Null, false.into(), 0.into(), 0.0.into(), "".into()] {
            assert!(!js_truthy(&falsy), "{falsy}");
        }
        for truthy in [
            true.into(),
            1.into(),
            "x".into(),
            Value::Array(vec![]),
            Value::Object(serde_json::Map::new()),
        ] {
            assert!(js_truthy(&truthy), "{truthy}");
        }
    }
}
