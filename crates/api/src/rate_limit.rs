//! Per-client rate limiting, as `@fastify/rate-limit` (11.x, in-memory
//! store) did for the TS server: a fixed window per client IP, the
//! `x-ratelimit-*` headers on every limited reply, and `429` with
//! `retry-after` once the window's allowance is spent.
//!
//! Like the TS server, each limiter keeps its own counts: the global
//! limit is one bucket per client shared by every route that uses it, and
//! each route with its own limit (login, registration) has a separate one.
//! While both servers run, each also has its own global bucket, so a
//! client's global allowance is briefly the sum of the two (accepted until
//! step 3g; see `docs/RUST_MIGRATION.md`).

use std::{
    net::{IpAddr, Ipv6Addr, SocketAddr},
    num::NonZeroUsize,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use axum::{
    extract::{ConnectInfo, Request, State},
    http::{HeaderMap, HeaderName, HeaderValue, StatusCode},
    middleware::Next,
    response::Response,
};
use lru::LruCache;

use crate::{app::fastify_error, body::is_js_whitespace};

/// Clients remembered per limiter (`@fastify/rate-limit`'s default cache
/// size). The least recently seen client is forgotten beyond this, so
/// memory stays bounded however many addresses send requests.
const CACHE_SIZE: usize = 5000;

/// One limit: at most `max` requests per client per `window`.
pub struct RateLimiter {
    max: u64,
    window: Duration,
    trust_proxy: u32,
    clients: Mutex<LruCache<String, Window>>,
}

struct Window {
    count: u64,
    started: Instant,
}

/// The outcome of counting one request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Decision {
    pub limit: u64,
    pub remaining: u64,
    /// Seconds until the window resets, rounded up.
    pub reset: u64,
    pub exceeded: bool,
}

impl RateLimiter {
    /// `trust_proxy` is the number of reverse-proxy hops whose
    /// `X-Forwarded-For` entries are believed (see [`client_ip`]).
    pub fn new(max: u64, window: Duration, trust_proxy: u32) -> Arc<Self> {
        Arc::new(Self {
            max,
            window,
            trust_proxy,
            clients: Mutex::new(LruCache::new(
                NonZeroUsize::new(CACHE_SIZE).expect("non-zero"),
            )),
        })
    }

    /// Counts one request from `key` at `now`.
    pub fn hit_at(&self, key: &str, now: Instant) -> Decision {
        let window_ms = self.window.as_millis();
        let mut clients = self.clients.lock().unwrap_or_else(|e| e.into_inner());
        let fresh = Window {
            count: 1,
            started: now,
        };
        let (count, ttl_ms) = match clients.get_mut(key) {
            Some(w) if now.saturating_duration_since(w.started) < self.window => {
                w.count += 1;
                let elapsed = now.saturating_duration_since(w.started).as_millis();
                (w.count, window_ms - elapsed)
            }
            Some(w) => {
                *w = fresh;
                (1, window_ms)
            }
            None => {
                clients.put(key.to_owned(), fresh);
                (1, window_ms)
            }
        };
        Decision {
            limit: self.max,
            remaining: self.max.saturating_sub(count),
            reset: u64::try_from(ttl_ms.div_ceil(1000)).unwrap_or(u64::MAX),
            exceeded: count > self.max,
        }
    }
}

/// Middleware applying `limiter` to a route (attach with `route_layer`, so
/// unmatched paths and methods -- 404s -- are not counted, as before).
pub async fn limit(
    State(limiter): State<Arc<RateLimiter>>,
    request: Request,
    next: Next,
) -> Response {
    let peer = request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|ConnectInfo(addr)| addr.ip());
    let key = normalize_ip(&client_ip(request.headers(), peer, limiter.trust_proxy));
    let decision = limiter.hit_at(&key, Instant::now());
    if decision.exceeded {
        let message = format!(
            "Rate limit exceeded, retry in {}",
            long_duration(decision.reset * 1000)
        );
        let mut response = fastify_error(StatusCode::TOO_MANY_REQUESTS, None, &message);
        add_headers(response.headers_mut(), &decision);
        return response;
    }
    let mut response = next.run(request).await;
    add_headers(response.headers_mut(), &decision);
    response
}

