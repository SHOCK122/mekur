//! The body of `PUT /keyring`. A port of the Zod schema that lived in
//! `apps/api/src/routes/keyringRoutes.ts` until step 3e; its issues are
//! checked against the TS server's recorded replies in
//! `crates/api/tests/fixtures/ts_keyring_responses.json`.

use serde::Serialize;

use crate::envelope::KeyringEnvelope;
use crate::zod::{self, NumCheck, parsers};

/// `{ envelope, expectedVersion }`: replace the account's keyring, if it is
/// still at the version the client read.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PutKeyringRequest {
    pub envelope: KeyringEnvelope,
    /// The version the client last read; 0 means "I believe no keyring
    /// exists yet". A non-negative integer (`1.0` counts, as in
    /// JavaScript). Zod accepts any JavaScript integer; one past `u64::MAX`
    /// is held as `u64::MAX`, which -- like every value past `i32::MAX` --
    /// no stored version can equal.
    pub expected_version: u64,
}

parsers!(PutKeyringRequest, |ctx, value| {
    let obj = zod::object(ctx, value)?;
    let envelope = zod::field(ctx, obj, "envelope", KeyringEnvelope::parse_in);
    let expected_version = zod::field(ctx, obj, "expectedVersion", |ctx, v| {
        zod::number(ctx, v, &[NumCheck::Int, NumCheck::Min(0, true)])
    });
    Some(Self {
        envelope: envelope?,
        // A float-to-integer `as` saturates (and -0.0 is 0); fractions
        // and negatives were reported above.
        expected_version: expected_version? as u64,
    })
});

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{MAX_KEYRING_CIPHERTEXT, ValidationError};
    use serde_json::{Value, json};

    fn envelope(ciphertext: &str) -> Value {
        json!({ "v": 1, "algo": "xchacha20poly1305", "keyId": "k", "nonce": "n",
                "ciphertext": ciphertext })
    }

    fn codes(err: &ValidationError) -> Vec<(&'static str, String)> {
        err.issues
            .iter()
            .map(|i| (i.code(), serde_json::to_string(&i.path).unwrap()))
            .collect()
    }

    #[test]
    fn versions_are_non_negative_integers_as_javascript_counts_them() {
        for (text, expected) in [
            ("0", 0),
            ("-0", 0),
            ("-0.0", 0),
            ("3", 3),
            ("3.0", 3),
            ("3e0", 3),
            ("2147483648", 2_147_483_648),
            ("1e21", u64::MAX),
        ] {
            let version: Value = serde_json::from_str(text).unwrap();
            let parsed = PutKeyringRequest::parse(
                &json!({ "envelope": envelope("c"), "expectedVersion": version }),
            )
            .unwrap();
            assert_eq!(parsed.expected_version, expected, "{text}");
        }
        let issues = |version: Value| {
            let err = PutKeyringRequest::parse(
                &json!({ "envelope": envelope("c"), "expectedVersion": version }),
            )
            .unwrap_err();
            err.issues.iter().map(|i| i.code()).collect::<Vec<_>>()
        };
        assert_eq!(issues(json!(-1)), ["too_small"]);
        assert_eq!(issues(json!(1.5)), ["invalid_type"]);
        assert_eq!(issues(json!(-1.5)), ["invalid_type", "too_small"]);
        assert_eq!(issues(json!("0")), ["invalid_type"]);
        assert_eq!(issues(Value::Null), ["invalid_type"]);
    }

    #[test]
    fn the_envelope_may_be_keyring_sized_and_no_larger() {
        let at_cap = "A".repeat(MAX_KEYRING_CIPHERTEXT);
        let parsed = PutKeyringRequest::parse(
            &json!({ "envelope": envelope(&at_cap), "expectedVersion": 0 }),
        )
        .unwrap();
        assert_eq!(parsed.envelope.ciphertext.len(), MAX_KEYRING_CIPHERTEXT);
        let over = format!("{at_cap}A");
        let err =
            PutKeyringRequest::parse(&json!({ "envelope": envelope(&over), "expectedVersion": 0 }))
                .unwrap_err();
        assert_eq!(
            codes(&err),
            [("too_big", r#"["envelope","ciphertext"]"#.to_owned())]
        );
    }

    #[test]
    fn issues_come_in_schema_order_and_unknown_keys_are_stripped() {
        let err = PutKeyringRequest::parse(&json!({})).unwrap_err();
        assert_eq!(
            codes(&err),
            [
                ("invalid_type", r#"["envelope"]"#.to_owned()),
                ("invalid_type", r#"["expectedVersion"]"#.to_owned()),
            ]
        );
        assert_eq!(err.issues[0].message, "Required");
        assert!(PutKeyringRequest::parse_optional(None).is_err());

        let mut body = json!({ "envelope": envelope("c"), "expectedVersion": 2, "other": 1 });
        body["envelope"]["epk"] = json!("e");
        let parsed = PutKeyringRequest::parse(&body).unwrap();
        assert_eq!(
            serde_json::to_value(&parsed).unwrap(),
            json!({ "envelope": envelope("c"), "expectedVersion": 2 })
        );
    }
}
