//! The parsing primitives the schemas are built from, following Zod 3's
//! semantics exactly, because they decide which issues are reported:
//!
//! - A wrong type (or a wrong literal / enum value) *aborts* that value:
//!   it has no parsed value, and an object or array containing it aborts
//!   too, so refinements over the container do not run.
//! - A failed check (length, range, integer, datetime) or refinement only
//!   makes the value *dirty*: it keeps its value, every other check still
//!   runs, and refinements over the container still see it.
//!
//! A parse function returns `None` when aborted and `Some(value)` otherwise
//! (dirty or clean); whether anything went wrong is whether issues were
//! recorded. Missing keys are `None` inputs (Zod's `undefined`); unknown
//! keys are ignored (Zod strips them).

use serde_json::{Map, Value};

use crate::datetime::is_zod_datetime;
use crate::issue::{Issue, IssueKind, PathSegment, SizeType, ValidationError};

/// Collects issues while a value is parsed.
#[derive(Debug, Default)]
pub(crate) struct Ctx {
    path: Vec<PathSegment>,
    pub(crate) issues: Vec<Issue>,
}

impl Ctx {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// Runs `f` one level deeper in the path.
    pub(crate) fn at<R>(&mut self, segment: PathSegment, f: impl FnOnce(&mut Ctx) -> R) -> R {
        self.path.push(segment);
        let out = f(self);
        self.path.pop();
        out
    }

    pub(crate) fn add(&mut self, kind: IssueKind, message: impl Into<String>) {
        self.add_at(&[], kind, message);
    }

    /// Adds an issue at `extra` below the current path (a refinement's
    /// `path` option).
    pub(crate) fn add_at(
        &mut self,
        extra: &[PathSegment],
        kind: IssueKind,
        message: impl Into<String>,
    ) {
        let mut path = self.path.clone();
        path.extend_from_slice(extra);
        self.issues.push(Issue {
            kind,
            path,
            message: message.into(),
        });
    }

    pub(crate) fn custom(&mut self, message: impl Into<String>) {
        self.add(IssueKind::Custom, message);
    }

    pub(crate) fn invalid_type(&mut self, expected: impl Into<String>, input: Option<&Value>) {
        let expected = expected.into();
        let received = parsed_type(input);
        let message = if input.is_none() {
            "Required".to_owned()
        } else {
            format!("Expected {expected}, received {received}")
        };
        self.add(IssueKind::InvalidType { expected, received }, message);
    }
}

/// The result of a top-level parse: the value if nothing was reported.
pub(crate) fn finish<T>(ctx: Ctx, value: Option<T>) -> Result<T, ValidationError> {
    match value {
        Some(v) if ctx.issues.is_empty() => Ok(v),
        _ => Err(ValidationError { issues: ctx.issues }),
    }
}

/// Zod's name for the type of a JSON value (`getParsedType`).
fn parsed_type(input: Option<&Value>) -> &'static str {
    match input {
        None => "undefined",
        Some(Value::Null) => "null",
        Some(Value::Bool(_)) => "boolean",
        Some(Value::Number(_)) => "number",
        Some(Value::String(_)) => "string",
        Some(Value::Array(_)) => "array",
        Some(Value::Object(_)) => "object",
    }
}

/// A JSON value as JavaScript would print it back: numbers that are
/// integers lose any `.0`, so an echoed `received` matches Zod's output.
pub(crate) fn as_js_json(value: &Value) -> Value {
    match value {
        Value::Number(n) => match n.as_f64() {
            Some(f) if n.is_f64() && f.fract() == 0.0 && f.abs() < 9_007_199_254_740_992.0 => {
                Value::from(f as i64)
            }
            _ => value.clone(),
        },
        Value::Array(items) => Value::Array(items.iter().map(as_js_json).collect()),
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(k, v)| (k.clone(), as_js_json(v)))
                .collect(),
        ),
        other => other.clone(),
    }
}

/// `z.object(...)`: the input must be an object.
pub(crate) fn object<'a>(
    ctx: &mut Ctx,
    input: Option<&'a Value>,
) -> Option<&'a Map<String, Value>> {
    match input {
        Some(Value::Object(map)) => Some(map),
        other => {
            ctx.invalid_type("object", other);
            None
        }
    }
}

