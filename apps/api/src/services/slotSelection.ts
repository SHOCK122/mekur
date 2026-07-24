/**
 * Picking one slot that best satisfies a group's individual rankings is a
 * preference-aggregation problem, not classic two-sided "stable matching"
 * (see docs/ARCHITECTURE.md for that terminology note). Strategies here
 * operate purely on (voterId, slotId, rank) tuples -- never on slot
 * content, which the server never sees anyway.
 */
export interface Vote {
  voterId: string;
  slotId: string;
  rank: number;
}

export type SelectionStrategy = (votes: Vote[], slotIds: string[]) => string | null;

interface SlotTally {
  slotId: string;
  sumOfRanks: number;
  voteCount: number;
  originalIndex: number;
}

function tally(votes: Vote[], slotIds: string[]): SlotTally[] {
  const bySlot = new Map<string, { sum: number; count: number }>();
  for (const vote of votes) {
    const existing = bySlot.get(vote.slotId) ?? { sum: 0, count: 0 };
    existing.sum += vote.rank;
    existing.count += 1;
    bySlot.set(vote.slotId, existing);
  }
  return slotIds
    .map((slotId, originalIndex) => {
      const entry = bySlot.get(slotId);
      return entry ? { slotId, sumOfRanks: entry.sum, voteCount: entry.count, originalIndex } : null;
    })
    .filter((entry): entry is SlotTally => entry !== null);
}

/**
 * Default strategy: minimize the total (Borda-count-style) sum of ranks
 * across everyone who voted for a slot. Ties broken by (1) more voters
 * having ranked it at all -- more consensus -- then (2) whichever slot
 * the organizer proposed first, for a fully deterministic result.
 * Slots nobody voted for are never selected; if nobody voted at all,
 * returns null (nothing to resolve yet).
 */
export const minimizeSumOfRanks: SelectionStrategy = (votes, slotIds) => {
  const tallies = tally(votes, slotIds);
  if (tallies.length === 0) return null;

  tallies.sort((a, b) => {
    if (a.sumOfRanks !== b.sumOfRanks) return a.sumOfRanks - b.sumOfRanks;
    if (a.voteCount !== b.voteCount) return b.voteCount - a.voteCount;
    return a.originalIndex - b.originalIndex;
  });

  return tallies[0]!.slotId;
};

/**
 * Alternative strategy: minimize the worst (highest/least-preferred) rank
 * anyone gave the winning slot -- a fairness-oriented rule ("nobody hates
 * the outcome") rather than a sum-minimizing one. Not wired as the
 * default; available if a deployment wants to configure it instead.
 */
export const minimizeWorstRank: SelectionStrategy = (votes, slotIds) => {
  const worstBySlot = new Map<string, number>();
  for (const vote of votes) {
    const current = worstBySlot.get(vote.slotId);
    if (current === undefined || vote.rank > current) worstBySlot.set(vote.slotId, vote.rank);
  }
  const candidates = slotIds
    .map((slotId, originalIndex) => {
      const worst = worstBySlot.get(slotId);
      return worst === undefined ? null : { slotId, worst, originalIndex };
    })
    .filter((entry): entry is { slotId: string; worst: number; originalIndex: number } => entry !== null);

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.worst - b.worst || a.originalIndex - b.originalIndex);
  return candidates[0]!.slotId;
};
