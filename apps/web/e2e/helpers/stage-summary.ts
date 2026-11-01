// Match Day C3 (review m6): what a stage card's one-line summary SAYS, read from the declarations the product words it from - the public
// site's describers over the cfg the stage plays, the public dictionary's clause words, and the ui dictionary's summary copy - so a test
// pins the copy instead of "it says something". Nothing here is a string typed for a particular sport.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { StageKind } from "@seazn/engine/core";
import { builtinModules } from "@seazn/engine/sports";
import { rulesLineText } from "../../src/lib/rules-line";
import { describeDeciders, describeMatchRules } from "../../src/server/public-site/describe-rules";

const read = (name: "ui" | "public"): Record<string, string> =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../src/dictionaries/en/${name}.json`, import.meta.url)), "utf8")) as Record<string, string>;
const UI = read("ui");
const PUB = read("public");

/** The sport's shipped module (a sport the registry does not have is a failure, not a skip). */
export function moduleOf(sportKey: string): (typeof builtinModules)[number] {
  const m = builtinModules.find((x) => x.key === sportKey);
  if (!m) throw new Error(`stage-summary: no module for sport "${sportKey}"`);
  return m;
}

/** The format clause the summary opens with: the stage's match rules and how a level match ends for this kind, in the public line's
 *  words (`rulesLineText`: only its first letter capitalised). `cfg` is the cfg the stage plays under - the server's own fold
 *  (`GET /fixtures/{id}/rules`) or the engine's declared defaults, never one built from the page. Zero clauses is a failure. */
export function summaryFormatText(sportKey: string, kind: StageKind, cfg: unknown): string {
  const m = moduleOf(sportKey);
  const clauses = [...(describeMatchRules(sportKey, m, cfg) ?? []), ...describeDeciders(m, kind, cfg)];
  if (clauses.length === 0) throw new Error(`stage-summary: ${sportKey}/${kind} has no format clauses to say`);
  return rulesLineText(PUB, clauses);
}

/** "Win 2 · Loss 0": the uniform points clause, from the engine's own pair for the stage's table. */
export function summaryPointsText(win: number, loss: number): string {
  return UI["stageCard.points.uniform"]!.replace("{w}", String(win)).replace("{l}", String(loss));
}

/** "Ties: " - the words the ties clause opens with, before the steps. */
export function summaryTiesPrefix(): string {
  return UI["stageCard.summary.ties"]!.split("{steps}")[0]!;
}

export const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
