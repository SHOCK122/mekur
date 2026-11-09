//! Validation issues shaped like Zod's.
//!
//! The API returns `{ error: "Invalid request", details: issues }` and the
//! web client formats `details` into user-visible messages, so the issue
//! shape is part of the HTTP API. Every issue serializes to the same JSON
//! object Zod 3.25 produces: the same `code`, `path`, `message` and the
//! same code-specific fields (`expected`/`received`, `minimum`, `type`,
//! `inclusive`, `exact`, `validation`, `options`). Only the order of keys
//! within an issue object may differ, which no JSON consumer observes.

use serde::ser::{Serialize, SerializeMap, Serializer};
use serde_json::Value;

/// One step of an issue's path: an object key or an array index.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PathSegment {
    Key(&'static str),
    Index(usize),
}

impl Serialize for PathSegment {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match self {
            PathSegment::Key(key) => s.serialize_str(key),
            PathSegment::Index(i) => s.serialize_u64(*i as u64),
        }
    }
}

/// What a length or size bound applies to (Zod's `type` field).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SizeType {
    String,
    Number,
    Array,
}

impl SizeType {
    fn as_str(self) -> &'static str {
        match self {
            SizeType::String => "string",
            SizeType::Number => "number",
            SizeType::Array => "array",
        }
    }
}

/// The code-specific part of an issue.
#[derive(Debug, Clone, PartialEq)]
pub enum IssueKind {
    /// `invalid_type`. `received` is Zod's parsed-type name
    /// (`"undefined"` for a missing key, `"float"` for a non-integer).
    InvalidType {
        expected: String,
        received: &'static str,
    },
    /// `invalid_literal`. `received` is the offending value itself, absent
    /// when the key was missing.
    InvalidLiteral {
        expected: Value,
        received: Option<Value>,
    },
    /// `invalid_enum_value`: a string outside the enum.
    InvalidEnumValue {
        options: &'static [&'static str],
        received: String,
    },
    /// `too_small`.
    TooSmall {
        minimum: i64,
        size: SizeType,
        inclusive: bool,
    },
    /// `too_big`.
    TooBig {
        maximum: i64,
        size: SizeType,
        inclusive: bool,
    },
    /// `invalid_string`, e.g. `validation: "datetime"`.
    InvalidString { validation: &'static str },
    /// `custom`: a refinement with its own message.
    Custom,
}

/// One validation failure.
#[derive(Debug, Clone, PartialEq)]
pub struct Issue {
    pub kind: IssueKind,
    pub path: Vec<PathSegment>,
    pub message: String,
}

impl Issue {
    /// Zod's `code` for this issue.
    pub fn code(&self) -> &'static str {
        match self.kind {
            IssueKind::InvalidType { .. } => "invalid_type",
            IssueKind::InvalidLiteral { .. } => "invalid_literal",
            IssueKind::InvalidEnumValue { .. } => "invalid_enum_value",
            IssueKind::TooSmall { .. } => "too_small",
            IssueKind::TooBig { .. } => "too_big",
            IssueKind::InvalidString { .. } => "invalid_string",
            IssueKind::Custom => "custom",
        }
    }
}

impl Serialize for Issue {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut map = s.serialize_map(None)?;
        map.serialize_entry("code", self.code())?;
        match &self.kind {
            IssueKind::InvalidType { expected, received } => {
                map.serialize_entry("expected", expected)?;
                map.serialize_entry("received", received)?;
            }
            IssueKind::InvalidLiteral { expected, received } => {
                map.serialize_entry("expected", expected)?;
                if let Some(received) = received {
                    map.serialize_entry("received", received)?;
                }
            }
            IssueKind::InvalidEnumValue { options, received } => {
                map.serialize_entry("options", options)?;
                map.serialize_entry("received", received)?;
            }
            IssueKind::TooSmall {
                minimum,
                size,
                inclusive,
            } => {
                map.serialize_entry("minimum", minimum)?;
                map.serialize_entry("type", size.as_str())?;
                map.serialize_entry("inclusive", inclusive)?;
                map.serialize_entry("exact", &false)?;
            }
            IssueKind::TooBig {
                maximum,
                size,
                inclusive,
            } => {
                map.serialize_entry("maximum", maximum)?;
                map.serialize_entry("type", size.as_str())?;
                map.serialize_entry("inclusive", inclusive)?;
                map.serialize_entry("exact", &false)?;
            }
            IssueKind::InvalidString { validation } => {
                map.serialize_entry("validation", validation)?;
            }
            IssueKind::Custom => {}
        }
        map.serialize_entry("path", &self.path)?;
        map.serialize_entry("message", &self.message)?;
        map.end()
    }
}

/// All issues found in one value, in the order Zod reports them.
#[derive(Debug, Clone, PartialEq)]
pub struct ValidationError {
    pub issues: Vec<Issue>,
}

impl std::fmt::Display for ValidationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let mut first = true;
        for issue in &self.issues {
            if !first {
                f.write_str("; ")?;
            }
            first = false;
            let mut path = String::new();
            for segment in &issue.path {
                if !path.is_empty() {
                    path.push('.');
                }
                match segment {
                    PathSegment::Key(k) => path.push_str(k),
                    PathSegment::Index(i) => path.push_str(&i.to_string()),
                }
            }
            if path.is_empty() {
                f.write_str(&issue.message)?;
            } else {
                write!(f, "{path}: {}", issue.message)?;
            }
        }
        Ok(())
    }
}

impl std::error::Error for ValidationError {}
