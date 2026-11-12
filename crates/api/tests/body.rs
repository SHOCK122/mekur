//! Request-body handling the TS fixture can't express (Fastify's `inject`
//! always adds a content type to a string payload): bodies without a
//! content type, the closing of the connection after a 413 or a malformed
//! body, and the limit itself.

mod common;

use axum::{body::Body, http::Request};
use common::{TestApp, request_with};
use mekur_api::body::BODY_LIMIT;

#[tokio::test]
async fn a_body_without_a_content_type_is_a_415() {
    let t = TestApp::new().await;
    let reply = t
        .send(request_with("POST", "/sessions", &[], Some(b"{}".to_vec())))
        .await;
    assert_eq!(reply.status, 415);
    assert_eq!(
        reply.text(),
        r#"{"statusCode":415,"code":"FST_ERR_CTP_INVALID_MEDIA_TYPE","error":"Unsupported Media Type","message":"Unsupported Media Type"}"#
    );
    // A chunked body counts too, whatever its length.
    let chunked = Request::builder()
        .method("POST")
        .uri("/sessions")
        .header("transfer-encoding", "chunked")
        .body(Body::empty())
        .unwrap();
    assert_eq!(t.send(chunked).await.status, 415);
}

#[tokio::test]
async fn no_content_type_and_an_empty_body_is_no_body() {
    let t = TestApp::new().await;
    let reply = t
        .send(request_with(
            "POST",
            "/sessions",
            &[("content-length", "0")],
            None,
        ))
        .await;
    assert_eq!(reply.status, 400);
    assert_eq!(reply.json()["details"][0]["message"], "Required");
    assert_eq!(reply.json()["details"][0]["received"], "undefined");
}

#[tokio::test]
async fn an_oversized_or_malformed_body_closes_the_connection() {
    let t = TestApp::new().await;
    let json = [("content-type", "application/json")];
    let big = vec![b' '; BODY_LIMIT + 1];
    let reply = t
        .send(request_with("POST", "/sessions", &json, Some(big)))
        .await;
    assert_eq!(reply.status, 413);
    assert_eq!(reply.header("connection"), Some("close"));
    assert_eq!(
        reply.text(),
        r#"{"statusCode":413,"code":"FST_ERR_CTP_BODY_TOO_LARGE","error":"Payload Too Large","message":"Request body is too large"}"#
    );

    // Without a content-length the limit is enforced while reading.
    let streamed = Request::builder()
        .method("POST")
        .uri("/sessions")
        .header("content-type", "application/json")
        .body(Body::from_stream(futures_stream(vec![
            b'x';
            BODY_LIMIT + 1
        ])))
        .unwrap();
    assert_eq!(t.send(streamed).await.status, 413);

    let malformed = t
        .send(request_with(
            "POST",
            "/sessions",
            &json,
            Some(b"{bad".to_vec()),
        ))
        .await;
    assert_eq!(malformed.status, 400);
    assert_eq!(malformed.header("connection"), Some("close"));
    let body = malformed.json();
    assert_eq!(
        (body["statusCode"].as_u64(), body["error"].as_str()),
        (Some(400), Some("Bad Request"))
    );
}

#[tokio::test]
async fn a_body_at_the_limit_is_read() {
    let t = TestApp::new().await;
    let at_limit = vec![b' '; BODY_LIMIT];
    let reply = t
        .send(request_with(
            "POST",
            "/sessions",
            &[("content-type", "application/json")],
            Some(at_limit),
        ))
        .await;
    // All whitespace: read as {}, so the route's own validation answers.
    assert_eq!(reply.status, 400);
    assert_eq!(reply.json()["error"], "Invalid request");
}

/// A body of unknown length, in two chunks.
fn futures_stream(
    bytes: Vec<u8>,
) -> impl futures_core::Stream<Item = Result<Vec<u8>, std::io::Error>> + Send + 'static {
    let (a, b) = bytes.split_at(bytes.len() / 2);
    tokio_stream_iter(vec![Ok(a.to_vec()), Ok(b.to_vec())])
}

fn tokio_stream_iter<T: Send + 'static>(
    items: Vec<T>,
) -> impl futures_core::Stream<Item = T> + Send + 'static {
    struct Iter<T>(std::vec::IntoIter<T>);
    impl<T> futures_core::Stream for Iter<T> {
        type Item = T;
        fn poll_next(
            mut self: std::pin::Pin<&mut Self>,
            _: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Option<T>> {
            std::task::Poll::Ready(self.0.next())
        }
    }
    impl<T> Unpin for Iter<T> {}
    Iter(items.into_iter())
}
