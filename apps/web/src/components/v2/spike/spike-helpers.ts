// SPIKE (throwaway): server-safe helpers for ?spike=a|b - kept out of the "use client" module so the pages can call them.
import type { ExternalPlayQueueProps } from "@/components/v2/external-play-needs-result-queue";
import type { OpenRoundView } from "@/lib/open-round";
import type { ArbiterRound } from "@/lib/arbiter-view";

/** Variant C: what phase of a match day the round column is in. Before the round is open there is nothing to watch; while any
 *  board of it is still checking in, check-in is the work; after that the boards are being played. */
export type RoundPhase = "before" | "checkin" | "playing";
export function roundPhaseOf(round: ArbiterRound | null): RoundPhase {
  if (round === null) return "before";
  return round.boards.some((b) => b.state.kind === "checking_in") ? "checkin" : "playing";
}

export type SpikeVariant = "a" | "b" | "c";

export function parseSpike(raw: string | string[] | undefined): SpikeVariant | null {
  return raw === "a" || raw === "b" || raw === "c" ? raw : null;
}

export type SpikeQueue = Omit<ExternalPlayQueueProps, "slugs">;

/** What the arbiter page hands the panel in spike mode: every round `listOpenRounds` offers (the fixtures tab's own list),
 *  the division's Held/Flagged queue, and the zone the control prints times in. */
export type SpikeRoundData = { rounds: OpenRoundView[]; queue: SpikeQueue; tz: string };

/** Boards needing a decision, per (stage, round) — a board both held and flagged counts once. `unmatched` is what no
 *  listed round claims (an older, closed round's board): the Fixtures tab still owes it a red line. */
export function spikeAttention(queue: SpikeQueue, rounds: readonly OpenRoundView[]): { byRound: Record<string, number>; unmatched: number } {
  const seen = new Map<string, string>();
  for (const h of queue.held) seen.set(h.fixtureId, `${h.stageName}:${h.roundNo ?? ""}`);
  for (const b of queue.flagged) seen.set(b.fixtureId, `${b.stageName}:${b.roundNo ?? ""}`);
  const listed = new Set(rounds.map((r) => `${r.stageName}:${r.roundNo}`));
  const byRound: Record<string, number> = {};
  let unmatched = 0;
  for (const key of seen.values()) {
    if (listed.has(key)) byRound[key] = (byRound[key] ?? 0) + 1;
    else unmatched += 1;
  }
  return { byRound, unmatched };
}

export const spikeRoundKey = (r: Pick<OpenRoundView, "stageName" | "roundNo">) => `${r.stageName}:${r.roundNo}`;

