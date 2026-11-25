//! Social requests: resolving a tag (a username or a one-time friend
//! code) to an invitable target. Port of the Zod `ResolveTagRequestSchema`
//! that lived in `apps/api/src/routes/socialRoutes.ts` until step 3f.

use serde::Serialize;
use serde_json::Value;

use crate::issue::ValidationError;
use crate::zod::{self, Ctx, StrChecks, finish};

/// `POST /tags/resolve` (`ResolveTagRequestSchema`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ResolveTagRequest {
    /// 1-64 UTF-16 code units; a username or a friend code, untrimmed.
    pub tag: String,
}

impl ResolveTagRequest {
    /// Validates a JSON value. Unknown keys are ignored.
    pub fn parse(value: &Value) -> Result<Self, ValidationError> {
        Self::parse_optional(Some(value))
    }

    /// As [`parse`](Self::parse), where `None` is a request without a body.
    pub fn parse_optional(value: Option<&Value>) -> Result<Self, ValidationError> {
        let mut ctx = Ctx::new();
        let out = (|| {
            let obj = zod::object(&mut ctx, value)?;
            let tag = zod::field(&mut ctx, obj, "tag", |ctx, v| {
                zod::string(ctx, v, StrChecks::between(1, 64))
            });
            Some(Self { tag: tag? })
        })();
        finish(ctx, out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn tag_is_one_to_sixty_four_units() {
        assert_eq!(
            ResolveTagRequest::parse(&json!({"tag": "bob"})).unwrap(),
            ResolveTagRequest { tag: "bob".into() }
        );
        assert!(ResolveTagRequest::parse(&json!({"tag": ""})).is_err());
        assert!(ResolveTagRequest::parse(&json!({"tag": "x".repeat(65)})).is_err());
        assert!(ResolveTagRequest::parse(&json!({"tag": "x".repeat(64)})).is_ok());
        assert!(ResolveTagRequest::parse(&json!({})).is_err());
        assert!(ResolveTagRequest::parse(&json!({"tag": 1})).is_err());
    }
}
