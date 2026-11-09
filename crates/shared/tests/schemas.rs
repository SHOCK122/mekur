//! Port of `packages/shared/test/index.test.ts`, test for test, plus the
//! cases a JSON fixture cannot carry (`1.0` vs `1`, integers past `u64`)
//! and the serialized shape of each type.

use mekur_shared::{
    EncryptedEnvelope, EventContent, KeyringEnvelope, MAX_OCCURRENCE_OVERRIDES, RecurrenceRule,
    SealedEnvelope, Weekday,
};
use serde_json::{Value, json};

fn envelope() -> Value {
    json!({
        "v": 1,
        "algo": "xchacha20poly1305",
        "keyId": "user-key-1",
        "nonce": "bm9uY2U=",
        "ciphertext": "Y2lwaGVydGV4dA==",
    })
}

fn with(mut base: Value, key: &str, value: Value) -> Value {
    base[key] = value;
    base
}

fn without(mut base: Value, key: &str) -> Value {
    base.as_object_mut().expect("object").remove(key);
    base
}

fn messages(r: Result<impl std::fmt::Debug, mekur_shared::ValidationError>) -> Vec<String> {
    r.expect_err("should be invalid")
        .issues
        .into_iter()
        .map(|i| i.message)
        .collect()
}

// --- EncryptedEnvelopeSchema ---

#[test]
fn accepts_a_well_formed_envelope() {
    let parsed = EncryptedEnvelope::parse(&envelope()).expect("valid");
    assert_eq!(serde_json::to_value(&parsed).expect("json"), envelope());
}

#[test]
fn rejects_an_envelope_missing_ciphertext() {
    assert!(EncryptedEnvelope::parse(&without(envelope(), "ciphertext")).is_err());
}

#[test]
fn rejects_an_unknown_algo() {
    assert!(EncryptedEnvelope::parse(&with(envelope(), "algo", json!("aes-cbc"))).is_err());
}

// --- EventContentSchema ---

#[test]
fn accepts_valid_plaintext_event_content() {
    let content = json!({
        "title": "Team sync",
        "startTime": "2026-08-01T10:00:00.000Z",
        "endTime": "2026-08-01T11:00:00.000Z",
    });
    let parsed = EventContent::parse(&content).expect("valid");
    assert_eq!(serde_json::to_value(&parsed).expect("json"), content);
}

#[test]
fn rejects_an_empty_title() {
    assert!(
        EventContent::parse(&json!({
            "title": "",
            "startTime": "2026-08-01T10:00:00.000Z",
            "endTime": "2026-08-01T10:00:00.000Z",
        }))
        .is_err()
    );
}

#[test]
fn rejects_an_end_time_before_the_start_time() {
    let r = EventContent::parse(&json!({
        "title": "Backwards event",
        "startTime": "2026-08-01T10:00:00.000Z",
        "endTime": "2026-08-01T09:00:00.000Z",
    }));
    assert_eq!(messages(r), ["endTime must be after startTime"]);
}

#[test]
fn rejects_an_end_time_equal_to_the_start_time() {
    assert!(
        EventContent::parse(&json!({
            "title": "Zero-length event",
            "startTime": "2026-08-01T10:00:00.000Z",
            "endTime": "2026-08-01T10:00:00.000Z",
        }))
        .is_err()
    );
}

#[test]
fn accepts_a_recurrence_rule_for_an_arbitrary_interval() {
    let parsed = EventContent::parse(&json!({
        "title": "Custom interval reminder",
        "startTime": "2026-08-01T09:00:00.000Z",
        "endTime": "2026-08-01T09:05:00.000Z",
        "recurrence": { "freq": "MINUTELY", "interval": 37 },
    }))
    .expect("valid");
    assert_eq!(
        serde_json::to_value(parsed.recurrence).expect("json"),
        json!({ "freq": "MINUTELY", "interval": 37 })
    );
}

#[test]
fn accepts_a_recurrence_rule_for_every_weekday() {
    let parsed = EventContent::parse(&json!({
        "title": "Daily standup",
        "startTime": "2026-08-03T09:00:00.000Z",
        "endTime": "2026-08-03T09:15:00.000Z",
        "recurrence": { "freq": "WEEKLY", "interval": 1, "byDay": ["MO", "TU", "WE", "TH", "FR"] },
    }))
    .expect("valid");
    use Weekday::*;
    assert_eq!(
        parsed.recurrence.expect("rule").by_day,
        Some(vec![Monday, Tuesday, Wednesday, Thursday, Friday])
    );
}

