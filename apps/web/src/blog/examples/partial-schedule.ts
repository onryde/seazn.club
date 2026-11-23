// Blog batch 2 (fix round 2): what a table does while the meetings among its level teams are not all played.
//
// A head-to-head step runs only on a COMPLETE mini-schedule. In ten of the eleven sports the step is skipped until then and the
// table goes on to the next check; one sport (ice hockey) DECLARES a partial-schedule order instead (`SportModule.
// partialScheduleOrder`, which the app hands to the ranker in `stage-inputs.ts`): the level teams are ranked by it first, and
// whatever stays level goes on down the list. Two posts say this (#7 and #8), so both examples carry these facts and this one
// claim, read from the declarations of every sport in the registry, never typed.
import { builtinModules } from "@seazn/engine/sports";
import { sportLabel } from "@/blog/labels";
import { standingsLabel } from "@/blog/labels-screens";
import type { Claim } from "./types";

const listOf = (items: readonly string[]) => (items.length < 2 ? (items[0] ?? "none") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`);

/** The sports that declare a partial-schedule order, and the steps it runs (lots is the stage's last step, not one of them), in the Standings tab's words. */
export function partialScheduleFacts(): { sports: string; order: string; count: number } {
  const declaring = builtinModules.filter((m) => m.partialScheduleOrder !== undefined);
  if (declaring.length === 0) throw new Error("partial-schedule: no sport declares a partial-schedule order");
  const orders = new Set(declaring.map((m) => (m.partialScheduleOrder ?? []).filter((k) => k !== "lots").join()));
  if (orders.size !== 1) throw new Error(`partial-schedule: ${declaring.length} sports declare ${orders.size} different orders; the post tells one`);
  const first = declaring[0]!;
  return {
    sports: listOf(declaring.map((m) => sportLabel(m.key))),
    order: (first.partialScheduleOrder ?? []).filter((k) => k !== "lots").map((k) => standingsLabel(k, first.key)).join(", "),
    count: declaring.length,
  };
}

export const partialScheduleClaim: Claim = {
  says: "the sports that declare a partial-schedule order are the ones the facts name, and the order is the declared one, without its lots step",
  source: "every registry module's `partialScheduleOrder` (ice hockey's declares fewest games played, goal difference, goals scored, seed, lots), read as the Standings tab words it; the app passes it to the ranker (`stage-inputs.ts`)",
  check(r) {
    const modules = builtinModules;
    if (modules.length === 0) return "no sports in the registry";
    const declaring = modules.filter((m) => m.partialScheduleOrder !== undefined);
    // Anti-vacuity: the claim is about the ones that declare one AND the ones that do not.
    if (declaring.length === 0) return "no sport declares a partial-schedule order";
    if (declaring.length === modules.length) return "every sport declares one: the post's 'every other sport skips the step' would be false";
    const want = listOf(declaring.map((m) => sportLabel(m.key)));
    if (r.facts.partialScheduleSports !== want) return `partialScheduleSports is '${String(r.facts.partialScheduleSports)}', the declarations give '${want}'`;
    if (r.facts.partialScheduleCount !== declaring.length) return `partialScheduleCount is ${String(r.facts.partialScheduleCount)}, the declarations give ${declaring.length}`;
    const first = declaring[0]!;
    const order = (first.partialScheduleOrder ?? []).filter((k) => k !== "lots").map((k) => standingsLabel(k, first.key)).join(", ");
    return r.facts.partialScheduleOrder === order || `partialScheduleOrder is '${String(r.facts.partialScheduleOrder)}', the declaration gives '${order}'`;
  },
};
