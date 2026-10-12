// W2b Task 13 (spec §5.5 "Public", UI-2 option A) — the ONE reader that turns a fixture's outcome and its ledger into
// the public tag ("w/o", "ret.", "DQ", "2× w/o", "Aband. · DLS", "Aband. · NR", "Aband.") and the full sentence that is
// its tooltip, its accessible name and the match centre's line. Every public surface calls this — the match centre
// (server/public-site/match-centre.ts), the competition hub's cards and bracket tiles (competition-hub.ts →
// match-card.tsx, knockout-tab.tsx), the live score (live-score.tsx) and the division page's result line
// (v2/stages-panel.tsx `outcomeText`, read by the run sheet) — so no two of them can name one result two ways.
//
// What it reads, and from where:
//  - A forfeit's KIND is `forfeitCopyKind`'s (Task 12, lib/forfeit-copy-kind.ts), the one classifier the pad, the
//    timeline and the event copy already speak through. An award carries its reason on the outcome (D2), and a double
//    walkover is a forfeit "by both" — so the outcome is put to the classifier in the payload shape it reads, never
//    mapped a second time here.
//  - An ABANDON is read from the LEDGER (§5.4: "an active `core.abandon` and its reason"), never the fixture status.
//    After ST-G1 an abandon with a result is `decided` like any other result, and a DLS win is ALSO how a
//    rain-reduced chase that was played out ends — the status cannot tell the two apart, the ledger can.
//  - A bye keeps today's copy: no tag (the vocabulary is total over the engine's award reasons, and a bye maps to none).
//
// Client-safe (no `server-only`): the hub's islands and the live score render it in the browser.
import type { OutcomeKind } from "@seazn/engine/core";
import { forfeitCopyKind, type ForfeitCopyKind } from "./forfeit-copy-kind";
import { interpolate } from "./i18n-runtime";

/** What a surface hands the reader from its ledger: the ACTIVE `core.abandon` (one no `core.void` targets) and its
 *  reason, or none. A surface with no ledger at all passes `NO_LEDGER` — and then shows no abandon tag, never one
 *  guessed from the status. */
export interface ForfeitLedger {
  readonly abandon: { readonly reason: string } | null;
}
export const NO_LEDGER: ForfeitLedger = { abandon: null };

/** The ledger as a stored projection reads it (`activeAbandonReasonSql`, server/engine-db/recorded-abandon.ts): the
 *  active abandon's reason, or null. An empty reason is not one (`CoreAbandon` refuses it). */
export function forfeitLedgerOfReason(reason: string | null | undefined): ForfeitLedger {
  return typeof reason === "string" && reason !== "" ? { abandon: { reason } } : NO_LEDGER;
}

/** The ledger from a fixture's ACTIVE events (voids already resolved — `resolveVoids`): its last `core.abandon`.
 *  The kernel refuses a second abandon once one has decided, so "last" only matters to a ledger it would refuse.
 *  A withdrawal's EXPUNGE (`expunge: true`, withdrawal.ts `expungeAbandon`, D5) is no abandon to this reader: it took
 *  the match out of the table altogether, nothing is owed on it, and it reads as it always has (T16 review m3) —
 *  `activeAbandonReasonSql` answers the same. */
export function forfeitLedgerOf(events: readonly { readonly type: string; readonly payload: unknown }[]): ForfeitLedger {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type !== "core.abandon") continue;
    const payload = e.payload as { reason?: unknown; expunge?: unknown } | null;
    if (payload?.expunge === true) return NO_LEDGER;
    return forfeitLedgerOfReason(typeof payload?.reason === "string" ? payload.reason : null);
  }
  return NO_LEDGER;
}

/** The abandon tags, by what the abandon left behind (UI-2 / public-copy.html). */
type AbandonTagKind = "abandoned_dls" | "abandoned_no_result" | "abandoned";
/** Every tag the reader can answer. A bye is not one: it keeps today's copy. */
export type ForfeitTagKind = Exclude<ForfeitCopyKind, "bye"> | AbandonTagKind;

/** The outcome kinds an abandon can leave behind that the reader tags from the ledger — the played-result kinds
 *  (an award and a double walkover are forfeits, tagged by their own kind). Exported for the SQL ledger read, which
 *  probes the ledger only for rows the reader could tag (one list, so the two cannot drift). */
