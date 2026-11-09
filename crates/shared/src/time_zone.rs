//! Time-zone names, accepted as JavaScript's `Intl.DateTimeFormat`
//! accepts them (the TypeScript `isValidTimeZone` asked it).
//!
//! `Intl` (ICU) accepts:
//! - every IANA zone and alias, in any ASCII letter case;
//! - UTC offsets `±HH`, `±HHMM`, `±HH:MM` (hours 00-23, minutes 00-59;
//!   U+2212 MINUS SIGN works as the sign too);
//! - a few legacy names IANA has since dropped but ICU keeps (the Java
//!   three-letter ids, `SystemV/*`, `US/Pacific-New`,
//!   `Canada/East-Saskatchewan`).
//!
//! IANA names come from `chrono-tz` (tzdata 2025b at the time of the
//! port); `crates/shared/tests/fixtures/zod_parity.json` records Node's
//! verdict on every zone Node knows plus the edge cases, and the tests
//! check this function agrees with all of them.

use std::collections::HashSet;
use std::sync::OnceLock;

use chrono_tz::TZ_VARIANTS;

/// Zone ids ICU accepts that are not (or no longer) in the IANA database.
const ICU_LEGACY: &[&str] = &[
    "ACT",
    "AET",
    "AGT",
    "ART",
    "AST",
    "BET",
    "BST",
    "CAT",
    "CNT",
    "CST",
    "CTT",
    "EAT",
    "ECT",
    "IET",
    "IST",
    "JST",
    "MIT",
    "NET",
    "NST",
    "PLT",
    "PNT",
    "PRT",
    "PST",
    "SST",
    "VST",
    "SystemV/AST4",
    "SystemV/AST4ADT",
    "SystemV/CST6",
    "SystemV/CST6CDT",
    "SystemV/EST5",
    "SystemV/EST5EDT",
    "SystemV/HST10",
    "SystemV/MST7",
    "SystemV/MST7MDT",
    "SystemV/PST8",
    "SystemV/PST8PDT",
    "SystemV/YST9",
    "SystemV/YST9YDT",
    "US/Pacific-New",
    "Canada/East-Saskatchewan",
];

/// Every accepted zone name, ASCII-lower-cased; built on first use.
fn names() -> &'static HashSet<String> {
    static NAMES: OnceLock<HashSet<String>> = OnceLock::new();
    NAMES.get_or_init(|| {
        TZ_VARIANTS
            .iter()
            .map(|tz| tz.name())
            .chain(ICU_LEGACY.iter().copied())
            .map(str::to_ascii_lowercase)
            .collect()
    })
}

/// True when `time_zone` names a zone `Intl.DateTimeFormat` would accept.
pub fn is_valid_time_zone(time_zone: &str) -> bool {
    // No zone name is longer than this; don't lower-case arbitrary input.
    const LONGEST: usize = 64;
    is_offset(time_zone)
        || (time_zone.len() <= LONGEST && names().contains(&time_zone.to_ascii_lowercase()))
}

fn two_digits(s: &str, max: u8) -> bool {
    s.len() == 2 && s.bytes().all(|b| b.is_ascii_digit()) && s.parse::<u8>().is_ok_and(|n| n <= max)
}

fn is_offset(s: &str) -> bool {
    let rest = if let Some(r) = s.strip_prefix(['+', '-']) {
        r
    } else if let Some(r) = s.strip_prefix('\u{2212}') {
        r
    } else {
        return false;
    };
    if !rest.is_ascii() {
        return false;
    }
    let (hours, minutes) = match rest.len() {
        2 => (rest, None),
        4 => (&rest[..2], Some(&rest[2..])),
        5 if rest.as_bytes()[2] == b':' => (&rest[..2], Some(&rest[3..])),
        _ => return false,
    };
    two_digits(hours, 23) && minutes.is_none_or(|m| two_digits(m, 59))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn offsets() {
        for ok in [
            "+05:00",
            "+0500",
            "+05",
            "-12:00",
            "+23:59",
            "-0000",
            "\u{2212}05:00",
        ] {
            assert!(is_valid_time_zone(ok), "{ok}");
        }
        for bad in [
            "+24:00",
            "+05:60",
            "+5",
            "+5:00",
            "+05:3",
            "+05:30:00",
            "05:00",
            "+",
            "+é5",
            "+5é5",
            "+0é",
        ] {
            assert!(!is_valid_time_zone(bad), "{bad}");
        }
    }

    #[test]
    fn names_in_any_case() {
        for ok in [
            "UTC",
            "utc",
            "america/new_york",
            "US/Eastern",
            "EST",
            "etc/gmt+5",
            "pst",
        ] {
            assert!(is_valid_time_zone(ok), "{ok}");
        }
        for bad in ["", " UTC", "Mars/Olympus_Mons", "GMT+5", "Etc/GMT+13", "Z"] {
            assert!(!is_valid_time_zone(bad), "{bad}");
        }
    }
}