/// Parses `obj[key]` one level down the path.
pub(crate) fn field<R>(
    ctx: &mut Ctx,
    obj: &Map<String, Value>,
    key: &'static str,
    f: impl FnOnce(&mut Ctx, Option<&Value>) -> R,
) -> R {
    ctx.at(PathSegment::Key(key), |ctx| f(ctx, obj.get(key)))
}

/// `.optional()`: a missing key is fine (`Some(None)`); anything else is
/// parsed by `f`. JSON `null` is not missing: it is a wrong type.
pub(crate) fn optional<T>(
    ctx: &mut Ctx,
    input: Option<&Value>,
    f: impl FnOnce(&mut Ctx, Option<&Value>) -> Option<T>,
) -> Option<Option<T>> {
    match input {
        None => Some(None),
        some => f(ctx, some).map(Some),
    }
}

/// Checks on a string, in the order the schema declares them.
#[derive(Debug, Default, Clone, Copy)]
pub(crate) struct StrChecks {
    pub min: Option<usize>,
    pub max: Option<usize>,
    pub datetime: bool,
}

impl StrChecks {
    /// `.datetime()`
    pub const DATETIME: Self = Self {
        min: None,
        max: None,
        datetime: true,
    };

    /// `.min(min).max(max)`
    pub const fn between(min: usize, max: usize) -> Self {
        Self {
            min: Some(min),
            max: Some(max),
            datetime: false,
        }
    }

    /// `.min(min)`
    pub const fn at_least(min: usize) -> Self {
        Self {
            min: Some(min),
            max: None,
            datetime: false,
        }
    }

    /// `.max(max)`
    pub const fn at_most(max: usize) -> Self {
        Self {
            min: None,
            max: Some(max),
            datetime: false,
        }
    }
}

/// `z.string()` with its checks. Lengths count UTF-16 code units, as
/// JavaScript's `length` does.
pub(crate) fn string(ctx: &mut Ctx, input: Option<&Value>, checks: StrChecks) -> Option<String> {
    let Some(Value::String(s)) = input else {
        ctx.invalid_type("string", input);
        return None;
    };
    let len = s.encode_utf16().count();
    if let Some(min) = checks.min
        && len < min
    {
        ctx.add(
            IssueKind::TooSmall {
                minimum: min as i64,
                size: SizeType::String,
                inclusive: true,
            },
            format!("String must contain at least {min} character(s)"),
        );
    }
    if let Some(max) = checks.max
        && len > max
    {
        ctx.add(
            IssueKind::TooBig {
                maximum: max as i64,
                size: SizeType::String,
                inclusive: true,
            },
            format!("String must contain at most {max} character(s)"),
        );
    }
    if checks.datetime && !is_zod_datetime(s) {
        ctx.add(
            IssueKind::InvalidString {
                validation: "datetime",
            },
            "Invalid datetime",
        );
    }
    Some(s.clone())
}

/// One check on a number.
#[derive(Debug, Clone, Copy)]
pub(crate) enum NumCheck {
    Int,
    /// `.min(n)` (inclusive) or `.positive()` (`Min(0, false)`).
    Min(i64, bool),
    Max(i64, bool),
}

/// `z.number()` with its checks, in declaration order. The value stays an
/// `f64`, as in JavaScript, so refinements over dirty values (`1.5`, `0`)
/// behave as Zod's do; callers convert once everything has passed.
pub(crate) fn number(ctx: &mut Ctx, input: Option<&Value>, checks: &[NumCheck]) -> Option<f64> {
    let Some(n) = input.and_then(Value::as_f64) else {
        ctx.invalid_type("number", input);
        return None;
    };
    for check in checks {
        match *check {
            NumCheck::Int => {
                if n.fract() != 0.0 || !n.is_finite() {
                    ctx.add(
                        IssueKind::InvalidType {
                            expected: "integer".to_owned(),
                            received: "float",
                        },
                        "Expected integer, received float",
                    );
                }
            }
            NumCheck::Min(min, inclusive) => {
                let ok = if inclusive {
                    n >= min as f64
                } else {
                    n > min as f64
                };
                if !ok {
                    let message = if inclusive {
                        format!("Number must be greater than or equal to {min}")
                    } else {
                        format!("Number must be greater than {min}")
                    };
                    ctx.add(
                        IssueKind::TooSmall {
                            minimum: min,
                            size: SizeType::Number,
                            inclusive,
                        },
                        message,
                    );
                }
            }
            NumCheck::Max(max, inclusive) => {
                let ok = if inclusive {
                    n <= max as f64
                } else {
                    n < max as f64
                };
                if !ok {
                    let message = if inclusive {
                        format!("Number must be less than or equal to {max}")
                    } else {
                        format!("Number must be less than {max}")
                    };
                    ctx.add(
                        IssueKind::TooBig {
                            maximum: max,
                            size: SizeType::Number,
                            inclusive,
                        },
                        message,
                    );
                }
            }
        }
    }
    Some(n)
}