#[test]
fn rejects_a_recurrence_with_a_non_positive_interval() {
    assert!(
        EventContent::parse(&json!({
            "title": "Bad recurrence",
            "startTime": "2026-08-01T09:00:00.000Z",
            "endTime": "2026-08-01T09:15:00.000Z",
            "recurrence": { "freq": "DAILY", "interval": 0 },
        }))
        .is_err()
    );
}

// --- optional end time ---

#[test]
fn accepts_an_event_with_no_end_time() {
    let parsed = EventContent::parse(&json!({
        "title": "Open ended",
        "startTime": "2026-08-01T09:00:00.000Z",
    }))
    .expect("valid");
    assert_eq!(parsed.end_time, None);
}

#[test]
fn still_rejects_an_end_before_the_start_when_one_is_given() {
    let r = EventContent::parse(&json!({
        "title": "Backwards",
        "startTime": "2026-08-01T10:00:00.000Z",
        "endTime": "2026-08-01T09:00:00.000Z",
    }));
    assert_eq!(messages(r), ["endTime must be after startTime"]);
}

#[test]
fn accepts_a_fractional_rank_and_an_important_flag() {
    let parsed = EventContent::parse(&json!({
        "title": "Ranked",
        "startTime": "2026-08-01T09:00:00.000Z",
        "rank": "V",
        "important": true,
    }))
    .expect("valid");
    assert_eq!(parsed.rank.as_deref(), Some("V"));
    assert_eq!(parsed.important, Some(true));
}

// --- SealedEnvelopeSchema ---

#[test]
fn sealed_envelope_requires_the_ephemeral_public_key() {
    let sealed = with(envelope(), "keyId", json!("sealed"));
    assert!(SealedEnvelope::parse(&sealed).is_err());
    let parsed = SealedEnvelope::parse(&with(sealed.clone(), "epk", json!("ZXBr"))).expect("valid");
    assert_eq!(parsed.epk, "ZXBr");
    assert_eq!(
        serde_json::to_value(&parsed).expect("json"),
        with(sealed, "epk", json!("ZXBr"))
    );
}

// --- KeyringEnvelopeSchema ---

#[test]
fn allows_a_keyring_larger_than_a_single_events_cap() {
    let big = "A".repeat(200 * 1024);
    let env = json!({
        "v": 1, "algo": "xchacha20poly1305", "keyId": "keyring", "nonce": "bm9uY2U=", "ciphertext": big,
    });
    assert!(EncryptedEnvelope::parse(&env).is_err());
    assert_eq!(
        KeyringEnvelope::parse(&env)
            .expect("valid")
            .ciphertext
            .len(),
        big.len()
    );
}

#[test]
fn keyring_and_event_ciphertext_limits_are_exact() {
    let at = |n: usize| with(envelope(), "ciphertext", json!("A".repeat(n)));
    assert!(EncryptedEnvelope::parse(&at(128 * 1024)).is_ok());
    assert!(EncryptedEnvelope::parse(&at(128 * 1024 + 1)).is_err());
    assert!(KeyringEnvelope::parse(&at(1024 * 1024)).is_ok());
    assert!(KeyringEnvelope::parse(&at(1024 * 1024 + 1)).is_err());
}

// --- RecurrenceRuleSchema calendar parts ---

fn ok(rule: Value) -> bool {
    RecurrenceRule::parse(&rule).is_ok()
}

#[test]
fn accepts_the_first_monday_of_every_month_in_a_time_zone() {
    assert!(ok(
        json!({ "freq": "MONTHLY", "interval": 1, "byDay": ["MO"], "bySetPos": [1], "tzid": "Australia/Sydney" })
    ));
}

#[test]
fn accepts_the_last_day_of_every_month_and_the_last_friday_of_march() {
    assert!(ok(json!({ "freq": "MONTHLY", "byMonthDay": [-1] })));
    assert!(ok(
        json!({ "freq": "YEARLY", "byMonth": [3], "byDay": ["FR"], "bySetPos": [-1] })
    ));
}

#[test]
fn still_accepts_rules_written_before_calendar_parts_existed() {
    assert!(ok(
        json!({ "freq": "WEEKLY", "interval": 1, "byDay": ["MO", "WE"] })
    ));
    assert!(ok(json!({ "freq": "DAILY", "interval": 3 })));
}