fn add_headers(headers: &mut HeaderMap, d: &Decision) {
    let mut set = |name: &'static str, value: u64| {
        headers.insert(HeaderName::from_static(name), HeaderValue::from(value));
    };
    set("x-ratelimit-limit", d.limit);
    set(
        "x-ratelimit-remaining",
        if d.exceeded { 0 } else { d.remaining },
    );
    set("x-ratelimit-reset", d.reset);
    if d.exceeded {
        set("retry-after", d.reset);
    }
}

/// The client's address as Fastify's `request.ip` gave it with
/// `trustProxy` set to a hop count: the socket address, then the
/// `X-Forwarded-For` entries from the right, believing at most
/// `trust_proxy` hops. With `0` the header is ignored, so a client can't
/// pick its own bucket. Requests without a socket (in-process tests, as
/// Fastify's `inject`) come from `127.0.0.1`.
pub fn client_ip(headers: &HeaderMap, peer: Option<IpAddr>, trust_proxy: u32) -> String {
    let socket = peer.map_or_else(|| "127.0.0.1".to_owned(), |ip| ip.to_string());
    if trust_proxy == 0 {
        return socket;
    }
    // Node joins repeated headers with ", ".
    let forwarded: Vec<String> = headers
        .get_all("x-forwarded-for")
        .iter()
        .map(|v| String::from_utf8_lossy(v.as_bytes()).into_owned())
        .collect();
    let mut addrs = vec![socket];
    if !forwarded.is_empty() {
        addrs.extend(forwarded_addresses(&forwarded.join(", ")));
    }
    let hops = usize::try_from(trust_proxy).unwrap_or(usize::MAX);
    addrs.swap_remove(hops.min(addrs.len() - 1))
}

/// The `X-Forwarded-For` entries, nearest proxy first (`@fastify/forwarded`).
fn forwarded_addresses(header: &str) -> Vec<String> {
    if !header.contains(',') {
        let one = header.trim_matches(is_js_whitespace);
        return if one.is_empty() {
            vec![]
        } else {
            vec![one.to_owned()]
        };
    }
    header
        .rsplit(',')
        .map(|entry| entry.trim_matches(' '))
        .filter(|entry| !entry.is_empty())
        .map(str::to_owned)
        .collect()
}

/// The rate-limit key for an address (`normalizeIP`): an IPv4-mapped IPv6
/// address is its IPv4 address, any other IPv6 address its /64 (one
/// client usually holds a whole /64), anything else lowercased.
pub fn normalize_ip(ip: &str) -> String {
    match ip.parse::<Ipv6Addr>() {
        Ok(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => v4.to_string(),
            None => Ipv6Addr::from_bits(v6.to_bits() & !((1u128 << 64) - 1)).to_string(),
        },
        Err(_) => ip.to_lowercase(),
    }
}

