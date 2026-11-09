// Zod's own verdicts, recorded for the Rust port (crates/shared).
//
// Every case below is run through the Zod schemas and the result -- the
// parsed output, or the full `issues` array -- is compared with
// crates/shared/tests/fixtures/zod_parity.json, which the Rust tests
// replay against mekur-shared. So the fixture can never drift from what
// Zod actually does while this package exists. After changing a case or a
// schema, regenerate it with:
//
//   UPDATE_ZOD_PARITY=1 npm run test --workspace=@schedule-app/shared
//
// Time zones are recorded separately: Node's `Intl` verdict on every zone
// it knows plus edge cases, since `isValidTimeZone` is defined by `Intl`.
import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ZodTypeAny } from "zod";
import {
  EncryptedEnvelopeSchema,
  SealedEnvelopeSchema,
  KeyringEnvelopeSchema,
  RecurrenceRuleSchema,
  EventContentSchema,
  isValidTimeZone,
} from "../src/index.js";

const FIXTURE = fileURLToPath(new URL("../../../crates/shared/tests/fixtures/zod_parity.json", import.meta.url));

const SCHEMAS: Record<string, ZodTypeAny> = {
  EncryptedEnvelope: EncryptedEnvelopeSchema,
  SealedEnvelope: SealedEnvelopeSchema,
  KeyringEnvelope: KeyringEnvelopeSchema,
  RecurrenceRule: RecurrenceRuleSchema,
  EventContent: EventContentSchema,
};

type Case = { schema: keyof typeof SCHEMAS; name: string; input: unknown };

// JSON can't tell 1.0 from 1 once JavaScript has parsed it, so float
// spellings of integers are tested in crates/shared/tests/schemas.rs instead.
const env = { v: 1, algo: "xchacha20poly1305", keyId: "user-key-1", nonce: "bm9uY2U=", ciphertext: "Y2lwaGVydGV4dA==" };
const event = { title: "Team sync", startTime: "2026-08-01T10:00:00.000Z" };
const series = { ...event, recurrence: { freq: "DAILY", interval: 1 } };
const ov = (occurrence: string, startTime = occurrence, endTime?: string) =>
  endTime === undefined ? { occurrence, startTime } : { occurrence, startTime, endTime };

