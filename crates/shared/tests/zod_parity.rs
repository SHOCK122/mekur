//! Replays Zod's own verdicts (recorded by
//! `packages/shared/test/zodParity.test.ts`) against mekur-shared: the
//! same inputs must give the same parsed output, or the same issues -- code,
//! path, message and every code-specific field.

use mekur_shared::{
    EncryptedEnvelope, EventContent, KeyringEnvelope, RecurrenceRule, SealedEnvelope,
    ValidationError, is_valid_time_zone,
};
use serde_json::{Value, json};

fn fixture() -> Value {
    let text = include_str!("fixtures/zod_parity.json");
    serde_json::from_str(text).expect("fixture is JSON")
}

fn to_json<T: serde::Serialize>(r: Result<T, ValidationError>) -> Value {
    match r {
        Ok(data) => json!({ "success": true, "data": data }),
        Err(e) => json!({ "success": false, "issues": e.issues }),
    }
}

fn run(schema: &str, input: &Value) -> Value {
    match schema {
        "EncryptedEnvelope" => to_json(EncryptedEnvelope::parse(input)),
        "SealedEnvelope" => to_json(SealedEnvelope::parse(input)),
        "KeyringEnvelope" => to_json(KeyringEnvelope::parse(input)),
        "RecurrenceRule" => to_json(RecurrenceRule::parse(input)),
        "EventContent" => to_json(EventContent::parse(input)),
        other => panic!("unknown schema {other}"),
    }
}

#[test]
fn every_case_matches_zod() {
    let fixture = fixture();
    let cases = fixture["cases"].as_array().expect("cases");
    assert!(cases.len() > 100, "fixture lost its cases");
    let mut failures = Vec::new();
    for case in cases {
        let schema = case["schema"].as_str().expect("schema");
        let name = case["name"].as_str().expect("name");
        let actual = run(schema, &case["input"]);
        if actual != case["expected"] {
            failures.push(format!(
                "{schema} / {name}\n  zod:  {}\n  rust: {actual}",
                case["expected"]
            ));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn every_time_zone_verdict_matches_intl() {
    let fixture = fixture();
    let zones = fixture["timeZones"].as_object().expect("timeZones");
    assert!(zones.len() > 400, "fixture lost its zones");
    let wrong: Vec<_> = zones
        .iter()
        .filter(|(tz, valid)| is_valid_time_zone(tz) != valid.as_bool().expect("bool"))
        .map(|(tz, valid)| format!("{tz:?}: Intl says {valid}"))
        .collect();
    assert!(wrong.is_empty(), "{}", wrong.join("\n"));
}