/// `@lukeed/ms`'s long format, for the 429 message ("1 minute",
/// "30 seconds").
fn long_duration(ms: u64) -> String {
    const SEC: u64 = 1000;
    const MIN: u64 = 60 * SEC;
    const HOUR: u64 = 60 * MIN;
    const DAY: u64 = 24 * HOUR;
    if ms < SEC {
        return format!("{ms} ms");
    }
    let (unit, name) = match ms {
        _ if ms < MIN => (SEC, "second"),
        _ if ms < HOUR => (MIN, "minute"),
        _ if ms < DAY => (HOUR, "hour"),
        _ => (DAY, "day"),
    };
    // Rounded half up, as `~~(val + 0.5)`.
    let n = (ms + unit / 2) / unit;
    format!("{n} {name}{}", if n == 1 { "" } else { "s" })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_a_fixed_window_per_client() {
        let limiter = RateLimiter::new(2, Duration::from_secs(60), 0);
        let t0 = Instant::now();
        let hit = |key, secs: f64| limiter.hit_at(key, t0 + Duration::from_secs_f64(secs));
        assert_eq!(
            hit("a", 0.0),
            Decision {
                limit: 2,
                remaining: 1,
                reset: 60,
                exceeded: false
            }
        );
        assert_eq!(hit("a", 0.5).reset, 60);
        let third = hit("a", 1.5);
        assert!(third.exceeded);
        assert_eq!((third.remaining, third.reset), (0, 59));
        // Another client has its own count.
        assert!(!hit("b", 2.0).exceeded);
        // Still limited until the window has passed, then counted afresh.
        assert!(hit("a", 59.999).exceeded);
        assert_eq!(hit("a", 60.0).remaining, 1);
    }

    #[test]
    fn forgets_the_least_recent_client_beyond_the_cache_size() {
        let limiter = RateLimiter::new(1, Duration::from_secs(60), 0);
        let now = Instant::now();
        limiter.hit_at("first", now);
        assert!(limiter.hit_at("first", now).exceeded);
        for i in 0..CACHE_SIZE {
            limiter.hit_at(&i.to_string(), now);
        }
        assert!(!limiter.hit_at("first", now).exceeded);
    }

    #[test]
    fn client_ip_believes_only_trusted_hops() {
        let mut headers = HeaderMap::new();
        let peer = Some("10.0.0.1".parse().unwrap());
        assert_eq!(client_ip(&headers, peer, 1), "10.0.0.1");
        headers.insert(
            "x-forwarded-for",
            HeaderValue::from_static("1.1.1.1, 2.2.2.2 ,  3.3.3.3"),
        );
        assert_eq!(client_ip(&headers, peer, 0), "10.0.0.1");
        assert_eq!(client_ip(&headers, peer, 1), "3.3.3.3");
        assert_eq!(client_ip(&headers, peer, 2), "2.2.2.2");
        assert_eq!(client_ip(&headers, peer, 3), "1.1.1.1");
        assert_eq!(client_ip(&headers, peer, 9), "1.1.1.1");
        headers.insert("x-forwarded-for", HeaderValue::from_static("  9.9.9.9 "));
        assert_eq!(client_ip(&headers, peer, 1), "9.9.9.9");
        headers.insert("x-forwarded-for", HeaderValue::from_static("a,, ,b"));
        assert_eq!(client_ip(&headers, peer, 2), "a");
        headers.insert("x-forwarded-for", HeaderValue::from_static(""));
        assert_eq!(client_ip(&headers, peer, 1), "10.0.0.1");
        // Repeated headers are joined, as Node does.
        let mut repeated = HeaderMap::new();
        repeated.append("x-forwarded-for", HeaderValue::from_static("1.1.1.1"));
        repeated.append("x-forwarded-for", HeaderValue::from_static("2.2.2.2"));
        assert_eq!(client_ip(&repeated, peer, 1), "2.2.2.2");
        assert_eq!(client_ip(&repeated, None, 0), "127.0.0.1");
    }

    #[test]
    fn normalizes_addresses_like_fastify() {
        assert_eq!(normalize_ip("203.0.113.1"), "203.0.113.1");
        assert_eq!(normalize_ip("::ffff:203.0.113.1"), "203.0.113.1");
        assert_eq!(normalize_ip("2001:DB8:1:2:3:4:5:6"), "2001:db8:1:2::");
        assert_eq!(normalize_ip("::1"), "::");
        assert_eq!(normalize_ip("NotAnIP"), "notanip");
    }

    #[test]
    fn formats_durations_like_lukeed_ms() {
        assert_eq!(long_duration(60_000), "1 minute");
        assert_eq!(long_duration(59_000), "59 seconds");
        assert_eq!(long_duration(1_000), "1 second");
        assert_eq!(long_duration(90_000), "2 minutes");
        assert_eq!(long_duration(500), "500 ms");
    }
}
