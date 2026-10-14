// The W2b rows the engine's rules reference owes, typed from the W2b spec (2026-10-08-format-matrix-w2b-design.md §6, Appendix A) and
// the rulings that amended it, and the reader of that spec's Appendix A. SHARED by two checkers: the engine's own
// (test/rules-reference.test.ts: the rows exist, in their files, with their statuses) and the monorepo's
// (scripts/__tests__/rules-reference.test.ts: the rows' TEXT is Appendix A's, which only the monorepo holds). One copy, so the two
// cannot disagree about which ids are owed. Moved out of the engine test by engine-split 1d-5; at 2b (D32) each repo takes what it reads.
import { RULE_ID, type RuleRow } from "../src/testkit/rules-reference.ts";

const W2B_DATE = "2026-10-08";
export const signed = (ruling: number, date = W2B_DATE) => `signed ${ruling} ${date}`;
const deviation = (ruling: number) => `deviation ${ruling} ${W2B_DATE}`;
/** Orchestrator pre-flight rulings are no owner signature (AGENTS.md class 17): their rows stay open until the owner signs. */
export const OPEN = "⬜ open";
/** The rows W2b adds, by rules file, each with the status it must carry. Typed from spec
 *  2026-10-08-format-matrix-w2b-design.md §6 and Appendix A — the spec is the source here, never the parsed files — as the
 *  W2b ledger's rulings amend it (plan PF-13: "53 new ids + CK-WO-2 + X-WD-6, plus the X-BR-1 amendment"):
 *  - Appendix A's 53 new ids, with Appendix A's status (`signed <ruling>` from _INDEX rulings 83–99; BD-WO-2 and BD-RT-1
 *    are recorded deviations);
 *  - CK-WO-2 (plan PF-6): an orchestrator ruling the ledger reported to the owner, OPEN until ruling 125; X-WD-6 (plan PF-7) was the same
 *    until owner ruling 113 (2026-10-11) settled its wording ("Amends X-RS-1, X-RT-1 and X-WD-6"), so it carries 113;
 *  - X-WO-1 and VB-RT-1 carry owner ruling 108 (2026-10-11), which changed their text: a credited result pays the table
 *    points of its credited score (a volleyball side at fault at two sets all takes the 3-2 loss's point);
 *  - X-RS-1 carries owner ruling 113 (2026-10-11), which changed its text after ruling 112 (a walkover stays
 *    recordable after the start until something is played): nothing played means not started, for every reason, and a
 *    retirement waits for play; ruling 114 keeps 112's "played" (any sport event, scoring or not). X-RT-1 carried 113 too;
 *  - X-RT-1, X-PS-1 and X-PS-2 carry owner ruling 115 (2026-10-12), which changed their text ("Amends X-PS-1, X-PS-2
 *    and X-RT-1"): a disqualification with nothing played is treated like a walkover — its credit, and no match in
 *    players' stats. Appendix A carries the same text, so none of the three is in AMENDED_TEXT;
 *  - HK-AB-1 and IH-AB-1 carry owner ruling 117 (2026-10-12), which confirmed R16-3 and qualifies them: where the cfg
 *    refuses a draw, a level abandon is accepted with no result (X-AB-1). Appendix A carries the same text. FB-AB-1 keeps
 *    its text: football takes a draw in every draw kind (football.ts `supportsDraws`), so no football cfg reaches it;
 *  - X-PS-2 and X-AB-1 carry owner ruling 120 (2026-10-12), which amends them ("X-PS-2 and X-AB-1, the stats clause
 *    only"): an abandon counts as a match in players' stats only if something was played before it. Appendix A carries
 *    the same text, so neither is in AMENDED_TEXT;
 *  - GN-RT-1 carries owner ruling 124 (2026-10-13, amends 87): football's FB-RT-1 rule — the walkover credit unless the
 *    recorded score is worse for the offender. Appendix A carries the same text, so it is not in AMENDED_TEXT;
 *  - CK-WO-2 carries owner ruling 125 (2026-10-13), which signed PF-6's row as built (its text unchanged);
 *  - X-PS-1 carries owner ruling 127 (2026-10-13), which amends it after 115: a withdrawal counts as a match in players'
 *    stats if and only if play was recorded before it, still with no personal W/L. Appendix A carries the same text, so
 *    it is not in AMENDED_TEXT. */
