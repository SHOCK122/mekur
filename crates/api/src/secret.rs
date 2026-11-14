//! The two operations behind every bearer secret the server issues (API
//! keys, capability tokens): minting random bytes as base64url, and the
//! stored form, base64(sha256(the secret's UTF-8 text)). One copy, so the
//! formats of stored hashes can't drift apart.

use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use sha2::{Digest, Sha256};

/// `N` random bytes from the OS, base64url without padding, as Node's
/// `randomBytes(N).toString("base64url")`.
pub fn random_base64url<const N: usize>() -> Result<String, getrandom::Error> {
    let mut bytes = [0u8; N];
    getrandom::fill(&mut bytes)?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

/// base64(sha256(UTF-8 of `text`)), as Node's
/// `createHash("sha256").update(text, "utf8").digest("base64")`.
pub fn sha256_base64(text: &str) -> String {
    STANDARD.encode(Sha256::digest(text.as_bytes()))
}