export const ABANDON_RESULT_KINDS = ["win", "draw", "tie", "no_result"] as const satisfies readonly OutcomeKind[];
/** The win methods an abandon decides with: cricket's DLS par (cricket.ts `applyAbandon`) and the award policy's
 *  leader (football.ts / period kernel `applyAbandon`, W2b D8). A win by any other method beside an active abandon —
 *  a settle's `settled_*`, which says how it was decided itself — is not tagged. */
export const ABANDON_WIN_METHODS = ["dls", "abandoned"] as const;

/** One key per tag (public.json). A walkover and a withdrawal share "w/o" (X-RS-2); their sentences differ. */
export const FORFEIT_TAG_KEY = {
  walkover: "forfeit.tag.walkover",
  withdrew: "forfeit.tag.walkover",
  retired: "forfeit.tag.retired",
  disqualified: "forfeit.tag.disqualified",
  double_walkover: "forfeit.tag.doubleWalkover",
  abandoned_dls: "forfeit.tag.abandonedDls",
  abandoned_no_result: "forfeit.tag.abandonedNoResult",
  abandoned: "forfeit.tag.abandoned",
} as const satisfies Record<ForfeitTagKind, string>;

/** One sentence per tag (public.json). Each forfeit sentence names the offending side (X-RS-2); an abandon's names its
 *  reason and carries the surface's own result sentence as `{result}` (X-AB-2). */
export const FORFEIT_SENTENCE_KEY = {
  walkover: "forfeit.sentence.walkover",
  withdrew: "forfeit.sentence.withdrew",
  retired: "forfeit.sentence.retired",
  disqualified: "forfeit.sentence.disqualified",
  double_walkover: "forfeit.sentence.doubleWalkover",
  abandoned_dls: "forfeit.sentence.abandoned",
  abandoned_no_result: "forfeit.sentence.abandoned",
  abandoned: "forfeit.sentence.abandoned",
} as const satisfies Record<ForfeitTagKind, string>;

/** X-DW-1's second clause: the side the double walkover's next match was walked over to. */
export const DOUBLE_WALKOVER_NEXT_KEY = "forfeit.sentence.doubleWalkoverNext";
/** An abandon whose surface has no result sentence of its own to append. */
export const ABANDONED_BARE_KEY = "forfeit.sentence.abandonedBare";

export type ForfeitTagKey = (typeof FORFEIT_TAG_KEY)[ForfeitTagKind];
export type ForfeitSentenceKey =
  | (typeof FORFEIT_SENTENCE_KEY)[ForfeitTagKind]
  | typeof DOUBLE_WALKOVER_NEXT_KEY
  | typeof ABANDONED_BARE_KEY;
/** Every key this reader can name — for the dictionary gates (forfeit-tag.test.ts). */
export const FORFEIT_TAG_KEYS: readonly ForfeitTagKey[] = [...new Set<ForfeitTagKey>(Object.values(FORFEIT_TAG_KEY))];
export const FORFEIT_SENTENCE_KEYS: readonly ForfeitSentenceKey[] = [
  ...new Set<ForfeitSentenceKey>([...Object.values(FORFEIT_SENTENCE_KEY), DOUBLE_WALKOVER_NEXT_KEY, ABANDONED_BARE_KEY]),
];

export interface ForfeitTag {
  readonly kind: ForfeitTagKind;
  readonly tagKey: ForfeitTagKey;
  readonly sentenceKey: (typeof FORFEIT_SENTENCE_KEY)[ForfeitTagKind];
  /** Entrant IDS, never names (each surface resolves its own, masked as it masks them), and an abandon's reason. */
  readonly params: { readonly winner?: string; readonly loser?: string; readonly reason?: string };
}

const ABANDON_KINDS: ReadonlySet<string> = new Set(ABANDON_RESULT_KINDS);
const ABANDON_METHODS: ReadonlySet<string> = new Set(ABANDON_WIN_METHODS);

function tagOf(kind: ForfeitTagKind, params: ForfeitTag["params"]): ForfeitTag {
  return { kind, tagKey: FORFEIT_TAG_KEY[kind], sentenceKey: FORFEIT_SENTENCE_KEY[kind], params };
}

