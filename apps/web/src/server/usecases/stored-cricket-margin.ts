// Owner decision 2026-09-16 — the cricket margin moved from English words
// ("by 12 runs") to the engine's `CricketMargin` (`{ kind, value? }`).
//
// `match_states` is a fold CACHE: a row is rewritten only when its fixture's
// ledger is next appended to. A cricket fixture decided before the change
// therefore keeps the old words in `state.margin` and `summary.detail.margin`
// until then, and `GET /api/v1/fixtures/{id}/state` serves those bytes. This
// maps them onto the structured shape on READ, so the endpoint serves one
// shape for old and new rows alike.
//
// Normalising on read, not re-folding, because `/state` is the fold-cache read
// (ETag on `last_seq`): a re-fold would add the ledger, config and line-up
// reads plus an engine fold to a poll endpoint for every sport, to correct one
// field on pre-change cricket rows. The five strings below are every margin
// the engine ever wrote — `decideWin`'s call sites, unchanged from the cricket
// module's first commit until this decision.
import type { CricketMargin } from "@seazn/engine/sports/cricket";

type CountedKind = Extract<CricketMargin, { value: number }>["kind"];

const COUNTED: readonly { pattern: RegExp; kind: CountedKind }[] = [
  { pattern: /^by (\d+) runs?$/, kind: "runs" },
  { pattern: /^by (\d+) wickets?$/, kind: "wickets" },
  { pattern: /^by an innings and (\d+) runs?$/, kind: "innings_and_runs" },
];

const UNCOUNTED: Readonly<Record<string, CricketMargin>> = {
  "Super Over": { kind: "super_over" },
  "on boundary count": { kind: "boundary_count" },
};

/** The structured margin an old English margin string stood for; `null` for
 *  anything the engine never wrote — no margin, rather than a second shape. */
export function structuredCricketMargin(words: string): CricketMargin | null {
  const uncounted = UNCOUNTED[words];
  if (uncounted !== undefined) return uncounted;
  for (const { pattern, kind } of COUNTED) {
    const match = pattern.exec(words);
    if (match) return { kind, value: Number(match[1]) };
  }
  return null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A stored `match_states` pair with any old-words cricket margin structured.
 *  Other sports, rows already in the new shape, and absent rows pass through. */
export function withStructuredCricketMargin(
  sportKey: string,
  stored: { state: unknown; summary: unknown },
): { state: unknown; summary: unknown } {
  if (sportKey !== "cricket") return stored;
  let { state, summary } = stored;
  if (isRecord(state) && typeof state.margin === "string") {
    state = { ...state, margin: structuredCricketMargin(state.margin) };
  }
  if (isRecord(summary) && isRecord(summary.detail) && typeof summary.detail.margin === "string") {
    // The summary omits the key when there is no margin (cricket.ts `summary`).
    const { margin: words, ...detail } = summary.detail;
    const margin = structuredCricketMargin(words);
    summary = { ...summary, detail: margin === null ? detail : { ...detail, margin } };
  }
  return { state, summary };
}
