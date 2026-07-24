import { describe, it, expect } from "vitest";
import { minimizeSumOfRanks, minimizeWorstRank, type Vote } from "../src/services/slotSelection.js";

describe("minimizeSumOfRanks", () => {
  it("returns null when there are no votes", () => {
    expect(minimizeSumOfRanks([], ["slot_1", "slot_2"])).toBeNull();
  });

  it("picks the slot with the lowest total rank sum", () => {
    const votes: Vote[] = [
      { voterId: "u1", slotId: "slot_1", rank: 1 },
      { voterId: "u2", slotId: "slot_1", rank: 2 },
      { voterId: "u1", slotId: "slot_2", rank: 2 },
      { voterId: "u2", slotId: "slot_2", rank: 1 },
      { voterId: "u3", slotId: "slot_2", rank: 1 },
    ];
    // slot_1: 1+2=3, slot_2: 2+1+1=4 -> slot_1 wins (lower sum)
    expect(minimizeSumOfRanks(votes, ["slot_1", "slot_2"])).toBe("slot_1");
  });

  it("never picks a slot nobody voted for, even though its sum is 0", () => {
    const votes: Vote[] = [{ voterId: "u1", slotId: "slot_2", rank: 5 }];
    expect(minimizeSumOfRanks(votes, ["slot_1", "slot_2"])).toBe("slot_2");
  });

  it("breaks a tied sum by preferring the slot more people ranked", () => {
    const votes: Vote[] = [
      { voterId: "u1", slotId: "slot_1", rank: 2 },
      { voterId: "u1", slotId: "slot_2", rank: 1 },
      { voterId: "u2", slotId: "slot_2", rank: 1 },
    ];
    // slot_1 sum=2 (1 voter), slot_2 sum=2 (2 voters) -> tie on sum, slot_2 has more consensus
    expect(minimizeSumOfRanks(votes, ["slot_1", "slot_2"])).toBe("slot_2");
  });

  it("breaks a fully tied result by earliest-proposed slot", () => {
    const votes: Vote[] = [
      { voterId: "u1", slotId: "slot_1", rank: 1 },
      { voterId: "u1", slotId: "slot_2", rank: 1 },
    ];
    expect(minimizeSumOfRanks(votes, ["slot_1", "slot_2"])).toBe("slot_1");
    expect(minimizeSumOfRanks(votes, ["slot_2", "slot_1"])).toBe("slot_2");
  });

  it("handles a voter who only ranks some of the slots", () => {
    const votes: Vote[] = [
      { voterId: "u1", slotId: "slot_1", rank: 1 },
      { voterId: "u2", slotId: "slot_3", rank: 1 },
    ];
    const winner = minimizeSumOfRanks(votes, ["slot_1", "slot_2", "slot_3"]);
    expect(["slot_1", "slot_3"]).toContain(winner);
  });
});

describe("minimizeWorstRank", () => {
  it("returns null when there are no votes", () => {
    expect(minimizeWorstRank([], ["slot_1"])).toBeNull();
  });

  it("picks the slot whose worst (highest) rank is lowest", () => {
    const votes: Vote[] = [
      { voterId: "u1", slotId: "slot_1", rank: 1 },
      { voterId: "u2", slotId: "slot_1", rank: 5 }, // one voter really dislikes slot_1
      { voterId: "u1", slotId: "slot_2", rank: 2 },
      { voterId: "u2", slotId: "slot_2", rank: 2 },
    ];
    // slot_1 worst=5, slot_2 worst=2 -> slot_2 wins (nobody hates it much)
    expect(minimizeWorstRank(votes, ["slot_1", "slot_2"])).toBe("slot_2");
  });

  it("never picks a slot nobody voted for", () => {
    const votes: Vote[] = [{ voterId: "u1", slotId: "slot_2", rank: 3 }];
    expect(minimizeWorstRank(votes, ["slot_1", "slot_2"])).toBe("slot_2");
  });
});
