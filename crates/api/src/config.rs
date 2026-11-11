//! Server configuration from the environment -- the same variables, defaults
//! and production guards as `apps/api/src/config.ts`.

use thiserror::Error;

/// The development-only JWT secret. Refused when `NODE_ENV=production`.
pub const DEV_JWT_SECRET: &str = "dev-only-insecure-secret-do-not-use-in-production";
/// A real, valid VAPID keypair so local development works out of the box.
/// It is public in this repository's history, so it is refused in
/// production.
pub const DEV_VAPID_PUBLIC_KEY: &str =
    "BAHQnCgvhlb0-G5wOocrFTe7zK7ewUJ7AR7ZCYGA2rfaGlueYTazRM-fTiZUrkJUlM2SmKbdUALS1FzUnSiFbUI";
pub const DEV_VAPID_PRIVATE_KEY: &str = "qUFTF3lXxouxuo_n0kPvwpMn2Ehl3W51M8Aw3vap5QQ";
const DEV_VAPID_SUBJECT: &str = "mailto:dev-only@example.com";
const DEFAULT_DATABASE_URL: &str = "postgres://postgres:postgres@localhost:5432/scheduleapp";

/// The server's configuration. Deliberately not `Debug`: it holds the JWT
/// secret and the VAPID private key.
pub struct Config {
    pub port: u16,
    pub host: String,
    pub database_url: String,
    pub jwt_secret: String,
    pub node_env: String,
    /// Reverse-proxy hops to trust when deriving the client IP. Behind
    /// nginx (docker-compose) this must be 1, or every request appears to
    /// come from nginx and all users share one rate-limit bucket.
    pub trust_proxy: u32,
    pub vapid_public_key: String,
    pub vapid_private_key: String,
    pub vapid_subject: String,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ConfigError {
    #[error("JWT_SECRET must be set to a real secret in production (NODE_ENV=production)")]
    DevJwtSecretInProduction,
    #[error(
        "VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY must be set to a real, privately-generated keypair in \
         production (NODE_ENV=production) -- the built-in fallback is public in this repo's \
         history. Generate one with: npx web-push generate-vapid-keys"
    )]
    DevVapidKeyInProduction,
    #[error("TRUST_PROXY must be a whole number of proxy hops (e.g. 1 behind nginx), got \"{0}\"")]
    InvalidTrustProxy(String),
    #[error("PORT must be a port number (0-65535), got \"{0}\"")]
    InvalidPort(String),
}

impl Config {
    /// Reads the process environment.
    pub fn from_env() -> Result<Self, ConfigError> {
        // A variable that is set but not valid Unicode is treated as unset
        // rather than silently mangled.
        Self::from_lookup(|name| std::env::var(name).ok())
    }

    /// Reads configuration through `lookup`, so tests needn't touch the
    /// process environment. As with TypeScript's `??`, a variable set to
    /// the empty string counts as set.
    pub fn from_lookup(lookup: impl Fn(&str) -> Option<String>) -> Result<Self, ConfigError> {
        let or = |name: &str, fallback: &str| lookup(name).unwrap_or_else(|| fallback.to_owned());

        let port = match lookup("PORT") {
            None => 3000,
            Some(raw) => whole_number(&raw)
                .and_then(|n| u16::try_from(n).ok())
                .ok_or(ConfigError::InvalidPort(raw))?,
        };
        let trust_proxy = match lookup("TRUST_PROXY") {
            None => 0,
            Some(raw) => whole_number(&raw)
                .and_then(|n| u32::try_from(n).ok())
                .ok_or(ConfigError::InvalidTrustProxy(raw))?,
        };

        let config = Config {
            port,
            host: or("HOST", "0.0.0.0"),
            database_url: or("DATABASE_URL", DEFAULT_DATABASE_URL),
            jwt_secret: or("JWT_SECRET", DEV_JWT_SECRET),
            node_env: or("NODE_ENV", "development"),
            trust_proxy,
            vapid_public_key: or("VAPID_PUBLIC_KEY", DEV_VAPID_PUBLIC_KEY),
            vapid_private_key: or("VAPID_PRIVATE_KEY", DEV_VAPID_PRIVATE_KEY),
            vapid_subject: or("VAPID_SUBJECT", DEV_VAPID_SUBJECT),
        };

        if config.node_env == "production" {
            if config.jwt_secret.starts_with("dev-only-") {
                return Err(ConfigError::DevJwtSecretInProduction);
            }
            if config.vapid_private_key == DEV_VAPID_PRIVATE_KEY {
                return Err(ConfigError::DevVapidKeyInProduction);
            }
        }
        Ok(config)
    }
}