#[test]
fn rejects_calendar_parts_on_rules_that_do_not_repeat_by_month_or_year() {
    assert!(!ok(json!({ "freq": "DAILY", "byMonthDay": [1] })));
    assert!(!ok(json!({ "freq": "WEEKLY", "byMonth": [1] })));
    assert!(!ok(
        json!({ "freq": "MINUTELY", "byDay": ["MO"], "bySetPos": [2] })
    ));
}

#[test]
fn rejects_by_set_pos_without_anything_to_pick_from() {
    assert!(!ok(json!({ "freq": "MONTHLY", "bySetPos": [1] })));
}

#[test]
fn rejects_out_of_range_and_zero_values() {
    assert!(!ok(json!({ "freq": "MONTHLY", "byMonthDay": [0] })));
    assert!(!ok(json!({ "freq": "MONTHLY", "byMonthDay": [32] })));
    assert!(!ok(json!({ "freq": "YEARLY", "byMonth": [13] })));
    assert!(!ok(
        json!({ "freq": "MONTHLY", "byDay": ["MO"], "bySetPos": [0] })
    ));
    assert!(!ok(json!({ "freq": "MONTHLY", "byMonthDay": [] })));
}

#[test]
fn rejects_a_day_that_none_of_the_chosen_months_has() {
    assert!(!ok(
        json!({ "freq": "YEARLY", "byMonth": [2], "byMonthDay": [30] })
    ));
    assert!(!ok(
        json!({ "freq": "YEARLY", "byMonth": [4, 6], "byMonthDay": [-31] })
    ));
    // February 29th does occur, in leap years; and one long month is enough.
    assert!(ok(
        json!({ "freq": "YEARLY", "byMonth": [2], "byMonthDay": [29] })
    ));
    assert!(ok(
        json!({ "freq": "MONTHLY", "byMonth": [2, 3], "byMonthDay": [31] })
    ));
}

#[test]
fn rejects_positions_past_the_most_days_a_month_or_year_can_offer() {
    assert!(!ok(
        json!({ "freq": "MONTHLY", "byDay": ["MO"], "bySetPos": [6] })
    ));
    assert!(ok(
        json!({ "freq": "MONTHLY", "byDay": ["MO"], "bySetPos": [-5] })
    ));
    assert!(!ok(
        json!({ "freq": "MONTHLY", "byMonthDay": [1, 15], "bySetPos": [3] })
    ));
    // Yearly without a month: every month's days are candidates.
    assert!(ok(
        json!({ "freq": "YEARLY", "byDay": ["MO"], "bySetPos": [20] })
    ));
    assert!(!ok(
        json!({ "freq": "YEARLY", "byMonth": [3], "byDay": ["MO"], "bySetPos": [6] })
    ));
}

#[test]
fn rejects_an_unknown_time_zone() {
    assert!(!ok(
        json!({ "freq": "MONTHLY", "byMonthDay": [1], "tzid": "Mars/Olympus_Mons" })
    ));
}

// --- occurrenceOverrides ---

fn series() -> Value {
    json!({
        "title": "Standup",
        "startTime": "2026-08-03T09:00:00.000Z",
        "endTime": "2026-08-03T09:30:00.000Z",
        "recurrence": { "freq": "DAILY", "interval": 1 },
    })
}

fn with_overrides(overrides: Value) -> Value {
    with(series(), "occurrenceOverrides", overrides)
}

#[test]
fn accepts_an_occurrence_moved_to_another_time() {
    let o = json!({
        "occurrence": "2026-08-05T09:00:00.000Z",
        "startTime": "2026-08-05T15:00:00.000Z",
        "endTime": "2026-08-05T16:00:00.000Z",
    });
    let parsed = EventContent::parse(&with_overrides(json!([o.clone()]))).expect("valid");
    assert_eq!(
        serde_json::to_value(parsed.occurrence_overrides).expect("json"),
        json!([o])
    );
}

#[test]
fn accepts_an_open_ended_override() {
    assert!(
        EventContent::parse(&with_overrides(json!([
            { "occurrence": "2026-08-05T09:00:00.000Z", "startTime": "2026-08-05T15:00:00.000Z" }
        ])))
        .is_ok()
    );
}

