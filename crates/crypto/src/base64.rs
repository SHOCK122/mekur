//! Base64 exactly as the TypeScript client reads and writes it.
//!
//! Encoding is standard base64 with padding (`Buffer`/`btoa`). Decoding
//! follows the browser's `atob` -- WHATWG "forgiving-base64 decode" --
//! because decryption has always run in the browser, so those are the
//! rules all stored data has actually been decoded under:
//! ASCII whitespace is ignored, padding is optional (but if present must
//! be correct), and leftover bits in the last character are ignored.
//! Node's `Buffer` is laxer still (URL-safe characters, skipping garbage);
//! that only ever applied server-side and in tests, and is not emulated.

use base64::Engine as _;
use base64::alphabet;
use base64::engine::general_purpose::{GeneralPurpose, GeneralPurposeConfig};
use base64::engine::{DecodePaddingMode, general_purpose::STANDARD};

use crate::CryptoError;

/// Standard alphabet, no padding expected (it is stripped first), and the
/// unused low bits of the final character are allowed to be non-zero, as
/// `atob` allows.
const FORGIVING: GeneralPurpose = GeneralPurpose::new(
    &alphabet::STANDARD,
    GeneralPurposeConfig::new()
        .with_decode_padding_mode(DecodePaddingMode::RequireNone)
        .with_decode_allow_trailing_bits(true),
);

/// Standard base64 with padding.
pub fn to_base64(bytes: &[u8]) -> String {
    STANDARD.encode(bytes)
}

/// Decodes base64 the way the browser's `atob` does.
pub fn from_base64(input: &str) -> Result<Vec<u8>, CryptoError> {
    // 1. Remove ASCII whitespace (TAB, LF, FF, CR, SPACE).
    let mut data: Vec<u8> = input
        .bytes()
        .filter(|b| !matches!(b, b'\t' | b'\n' | b'\x0C' | b'\r' | b' '))
        .collect();
    // 2. If the length is a multiple of 4, drop one or two trailing '='.
    if data.len().is_multiple_of(4) {
        if data.ends_with(b"==") {
            data.truncate(data.len() - 2);
        } else if data.ends_with(b"=") {
            data.truncate(data.len() - 1);
        }
    }
    // 3. A remainder of 1 can't encode a byte; any other '=' is invalid
    //    (the engine rejects it, as it does any non-alphabet character).
    if data.len() % 4 == 1 {
        return Err(CryptoError::InvalidBase64);
    }
    FORGIVING
        .decode(&data)
        .map_err(|_| CryptoError::InvalidBase64)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok(s: &str) -> Vec<u8> {
        from_base64(s).unwrap_or_else(|e| panic!("{s:?}: {e}"))
    }

    #[test]
    fn round_trips_every_length() {
        for len in 0..40u8 {
            let bytes: Vec<u8> = (0..len).map(|i| i.wrapping_mul(37)).collect();
            assert_eq!(ok(&to_base64(&bytes)), bytes);
        }
    }

    #[test]
    fn encodes_like_buffer_and_btoa() {
        assert_eq!(to_base64(b""), "");
        assert_eq!(to_base64(b"f"), "Zg==");
        assert_eq!(to_base64(b"fo"), "Zm8=");
        assert_eq!(to_base64(b"foo"), "Zm9v");
        assert_eq!(to_base64(&[0xfb, 0xff]), "+/8=");
    }

    #[test]
    fn accepts_what_atob_accepts() {
        // Missing padding.
        assert_eq!(ok("Zg"), b"f");
        assert_eq!(ok("Zm8"), b"fo");
        // ASCII whitespace anywhere, padding included.
        assert_eq!(ok(" Zm\n9v\t"), b"foo");
        assert_eq!(ok("Zg=\r\n="), b"f");
        assert_eq!(ok("Zm8\x0C="), b"fo");
        // Non-zero leftover bits ("Zh" and "Zg" both decode to "f").
        assert_eq!(ok("Zh=="), b"f");
        assert_eq!(ok("Zh"), b"f");
        assert_eq!(ok(""), b"");
    }

    #[test]
    fn rejects_what_atob_rejects() {
        for bad in [
            "Z",          // remainder 1
            "Zm9vY",      // remainder 1
            "Zg=",        // padding that doesn't complete a quantum
            "Zg===",      // too much padding
            "Z===",       // too much padding
            "Zm=9",       // '=' in the middle
            "Zm9v-_",     // URL-safe alphabet (Node accepts, atob doesn't)
            "Zm9v!",      // garbage (Node skips it, atob doesn't)
            "Zm9v\u{a0}", // non-ASCII whitespace
            "Zm9v\x0B",   // vertical tab is not ASCII whitespace for atob
        ] {
            assert!(from_base64(bad).is_err(), "{bad:?} should be rejected");
        }
    }
}
