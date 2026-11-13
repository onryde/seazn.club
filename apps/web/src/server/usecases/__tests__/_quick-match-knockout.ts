// A knockout quick match, for the tests of what a knockout's home, pad, list and admin row show.
//
// Owner 2026-11-12 ("take out"): a guest is offered League only for now, so the guarded create (`createQuickMatch`, what
// the route calls) refuses every knockout with QUICK_MATCH_FORMAT_NOT_OFFERED (quick-match-create.test.ts sweeps it).
// What a knockout looks like once made is KEPT for League + Knockout, which comes in a later PR and reuses the knockout
// stage, so its tests still need one: they make it through the unguarded tree, the same real producer the guarded create
// calls after its checks — never a hand-written row.
import type { CreateQuickMatch } from "@/server/api-v1/schemas";
import { createQuickMatch, createQuickMatchTree, sealNewHomeToken, type CreatedQuickMatch } from "../quick-match-create";

/** Make `input` as a quick match: a league through the guarded create a guest's post reaches, a knockout through the
 *  unguarded tree (no offer, cap or analytics step: the guarded create no longer lets one through). */
export async function createQuickMatchAnyFormat(
  input: CreateQuickMatch,
  ctx: { visitorHash: string; baseUrl?: string; now?: Date },
): Promise<CreatedQuickMatch> {
  if (input.format === "league") return createQuickMatch(input, { ...ctx, mailAllowed: async () => true });
  if (input.format !== "knockout") throw new Error(`a quick match is a league or a knockout, not ${String(input.format)}`);
  const { kind, ...rest } = input;
  return createQuickMatchTree(rest, kind, { ...ctx, home: sealNewHomeToken() });
}