/// `z.boolean()`.
pub(crate) fn boolean(ctx: &mut Ctx, input: Option<&Value>) -> Option<bool> {
    match input {
        Some(Value::Bool(b)) => Some(*b),
        other => {
            ctx.invalid_type("boolean", other);
            None
        }
    }
}

/// `z.literal(expected)`. Compared as JavaScript's `===` would: `1.0`
/// equals `1`.
pub(crate) fn literal(ctx: &mut Ctx, input: Option<&Value>, expected: &Value) -> Option<()> {
    let equal = match (input, expected) {
        (Some(Value::Number(a)), Value::Number(b)) => a.as_f64() == b.as_f64(),
        (Some(a), b) => a == b,
        (None, _) => false,
    };
    if equal {
        return Some(());
    }
    let shown = serde_json::to_string(expected).unwrap_or_default();
    ctx.add(
        IssueKind::InvalidLiteral {
            expected: expected.clone(),
            received: input.map(as_js_json),
        },
        format!("Invalid literal value, expected {shown}"),
    );
    None
}

/// `z.enum(options)`. Returns the index of the matching option.
pub(crate) fn enumeration(
    ctx: &mut Ctx,
    input: Option<&Value>,
    options: &'static [&'static str],
) -> Option<usize> {
    // Only needed for an issue, so only built then.
    let joined = || {
        options
            .iter()
            .map(|o| format!("'{o}'"))
            .collect::<Vec<_>>()
            .join(" | ")
    };
    let Some(Value::String(s)) = input else {
        ctx.invalid_type(joined(), input);
        return None;
    };
    if let Some(i) = options.iter().position(|o| o == s) {
        return Some(i);
    }
    ctx.add(
        IssueKind::InvalidEnumValue {
            options,
            received: s.clone(),
        },
        format!("Invalid enum value. Expected {}, received '{s}'", joined()),
    );
    None
}

/// `z.array(item)` with optional `.min()` / `.max()` lengths. Every item
/// is parsed even when the length is wrong; the array aborts if any item
/// does.
pub(crate) fn array<T>(
    ctx: &mut Ctx,
    input: Option<&Value>,
    min: Option<usize>,
    max: Option<usize>,
    mut item: impl FnMut(&mut Ctx, Option<&Value>) -> Option<T>,
) -> Option<Vec<T>> {
    let Some(Value::Array(items)) = input else {
        ctx.invalid_type("array", input);
        return None;
    };
    if let Some(min) = min
        && items.len() < min
    {
        ctx.add(
            IssueKind::TooSmall {
                minimum: min as i64,
                size: SizeType::Array,
                inclusive: true,
            },
            format!("Array must contain at least {min} element(s)"),
        );
    }
    if let Some(max) = max
        && items.len() > max
    {
        ctx.add(
            IssueKind::TooBig {
                maximum: max as i64,
                size: SizeType::Array,
                inclusive: true,
            },
            format!("Array must contain at most {max} element(s)"),
        );
    }
    let mut out = Vec::with_capacity(items.len());
    let mut aborted = false;
    for (i, value) in items.iter().enumerate() {
        match ctx.at(PathSegment::Index(i), |ctx| item(ctx, Some(value))) {
            Some(v) => out.push(v),
            None => aborted = true,
        }
    }
    (!aborted).then_some(out)
}
