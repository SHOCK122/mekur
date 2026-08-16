import { describe, it, expect } from "vitest";
import {
  rankBetween,
  rankAtEnd,
  rankAtStart,
  initialRanks,
} from "../src/lib/fractionalRank.js";

describe("fractionalRank", () => {
  it("produces a rank with no bounds", () => {
    const rank = rankBetween(null, null);
    expect(rank.length).toBeGreaterThan(0);
  });

  it("produces a rank strictly between two others", () => {
    const a = rankBetween(null, null);
    const c = rankAtEnd([a]);
    const b = rankBetween(a, c);
    expect(a < b).toBe(true);
    expect(b < c).toBe(true);
  });

  it("produces a rank before a given one", () => {
    const a = rankBetween(null, null);
    expect(rankBetween(null, a) < a).toBe(true);
  });

  it("produces a rank after a given one", () => {
    const a = rankBetween(null, null);
    expect(rankBetween(a, null) > a).toBe(true);
  });

  it("refuses an inverted or equal range rather than returning nonsense", () => {
    const a = rankBetween(null, null);
    const b = rankAtEnd([a]);
    expect(() => rankBetween(b, a)).toThrow();
    expect(() => rankBetween(a, a)).toThrow();
  });

  it("survives 500 repeated insertions between the SAME pair", () => {
    // The case that breaks float-based ordering: subdividing the same gap
    // over and over. Strings can always be extended, so this must hold.
    let low = rankBetween(null, null);
    const high = rankAtEnd([low]);
    let previous = low;
    for (let i = 0; i < 500; i++) {
      const mid = rankBetween(previous, high);
      expect(previous < mid).toBe(true);
      expect(mid < high).toBe(true);
      previous = mid;
    }
  });

  it("survives 500 repeated insertions at the START", () => {
    let first = rankBetween(null, null);
    for (let i = 0; i < 500; i++) {
      const next = rankBetween(null, first);
      expect(next < first).toBe(true);
      first = next;
    }
  });

  it("survives 500 repeated insertions at the END", () => {
    let last = rankBetween(null, null);
    for (let i = 0; i < 500; i++) {
      const next = rankBetween(last, null);
      expect(next > last).toBe(true);
      last = next;
    }
  });

  it("keeps a list correctly ordered through many random insertions", () => {
    // Property test: repeatedly insert at a random position and assert the
    // list is still sorted. Ordering bugs here typically only appear after
    // many operations, which is exactly what this simulates.
    let ranks = initialRanks(5);
    for (let i = 0; i < 300; i++) {
      const sorted = [...ranks].sort();
      const position = Math.floor(Math.random() * (sorted.length + 1));
      const lower = position === 0 ? null : sorted[position - 1]!;
      const upper = position === sorted.length ? null : sorted[position]!;
      const inserted = rankBetween(lower, upper);

      expect(ranks).not.toContain(inserted); // ranks must stay unique
      ranks = [...ranks, inserted];

      const resorted = [...ranks].sort();
      for (let j = 1; j < resorted.length; j++) {
        expect(resorted[j - 1]! < resorted[j]!).toBe(true);
      }
    }
    expect(ranks).toHaveLength(305);
  });

  it("keeps ranks reasonably short, so they don't grow without bound", () => {
    // Length growth is the practical cost of this scheme; it should grow
    // slowly (roughly log) rather than one character per insertion.
    let previous = rankBetween(null, null);
    const high = rankAtEnd([previous]);
    for (let i = 0; i < 200; i++) previous = rankBetween(previous, high);
    expect(previous.length).toBeLessThan(60);
  });

  it("initialRanks yields a strictly increasing sequence", () => {
    const ranks = initialRanks(50);
    expect(ranks).toHaveLength(50);
    for (let i = 1; i < ranks.length; i++) {
      expect(ranks[i - 1]! < ranks[i]!).toBe(true);
    }
  });

  it("rankAtStart and rankAtEnd bracket an existing list", () => {
    const ranks = initialRanks(10);
    expect(rankAtStart(ranks) < ranks[0]!).toBe(true);
    expect(rankAtEnd(ranks) > ranks[ranks.length - 1]!).toBe(true);
  });

  it("reordering one item is a single rank change, not a renumbering", () => {
    // The whole point: moving an item must not touch any other item's rank.
    const ranks = initialRanks(100);
    const before = [...ranks];
    const moved = rankBetween(ranks[10]!, ranks[11]!);
    expect(moved > ranks[10]!).toBe(true);
    expect(moved < ranks[11]!).toBe(true);
    expect(ranks).toEqual(before); // nothing else changed
  });
});
