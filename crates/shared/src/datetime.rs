//! Zod 3.25's `z.string().datetime()` format, and the instant it names.
//!
//! The format is `YYYY-MM-DDTHH:MM[:SS[.f+]]Z`: seconds optional, any
//! number of fractional digits, an upper-case `T`, a trailing `Z` only (no
//! offsets), and only dates that exist (leap years included). This is Zod's
//! regular expression written out by hand; chrono's RFC 3339 parser accepts
//! a different set (offsets, required seconds), so it is not used.

/// True when `s` passes Zod's `datetime()` check.
pub fn is_zod_datetime(s: &str) -> bool {
    parse(s).is_some()
}

/// Milliseconds since the Unix epoch for a string that passes
/// [`is_zod_datetime`], as JavaScript's `new Date(s).getTime()` gives it:
/// fractional seconds beyond milliseconds are truncated. `None` for any
/// other string.
///
/// The schemas' refinements compare instants. For strings Zod's check
/// rejects, JavaScript's `Date` may still find an instant (its parser is
/// lenient and partly implementation-defined); this port treats every such
/// string as an invalid date instead. That only changes which *extra*
/// issues an already-invalid value reports, never whether a value is
/// valid -- see `docs/RUST_MIGRATION.md`.
pub fn instant_millis(s: &str) -> Option<i64> {
    parse(s)
}

fn digits(b: &[u8]) -> Option<i64> {
    if b.is_empty() || !b.iter().all(u8::is_ascii_digit) {
        return None;
    }
    Some(b.iter().fold(0, |acc, d| acc * 10 + i64::from(d - b'0')))
}

fn is_leap(year: i64) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

fn days_in_month(year: i64, month: i64) -> i64 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap(year) => 29,
        2 => 28,
        _ => 0,
    }
}

/// Days from 1970-01-01 to the given proleptic Gregorian date
/// (Howard Hinnant's `days_from_civil`).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn parse(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    // YYYY-MM-DDTHH:MM is the fixed-width part; then optional seconds,
    // then `Z`.
    if b.len() < 17 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[13] != b':' {
        return None;
    }
    let year = digits(&b[0..4])?;
    let month = digits(&b[5..7])?;
    let day = digits(&b[8..10])?;
    let hour = digits(&b[11..13])?;
    let minute = digits(&b[14..16])?;
    if !(1..=12).contains(&month) || day < 1 || day > days_in_month(year, month) {
        return None;
    }
    if hour > 23 || minute > 59 {
        return None;
    }
    let rest = &b[16..];
    let (second, millis, rest) = match rest {
        [b':', s1, s2, tail @ ..] => {
            let second = digits(&[*s1, *s2])?;
            if second > 59 {
                return None;
            }
            match tail {
                [b'.', frac @ ..] => {
                    let end = frac.iter().position(|c| !c.is_ascii_digit())?;
                    if end == 0 {
                        return None;
                    }
                    let mut ms = 0;
                    for i in 0..3 {
                        ms = ms * 10
                            + frac
                                .get(i)
                                .filter(|_| i < end)
                                .map_or(0, |d| i64::from(d - b'0'));
                    }
                    (second, ms, &frac[end..])
                }
                tail => (second, 0, tail),
            }
        }
        tail => (0, 0, tail),
    };
    if rest != b"Z" {
        return None;
    }
    let days = days_from_civil(year, month, day);
    Some(((days * 24 + hour) * 60 + minute) * 60_000 + second * 1000 + millis)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_zods_formats() {
        for s in [
            "2024-01-01T10:00Z",
            "2024-01-01T10:00:00Z",
            "2024-01-01T10:00:00.1Z",
            "2024-01-01T10:00:00.123456789Z",
            "2024-02-29T00:00:00Z",
            "2000-02-29T00:00:00Z",
            "0000-02-29T00:00:00Z",
            "9999-12-31T23:59:59.999Z",
        ] {
            assert!(is_zod_datetime(s), "{s}");
        }
    }

    #[test]
    fn rejects_what_zod_rejects() {
        for s in [
            "",
            "2024-01-01",
            "2024-01-01T10Z",
            "2024-01-01T10:00",
            "2024-01-01T10:00:00",
            "2024-01-01t10:00:00Z",
            "2024-01-01 10:00:00Z",
            "2024-01-01T10:00:00z",
            "2024-01-01T10:00:00+00:00",
            "2024-01-01T10:00:00.Z",
            "2024-01-01T10:00:60Z",
            "2024-01-01T24:00:00Z",
            "2024-01-01T10:60:00Z",
            "2023-02-29T00:00:00Z",
            "1900-02-29T00:00:00Z",
            "2024-04-31T00:00:00Z",
            "2024-13-01T00:00:00Z",
            "2024-00-01T00:00:00Z",
            "2024-01-00T00:00:00Z",
            "+02024-01-01T00:00:00Z",
            "2024-01-01T10:00:00ZZ",
            "２０２４-01-01T10:00:00Z",
        ] {
            assert!(!is_zod_datetime(s), "{s}");
        }
    }

    #[test]
    fn instants_match_javascript() {
        // Values from `new Date(s).getTime()` in Node 22.
        assert_eq!(instant_millis("1970-01-01T00:00Z"), Some(0));
        assert_eq!(
            instant_millis("2026-08-01T10:00:00.1234567Z"),
            Some(1_785_578_400_123)
        );
        assert_eq!(
            instant_millis("2026-08-01T10:00:00.9999Z"),
            Some(1_785_578_400_999)
        );
        assert_eq!(instant_millis("2026-08-01T10:00Z"), Some(1_785_578_400_000));
        assert_eq!(
            instant_millis("0000-01-01T00:00:00Z"),
            Some(-62_167_219_200_000)
        );
        assert_eq!(instant_millis("2024-01-01T10:00:00+01:00"), None);
    }
}