export const W2B_ROWS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "cross-sport.md": {
    "X-RS-1": signed(118, "2026-10-12"), "X-RS-2": signed(83), "X-RS-3": signed(83),
    "X-DW-1": signed(84), "X-DW-2": signed(84), "X-DW-3": signed(84), "X-DW-4": signed(85),
    "X-WO-1": signed(108, "2026-10-11"), "X-RT-1": signed(118, "2026-10-12"),
    "X-AB-1": signed(120, "2026-10-12"), "X-AB-2": signed(88), "X-AB-3": signed(88), "X-AB-4": signed(89),
    "X-WD-1": signed(90), "X-WD-2": signed(90), "X-WD-3": signed(90), "X-WD-4": signed(90),
    "X-PS-1": signed(127, "2026-10-13"), "X-PS-2": signed(120, "2026-10-12"), "X-DE-1": signed(93), "X-WD-5": signed(90),
    "X-BL-1": signed(98, "2026-10-09"), "X-WD-6": signed(113, "2026-10-11"),
  },
  "football.md": { "FB-WO-1": signed(86), "FB-RT-1": signed(87), "FB-AB-1": signed(88) },
  "hockey.md": { "HK-WO-1": signed(86), "HK-RT-1": signed(87), "HK-AB-1": signed(117, "2026-10-12") },
  "icehockey.md": { "IH-WO-1": signed(86), "IH-RT-1": signed(87), "IH-AB-1": signed(117, "2026-10-12") },
  "volleyball.md": { "VB-WO-1": signed(86), "VB-RT-1": signed(108, "2026-10-11") },
  "tabletennis.md": { "TT-WO-1": signed(86), "TT-RT-1": signed(87) },
  "tennis.md": { "TN-WO-1": signed(86), "TN-RT-1": signed(87) },
  "badminton.md": { "BD-WO-1": signed(86), "BD-WO-2": deviation(86), "BD-RT-1": deviation(87) },
  "cricket.md": { "CK-WO-1": signed(86), "CK-AB-1": signed(88), "CK-AB-2": signed(88), "CK-WO-2": signed(125, "2026-10-13") },
  "boardgame.md": { "BG-WO-1": signed(86), "BG-DW-1": signed(84), "BG-WO-2": signed(90), "BG-WO-3": signed(99, "2026-10-09") },
  "carrom.md": { "CA-WO-1": signed(86), "CA-RT-1": signed(87), "CA-AB-1": signed(88) },
  "generic.md": { "GN-WO-1": signed(86), "GN-RT-1": signed(124, "2026-10-13"), "GN-AB-1": signed(88) },
};
/** Appendix A's own per-file count ("54 rows: cross-sport.md 23, football.md 3, …"), less the X-BR-1 amendment it counts
 *  in cross-sport, plus PF-7's X-WD-6 (cross-sport) and PF-6's CK-WO-2 (cricket). Pins W2B_ROWS against a dropped entry. */
export const W2B_PER_FILE: Readonly<Record<string, number>> = {
  "cross-sport.md": 23 - 1 + 1, "football.md": 3, "hockey.md": 3, "icehockey.md": 3, "volleyball.md": 2, "tabletennis.md": 2,
  "tennis.md": 2, "badminton.md": 3, "cricket.md": 3 + 1, "boardgame.md": 4, "carrom.md": 3, "generic.md": 3,
};
/** X-BR-1, amended by owner ruling 84 (W2b-R2): "decided only by a win" → "decided only by a win or a double walkover".
 *  W2b's proof of the amended text sits beside W2a's (plan, Task 7: "added to X-BR-1's proved by"). */
