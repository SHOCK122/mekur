//! The plaintext shape of an event (`EventContentSchema`), as it exists
//! only on the client after decryption. This is what gets encrypted into
//! an envelope before ever touching the network; the server never sees it.

use std::collections::HashSet;

use serde::Serialize;
use serde_json::Value;

use crate::datetime::instant_millis;
use crate::issue::{IssueKind, PathSegment, ValidationError};
use crate::recurrence::{RecurrenceRule, RuleDraft};
use crate::zod::{self, Ctx, StrChecks, finish};

/// Most occurrences one series can have moved. Overrides are rendered on
/// every pan frame, so the list is bounded rather than left to the
/// ciphertext cap.
pub const MAX_OCCURRENCE_OVERRIDES: usize = 200;

/// One occurrence of a series moved to other times (iCalendar
/// RECURRENCE-ID). `occurrence` is the start the series rule gives it;
/// `start_time`/`end_time` are where it actually takes place. No end makes
/// it open-ended.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OccurrenceOverride {
    pub occurrence: String,
    pub start_time: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_time: Option<String>,
}

/// Decrypted event content. Serializes to the same JSON the TypeScript
/// schema's output has (absent fields omitted).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventContent {
    /// 1-500 chars.
    pub title: String,
    /// Up to 10,000 chars.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Up to 500 chars.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub location: Option<String>,
    pub start_time: String,
    /// Strictly after `start_time` when present; absent = open-ended.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_time: Option<String>,
    /// Fractional ordering rank (stacking order on the timeline).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rank: Option<String>,
    /// Styling only, never position.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub important: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recurrence: Option<RecurrenceRule>,
    /// Skipped occurrences by their start (iCalendar EXDATE).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skipped_occurrences: Option<Vec<String>>,
    /// Moved occurrences; at most [`MAX_OCCURRENCE_OVERRIDES`], each
    /// occurrence at most once.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub occurrence_overrides: Option<Vec<OccurrenceOverride>>,
}

/// `endTime > startTime` as JavaScript compares two `Date`s: false when
/// either is an invalid date.
fn ends_after_start(start: &str, end: &str) -> bool {
    matches!((instant_millis(start), instant_millis(end)), (Some(s), Some(e)) if e > s)
}

/// The shared refinement on events and overrides.
fn check_end(ctx: &mut Ctx, start: &str, end: Option<&str>) {
    if let Some(end) = end
        && !ends_after_start(start, end)
    {
        ctx.add_at(
            &[PathSegment::Key("endTime")],
            IssueKind::Custom,
            "endTime must be after startTime",
        );
    }
}

impl OccurrenceOverride {
    fn parse_in(ctx: &mut Ctx, input: Option<&Value>) -> Option<Self> {
        let obj = zod::object(ctx, input)?;
        let occurrence = zod::field(ctx, obj, "occurrence", |ctx, v| {
            zod::string(ctx, v, StrChecks::DATETIME)
        });
        let start_time = zod::field(ctx, obj, "startTime", |ctx, v| {
            zod::string(ctx, v, StrChecks::DATETIME)
        });
        let end_time = zod::field(ctx, obj, "endTime", |ctx, v| {
            zod::optional(ctx, v, |ctx, v| zod::string(ctx, v, StrChecks::DATETIME))
        });
        let out = Self {
            occurrence: occurrence?,
            start_time: start_time?,
            end_time: end_time?,
        };
        check_end(ctx, &out.start_time, out.end_time.as_deref());
        Some(out)
    }
}

/// The overrides list and its refinement: each occurrence (compared by
/// instant, as expansion does) moved at most once. Like JavaScript's
/// `Set`, every invalid date counts as the same value.
fn parse_overrides(ctx: &mut Ctx, input: Option<&Value>) -> Option<Vec<OccurrenceOverride>> {
    let list = zod::array(
        ctx,
        input,
        None,
        Some(MAX_OCCURRENCE_OVERRIDES),
        OccurrenceOverride::parse_in,
    )?;
    let distinct: HashSet<Option<i64>> =
        list.iter().map(|o| instant_millis(&o.occurrence)).collect();
    if distinct.len() != list.len() {
        ctx.custom("an occurrence can only be moved once");
    }
    Some(list)
}

impl EventContent {
    /// Validates a JSON value. Unknown keys are ignored.
    pub fn parse(value: &Value) -> Result<Self, ValidationError> {
        let mut ctx = Ctx::new();
        let out = Self::parse_in(&mut ctx, Some(value));
        finish(ctx, out).map(|(event, rule)| Self {
            recurrence: rule.map(RuleDraft::finish),
            ..event
        })
    }

    fn parse_in(ctx: &mut Ctx, input: Option<&Value>) -> Option<(Self, Option<RuleDraft>)> {
        let obj = zod::object(ctx, input)?;
        let title = zod::field(ctx, obj, "title", |ctx, v| {
            zod::string(ctx, v, StrChecks::between(1, 500))
        });
        let description = zod::field(ctx, obj, "description", |ctx, v| {
            zod::optional(ctx, v, |ctx, v| {
                zod::string(ctx, v, StrChecks::at_most(10_000))
            })
        });
        let location = zod::field(ctx, obj, "location", |ctx, v| {
            zod::optional(ctx, v, |ctx, v| {
                zod::string(ctx, v, StrChecks::at_most(500))
            })
        });
        let start_time = zod::field(ctx, obj, "startTime", |ctx, v| {
            zod::string(ctx, v, StrChecks::DATETIME)
        });
        let end_time = zod::field(ctx, obj, "endTime", |ctx, v| {
            zod::optional(ctx, v, |ctx, v| zod::string(ctx, v, StrChecks::DATETIME))
        });
        let rank = zod::field(ctx, obj, "rank", |ctx, v| {
            zod::optional(ctx, v, |ctx, v| zod::string(ctx, v, StrChecks::at_least(1)))
        });
        let important = zod::field(ctx, obj, "important", |ctx, v| {
            zod::optional(ctx, v, zod::boolean)
        });
        let recurrence = zod::field(ctx, obj, "recurrence", |ctx, v| {
            zod::optional(ctx, v, RuleDraft::parse_in)
        });
        let skipped = zod::field(ctx, obj, "skippedOccurrences", |ctx, v| {
            zod::optional(ctx, v, |ctx, v| {
                zod::array(ctx, v, None, None, |ctx, v| {
                    zod::string(ctx, v, StrChecks::DATETIME)
                })
            })
        });
        let overrides = zod::field(ctx, obj, "occurrenceOverrides", |ctx, v| {
            zod::optional(ctx, v, parse_overrides)
        });

        let event = Self {
            title: title?,
            description: description?,
            location: location?,
            start_time: start_time?,
            end_time: end_time?,
            rank: rank?,
            important: important?,
            recurrence: None,
            skipped_occurrences: skipped?,
            occurrence_overrides: overrides?,
        };
        let rule = recurrence?;
        check_end(ctx, &event.start_time, event.end_time.as_deref());
        Some((event, rule))
    }
}
