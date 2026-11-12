//! Node's `Buffer.from(string, "base64")`, byte for byte.
//!
//! The TS server stored each account's auth verifier as
//! `sha256(Buffer.from(authKey, "base64"))`, so the bytes hashed are what
//! *Node's* decoder made of the string -- and it is lenient: it skips any
//! character outside the (standard or URL-safe) alphabet, stops at the
//! first `=`, ignores leftover bits and reads only the low byte of each
//! UTF-16 code unit. Clients send well-formed standard base64, which every
//! decoder agrees on, but a stored hash must keep verifying whatever was
//! sent at registration, so this reproduces Node's legacy decoder
//! (`nbytes::Base64Decode`; Node 22 tries simdutf first and falls back to
//! it, and simdutf's forgiving decoding gives the same bytes whenever it
//! succeeds). `tests/fixtures/node_base64.json` holds Node's own output for
//! the tricky cases, recorded by `apps/api/test/rustParity.test.ts`.

/// The decoder's table: `A-Z a-z 0-9 + /`, plus URL-safe `-` and `_`.
fn unbase64(c: u8) -> u8 {
    match c {
        b'A'..=b'Z' => c - b'A',
        b'a'..=b'z' => c - b'a' + 26,
        b'0'..=b'9' => c - b'0' + 52,
        b'+' | b'-' => 62,
        b'/' | b'_' => 63,
        _ => 255,
    }
}

/// The output buffer Node allocates (`Base64DecodedSize`): from the length,
/// less up to two trailing `=`.
fn decoded_size(src: &[u16]) -> usize {
    let mut size = src.len();
    if size < 2 {
        return 0;
    }
    if src[size - 1] == u16::from(b'=') {
        size -= 1;
        if src[size - 1] == u16::from(b'=') {
            size -= 1;
        }
    }
    let remainder = size % 4;
    let mut out = size / 4 * 3;
    if remainder != 0 {
        if out == 0 && remainder == 1 {
            out = 0;
        } else {
            out += 1 + usize::from(remainder == 3);
        }
    }
    out
}

/// Decodes `s` as Node's `Buffer.from(s, "base64")` does.
pub fn decode(s: &str) -> Vec<u8> {
    let units: Vec<u16> = s.encode_utf16().collect();
    let dstlen = decoded_size(&units);
    // Each code unit is read as its low byte (`static_cast<uint8_t>`).
    let src: Vec<u8> = units.iter().map(|&u| u.to_le_bytes()[0]).collect();
    let mut dst = vec![0u8; dstlen];
    let k = decode_fast(&mut dst, &src);
    dst.truncate(k);
    dst
}

/// `base64_decode_fast`: whole groups of four while they're clean, a slow
/// group (skipping junk) whenever one isn't, then one slow group for the
/// tail. Returns the number of bytes written.
fn decode_fast(dst: &mut [u8], src: &[u8]) -> usize {
    let dstlen = dst.len();
    let max_k = dstlen / 3 * 3;
    let mut max_i = src.len() / 4 * 4;
    let (mut i, mut k) = (0usize, 0usize);
    while i < max_i && k < max_k {
        let t = [
            unbase64(src[i]),
            unbase64(src[i + 1]),
            unbase64(src[i + 2]),
            unbase64(src[i + 3]),
        ];
        if t.iter().any(|&v| v & 0x80 != 0) {
            if !decode_group_slow(dst, src, &mut i, &mut k) {
                return k;
            }
            max_i = i + (src.len() - i) / 4 * 4;
        } else {
            dst[k] = (t[0] << 2) | (t[1] >> 4);
            dst[k + 1] = (t[1] << 4) | (t[2] >> 2);
            dst[k + 2] = (t[2] << 6) | t[3];
            i += 4;
            k += 3;
        }
    }
    if i < src.len() && k < dstlen {
        decode_group_slow(dst, src, &mut i, &mut k);
    }
    k
}

/// `base64_decode_group_slow`: one group of four alphabet characters,
/// skipping anything else; stops (returns `false`) at `=`, at the end of
/// the input or when the output is full.
fn decode_group_slow(dst: &mut [u8], src: &[u8], i: &mut usize, k: &mut usize) -> bool {
    let dstlen = dst.len();
    let mut hi = 0u8;
    for step in 0..4 {
        let lo = loop {
            let c = src[*i];
            let v = unbase64(c);
            *i += 1;
            if v < 64 {
                break v;
            }
            if c == b'=' || *i >= src.len() {
                return false;
            }
        };
        match step {
            1 => {
                dst[*k] = ((hi & 0x3F) << 2) | ((lo & 0x30) >> 4);
                *k += 1;
            }
            2 => {
                dst[*k] = ((hi & 0x0F) << 4) | ((lo & 0x3C) >> 2);
                *k += 1;
            }
            3 => {
                dst[*k] = ((hi & 0x03) << 6) | (lo & 0x3F);
                *k += 1;
            }
            _ => {}
        }
        if *i >= src.len() || *k >= dstlen {
            return false;
        }
        hi = lo;
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_well_formed_base64() {
        assert_eq!(decode("d3JvbmctZ3Vlc3M="), b"wrong-guess");
        assert_eq!(decode(""), b"");
        assert_eq!(decode("QQ=="), b"A");
        assert_eq!(decode("QUI="), b"AB");
        assert_eq!(decode("QUJD"), b"ABC");
    }

    #[test]
    fn is_lenient_like_node() {
        assert_eq!(decode("QQ"), b"A");
        assert_eq!(decode("Q U J D"), b"ABC");
        assert_eq!(decode("-_-_"), decode("+/+/"));
        assert_eq!(decode("!!!!"), b"");
        assert_eq!(decode("QQ==QUJD"), b"A");
    }
}
