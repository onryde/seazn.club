// Blog batch 2 (tie-breaks): the same tie-break step in the words of each screen that names it.
//
// The product names a step two ways. The organiser's Standings tab ("Tie-break cascade") and the public table's
// "split on" line say "goal difference" and "goals scored" where the ledger is goals, "run difference" for runs
// (`localizedTieBreakLabel` with the sport's ledger family, as the division page calls it), and "set ratio" and "set
// difference" for every set sport. The stage Tie-breaks editor, the stage card and the division builder name a step in
// the sport's own unit (`unitLabelKey`): "game ratio" and "game difference" in badminton, table tennis and carrom, and a
// plain "difference" where the Standings tab says "goal difference". A post names the screen it means.
//
// Its own file, not labels.ts: `server/blog-index.ts` imports labels.ts for the sport words, and this one pulls the engine
// registry and the public standings view into the module graph. Examples import it; no page may (a guard in
// blog-examples.test.ts lists it beside labels.ts).
import { builtinModules } from "@seazn/engine/sports";
import ui from "@/dictionaries/en/ui.json";
import { localizedTieBreakLabel } from "@/lib/tiebreak-label";
import { unitLabelKey } from "@/lib/stage-card/summaries";
import { sportLedgerFamily } from "@/server/public-site/standings-view";

const UI = ui as Record<string, string>;

function need(id: string, what: string, key: string): string {
  const v = UI[id];
  if (typeof v !== "string" || v.length === 0) throw new Error(`blog label: no ${what} label for '${key}' (${id})`);
  return v;
}

/** A step's name as the Standings tab's cascade line and the public "split on" line print it, for one sport. */
export function standingsLabel(key: string, sportKey: string): string {
  const sport = builtinModules.find((m) => m.key === sportKey);
  if (sport === undefined) throw new Error(`blog label: no sport '${sportKey}'`);
  // A key with no label at all throws, naming it: an example never prints an engine key by falling back to it.
  const plain = need(`div.detail.tiebreak.rule.${key}`, "tie-break", key);
  const family = key === "diff" || key === "for" ? sportLedgerFamily(sport.metrics, key) : undefined;
  const label = localizedTieBreakLabel(UI, key, family);
  if (family !== undefined && family !== "plain" && label === plain) throw new Error(`blog label: no ${family} label for '${key}'`);
  return label;
}

/** A step's name as the stage Tie-breaks editor, the stage card and the division builder print it, for one sport. */
export function editorLabel(key: string, sportKey: string): string {
  return need(unitLabelKey(key, sportKey), "editor tie-break", `${sportKey}/${key}`);
}