/** The abandon tag an outcome takes beside an active abandon, or null when the outcome is not one an abandon leaves. */
function abandonKindOf(o: { kind?: unknown; method?: unknown }): AbandonTagKind | null {
  if (typeof o.kind !== "string" || !ABANDON_KINDS.has(o.kind)) return null;
  if (o.kind === "no_result") return "abandoned_no_result";
  if (o.kind !== "win") return "abandoned"; // a level abandon: an award-policy draw, a 2-innings draw, a tie
  if (typeof o.method !== "string" || !ABANDON_METHODS.has(o.method)) return null;
  return o.method === "dls" ? "abandoned_dls" : "abandoned";
}

/**
 * The tag and sentence for a fixture's outcome, or null — a played result, a bye, no outcome with no abandon, or an
 * abandon the ledger does not hold. `outcome` is the stored `MatchOutcome` as any surface holds it (loose JSON is fine).
 *
 * T16 review m3 (X-AB-1): NO outcome beside an active abandon is an abandon that decided nobody — out of the table,
 * flagged for replay or settle (a replay-policy abandon; R16-3's level abandon where the cfg refuses a draw) — and reads
 * "abandoned" with its reason, as a level one does. Before, it read nothing, so R16-3 took the public "Abandoned
 * (reason)" off a no-draw cfg's bracket abandon, which had been a (tagged) draw.
 */
export function forfeitTag(outcome: unknown, ledger: ForfeitLedger): ForfeitTag | null {
  if (outcome === null || outcome === undefined) return ledger.abandon === null ? null : tagOf("abandoned", { reason: ledger.abandon.reason });
  if (typeof outcome !== "object") return null;
  const o = outcome as { kind?: unknown; winner?: unknown; loser?: unknown; reason?: unknown; method?: unknown };
  const ids = {
    ...(typeof o.winner === "string" ? { winner: o.winner } : {}),
    ...(typeof o.loser === "string" ? { loser: o.loser } : {}),
  };
  if (o.kind === "award") {
    const kind = forfeitCopyKind({ reason: o.reason });
    // A bye (and a reason-less legacy award, which is the bye it always was — C-5) keeps today's copy.
    if (kind === null || kind === "bye") return null;
    // Every forfeit award the engine writes names its loser (D9); one that does not is not a forfeit we can word —
    // the sentence names the offending side, and there is none to name.
    if (ids.loser === undefined) return null;
    return tagOf(kind, ids);
  }
  if (o.kind === "double_walkover") {
    const kind = forfeitCopyKind({ by: "both" });
    return kind === "double_walkover" ? tagOf(kind, {}) : null;
  }
  if (ledger.abandon === null) return null;
  const kind = abandonKindOf(o);
  return kind === null ? null : tagOf(kind, { ...ids, reason: ledger.abandon.reason });
}

/**
 * Owner ruling 116 / R116-1 — the entrant an EMPTY seat names, or null. A knockout winner who withdrew while her next
 * tie's opponent was TBD left that seat dead, and the side that arrived walked over HER: the award names her as its
 * loser (`awardSeededByes`, reason "withdrew") while she is never seated. Such a tie reads as a walkover, never a bye,
 * so every public surface prints HER name in the empty seat — as any walkover names the side that did not play —
 * where it would print the seat's stored bye label. Read through `forfeitTag`, the one reader: only a forfeit it tags
 * names a loser, so a genuine bye (no loser), a disqualified winner's dead seat (a bye: nobody is named) and a seated
 * loser all answer null, and the seat keeps the text it always had.
 *
 * The seat must be the empty one facing the award's seated winner; anything else (both seats empty, the loser seated)
 * is not this shape and names nobody.
 */
export function unseatedForfeitLoser(
  fixture: { readonly outcome: unknown; readonly home_entrant_id: string | null; readonly away_entrant_id: string | null },
  seat: "home" | "away",
): string | null {
  const tag = forfeitTag(fixture.outcome, NO_LEDGER);
  const { winner, loser } = tag?.params ?? {};
  if (winner === undefined || loser === undefined) return null;
  const [mine, theirs] =
    seat === "home" ? [fixture.home_entrant_id, fixture.away_entrant_id] : [fixture.away_entrant_id, fixture.home_entrant_id];
  return mine === null && theirs === winner && loser !== winner ? loser : null;
}

