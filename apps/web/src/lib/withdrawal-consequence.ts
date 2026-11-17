// W5 T8b Part 3 (X-WDT-10, owner ruling 289's condition: "clear instruction when DQ") — the plain copy a Disqualify shows
// BEFORE it is confirmed, on the pad's sanction ending and in the organiser's Entrants menu: which remaining matches are taken
// out, whether the played results stand or are removed under ruling 277's 50 percent rule with THIS entrant's own count, and
// whether it can be undone.
//
// The numbers are never worked out here. They come from the cascade's own decision (`decideTableWithdrawal`, read through
// `previewWithdrawal`, server/usecases/withdrawal-preview.ts) and travel on the wire as `WithdrawalPreview`; this module only
// turns one decision into message keys and their values. Pure, no I/O, no server import: the pad and the console both render it.
//
// Undo is Reinstate in every case a preview reaches, and what Reinstate then does is read from the code, not promised here:
// a league or group reverses the cascade exactly (RB5-W6, `reinstateTableEntrant`); a Swiss reinstate is an arrival who
// rejoins, rounds she missed scoring nothing (W3 T9, ruling 251); a knockout reinstate WAITS for the organiser to place her
// (W4 T11, `admitKnockoutLateEntrant`).

/** How the stage settles her lines: a league or group under half played `expunge`s, at half or more (and every Swiss) the
 *  played results stand as an `award` and the rest walk over; a bracket walks her open lines over (`bracket_walkover`). */
export type ConsequenceMode = "expunge" | "award" | "bracket_walkover";
/** What Reinstate does afterwards, per stage kind (the file header). */
export type ConsequenceUndo = "restores" | "rejoins" | "waits";

/** One stage of a preview, as `previewWithdrawal` returns it. */
export interface WithdrawalPreviewStage {
  stage_id: string;
  stage_kind: string;
  mode: ConsequenceMode;
  /** RB5-W4: her lines with a recorded result (an in-match disqualification's own match included). */
  played: number;
  /** played + pending. */
  scheduled: number;
  /** Her lines still to play, the ones the confirmation takes out. `opponent` is null for a seat not yet filled. */
  pending: { fixture_id: string; opponent: string | null; round_no: number }[];
  undo: ConsequenceUndo;
}

/** `GET /api/v1/entrants/{id}/withdrawal-preview` and `GET /api/v1/fixtures/{id}/withdrawal-preview`. */
export interface WithdrawalPreview {
  entrant_id: string;
  name: string;
  as: "withdrawn" | "disqualified";
  /** The division has started: before Start a departure is a plain status flip and no match is touched. */
  started: boolean;
  /** False when the write settles nothing beyond its own match: an entrant already departed, or a disqualification recorded in
   *  a bracket match (W4: the bracket's own forfeit). The confirmation then shows no consequence block. */
  cascade: boolean;
  stages: WithdrawalPreviewStage[];
}

export const WITHDRAWAL_CONSEQUENCE_KEYS = [
  "withdrawal.consequence.title",
  "withdrawal.consequence.loading",
  "withdrawal.consequence.failed",
  "withdrawal.consequence.notStarted",
  "withdrawal.consequence.remaining",
  "withdrawal.consequence.remainingOne",
  "withdrawal.consequence.noRemaining",
  "withdrawal.consequence.item",
  "withdrawal.consequence.tbd",
  "withdrawal.consequence.expunge",
  "withdrawal.consequence.award",
  "withdrawal.consequence.swiss",
  "withdrawal.consequence.bracket",
  "withdrawal.consequence.undo.reinstate",
  "withdrawal.consequence.undo.rejoin",
  "withdrawal.consequence.undo.bracket",
] as const;
export type WithdrawalConsequenceKey = (typeof WITHDRAWAL_CONSEQUENCE_KEYS)[number];

export interface ConsequenceLine {
  key: WithdrawalConsequenceKey;
  vars: Record<string, string | number>;
  /** The remaining-matches line's list, one entry per match, joined by the renderer into `{list}`. */
  items?: { key: WithdrawalConsequenceKey; vars: Record<string, string | number> }[];
}

const UNDO_KEY: Record<ConsequenceUndo, WithdrawalConsequenceKey> = {
  restores: "withdrawal.consequence.undo.reinstate",
  rejoins: "withdrawal.consequence.undo.rejoin",
  waits: "withdrawal.consequence.undo.bracket",
};

/** One stage's consequence: the remaining matches, the rule with her count, and the undo. */
export function withdrawalConsequence(name: string, stage: WithdrawalPreviewStage): ConsequenceLine[] {
  const n = stage.pending.length;
  const items = stage.pending.map((p): NonNullable<ConsequenceLine["items"]>[number] =>
    p.opponent === null
      ? { key: "withdrawal.consequence.tbd", vars: { round: p.round_no } }
      : { key: "withdrawal.consequence.item", vars: { opponent: p.opponent, round: p.round_no } },
  );
  const remaining: ConsequenceLine =
    n === 0
      ? { key: "withdrawal.consequence.noRemaining", vars: { name } }
      : { key: n === 1 ? "withdrawal.consequence.remainingOne" : "withdrawal.consequence.remaining", vars: { n }, items };
  const counts = { name, played: stage.played, scheduled: stage.scheduled };
  const rule: ConsequenceLine =
    stage.mode === "bracket_walkover"
      ? { key: "withdrawal.consequence.bracket", vars: {} }
      : stage.stage_kind === "swiss"
        ? { key: "withdrawal.consequence.swiss", vars: { name, played: stage.played } }
        : { key: stage.mode === "expunge" ? "withdrawal.consequence.expunge" : "withdrawal.consequence.award", vars: counts };
  return [remaining, rule, { key: UNDO_KEY[stage.undo], vars: {} }];
}

/** The whole confirmation's lines for one preview: none when nothing beyond the match is settled, the not-started sentence
 *  before Start, else every stage's (a started entrant with no line left reads "no remaining matches"). */
export function previewConsequence(preview: WithdrawalPreview): ConsequenceLine[] {
  if (!preview.cascade) return [];
  const reinstate: ConsequenceLine = { key: "withdrawal.consequence.undo.reinstate", vars: {} };
  if (!preview.started) return [{ key: "withdrawal.consequence.notStarted", vars: { name: preview.name } }, reinstate];
  if (preview.stages.length === 0) return [{ key: "withdrawal.consequence.noRemaining", vars: { name: preview.name } }, reinstate];
  return preview.stages.flatMap((s) => withdrawalConsequence(preview.name, s));
}

type TFn = (key: string, vars?: Record<string, string | number>) => string;

/** The lines as sentences, in the reader's locale. A list joins its matches with the locale's own list format. */
export function consequenceSentences(lines: readonly ConsequenceLine[], t: TFn, locale = "en"): string[] {
  return lines.map((l) => {
    if (l.items === undefined) return t(l.key, l.vars);
    const parts = l.items.map((i) => t(i.key, i.vars));
    let list: string;
    try {
      list = new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(parts);
    } catch {
      list = parts.join(", ");
    }
    return t(l.key, { ...l.vars, list });
  });
}
