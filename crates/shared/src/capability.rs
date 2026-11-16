//! Event requests under the capability model: the bodies of `POST
//! /events`, `PUT /events/{id}`, `POST /events/batch-read`, `POST
//! /events/{id}/capabilities` and `.../capabilities/revoke`. Ports of the
//! Zod schemas that lived in `apps/api/src/routes/eventRoutes.ts` until
//! step 3d; their issues are checked against the TS server's recorded
//! replies in `crates/api/tests/fixtures/ts_event_responses.json`.

use serde::Serialize;
use serde_json::Value;

use crate::envelope::EncryptedEnvelope;
use crate::zod::{self, StrChecks, parsers};

/// Most capabilities one batch read may present.
pub const BATCH_READ_LIMIT: usize = 500;

/// What a capability token grants. An edit capability implies view; the
/// reverse never holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CapabilityLevel {
    View,
    Edit,
}

const LEVELS: &[&str] = &["view", "edit"];

impl CapabilityLevel {
    pub fn as_str(self) -> &'static str {
        LEVELS[self as usize]
    }
}

/// `{ envelope }`: the body of `POST /events` and `PUT /events/{id}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct EventEnvelopeRequest {
    pub envelope: EncryptedEnvelope,
}

/// One capability presented to a batch read.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PresentedCapability {
    /// A UUID as Zod checks it (either case).
    pub event_id: String,
    /// 1-128 UTF-16 code units.
    pub token: String,
}

/// `POST /events/batch-read`: the capabilities the client holds, at most
/// [`BATCH_READ_LIMIT`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BatchReadRequest {
    pub events: Vec<PresentedCapability>,
}

/// `POST /events/{id}/capabilities`: mint another capability (a reusable
/// join code).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MintCapabilityRequest {
    pub level: CapabilityLevel,
    /// A Zod datetime (`YYYY-MM-DDTHH:MM[:SS[.f+]]Z`); absent and `null`
    /// both mean "never expires".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
}

/// `POST /events/{id}/capabilities/revoke`: the token to revoke.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RevokeCapabilityRequest {
    /// At least 1 UTF-16 code unit; no upper bound, as in TS.
    pub token: String,
}

parsers!(EventEnvelopeRequest, |ctx, value| {
    let obj = zod::object(ctx, value)?;
    let envelope = zod::field(ctx, obj, "envelope", EncryptedEnvelope::parse_in);
    Some(Self {
        envelope: envelope?,
    })
});

parsers!(BatchReadRequest, |ctx, value| {
    let obj = zod::object(ctx, value)?;
    let events = zod::field(ctx, obj, "events", |ctx, v| {
        zod::array(ctx, v, None, Some(BATCH_READ_LIMIT), |ctx, item| {
            let obj = zod::object(ctx, item)?;
            let event_id = zod::field(ctx, obj, "eventId", |ctx, v| {
                zod::string(ctx, v, StrChecks::UUID)
            });
            let token = zod::field(ctx, obj, "token", |ctx, v| {
                zod::string(ctx, v, StrChecks::between(1, 128))
            });
            Some(PresentedCapability {
                event_id: event_id?,
                token: token?,
            })
        })
    });
    Some(Self { events: events? })
});

parsers!(MintCapabilityRequest, |ctx, value| {
    let obj = zod::object(ctx, value)?;
    let level = zod::field(ctx, obj, "level", |ctx, v| zod::enumeration(ctx, v, LEVELS));
    // `.nullable().optional()`: missing and `null` are both no expiry.
    let expires_at = zod::field(ctx, obj, "expiresAt", |ctx, v| match v {
        None | Some(Value::Null) => Some(None),
        some => zod::string(ctx, some, StrChecks::DATETIME).map(Some),
    });
    let level = match level? {
        0 => CapabilityLevel::View,
        _ => CapabilityLevel::Edit,
    };
    Some(Self {
        level,
        expires_at: expires_at?,
    })
});

parsers!(RevokeCapabilityRequest, |ctx, value| {
    let obj = zod::object(ctx, value)?;
    let token = zod::field(ctx, obj, "token", |ctx, v| {
        zod::string(ctx, v, StrChecks::at_least(1))
    });
    Some(Self { token: token? })
});

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ValidationError;
    use serde_json::json;

    fn codes(err: &ValidationError) -> Vec<(&'static str, String)> {
        err.issues
            .iter()
            .map(|i| (i.code(), serde_json::to_string(&i.path).unwrap()))
            .collect()
    }

    #[test]
    fn level_names_round_trip() {
        assert_eq!(CapabilityLevel::View.as_str(), "view");
        assert_eq!(CapabilityLevel::Edit.as_str(), "edit");
        assert_eq!(json!(CapabilityLevel::Edit), json!("edit"));
    }

    #[test]
    fn batch_read_checks_every_entry_and_the_length() {
        let entry = json!({ "eventId": "x", "token": "" });
        let err = BatchReadRequest::parse(&json!({ "events": vec![entry; 501] })).unwrap_err();
        // The length issue first, then each entry's, as Zod lists them.
        assert_eq!(err.issues[0].code(), "too_big");
        assert_eq!(err.issues.len(), 1 + 2 * 501);
        assert_eq!(
            codes(&err)[1..3],
            [
                ("invalid_string", r#"["events",0,"eventId"]"#.to_owned()),
                ("too_small", r#"["events",0,"token"]"#.to_owned()),
            ]
        );
    }

    #[test]
    fn mint_expiry_may_be_missing_or_null() {
        for body in [
            json!({ "level": "view" }),
            json!({ "level": "view", "expiresAt": null }),
        ] {
            let parsed = MintCapabilityRequest::parse(&body).unwrap();
            assert_eq!(parsed.expires_at, None);
        }
        let parsed = MintCapabilityRequest::parse(
            &json!({ "level": "edit", "expiresAt": "2999-01-01T00:00Z" }),
        )
        .unwrap();
        assert_eq!(parsed.level, CapabilityLevel::Edit);
        assert_eq!(parsed.expires_at.as_deref(), Some("2999-01-01T00:00Z"));
        let err = MintCapabilityRequest::parse(&json!({ "level": "view", "expiresAt": false }))
            .unwrap_err();
        assert_eq!(
            codes(&err),
            [("invalid_type", r#"["expiresAt"]"#.to_owned())]
        );
    }

    #[test]
    fn envelope_issues_are_nested_under_envelope() {
        let err = EventEnvelopeRequest::parse(&json!({ "envelope": { "v": 2 } })).unwrap_err();
        assert_eq!(err.issues[0].code(), "invalid_literal");
        assert_eq!(
            serde_json::to_string(&err.issues[0].path).unwrap(),
            r#"["envelope","v"]"#
        );
        assert!(EventEnvelopeRequest::parse_optional(None).is_err());
    }
}
