//! Request bodies as Fastify read them in `apps/api/src/app.ts`: its
//! content-type rules, the 256 KB limit, an empty JSON body read as `{}`
//! and its error replies (415, 413, 400 for malformed JSON).

use axum::{
    body::Body,
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::Response,
};
use http_body_util::{BodyExt, Limited};
use serde_json::Value;

use crate::app::fastify_error;

/// Encrypted envelopes are small; without a cap a client could store
/// arbitrarily large blobs. 256 KB is far more than any real event needs.
pub const BODY_LIMIT: usize = 256 * 1024;

/// The JSON body of a `POST`/`PUT`/`PATCH`/`DELETE`/`OPTIONS` request, as
/// the TS routes received it in `request.body`:
///
/// - no `Content-Type` and no body: `None` (JavaScript's `undefined`);
/// - `application/json` (any parameters, any case): parsed, with an empty
///   or all-whitespace body read as `{}`;
/// - `text/plain`: the text as a JSON string (Fastify's built-in parser),
///   so the route answers with its own validation error;
/// - anything else, or a body without a `Content-Type`: 415.
///
/// Over `limit` bytes is a 413. Errors are complete replies in Fastify's
/// shape; the 413 and the malformed-JSON 400 close the connection, as
/// Fastify does (the client may still be sending).
pub async fn read_body(
    headers: &HeaderMap,
    body: Body,
    limit: usize,
) -> Result<Option<Value>, Response> {
    let parser = match headers.get(header::CONTENT_TYPE) {
        None => {
            let length = headers.get(header::CONTENT_LENGTH);
            let empty = !headers.contains_key(header::TRANSFER_ENCODING)
                && length.is_none_or(|l| l.as_bytes() == b"0");
            if empty {
                return Ok(None);
            }
            return Err(unsupported_media_type());
        }
        Some(value) => match value.to_str().ok().and_then(media_type) {
            Some(media) if media == "application/json" => Parser::Json,
            Some(media) if media == "text/plain" => Parser::Text,
            _ => return Err(unsupported_media_type()),
        },
    };

    // `Number(content-length) > limit` is refused before reading.
    if let Some(length) = headers.get(header::CONTENT_LENGTH)
        && let Some(length) = length
            .to_str()
            .ok()
            .and_then(|l| l.trim().parse::<u64>().ok())
        && length > limit as u64
    {
        return Err(too_large());
    }
    let bytes = match Limited::new(body, limit).collect().await {
        Ok(collected) => collected.to_bytes(),
        Err(err) if err.is::<http_body_util::LengthLimitError>() => return Err(too_large()),
        // The client went away or sent a broken body.
        Err(_) => return Err(bad_request("Request body could not be read")),
    };
    // Fastify decodes the body as UTF-8, replacing invalid sequences.
    let text = String::from_utf8_lossy(&bytes);
    match parser {
        Parser::Text => Ok(Some(Value::String(text.into_owned()))),
        Parser::Json => {
            if text.chars().all(is_js_whitespace) {
                return Ok(Some(Value::Object(serde_json::Map::new())));
            }
            serde_json::from_str(&text)
                .map(Some)
                .map_err(|err| bad_request(&err.to_string()))
        }
    }
}

enum Parser {
    Json,
    Text,
}

/// The lowercased `type/subtype` of a `Content-Type` value, or `None` if
/// Fastify's `ContentType` would call it invalid (which is a 415).
fn media_type(value: &str) -> Option<String> {
    if value.is_empty() || value == "undefined" {
        return None;
    }
    let media = match value.find(';') {
        Some(i) => &value[..i],
        None => value,
    };
    let (type_, subtype) = media.split_once('/')?;
    let type_ = type_.trim_start_matches(is_js_whitespace).to_lowercase();
    let subtype = subtype.trim_end_matches(is_js_whitespace).to_lowercase();
    let token = |s: &str| {
        !s.is_empty()
            && s.chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || "!#$%&'*+.^`|~-".contains(c))
    };
    (token(&type_) && token(&subtype)).then(|| format!("{type_}/{subtype}"))
}

/// The characters JavaScript's `String.prototype.trim` removes: Unicode
/// `White_Space` except U+0085, plus U+FEFF.
pub fn is_js_whitespace(c: char) -> bool {
    (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}'
}

fn unsupported_media_type() -> Response {
    fastify_error(
        StatusCode::UNSUPPORTED_MEDIA_TYPE,
        Some("FST_ERR_CTP_INVALID_MEDIA_TYPE"),
        "Unsupported Media Type",
    )
}

fn too_large() -> Response {
    closing(fastify_error(
        StatusCode::PAYLOAD_TOO_LARGE,
        Some("FST_ERR_CTP_BODY_TOO_LARGE"),
        "Request body is too large",
    ))
}

/// Fastify's reply to a body its parser threw on. The message is
/// `serde_json`'s, not V8's (see `docs/RUST_MIGRATION.md`).
fn bad_request(message: &str) -> Response {
    closing(fastify_error(StatusCode::BAD_REQUEST, None, message))
}

fn closing(mut response: Response) -> Response {
    response
        .headers_mut()
        .insert(header::CONNECTION, HeaderValue::from_static("close"));
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn media_types_follow_fastify() {
        assert_eq!(
            media_type("application/json").as_deref(),
            Some("application/json")
        );
        assert_eq!(
            media_type("Application/JSON; charset=latin1").as_deref(),
            Some("application/json")
        );
        assert_eq!(media_type(" text/plain ").as_deref(), Some("text/plain"));
        assert_eq!(
            media_type("application/vnd.api+json").as_deref(),
            Some("application/vnd.api+json")
        );
        for invalid in [
            "",
            "undefined",
            "json",
            "application/",
            "/json",
            "a b/c",
            "a/b c",
        ] {
            assert_eq!(media_type(invalid), None, "{invalid:?}");
        }
    }

    #[test]
    fn js_whitespace() {
        for c in [
            ' ', '\t', '\n', '\r', '\u{b}', '\u{c}', '\u{a0}', '\u{feff}', '\u{2028}', '\u{3000}',
        ] {
            assert!(is_js_whitespace(c), "{c:?}");
        }
        for c in ['\u{85}', 'a', '\u{200b}'] {
            assert!(!is_js_whitespace(c), "{c:?}");
        }
    }
}
