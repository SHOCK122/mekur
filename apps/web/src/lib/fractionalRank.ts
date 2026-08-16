/**
 * Fractional ordering (the technique behind Jira's LexoRank and Figma's
 * fractional indexing).
 *
 * Every event holds a unique string rank, ordered lexicographically. To put
 * an event between two others you generate a rank strictly between theirs
 * -- **one write**, no renumbering, regardless of how many events exist.
 * The previous integer-priority scheme needed O(n) writes to lower one
 * event (it raised every other), which does not survive thousands of
 * events, each write being an encrypted round trip.
 *
 * Ranks are strings rather than numbers because floating point runs out of
 * precision after roughly 50 insertions between the same pair. Strings can
 * always be subdivided by appending another character.
 */

// Ordered so that lexicographic string comparison matches value order.
const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function indexOfChar(char: string): number {
  const index = ALPHABET.indexOf(char);
  if (index < 0) throw new Error(`Invalid rank character: ${char}`);
  return index;
}

const BASE = ALPHABET.length;

/**
 * Ranks are base-62 fractions held as digit arrays: "V5" means 0.V5.
 * Working in digits rather than on strings directly makes the midpoint
 * logic something that can actually be reasoned about.
 *
 * One invariant matters above all: **never emit a trailing zero**. As
 * fractions 0.V and 0.V0 are equal, but as strings "V0" sorts *after*
 * "V" -- so a trailing zero silently breaks the correspondence between
 * lexicographic order and numeric order that the whole scheme rests on.
 */
function toDigits(rank: string): number[] {
  return [...rank].map(indexOfChar);
}

function toRank(digits: number[]): string {
  return digits.map((d) => ALPHABET[d]!).join("");
}

function digitsBetween(lower: number[] | null, upper: number[] | null): number[] {
  const result: number[] = [];
  let i = 0;

  while (true) {
    // Past the end of `lower` reads as 0; past the end of `upper` reads as
    // BASE, i.e. "no constraint above".
    const low = lower && i < lower.length ? lower[i]! : 0;
    const high = upper && i < upper.length ? upper[i]! : BASE;

    if (low === high) {
      result.push(low);
      i++;
      continue;
    }

    if (high - low >= 2) {
      // A digit fits cleanly between them, and it is never 0 here since
      // it is strictly greater than low >= 0.
      result.push(Math.floor((low + high) / 2));
      return result;
    }

    // The digits are adjacent, so nothing fits at this position. Keep the
    // lower digit and then produce anything strictly greater than the rest
    // of `lower` -- appending keeps us below `upper` automatically.
    result.push(low);
    i++;
    while (true) {
      const digit = lower && i < lower.length ? lower[i]! : 0;
      if (digit < BASE - 1) {
        result.push(Math.floor((digit + BASE) / 2));
        return result;
      }
      // Digit is already the maximum; carry it and look further along.
      result.push(digit);
      i++;
    }
  }
}

/** Rank for an item placed at the end of an ordered list. */
export function rankAtEnd(existing: string[]): string {
  if (existing.length === 0) return rankBetween(null, null);
  const sorted = [...existing].sort();
  return rankBetween(sorted[sorted.length - 1]!, null);
}

/** Rank for an item placed at the start of an ordered list. */
export function rankAtStart(existing: string[]): string {
  if (existing.length === 0) return rankBetween(null, null);
  const sorted = [...existing].sort();
  return rankBetween(null, sorted[0]!);
}

/**
 * Assigns initial ranks to a list already ordered by some legacy scheme
 * (e.g. the old integer priorities), preserving that order.
 */
export function initialRanks(count: number): string[] {
  const ranks: string[] = [];
  let previous: string | null = null;
  for (let i = 0; i < count; i++) {
    previous = rankBetween(previous, null);
    ranks.push(previous);
  }
  return ranks;
}

export function rankBetween(lower: string | null, upper: string | null): string {
  if (lower !== null && upper !== null && lower >= upper) {
    throw new Error(`rankBetween requires lower < upper (got ${lower}, ${upper})`);
  }
  return toRank(
    digitsBetween(lower === null ? null : toDigits(lower), upper === null ? null : toDigits(upper))
  );
}
