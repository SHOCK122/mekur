//! Recurrence rules: an iCalendar RRULE subset
//! (FREQ/INTERVAL/BYDAY/BYMONTHDAY/BYMONTH/BYSETPOS/COUNT/UNTIL/TZID).
//! Mirrors `RecurrenceRuleSchema`. Expansion into occurrences happens
//! client-side; the server never interprets a rule -- it is just more
//! content inside an encrypted envelope.

use serde::Serialize;
use serde_json::Value;

use crate::issue::{IssueKind, PathSegment, ValidationError};
use crate::time_zone::is_valid_time_zone;
use crate::zod::{self, Ctx, NumCheck, StrChecks, finish};

/// How often a rule repeats (FREQ).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum RecurrenceFrequency {
    Minutely,
    Hourly,
    Daily,
    Weekly,
    Monthly,
    Yearly,
}

impl RecurrenceFrequency {
    /// Every variant with its wire name: the one table both parsing and
    /// serializing use. `NAMES` repeats the names for Zod's `options`; a
    /// test checks the two agree.
    const TABLE: [(&'static str, Self); 6] = [
        ("MINUTELY", Self::Minutely),
        ("HOURLY", Self::Hourly),
        ("DAILY", Self::Daily),
        ("WEEKLY", Self::Weekly),
        ("MONTHLY", Self::Monthly),
        ("YEARLY", Self::Yearly),
    ];
    const NAMES: &'static [&'static str] =
        &["MINUTELY", "HOURLY", "DAILY", "WEEKLY", "MONTHLY", "YEARLY"];

    /// The iCalendar FREQ name, e.g. `"MONTHLY"`.
    pub fn as_str(self) -> &'static str {
        Self::TABLE[self as usize].0
    }

    /// Monthly and yearly rules: the only ones that take the calendar
    /// parts (`by_month_day`, `by_month`, `by_set_pos`).
    pub fn is_calendar(self) -> bool {
        matches!(self, Self::Monthly | Self::Yearly)
    }
}

/// A day of the week (BYDAY), iCalendar's two-letter names.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Weekday {
    Monday,
    Tuesday,
    Wednesday,
    Thursday,
    Friday,
    Saturday,
    Sunday,
}

impl Weekday {
    /// Every variant with its wire name; see `RecurrenceFrequency::TABLE`.
    const TABLE: [(&'static str, Self); 7] = [
        ("MO", Self::Monday),
        ("TU", Self::Tuesday),
        ("WE", Self::Wednesday),
        ("TH", Self::Thursday),
        ("FR", Self::Friday),
        ("SA", Self::Saturday),
        ("SU", Self::Sunday),
    ];
    const NAMES: &'static [&'static str] = &["MO", "TU", "WE", "TH", "FR", "SA", "SU"];

    /// The iCalendar two-letter name, e.g. `"MO"`.
    pub fn as_str(self) -> &'static str {
        Self::TABLE[self as usize].0
    }
}

impl Serialize for RecurrenceFrequency {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(self.as_str())
    }
}

impl Serialize for Weekday {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(self.as_str())
    }
}

/// A validated recurrence rule. Serializes to the same JSON the TypeScript
/// schema's output has (absent parts omitted, `interval` always present).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecurrenceRule {
    pub freq: RecurrenceFrequency,
    /// Every `interval` periods; defaults to 1 when absent.
    pub interval: u64,
    /// At most 7 entries.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub by_day: Option<Vec<Weekday>>,
    /// Days of the month, -31..=31 except 0 (negative counts from the
    /// end). 1-31 entries. Monthly and yearly rules only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub by_month_day: Option<Vec<i8>>,
    /// Months, 1 = January. 1-12 entries. Monthly and yearly rules only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub by_month: Option<Vec<u8>>,
    /// Which matching days of each period to keep, -366..=366 except 0.
    /// 1-10 entries. Monthly and yearly rules only, with `by_day` or
    /// `by_month_day`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub by_set_pos: Option<Vec<i16>>,
    /// IANA zone the rule is evaluated in; UTC when absent.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tzid: Option<String>,
    /// Stop after this many occurrences.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub count: Option<u64>,
    /// Stop after this instant (Zod datetime format).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub until: Option<String>,
}

/// Longest each month can be, leap years included (index 0 = January).
const MAX_DAYS_IN_MONTH: [f64; 12] = [
    31.0, 29.0, 31.0, 30.0, 31.0, 30.0, 31.0, 31.0, 30.0, 31.0, 30.0, 31.0,
];