const cases: Case[] = [
  // --- envelopes ---
  { schema: "EncryptedEnvelope", name: "well-formed", input: env },
  { schema: "EncryptedEnvelope", name: "unknown keys are stripped", input: { ...env, extra: 1, epk: "x" } },
  { schema: "EncryptedEnvelope", name: "missing ciphertext", input: { ...env, ciphertext: undefined } },
  { schema: "EncryptedEnvelope", name: "unknown algo", input: { ...env, algo: "aes-cbc" } },
  { schema: "EncryptedEnvelope", name: "wrong version", input: { ...env, v: 2 } },
  { schema: "EncryptedEnvelope", name: "version as string", input: { ...env, v: "1" } },
  { schema: "EncryptedEnvelope", name: "version as float", input: { ...env, v: 1.5 } },
  { schema: "EncryptedEnvelope", name: "version as object", input: { ...env, v: { a: [1, "2"] } } },
  { schema: "EncryptedEnvelope", name: "missing version and algo", input: { keyId: "k", nonce: "n", ciphertext: "c" } },
  { schema: "EncryptedEnvelope", name: "every field wrong", input: { v: 2, algo: "x", keyId: "", nonce: 5, ciphertext: null } },
  { schema: "EncryptedEnvelope", name: "empty object", input: {} },
  { schema: "EncryptedEnvelope", name: "string", input: "envelope" },
  { schema: "EncryptedEnvelope", name: "array", input: [env] },
  { schema: "EncryptedEnvelope", name: "null", input: null },
  { schema: "EncryptedEnvelope", name: "number", input: 1 },
  { schema: "EncryptedEnvelope", name: "boolean", input: true },
  { schema: "EncryptedEnvelope", name: "keyId at 64", input: { ...env, keyId: "k".repeat(64) } },
  { schema: "EncryptedEnvelope", name: "keyId at 65", input: { ...env, keyId: "k".repeat(65) } },
  { schema: "EncryptedEnvelope", name: "keyId of 32 emoji is 64 UTF-16 units", input: { ...env, keyId: "😀".repeat(32) } },
  { schema: "EncryptedEnvelope", name: "keyId of 33 emoji is 66 UTF-16 units", input: { ...env, keyId: "😀".repeat(33) } },
  { schema: "EncryptedEnvelope", name: "keyId of 64 accented letters", input: { ...env, keyId: "é".repeat(64) } },
  { schema: "EncryptedEnvelope", name: "nonce at 129", input: { ...env, nonce: "n".repeat(129) } },
  { schema: "EncryptedEnvelope", name: "empty nonce and ciphertext", input: { ...env, nonce: "", ciphertext: "" } },
  { schema: "SealedEnvelope", name: "with epk", input: { ...env, keyId: "sealed", epk: "ZXBr" } },
  { schema: "SealedEnvelope", name: "without epk", input: env },
  { schema: "SealedEnvelope", name: "epk too long and algo wrong", input: { ...env, algo: "x", epk: "e".repeat(65) } },
  { schema: "SealedEnvelope", name: "empty epk", input: { ...env, epk: "" } },
  { schema: "KeyringEnvelope", name: "well-formed", input: { ...env, keyId: "keyring" } },
  { schema: "KeyringEnvelope", name: "empty ciphertext", input: { ...env, ciphertext: "" } },
  { schema: "KeyringEnvelope", name: "missing nonce", input: { ...env, nonce: undefined } },

  // --- recurrence rules ---
  { schema: "RecurrenceRule", name: "every 37 minutes", input: { freq: "MINUTELY", interval: 37 } },
  { schema: "RecurrenceRule", name: "interval defaults to 1", input: { freq: "DAILY" } },
  { schema: "RecurrenceRule", name: "every weekday", input: { freq: "WEEKLY", interval: 1, byDay: ["MO", "TU", "WE", "TH", "FR"] } },
  { schema: "RecurrenceRule", name: "first Monday in Sydney", input: { freq: "MONTHLY", interval: 1, byDay: ["MO"], bySetPos: [1], tzid: "Australia/Sydney" } },
  { schema: "RecurrenceRule", name: "last day of the month", input: { freq: "MONTHLY", byMonthDay: [-1] } },
  { schema: "RecurrenceRule", name: "last Friday of March", input: { freq: "YEARLY", byMonth: [3], byDay: ["FR"], bySetPos: [-1] } },
  { schema: "RecurrenceRule", name: "count and until", input: { freq: "DAILY", count: 5, until: "2026-12-31T00:00:00Z" } },
  { schema: "RecurrenceRule", name: "every part at once", input: { freq: "YEARLY", interval: 2, byDay: ["SU"], byMonthDay: [1, 2, 3, 4, 5, 6, 7], byMonth: [1, 7], bySetPos: [1, -1], tzid: "utc", count: 10, until: "2030-01-01T00:00Z" } },
  { schema: "RecurrenceRule", name: "missing freq", input: { interval: 1 } },
  { schema: "RecurrenceRule", name: "unknown freq", input: { freq: "SECONDLY" } },
  { schema: "RecurrenceRule", name: "lower-case freq", input: { freq: "daily" } },
  { schema: "RecurrenceRule", name: "numeric freq", input: { freq: 3 } },
  { schema: "RecurrenceRule", name: "interval 0", input: { freq: "DAILY", interval: 0 } },
  { schema: "RecurrenceRule", name: "interval -1", input: { freq: "DAILY", interval: -1 } },
  { schema: "RecurrenceRule", name: "interval 1.5", input: { freq: "DAILY", interval: 1.5 } },
  { schema: "RecurrenceRule", name: "interval -0.5", input: { freq: "DAILY", interval: -0.5 } },
  { schema: "RecurrenceRule", name: "interval null", input: { freq: "DAILY", interval: null } },
  { schema: "RecurrenceRule", name: "interval string", input: { freq: "DAILY", interval: "2" } },
  { schema: "RecurrenceRule", name: "byDay with a bad day and a number", input: { freq: "WEEKLY", byDay: ["MO", "XX", 3] } },
  { schema: "RecurrenceRule", name: "byDay of 8", input: { freq: "WEEKLY", byDay: ["MO", "TU", "WE", "TH", "FR", "SA", "SU", "MO"] } },
  { schema: "RecurrenceRule", name: "byDay empty", input: { freq: "WEEKLY", byDay: [] } },
  { schema: "RecurrenceRule", name: "byDay not an array", input: { freq: "WEEKLY", byDay: "MO" } },
  { schema: "RecurrenceRule", name: "calendar parts on DAILY", input: { freq: "DAILY", byMonthDay: [1] } },
  { schema: "RecurrenceRule", name: "byMonth on WEEKLY", input: { freq: "WEEKLY", byMonth: [1] } },
  { schema: "RecurrenceRule", name: "bySetPos on MINUTELY", input: { freq: "MINUTELY", byDay: ["MO"], bySetPos: [2] } },
  { schema: "RecurrenceRule", name: "all calendar parts on HOURLY", input: { freq: "HOURLY", byMonthDay: [40], byMonth: [2], bySetPos: [1] } },
  { schema: "RecurrenceRule", name: "bySetPos alone", input: { freq: "MONTHLY", bySetPos: [1] } },
  { schema: "RecurrenceRule", name: "byMonthDay 0", input: { freq: "MONTHLY", byMonthDay: [0] } },
  { schema: "RecurrenceRule", name: "byMonthDay 32", input: { freq: "MONTHLY", byMonthDay: [32] } },
  { schema: "RecurrenceRule", name: "byMonthDay -32", input: { freq: "MONTHLY", byMonthDay: [-32] } },
  { schema: "RecurrenceRule", name: "byMonthDay 1.5", input: { freq: "MONTHLY", byMonthDay: [1.5] } },
  { schema: "RecurrenceRule", name: "byMonthDay 0, 40, 1.5", input: { freq: "MONTHLY", byMonthDay: [0, 40, 1.5] } },
  { schema: "RecurrenceRule", name: "byMonthDay empty", input: { freq: "MONTHLY", byMonthDay: [] } },
  { schema: "RecurrenceRule", name: "byMonthDay of 32", input: { freq: "MONTHLY", byMonthDay: Array.from({ length: 32 }, (_, i) => (i % 31) + 1) } },
  { schema: "RecurrenceRule", name: "byMonthDay with a string", input: { freq: "MONTHLY", byMonthDay: [1, "2"] } },
  { schema: "RecurrenceRule", name: "byMonth 13", input: { freq: "YEARLY", byMonth: [13] } },
  { schema: "RecurrenceRule", name: "byMonth 0", input: { freq: "YEARLY", byMonth: [0] } },
  { schema: "RecurrenceRule", name: "byMonth empty with a day", input: { freq: "YEARLY", byMonth: [], byMonthDay: [1] } },
  { schema: "RecurrenceRule", name: "byMonth empty with a position", input: { freq: "YEARLY", byMonth: [], byDay: ["MO"], bySetPos: [1] } },
  { schema: "RecurrenceRule", name: "byMonth 13 with day 31", input: { freq: "YEARLY", byMonth: [13], byMonthDay: [31] } },
  { schema: "RecurrenceRule", name: "byMonth 2.5 with day 30", input: { freq: "YEARLY", byMonth: [2.5], byMonthDay: [30] } },
  { schema: "RecurrenceRule", name: "bySetPos 0", input: { freq: "MONTHLY", byDay: ["MO"], bySetPos: [0] } },
  { schema: "RecurrenceRule", name: "bySetPos 367", input: { freq: "YEARLY", byDay: ["MO"], bySetPos: [367] } },
  { schema: "RecurrenceRule", name: "bySetPos of 11", input: { freq: "MONTHLY", byDay: ["MO"], bySetPos: [1, 2, 3, 4, 5, -1, -2, -3, -4, -5, 1] } },
  { schema: "RecurrenceRule", name: "February 30th", input: { freq: "YEARLY", byMonth: [2], byMonthDay: [30] } },
  { schema: "RecurrenceRule", name: "-31st of April or June", input: { freq: "YEARLY", byMonth: [4, 6], byMonthDay: [-31] } },
  { schema: "RecurrenceRule", name: "February 29th", input: { freq: "YEARLY", byMonth: [2], byMonthDay: [29] } },
  { schema: "RecurrenceRule", name: "31st of February or March", input: { freq: "MONTHLY", byMonth: [2, 3], byMonthDay: [31] } },
  { schema: "RecurrenceRule", name: "sixth Monday", input: { freq: "MONTHLY", byDay: ["MO"], bySetPos: [6] } },
  { schema: "RecurrenceRule", name: "fifth-last Monday", input: { freq: "MONTHLY", byDay: ["MO"], bySetPos: [-5] } },
  { schema: "RecurrenceRule", name: "third of two days", input: { freq: "MONTHLY", byMonthDay: [1, 15], bySetPos: [3] } },
  { schema: "RecurrenceRule", name: "twentieth Monday of the year", input: { freq: "YEARLY", byDay: ["MO"], bySetPos: [20] } },
  { schema: "RecurrenceRule", name: "sixth Monday of March", input: { freq: "YEARLY", byMonth: [3], byDay: ["MO"], bySetPos: [6] } },
  { schema: "RecurrenceRule", name: "positions past the bound and out of range", input: { freq: "MONTHLY", byDay: ["MO"], bySetPos: [400, 5, 6, -6] } },
  { schema: "RecurrenceRule", name: "unknown time zone", input: { freq: "MONTHLY", byMonthDay: [1], tzid: "Mars/Olympus_Mons" } },
  { schema: "RecurrenceRule", name: "empty time zone", input: { freq: "DAILY", tzid: "" } },
  { schema: "RecurrenceRule", name: "time zone too long", input: { freq: "DAILY", tzid: "A".repeat(65) } },
  { schema: "RecurrenceRule", name: "offset time zone", input: { freq: "DAILY", tzid: "+05:30" } },
  { schema: "RecurrenceRule", name: "lower-case time zone", input: { freq: "DAILY", tzid: "america/new_york" } },
  { schema: "RecurrenceRule", name: "count 0", input: { freq: "DAILY", count: 0 } },
  { schema: "RecurrenceRule", name: "count 2.5", input: { freq: "DAILY", count: 2.5 } },
  { schema: "RecurrenceRule", name: "huge safe count", input: { freq: "DAILY", count: 9007199254740991 } },
  { schema: "RecurrenceRule", name: "until not a datetime", input: { freq: "DAILY", until: "tomorrow" } },
  { schema: "RecurrenceRule", name: "until with an offset", input: { freq: "DAILY", until: "2026-01-01T00:00:00+01:00" } },
  { schema: "RecurrenceRule", name: "invalid freq skips the cross-field checks", input: { freq: "X", interval: 1.5, byDay: ["XX", 3], byMonthDay: [0, 40, 1.5], count: 0, until: "nope", tzid: "" } },
  { schema: "RecurrenceRule", name: "dirty values still reach the cross-field checks", input: { freq: "MONTHLY", interval: -1, byMonthDay: [], bySetPos: [400] } },
  { schema: "RecurrenceRule", name: "null", input: null },
  { schema: "RecurrenceRule", name: "array", input: [] },

  // --- event content ---
  { schema: "EventContent", name: "minimal", input: event },
  { schema: "EventContent", name: "with an end", input: { ...event, endTime: "2026-08-01T11:00:00.000Z" } },
  { schema: "EventContent", name: "every field", input: { ...series, description: "d", location: "l", endTime: "2026-08-01T10:30Z", rank: "V", important: false, skippedOccurrences: ["2026-08-02T10:00:00.000Z"], occurrenceOverrides: [ov("2026-08-03T10:00:00.000Z", "2026-08-03T15:00:00.000Z", "2026-08-03T16:00:00.000Z")] } },
  { schema: "EventContent", name: "unknown keys stripped, nested too", input: { ...event, extra: 1, recurrence: { freq: "DAILY", x: 1 }, occurrenceOverrides: [{ ...ov("2026-08-03T10:00:00Z"), y: 2 }] } },
  { schema: "EventContent", name: "empty title", input: { ...event, title: "" } },
  { schema: "EventContent", name: "title at 500", input: { ...event, title: "t".repeat(500) } },
  { schema: "EventContent", name: "title at 501", input: { ...event, title: "t".repeat(501) } },
  { schema: "EventContent", name: "title of 250 emoji", input: { ...event, title: "📅".repeat(250) } },
  { schema: "EventContent", name: "title of 251 emoji", input: { ...event, title: "📅".repeat(251) } },
  { schema: "EventContent", name: "description at 10001", input: { ...event, description: "d".repeat(10_001) } },
  { schema: "EventContent", name: "location at 501", input: { ...event, location: "l".repeat(501) } },
  { schema: "EventContent", name: "missing title and start", input: {} },
  { schema: "EventContent", name: "end before start", input: { ...event, endTime: "2026-08-01T09:00:00.000Z" } },
  { schema: "EventContent", name: "end equal to start", input: { ...event, endTime: "2026-08-01T10:00:00.000Z" } },
  { schema: "EventContent", name: "end equal to start, other spelling", input: { ...event, endTime: "2026-08-01T10:00Z" } },
  { schema: "EventContent", name: "end equal below a millisecond", input: { ...event, endTime: "2026-08-01T10:00:00.0009Z" } },
  { schema: "EventContent", name: "end one millisecond later", input: { ...event, endTime: "2026-08-01T10:00:00.001Z" } },
  { schema: "EventContent", name: "start not a datetime, with an end", input: { ...event, startTime: "soon", endTime: "2026-08-01T11:00:00Z" } },
  { schema: "EventContent", name: "end not a datetime", input: { ...event, endTime: "later" } },
  { schema: "EventContent", name: "end null", input: { ...event, endTime: null } },
  { schema: "EventContent", name: "empty rank", input: { ...event, rank: "" } },
  { schema: "EventContent", name: "important as string, end before start", input: { ...event, important: "yes", endTime: "2026-08-01T09:00:00Z" } },
  { schema: "EventContent", name: "bad recurrence, end before start", input: { ...event, endTime: "2026-08-01T09:00:00Z", recurrence: { freq: "DAILY", interval: 0 } } },
  { schema: "EventContent", name: "aborted recurrence, end before start", input: { ...event, endTime: "2026-08-01T09:00:00Z", recurrence: { freq: "NEVER" } } },
  { schema: "EventContent", name: "recurrence with a bad set position", input: { ...event, recurrence: { freq: "MONTHLY", byDay: ["MO"], bySetPos: [6] } } },
  { schema: "EventContent", name: "skipped occurrences, one bad", input: { ...series, skippedOccurrences: ["2026-08-02T10:00:00Z", "2026-08-03"] } },
  { schema: "EventContent", name: "skipped occurrences not strings", input: { ...series, skippedOccurrences: [1] } },
  { schema: "EventContent", name: "open-ended override", input: { ...series, occurrenceOverrides: [ov("2026-08-05T09:00:00.000Z", "2026-08-05T15:00:00.000Z")] } },
  { schema: "EventContent", name: "override ends before it starts", input: { ...series, occurrenceOverrides: [ov("2026-08-05T09:00:00.000Z", "2026-08-05T15:00:00.000Z", "2026-08-05T14:00:00.000Z")] } },
  { schema: "EventContent", name: "the same occurrence moved twice", input: { ...series, occurrenceOverrides: [ov("2026-08-05T09:00:00.000Z", "2026-08-05T15:00:00.000Z"), ov("2026-08-05T09:00:00.000Z", "2026-08-05T16:00:00.000Z")] } },
  { schema: "EventContent", name: "the same occurrence spelled two ways", input: { ...series, occurrenceOverrides: [ov("2026-08-05T09:00Z"), ov("2026-08-05T09:00:00.000Z")] } },
  { schema: "EventContent", name: "occurrences differing below a millisecond", input: { ...series, occurrenceOverrides: [ov("2026-08-05T09:00:00.0001Z"), ov("2026-08-05T09:00:00.0002Z")] } },
  { schema: "EventContent", name: "occurrences a millisecond apart", input: { ...series, occurrenceOverrides: [ov("2026-08-05T09:00:00.001Z"), ov("2026-08-05T09:00:00.002Z")] } },
  { schema: "EventContent", name: "two invalid occurrences count as the same", input: { ...series, occurrenceOverrides: [ov("x", "y"), ov("z", "2026-08-01T09:00:00Z", "2026-08-01T09:00:00Z")] } },
  { schema: "EventContent", name: "override missing its start", input: { ...series, occurrenceOverrides: [{ occurrence: "2026-08-05T09:00:00Z" }] } },
  { schema: "EventContent", name: "override not an object", input: { ...series, occurrenceOverrides: ["2026-08-05T09:00:00Z"] } },
  { schema: "EventContent", name: "overrides not an array", input: { ...series, occurrenceOverrides: {} } },
  { schema: "EventContent", name: "201 overrides", input: { ...series, occurrenceOverrides: Array.from({ length: 201 }, (_, i) => ov(new Date(Date.UTC(2026, 7, 3 + i, 9)).toISOString())) } },
  { schema: "EventContent", name: "200 overrides", input: { ...series, occurrenceOverrides: Array.from({ length: 200 }, (_, i) => ov(new Date(Date.UTC(2026, 7, 3 + i, 9)).toISOString())) } },
  { schema: "EventContent", name: "string", input: "event" },
];