export const X_BR_1 = {
  says: "decided only by a win or a double walkover",
  saidBefore: "decided only by a win (",
  status: signed(84),
  proof: "apps/web/src/server/engine-db/__tests__/double-walkover-seating.test.ts",
} as const;
export const w2bIds = (): string[] => Object.values(W2B_ROWS).flatMap((ids) => Object.keys(ids));


/** Everything the parsed rows owe W2b, as data: each pinned id present, in its file, with its status; X-BR-1 amended. */
export function w2bProblems(rows: readonly RuleRow[]): string[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: string[] = [];
  for (const [file, ids] of Object.entries(W2B_ROWS)) {
    for (const [id, status] of Object.entries(ids)) {
      const r = byId.get(id);
      if (r === undefined) { out.push(`${id}: missing (owed in ${file})`); continue; }
      if (r.file !== file) out.push(`${id}: in ${r.file}, not ${file}`);
      if (r.status !== status) out.push(`${id}: status "${r.status}", not "${status}"`);
    }
  }
  const br = byId.get("X-BR-1");
  if (br === undefined) return [...out, "X-BR-1: missing"];
  if (!br.rule.includes(X_BR_1.says) || br.rule.includes(X_BR_1.saidBefore)) out.push(`X-BR-1: the rule does not say "${X_BR_1.says}": ${br.rule}`);
  if (br.status !== X_BR_1.status) out.push(`X-BR-1: status "${br.status}", not "${X_BR_1.status}"`);
  if (!br.provedBy.includes(X_BR_1.proof)) out.push(`X-BR-1: proved by does not name ${X_BR_1.proof}`);
  return out;
}

/** "### `cricket.md`", or "### `football.md (new)`" for a file W2b creates. */
const APPENDIX_SECTION = /^### `([a-z-]+\.md)(?: \(new\))?`/;
export interface AppendixA {
  /** Each row's id, rule text and the rules file its `### \`<file>.md\`` subsection names. */
  readonly rows: readonly { id: string; rule: string; file: string }[];
  /** Row-shaped lines whose id cell is not an id: "X-BR-1 (amend)". */
  readonly amendments: readonly string[];
  /** The total the appendix states of itself ("54 rows: …"). */
  readonly stated: number;
}
/** Appendix A of the W2b spec, from its heading to the next `## ` heading. A row outside a file subsection, a row that is
 *  not 6 cells, a missing stated total and an appendix with no row are refusals, never an empty answer. */
export function readAppendixA(text: string): AppendixA {
  const at = text.indexOf("\n## Appendix A");
  if (at < 0) throw new Error('W2b spec: no "## Appendix A" section');
  const lines = text.slice(at + 1).split("\n");
  const end = lines.findIndex((l, i) => i > 0 && l.startsWith("## "));
  const body = end < 0 ? lines : lines.slice(0, end);
  const stated = /^(\d+) rows: /m.exec(body.join("\n"));
  if (stated?.[1] === undefined) throw new Error('W2b spec: Appendix A no longer states its own total ("N rows: …")');
  let file: string | undefined;
  const rows: { id: string; rule: string; file: string }[] = [];
  const amendments: string[] = [];
  for (const line of body) {
    const h = APPENDIX_SECTION.exec(line);
    if (h?.[1] !== undefined) { file = h[1]; continue; }
    if (!line.startsWith("| ")) continue; // prose, and the |---| separator
    const cells = line.slice(2, -2).split(" | ").map((c) => c.trim());
    if (cells[0] === "id") continue; // the header
    if (cells.length !== 6) throw new Error(`W2b spec: an Appendix A row has ${cells.length} cells, not 6: ${line.slice(0, 48)}`);
    const [id, rule] = cells as [string, string];
    if (!RULE_ID.test(id)) { amendments.push(id); continue; }
    if (file === undefined) throw new Error(`W2b spec: Appendix A row ${id} sits before any \`<file>.md\` subsection`);
    rows.push({ id, rule, file });
  }
  if (rows.length === 0) throw new Error("W2b spec: no row parsed from Appendix A");
  return { rows, amendments, stated: Number(stated[1]) };
}