/// A rule as parsed, numbers still `f64` (possibly dirty: `1.5`, `0`,
/// out of range), so the cross-field checks see exactly what Zod's
/// `superRefine` sees.
#[derive(Debug, Clone)]
pub(crate) struct RuleDraft {
    freq: RecurrenceFrequency,
    interval: f64,
    by_day: Option<Vec<Weekday>>,
    by_month_day: Option<Vec<f64>>,
    by_month: Option<Vec<f64>>,
    by_set_pos: Option<Vec<f64>>,
    tzid: Option<String>,
    count: Option<f64>,
    until: Option<String>,
}

/// A positive integer that also fits `u64`. Zod accepts any JavaScript
/// integer; values past `u64::MAX` (~1.8e19) are a documented divergence.
fn positive_int(ctx: &mut Ctx, v: Option<&Value>) -> Option<f64> {
    let n = zod::number(ctx, v, &[NumCheck::Int, NumCheck::Min(0, false)])?;
    if n >= 18_446_744_073_709_551_616.0 {
        ctx.custom("too large");
    }
    Some(n)
}

fn non_zero_int(ctx: &mut Ctx, v: Option<&Value>, min: i64, max: i64) -> Option<f64> {
    let n = zod::number(
        ctx,
        v,
        &[
            NumCheck::Int,
            NumCheck::Min(min, true),
            NumCheck::Max(max, true),
        ],
    )?;
    if n == 0.0 {
        ctx.custom("must not be 0");
    }
    Some(n)
}

impl RuleDraft {
    pub(crate) fn parse_in(ctx: &mut Ctx, input: Option<&Value>) -> Option<Self> {
        let obj = zod::object(ctx, input)?;
        let freq = zod::field(ctx, obj, "freq", |ctx, v| {
            zod::enumeration(ctx, v, RecurrenceFrequency::NAMES)
                .map(|i| RecurrenceFrequency::TABLE[i].1)
        });
        let interval = zod::field(ctx, obj, "interval", |ctx, v| match v {
            None => Some(1.0),
            some => positive_int(ctx, some),
        });
        let by_day = zod::field(ctx, obj, "byDay", |ctx, v| {
            zod::optional(ctx, v, |ctx, v| {
                zod::array(ctx, v, None, Some(7), |ctx, v| {
                    zod::enumeration(ctx, v, Weekday::NAMES).map(|i| Weekday::TABLE[i].1)
                })
            })
        });
        let by_month_day = zod::field(ctx, obj, "byMonthDay", |ctx, v| {
            zod::optional(ctx, v, |ctx, v| {
                zod::array(ctx, v, Some(1), Some(31), |ctx, v| {
                    non_zero_int(ctx, v, -31, 31)
                })
            })
        });
        let by_month = zod::field(ctx, obj, "byMonth", |ctx, v| {
            zod::optional(ctx, v, |ctx, v| {
                zod::array(ctx, v, Some(1), Some(12), |ctx, v| {
                    zod::number(
                        ctx,
                        v,
                        &[
                            NumCheck::Int,
                            NumCheck::Min(1, true),
                            NumCheck::Max(12, true),
                        ],
                    )
                })
            })
        });
        let by_set_pos = zod::field(ctx, obj, "bySetPos", |ctx, v| {
            zod::optional(ctx, v, |ctx, v| {
                zod::array(ctx, v, Some(1), Some(10), |ctx, v| {
                    non_zero_int(ctx, v, -366, 366)
                })
            })
        });
        let tzid = zod::field(ctx, obj, "tzid", |ctx, v| {
            zod::optional(ctx, v, |ctx, v| {
                let s = zod::string(ctx, v, StrChecks::between(1, 64))?;
                if !is_valid_time_zone(&s) {
                    ctx.custom("unknown time zone");
                }
                Some(s)
            })
        });
        let count = zod::field(ctx, obj, "count", |ctx, v| {
            zod::optional(ctx, v, positive_int)
        });
        let until = zod::field(ctx, obj, "until", |ctx, v| {
            zod::optional(ctx, v, |ctx, v| zod::string(ctx, v, StrChecks::DATETIME))
        });

        let rule = RuleDraft {
            freq: freq?,
            interval: interval?,
            by_day: by_day?,
            by_month_day: by_month_day?,
            by_month: by_month?,
            by_set_pos: by_set_pos?,
            tzid: tzid?,
            count: count?,
            until: until?,
        };
        rule.check(ctx);
        Some(rule)
    }