// IANA aliases (tzdata "backward" links and the like): Intl accepts them but
// leaves them out of supportedValuesOf, which lists canonical ids only.
// Every name chrono-tz knows must be recorded; the Rust test checks that.
const IANA_ALIASES = [
  "Africa/Asmara", "Africa/Timbuktu", "America/Argentina/Buenos_Aires", "America/Argentina/Catamarca",
  "America/Argentina/ComodRivadavia", "America/Argentina/Cordoba", "America/Argentina/Jujuy",
  "America/Argentina/Mendoza", "America/Atikokan", "America/Atka", "America/Ensenada", "America/Fort_Wayne",
  "America/Indiana/Indianapolis", "America/Kentucky/Louisville", "America/Knox_IN", "America/Montreal",
  "America/Nipigon", "America/Nuuk", "America/Pangnirtung", "America/Porto_Acre", "America/Rainy_River",
  "America/Rosario", "America/Santa_Isabel", "America/Shiprock", "America/Thunder_Bay", "America/Virgin",
  "America/Yellowknife", "Antarctica/South_Pole", "Asia/Ashkhabad", "Asia/Choibalsan", "Asia/Chongqing",
  "Asia/Chungking", "Asia/Dacca", "Asia/Harbin", "Asia/Ho_Chi_Minh", "Asia/Istanbul", "Asia/Kashgar",
  "Asia/Kathmandu", "Asia/Kolkata", "Asia/Macao", "Asia/Tel_Aviv", "Asia/Thimbu", "Asia/Ujung_Pandang",
  "Asia/Ulan_Bator", "Asia/Yangon", "Atlantic/Faroe", "Atlantic/Jan_Mayen", "Australia/ACT", "Australia/Canberra",
  "Australia/Currie", "Australia/LHI", "Australia/NSW", "Australia/North", "Australia/Queensland", "Australia/South",
  "Australia/Tasmania", "Australia/Victoria", "Australia/West", "Australia/Yancowinna", "Brazil/Acre",
  "Brazil/DeNoronha", "Brazil/East", "Brazil/West", "CET", "CST6CDT", "Canada/Atlantic", "Canada/Central",
  "Canada/Eastern", "Canada/Mountain", "Canada/Newfoundland", "Canada/Pacific", "Canada/Saskatchewan",
  "Canada/Yukon", "Chile/Continental", "Chile/EasterIsland", "Cuba", "EET", "EST", "EST5EDT", "Egypt", "Eire",
  "Etc/GMT", "Etc/GMT+0", "Etc/GMT+1", "Etc/GMT+10", "Etc/GMT+11", "Etc/GMT+12", "Etc/GMT+2", "Etc/GMT+3",
  "Etc/GMT+4", "Etc/GMT+5", "Etc/GMT+6", "Etc/GMT+7", "Etc/GMT+8", "Etc/GMT+9", "Etc/GMT-0", "Etc/GMT-1",
  "Etc/GMT-10", "Etc/GMT-11", "Etc/GMT-12", "Etc/GMT-13", "Etc/GMT-14", "Etc/GMT-2", "Etc/GMT-3", "Etc/GMT-4",
  "Etc/GMT-5", "Etc/GMT-6", "Etc/GMT-7", "Etc/GMT-8", "Etc/GMT-9", "Etc/GMT0", "Etc/Greenwich", "Etc/UCT", "Etc/UTC",
  "Etc/Universal", "Etc/Zulu", "Europe/Belfast", "Europe/Kyiv", "Europe/Nicosia", "Europe/Tiraspol",
  "Europe/Uzhgorod", "Europe/Zaporozhye", "GB", "GB-Eire", "GMT", "GMT+0", "GMT-0", "GMT0", "Greenwich", "HST",
  "Hongkong", "Iceland", "Iran", "Israel", "Jamaica", "Japan", "Kwajalein", "Libya", "MET", "MST", "MST7MDT",
  "Mexico/BajaNorte", "Mexico/BajaSur", "Mexico/General", "NZ", "NZ-CHAT", "Navajo", "PRC", "PST8PDT",
  "Pacific/Chuuk", "Pacific/Johnston", "Pacific/Kanton", "Pacific/Pohnpei", "Pacific/Samoa", "Pacific/Yap", "Poland",
  "Portugal", "ROC", "ROK", "Singapore", "Turkey", "UCT", "US/Alaska", "US/Aleutian", "US/Arizona", "US/Central",
  "US/East-Indiana", "US/Eastern", "US/Hawaii", "US/Indiana-Starke", "US/Michigan", "US/Mountain", "US/Pacific",
  "US/Samoa", "UTC", "Universal", "W-SU", "WET", "Zulu",
];