/// A non-negative whole number as `Number(raw)` reads one in decimal:
/// surrounding whitespace ignored, and an empty or all-whitespace value
/// is 0. (Hex, exponent and fractional spellings that `Number` would also
/// accept, such as `0x1` or `1e0`, are refused rather than reproduced.)
fn whole_number(raw: &str) -> Option<u64> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Some(0);
    }
    let digits = trimmed.strip_prefix('+').unwrap_or(trimmed);
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    digits.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn config(vars: &[(&str, &str)]) -> Result<Config, ConfigError> {
        let vars: HashMap<String, String> = vars
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect();
        Config::from_lookup(|name| vars.get(name).cloned())
    }

    #[test]
    fn defaults_match_the_typescript_server() {
        let c = config(&[]).unwrap();
        assert_eq!(c.port, 3000);
        assert_eq!(c.host, "0.0.0.0");
        assert_eq!(c.database_url, DEFAULT_DATABASE_URL);
        assert_eq!(c.jwt_secret, DEV_JWT_SECRET);
        assert_eq!(c.node_env, "development");
        assert_eq!(c.trust_proxy, 0);
        assert_eq!(c.vapid_public_key, DEV_VAPID_PUBLIC_KEY);
        assert_eq!(c.vapid_private_key, DEV_VAPID_PRIVATE_KEY);
        assert_eq!(c.vapid_subject, DEV_VAPID_SUBJECT);
    }

    #[test]
    fn reads_every_variable() {
        let c = config(&[
            ("PORT", "8080"),
            ("HOST", "127.0.0.1"),
            ("DATABASE_URL", "postgres://x@db/y"),
            ("JWT_SECRET", "s"),
            ("NODE_ENV", "test"),
            ("TRUST_PROXY", "1"),
            ("VAPID_PUBLIC_KEY", "pub"),
            ("VAPID_PRIVATE_KEY", "priv"),
            ("VAPID_SUBJECT", "mailto:a@b.c"),
        ])
        .unwrap();
        assert_eq!(
            (
                c.port,
                c.host.as_str(),
                c.database_url.as_str(),
                c.jwt_secret.as_str()
            ),
            (8080, "127.0.0.1", "postgres://x@db/y", "s")
        );
        assert_eq!((c.node_env.as_str(), c.trust_proxy), ("test", 1));
        assert_eq!(
            (
                c.vapid_public_key.as_str(),
                c.vapid_private_key.as_str(),
                c.vapid_subject.as_str()
            ),
            ("pub", "priv", "mailto:a@b.c")
        );
    }

    #[test]
    fn refuses_the_dev_jwt_secret_in_production() {
        let err = config(&[("NODE_ENV", "production"), ("VAPID_PRIVATE_KEY", "real")]);
        assert_eq!(err.err(), Some(ConfigError::DevJwtSecretInProduction));
        // Anything that merely looks like the fallback is refused too.
        let err = config(&[
            ("NODE_ENV", "production"),
            ("JWT_SECRET", "dev-only-something"),
            ("VAPID_PRIVATE_KEY", "real"),
        ]);
        assert_eq!(err.err(), Some(ConfigError::DevJwtSecretInProduction));
    }

    #[test]
    fn refuses_the_public_vapid_key_in_production() {
        let err = config(&[("NODE_ENV", "production"), ("JWT_SECRET", "real")]);
        assert_eq!(err.err(), Some(ConfigError::DevVapidKeyInProduction));
    }

    #[test]
    fn accepts_real_secrets_in_production_and_dev_secrets_elsewhere() {
        let c = config(&[
            ("NODE_ENV", "production"),
            ("JWT_SECRET", "real"),
            ("VAPID_PRIVATE_KEY", "real"),
        ]);
        assert!(c.is_ok());
        assert!(config(&[("NODE_ENV", "staging")]).is_ok());
    }

    #[test]
    fn trust_proxy_must_be_a_whole_number_of_hops() {
        for ok in [
            ("0", 0),
            ("1", 1),
            (" 2 ", 2),
            ("+3", 3),
            ("", 0),
            ("  ", 0),
        ] {
            assert_eq!(
                config(&[("TRUST_PROXY", ok.0)]).unwrap().trust_proxy,
                ok.1,
                "{ok:?}"
            );
        }
        for bad in ["-1", "1.5", "one", "true", "1 2"] {
            assert_eq!(
                config(&[("TRUST_PROXY", bad)]).err(),
                Some(ConfigError::InvalidTrustProxy(bad.to_owned())),
                "{bad}"
            );
        }
        assert_eq!(
            ConfigError::InvalidTrustProxy("x".into()).to_string(),
            "TRUST_PROXY must be a whole number of proxy hops (e.g. 1 behind nginx), got \"x\""
        );
    }

    #[test]
    fn port_must_be_a_port_number() {
        assert_eq!(config(&[("PORT", "0")]).unwrap().port, 0);
        assert_eq!(config(&[("PORT", "65535")]).unwrap().port, 65535);
        for bad in ["65536", "-1", "http", "3000.5"] {
            assert_eq!(
                config(&[("PORT", bad)]).err(),
                Some(ConfigError::InvalidPort(bad.to_owned())),
                "{bad}"
            );
        }
    }
}