    /// The schema's `superRefine`: cross-field rules.
    fn check(&self, ctx: &mut Ctx) {
        let calendar = self.freq.is_calendar();
        for (name, present) in [
            ("byMonthDay", self.by_month_day.is_some()),
            ("byMonth", self.by_month.is_some()),
            ("bySetPos", self.by_set_pos.is_some()),
        ] {
            if present && !calendar {
                ctx.add_at(
                    &[PathSegment::Key(name)],
                    IssueKind::Custom,
                    format!("{name} needs a monthly or yearly rule"),
                );
            }
        }
        if self.by_set_pos.is_some() && self.by_day.is_none() && self.by_month_day.is_none() {
            ctx.add_at(
                &[PathSegment::Key("bySetPos")],
                IssueKind::Custom,
                "bySetPos needs byDay or byMonthDay",
            );
        }
        // Positions past the most days one month (or year) can offer would
        // never occur: there is no sixth Monday. (An upper bound -- byDay
        // can narrow byMonthDay further -- so expansion still guards the
        // rest.)
        if let Some(positions) = &self.by_set_pos {
            let months = match &self.by_month {
                Some(m) => m.len() as f64,
                None if self.freq == RecurrenceFrequency::Yearly => 12.0,
                None => 1.0,
            };
            let per_month = match (&self.by_month_day, &self.by_day) {
                (Some(days), _) => days.len() as f64,
                (None, by_day) => 5.0 * by_day.as_ref().map_or(0, Vec::len) as f64,
            };
            for (i, pos) in positions.iter().enumerate() {
                if pos.abs() > months * per_month {
                    ctx.add_at(
                        &[PathSegment::Key("bySetPos"), PathSegment::Index(i)],
                        IssueKind::Custom,
                        "there are never that many matching days",
                    );
                }
            }
        }
        // A day no allowed month has (February 30th) would never occur, and
        // expanding a rule that never matches walks to the year 9999.
        if let Some(days) = &self.by_month_day {
            // As in JavaScript: an out-of-range month counts as 31 days, and
            // the longest of no months at all is -Infinity.
            let longest = match &self.by_month {
                Some(months) => months
                    .iter()
                    .map(|&m| {
                        if m.fract() == 0.0 && (1.0..=12.0).contains(&m) {
                            MAX_DAYS_IN_MONTH[m as usize - 1]
                        } else {
                            31.0
                        }
                    })
                    .fold(f64::NEG_INFINITY, f64::max),
                None => 31.0,
            };
            for (i, day) in days.iter().enumerate() {
                if day.abs() > longest {
                    ctx.add_at(
                        &[PathSegment::Key("byMonthDay"), PathSegment::Index(i)],
                        IssueKind::Custom,
                        "that day never occurs in these months",
                    );
                }
            }
        }
    }

    /// The typed rule. Only called once parsing recorded no issues, so
    /// every number is an in-range integer.
    pub(crate) fn finish(self) -> RecurrenceRule {
        let ints =
            |v: Option<Vec<f64>>| v.map(|v| v.into_iter().map(|n| n as i64).collect::<Vec<_>>());
        RecurrenceRule {
            freq: self.freq,
            interval: self.interval as u64,
            by_day: self.by_day,
            by_month_day: ints(self.by_month_day).map(|v| v.into_iter().map(|n| n as i8).collect()),
            by_month: ints(self.by_month).map(|v| v.into_iter().map(|n| n as u8).collect()),
            by_set_pos: ints(self.by_set_pos).map(|v| v.into_iter().map(|n| n as i16).collect()),
            tzid: self.tzid,
            count: self.count.map(|n| n as u64),
            until: self.until,
        }
    }
}

impl RecurrenceRule {
    /// Validates a JSON value. Unknown keys are ignored; a missing
    /// `interval` becomes 1.
    pub fn parse(value: &Value) -> Result<Self, ValidationError> {
        let mut ctx = Ctx::new();
        let out = RuleDraft::parse_in(&mut ctx, Some(value));
        finish(ctx, out).map(RuleDraft::finish)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn name_tables_agree_and_follow_declaration_order() {
        for (i, (name, variant)) in RecurrenceFrequency::TABLE.iter().enumerate() {
            assert_eq!(RecurrenceFrequency::NAMES[i], *name);
            assert_eq!(*variant as usize, i);
        }
        assert_eq!(
            RecurrenceFrequency::NAMES.len(),
            RecurrenceFrequency::TABLE.len()
        );
        for (i, (name, variant)) in Weekday::TABLE.iter().enumerate() {
            assert_eq!(Weekday::NAMES[i], *name);
            assert_eq!(*variant as usize, i);
        }
        assert_eq!(Weekday::NAMES.len(), Weekday::TABLE.len());
    }
}