// Strings Intl accepts or rejects that are worth pinning beyond the zone
// list: case, offsets, legacy ICU ids, near misses.
const EXTRA_TIME_ZONES = [
  "utc", "UTC", "Utc", "gmt", "america/new_york", "AMERICA/NEW_YORK", "US/Eastern", "EST", "est5edt", "Etc/GMT+5",
  "etc/gmt-14", "Etc/GMT+12", "Etc/GMT+13", "Etc/GMT-15", "GMT+5", "Z", "", " UTC", "UTC ", "Mars/Olympus_Mons",
  "Etc/Unknown", "Factory", "Asia/Riyadh87", "Asia/Calcutta", "Asia/Hanoi", "Europe/Kiev", "America/Godthab",
  "+05:00", "+0500", "+05", "-12:00", "+23:59", "+24:00", "+05:60", "-0000", "+00:00", "+5", "+5:00", "+05:3",
  "+05:30:00", "05:00", "−05:00", "−0530", "+", "-", "+é5",
  "ACT", "AET", "AGT", "ART", "AST", "BET", "BST", "CAT", "CNT", "CST", "CTT", "EAT", "ECT", "IET", "IST", "JST",
  "MIT", "NET", "NST", "PLT", "PNT", "PRT", "PST", "SST", "VST", "pst", "SystemV/AST4", "SystemV/AST4ADT",
  "SystemV/CST6", "SystemV/CST6CDT", "SystemV/EST5", "SystemV/EST5EDT", "SystemV/HST10", "SystemV/MST7",
  "SystemV/MST7MDT", "SystemV/PST8", "SystemV/PST8PDT", "SystemV/YST9", "SystemV/YST9YDT", "systemv/est5",
  "US/Pacific-New", "Canada/East-Saskatchewan", "Mideast/Riyadh87",
];