/** A sentence as a dictionary key and EXACTLY the params its template names (the match centre ships it as a `Msg`,
 *  and `match-centre-msg-params.test.ts` fails a param the template drops). Names are resolved by the caller's
 *  `nameOf` — each surface masks names its own way. `result` is the surface's own result sentence for an abandon
 *  ("Eagles won by 12 runs (DLS)"), already in words; `next` the name of the side a double walkover's next match was
 *  walked over to (X-DW-1, `doubleWalkoverNextWinner`), when there is one. */
export interface ForfeitSentence {
  readonly key: ForfeitSentenceKey;
  readonly params?: Record<string, string>;
}
export function forfeitSentence(
  tag: ForfeitTag,
  nameOf: (entrantId: string) => string,
  extra: { readonly result?: string | null; readonly next?: string | null } = {},
): ForfeitSentence {
  if (tag.kind === "double_walkover") {
    const next = extra.next ?? null;
    return next !== null && next !== "" ? { key: DOUBLE_WALKOVER_NEXT_KEY, params: { next } } : { key: tag.sentenceKey };
  }
  if (tag.sentenceKey === FORFEIT_SENTENCE_KEY.abandoned) {
    const reason = tag.params.reason ?? "";
    const result = extra.result ?? null;
    return result !== null && result !== ""
      ? { key: tag.sentenceKey, params: { reason, result } }
      : { key: ABANDONED_BARE_KEY, params: { reason } };
  }
  // A forfeit: the sentence names the OFFENDING side (X-RS-2). `forfeitTag` refuses a forfeit with no loser.
  return { key: tag.sentenceKey, params: { loser: nameOf(tag.params.loser ?? "") } };
}

/** The tag and its sentence in words, through a surface's own translator (`t` bound to its dictionary, or
 *  `forfeitCopyLookup` over a pre-resolved `ForfeitCopy`). */
export interface ForfeitWords {
  readonly kind: ForfeitTagKind;
  readonly tag: string;
  readonly sentence: string;
}
export function forfeitWords(
  tag: ForfeitTag,
  lookup: (key: ForfeitTagKey | ForfeitSentenceKey, vars?: Record<string, string>) => string,
  nameOf: (entrantId: string) => string,
  extra: { readonly result?: string | null; readonly next?: string | null } = {},
): ForfeitWords {
  const s = forfeitSentence(tag, nameOf, extra);
  return { kind: tag.kind, tag: lookup(tag.tagKey), sentence: lookup(s.key, s.params) };
}

/** Every tag and sentence template, pre-resolved from one dictionary — a plain object, so a server page can hand it
 *  to a client component (the live score, the run sheet) the way `decidedTemplates` is handed over. */
export type ForfeitCopy = Readonly<Record<ForfeitTagKey | ForfeitSentenceKey, string>>;
export function forfeitCopyOf(resolve: (key: ForfeitTagKey | ForfeitSentenceKey) => string): ForfeitCopy {
  return Object.fromEntries([...FORFEIT_TAG_KEYS, ...FORFEIT_SENTENCE_KEYS].map((k) => [k, resolve(k)])) as ForfeitCopy;
}
/** A translator over a `ForfeitCopy`, substituting `{param}`s exactly as `t()` does (`interpolate`). */
export function forfeitCopyLookup(copy: ForfeitCopy) {
  return (key: ForfeitTagKey | ForfeitSentenceKey, vars?: Record<string, string>): string =>
    interpolate(copy[key] ?? key, vars);
}

/** X-DW-1 — who a double walkover's next match was walked over to: the line must feed a next match (D19,
 *  `feedsNextMatch`), and that match must actually stand walked over — the cascade's seat-arrival walkover, an award
 *  naming its winner. The rule is not restated here: the caller hands `feeds` (its `feedsNextMatch` reading) and the
 *  next fixture as it is stored. Anything else — no next match, a next match still waiting for its other side, or one
 *  voided because both its feeders died — has no clause. */
export function doubleWalkoverNextWinner(
  feeds: boolean,
  next: { readonly outcome: unknown } | null | undefined,
): string | null {
  if (!feeds || next == null || next.outcome === null || typeof next.outcome !== "object") return null;
  const o = next.outcome as { kind?: unknown; winner?: unknown };
  return o.kind === "award" && typeof o.winner === "string" && o.winner !== "" ? o.winner : null;
}
