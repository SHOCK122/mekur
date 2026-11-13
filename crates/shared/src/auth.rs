//! Account requests: registration and login bodies. Ports of the Zod
//! `RegisterRequestSchema` and `LoginRequestSchema` that lived in
//! `apps/api/src/schemas.ts` until step 3b; their issues are checked
//! against the TS server's recorded replies in
//! `crates/api/tests/fixtures/ts_auth_responses.json`.

use serde::Serialize;
use serde_json::Value;

use crate::issue::ValidationError;
use crate::zod::{self, Ctx, Pattern, StrChecks, finish};

/// Usernames are login handles and invite tags: 3-64 of `[a-z0-9_.-]`.
const USERNAME: StrChecks = StrChecks {
    pattern: Some(Pattern {
        matches: is_username_text,
        message: "username must be lowercase letters, numbers, _ . -",
    }),
    ..StrChecks::between(3, 64)
};
/// An X25519 public key, base64.
const PUBLIC_KEY: StrChecks = StrChecks::between(1, 64);

/// `/^[a-z0-9_.-]+$/`.
fn is_username_text(s: &str) -> bool {
    !s.is_empty()
        && s.bytes()
            .all(|b| matches!(b, b'a'..=b'z' | b'0'..=b'9' | b'_' | b'.' | b'-'))
}

/// `POST /users` (`RegisterRequestSchema`).
#[derive(Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterRequest {
    pub username: String,
    /// 1-200 chars.
    pub display_name: String,
    /// The account's X25519 identity public key, base64. 1-64 chars.
    pub public_key: String,
    /// Base64. The server hashes it itself before storing; never the
    /// password or the encryption key.
    pub auth_key: String,
    /// Base64 scrypt salt, so the client can re-derive its keys later.
    pub auth_salt: String,
}

/// `POST /sessions` (`LoginRequestSchema`).
#[derive(Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginRequest {
    pub username: String,
    pub auth_key: String,
    /// The identity public key the client derived from this password. If
    /// it differs from the stored one, login replaces the stored one --
    /// see the login route for why that is safe only there.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub public_key: Option<String>,
}

// The auth key is a login credential: keep it out of logs.
impl std::fmt::Debug for RegisterRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RegisterRequest")
            .field("username", &self.username)
            .field("display_name", &self.display_name)
            .field("public_key", &self.public_key)
            .field("auth_key", &"<redacted>")
            .field("auth_salt", &self.auth_salt)
            .finish()
    }
}

impl std::fmt::Debug for LoginRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LoginRequest")
            .field("username", &self.username)
            .field("auth_key", &"<redacted>")
            .field("public_key", &self.public_key)
            .finish()
    }
}

impl RegisterRequest {
    /// Validates a JSON value. Unknown keys are ignored.
    pub fn parse(value: &Value) -> Result<Self, ValidationError> {
        Self::parse_optional(Some(value))
    }

    /// As [`parse`](Self::parse), where `None` is a request without a body
    /// (Zod's `undefined`: one "Required" issue).
    pub fn parse_optional(value: Option<&Value>) -> Result<Self, ValidationError> {
        let mut ctx = Ctx::new();
        let out = (|| {
            let obj = zod::object(&mut ctx, value)?;
            let s = |checks| move |ctx: &mut Ctx, v: Option<&Value>| zod::string(ctx, v, checks);
            let username = zod::field(&mut ctx, obj, "username", s(USERNAME));
            let display_name =
                zod::field(&mut ctx, obj, "displayName", s(StrChecks::between(1, 200)));
            let public_key = zod::field(&mut ctx, obj, "publicKey", s(PUBLIC_KEY));
            let auth_key = zod::field(&mut ctx, obj, "authKey", s(StrChecks::at_least(1)));
            let auth_salt = zod::field(&mut ctx, obj, "authSalt", s(StrChecks::at_least(1)));
            Some(Self {
                username: username?,
                display_name: display_name?,
                public_key: public_key?,
                auth_key: auth_key?,
                auth_salt: auth_salt?,
            })
        })();
        finish(ctx, out)
    }
}

impl LoginRequest {
    /// Validates a JSON value. Unknown keys are ignored.
    pub fn parse(value: &Value) -> Result<Self, ValidationError> {
        Self::parse_optional(Some(value))
    }

    /// As [`parse`](Self::parse), where `None` is a request without a body.
    pub fn parse_optional(value: Option<&Value>) -> Result<Self, ValidationError> {
        let mut ctx = Ctx::new();
        let out = (|| {
            let obj = zod::object(&mut ctx, value)?;
            let username = zod::field(&mut ctx, obj, "username", |ctx, v| {
                zod::string(ctx, v, USERNAME)
            });
            let auth_key = zod::field(&mut ctx, obj, "authKey", |ctx, v| {
                zod::string(ctx, v, StrChecks::at_least(1))
            });
            let public_key = zod::field(&mut ctx, obj, "publicKey", |ctx, v| {
                zod::optional(ctx, v, |ctx, v| zod::string(ctx, v, PUBLIC_KEY))
            });
            Some(Self {
                username: username?,
                auth_key: auth_key?,
                public_key: public_key?,
            })
        })();
        finish(ctx, out)
    }
}

/// `POST /api-keys` (`CreateApiKeyRequestSchema`, which lived in
/// `apps/api/src/routes/apiKeyRoutes.ts` until step 3c): a label so a user
/// can tell their keys apart.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CreateApiKeyRequest {
    /// 1-200 UTF-16 code units.
    pub name: String,
}

impl CreateApiKeyRequest {
    /// Validates a JSON value. Unknown keys are ignored.
    pub fn parse(value: &Value) -> Result<Self, ValidationError> {
        Self::parse_optional(Some(value))
    }

    /// As [`parse`](Self::parse), where `None` is a request without a body.
    pub fn parse_optional(value: Option<&Value>) -> Result<Self, ValidationError> {
        let mut ctx = Ctx::new();
        let out = (|| {
            let obj = zod::object(&mut ctx, value)?;
            let name = zod::field(&mut ctx, obj, "name", |ctx, v| {
                zod::string(ctx, v, StrChecks::between(1, 200))
            });
            Some(Self { name: name? })
        })();
        finish(ctx, out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn username_text_is_the_regex() {
        for ok in ["ada", "a.b-c_d", "0123", "x"] {
            assert!(is_username_text(ok), "{ok}");
        }
        for bad in ["", "Ada", "a b", "a/b", "é", "a\n", "a+b"] {
            assert!(!is_username_text(bad), "{bad:?}");
        }
    }

    #[test]
    fn debug_hides_the_auth_key() {
        let login = LoginRequest {
            username: "ada".into(),
            auth_key: "SECRET".into(),
            public_key: None,
        };
        assert!(!format!("{login:?}").contains("SECRET"));
        let register = RegisterRequest {
            username: "ada".into(),
            display_name: "Ada".into(),
            public_key: "pk".into(),
            auth_key: "SECRET".into(),
            auth_salt: "salt".into(),
        };
        assert!(!format!("{register:?}").contains("SECRET"));
    }
}
