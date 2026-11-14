//! Zod's UUID check.

/// Zod 3's `z.string().uuid()`: 8-4-4-4-12 hex digits in either case, any
/// version or variant. Narrower than `uuid::Uuid::parse_str`, which also
/// takes braces, URNs and the unhyphenated form.
pub fn is_zod_uuid(s: &str) -> bool {
    s.len() == 36
        && s.bytes().enumerate().all(|(i, b)| match i {
            8 | 13 | 18 | 23 => b == b'-',
            _ => b.is_ascii_hexdigit(),
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uuids_as_zod_checks_them() {
        for ok in [
            "1a000000-0000-4000-8000-00000000000a",
            "FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF",
            "00000000-0000-0000-0000-000000000000",
        ] {
            assert!(is_zod_uuid(ok), "{ok}");
        }
        for bad in [
            "",
            "not-a-uuid",
            "1a00000000004000800000000000000a",
            "{1a000000-0000-4000-8000-00000000000a}",
            "urn:uuid:1a000000-0000-4000-8000-00000000000a",
            "1a000000-0000-4000-8000-00000000000a\n",
            "1a000000-0000-4000-8000-00000000000g",
            "1a0000000-000-4000-8000-00000000000a",
        ] {
            assert!(!is_zod_uuid(bad), "{bad:?}");
        }
    }
}