#[test]
fn rejects_an_override_that_ends_before_it_starts() {
    assert!(
        EventContent::parse(&with_overrides(json!([{
            "occurrence": "2026-08-05T09:00:00.000Z",
            "startTime": "2026-08-05T15:00:00.000Z",
            "endTime": "2026-08-05T14:00:00.000Z",
        }])))
        .is_err()
    );
}

#[test]
fn rejects_two_overrides_of_the_same_occurrence() {
    let r = EventContent::parse(&with_overrides(json!([
        { "occurrence": "2026-08-05T09:00:00.000Z", "startTime": "2026-08-05T15:00:00.000Z" },
        { "occurrence": "2026-08-05T09:00:00.000Z", "startTime": "2026-08-05T16:00:00.000Z" },
    ])));
    assert_eq!(messages(r), ["an occurrence can only be moved once"]);
}

#[test]
fn overrides_are_bounded() {
    // 2026-08-03T09:00Z plus i days, as the TS test builds them.
    let many: Vec<Value> = (0..=MAX_OCCURRENCE_OVERRIDES as i64)
        .map(|i| {
            let ms = 1_785_747_600_000 + i * 86_400_000;
            let iso = iso_from_millis(ms);
            json!({ "occurrence": iso, "startTime": iso })
        })
        .collect();
    assert!(EventContent::parse(&with_overrides(json!(many))).is_err());
    assert!(EventContent::parse(&with_overrides(json!(many[..MAX_OCCURRENCE_OVERRIDES]))).is_ok());
}

fn iso_from_millis(ms: i64) -> String {
    // Civil-from-days (Howard Hinnant), enough for test dates.
    let days = ms.div_euclid(86_400_000);
    let rem = ms.rem_euclid(86_400_000);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z",
        rem / 3_600_000,
        rem / 60_000 % 60,
        rem / 1000 % 60,
        rem % 1000
    )
}

// --- beyond the TS tests: what a JSON fixture can't carry ---

#[test]
fn integers_written_with_a_fraction_are_integers_as_in_javascript() {
    let env: Value = serde_json::from_str(
        r#"{"v":1.0,"algo":"xchacha20poly1305","keyId":"k","nonce":"n","ciphertext":"c"}"#,
    )
    .expect("json");
    assert!(EncryptedEnvelope::parse(&env).is_ok());

    let rule: Value = serde_json::from_str(
        r#"{"freq":"MONTHLY","interval":2.0,"byMonthDay":[-1.0],"count":3.0}"#,
    )
    .expect("json");
    let parsed = RecurrenceRule::parse(&rule).expect("valid");
    assert_eq!(
        serde_json::to_value(parsed).expect("json"),
        json!({ "freq": "MONTHLY", "interval": 2, "byMonthDay": [-1], "count": 3 })
    );
}

#[test]
fn an_echoed_literal_prints_as_javascript_would() {
    let env: Value = serde_json::from_str(
        r#"{"v":2.0,"algo":"xchacha20poly1305","keyId":"k","nonce":"n","ciphertext":"c"}"#,
    )
    .expect("json");
    let issues = EncryptedEnvelope::parse(&env).expect_err("invalid").issues;
    assert_eq!(
        serde_json::to_value(&issues).expect("json"),
        json!([{
            "code": "invalid_literal", "expected": 1, "received": 2, "path": ["v"],
            "message": "Invalid literal value, expected 1",
        }])
    );
}

#[test]
fn integers_past_u64_are_refused() {
    // Documented divergence: Zod accepts any JavaScript integer here, but
    // no client can create one and a u64 cannot hold it.
    let r = RecurrenceRule::parse(&json!({ "freq": "DAILY", "count": 1e20 }));
    assert_eq!(messages(r), ["too large"]);
    assert!(
        RecurrenceRule::parse(&json!({ "freq": "DAILY", "count": 9_007_199_254_740_993u64 }))
            .is_ok()
    );
}

#[test]
fn issues_display_with_their_paths() {
    let err = EventContent::parse(&json!({ "title": "", "startTime": "x" })).expect_err("invalid");
    assert_eq!(
        err.to_string(),
        "title: String must contain at least 1 character(s); startTime: Invalid datetime"
    );
    let err = EventContent::parse(&json!(null)).expect_err("invalid");
    assert_eq!(err.to_string(), "Expected object, received null");
}