function zodResult(c: Case) {
  const result = SCHEMAS[c.schema]!.safeParse(c.input);
  return result.success ? { success: true, data: result.data } : { success: false, issues: result.error.issues };
}

function buildFixture() {
  const zones = [...new Set([...Intl.supportedValuesOf("timeZone"), ...IANA_ALIASES, ...EXTRA_TIME_ZONES])];
  return {
    generatedBy: "packages/shared/test/zodParity.test.ts",
    node: process.version,
    icuTimeZoneData: process.versions.tz,
    cases: cases.map((c) => ({ ...c, expected: zodResult(c) })),
    timeZones: Object.fromEntries(zones.map((tz) => [tz, isValidTimeZone(tz)])),
  };
}

// JSON round trip: drops `undefined` keys exactly as the committed file does.
const normalise = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown;

describe("Zod parity fixture for crates/shared", () => {
  it("matches what Zod and Intl do today", () => {
    const fresh = buildFixture();
    if (process.env.UPDATE_ZOD_PARITY) {
      writeFileSync(FIXTURE, JSON.stringify(fresh, null, 1) + "\n");
    }
    const committed = JSON.parse(readFileSync(FIXTURE, "utf8")) as ReturnType<typeof buildFixture>;
    expect(normalise(fresh.cases)).toEqual(committed.cases);
    // Zone verdicts are compared for the zones recorded, so a newer Node
    // that knows one more zone doesn't fail; a changed verdict does.
    for (const [tz, valid] of Object.entries(committed.timeZones)) {
      expect([tz, isValidTimeZone(tz)]).toEqual([tz, valid]);
    }
  });
});
