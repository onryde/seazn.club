// W2d Task 15 (spec §9) — the Tie-breaks section is MOUNTED on the stage card, after the Points section, and gets what the
// page hands the panel: the stage's table rules (`stageTableRules`, the API's one loader), the server's lock list
// (`formatLockedStageIds`) and the stage rows a cross-group line reads (pooled, a later best-Nth take). Node env, no DOM: a
// static render settles "is it on the card, in which state" — the wiring a section test cannot see (AGENTS.md class 2).
// Saving, the pin at generate and the lock after a first score are the browser's (`e2e/stage-tiebreaks-w2d.spec.ts`).
// Expected values come from the engine (`DRAW_KINDS`, `BRACKET_KINDS`, `resolveTableRules` via the shared fixture); every
// sweep reports its count and zero is a failure.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { StagesPanel } from "@/components/v2/stages-panel";
import { BRACKET_KINDS, DRAW_KINDS } from "@seazn/engine/core";
import { builtinModules } from "@seazn/engine/sports";
import type { TableStageKind } from "@seazn/engine/sport";
import enUi from "@/dictionaries/en/ui.json";
import type { StageTableRules } from "@/server/api-v1/schemas";
import { tableRulesOf } from "../stage-rules/__tests__/_table-rules-fixture";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("@/components/ui/confirm-provider", () => ({
  useConfirm: () => vi.fn(async () => false),
}));

const UI = enUi as Record<string, string>;
const A = "11111111-1111-4111-8111-111111111111";
const B = "33333333-3333-4333-8333-333333333333";
const football = builtinModules.find((m) => m.key === "football")!; // single-sport: the MOUNT is under test; the section's sport sweeps are stage-tiebreaks-section.test.tsx

function panel(over: Record<string, unknown> = {}): string {
  // single-sport: the panel's sportKey only names the module the mount reads; the section's sport sweeps are elsewhere
  return renderToStaticMarkup(
    <StagesPanel
      divisionId="d1"
      competitionId="c1"
      orgSlug="o"
      compSlug="c"
      divSlug="d"
      stages={[{ id: A, seq: 1, kind: "league", name: "League", config: {}, progression: null, status: "active" }]}
      fixtures={[]}
      entrantNames={{}}
      canEdit
      sportKey="football"
      divisionConfig={{}}
      tz="UTC"
      orgTz="UTC"
      canExport={false}
      viewerPlan={{ plan: "pro", isStaff: false } as never}
      {...over}
    />,
  );
}
const stageOf = (kind: string, name = "Stage"): Record<string, unknown>[] => [
  { id: A, seq: 1, kind, name, config: {}, progression: null, status: "active" },
];
const rulesFor = (kind: string): Record<string, StageTableRules> => ({ [A]: tableRulesOf(football, kind as TableStageKind) });
const sectionAt = (html: string, id = A): number => html.indexOf(`data-testid="stage-tiebreaks-${id}"`);
const stateOf = (html: string, id = A): string | null =>
  new RegExp(`data-testid="stage-tiebreaks-${id}" data-state="([a-z]+)"`).exec(html)?.[1] ?? null;

describe("the Tie-breaks section is on a TABLE stage's card, after Points, and on no other", () => {
  it("sweep: every table kind and every bracket kind, rules handed for each — present iff the engine says the kind has a table", () => {
    let present = 0;
    let absent = 0;
    for (const kind of [...DRAW_KINDS, ...BRACKET_KINDS] as string[]) {
      // A bracket stage has no table rules to serve; handing one anyway proves the card, not the loader, keeps it off.
      const rules = { [A]: tableRulesOf(football, "league") };
      const html = panel({ stages: stageOf(kind), stageTableRules: rules });
      const table = (DRAW_KINDS as ReadonlySet<string>).has(kind);
      expect(sectionAt(html) > -1, kind).toBe(table);
      if (table) {
        const points = html.indexOf(`data-testid="stage-points-${A}"`);
        expect(points, `${kind}: the points section`).toBeGreaterThan(-1);
        expect(sectionAt(html), `${kind}: tie-breaks after points`).toBeGreaterThan(points);
        present++;
      } else absent++;
    }
    expect(present, "table kinds").toBe(DRAW_KINDS.size);
    expect(absent, "bracket kinds").toBe(BRACKET_KINDS.size);
  });

  it("no table rules handed for the stage (its rules do not read): no section, never a guessed order (R3)", () => {
    expect(sectionAt(panel({ stageTableRules: {} }))).toBe(-1);
    expect(sectionAt(panel())).toBe(-1);
    // Rules for ANOTHER stage id do not leak onto this card.
    expect(sectionAt(panel({ stageTableRules: { [B]: tableRulesOf(football, "league") } }))).toBe(-1);
  });

  it("the order listed is the one handed for THIS stage", () => {
    const rules = rulesFor("league");
    const html = panel({ stageTableRules: rules });
    const keys = [...html.matchAll(/data-testid="stage-tiebreaks-row-\d+" data-key="([a-z_0-9]+)"/g)].map((x) => x[1]);
    expect(keys).toEqual(rules[A]!.tiebreakers.keys);
  });
});

describe("the lock is the server's list (OC2)", () => {
  it("listed in formatLockedStageIds: locked, ONE 🔒 line in organiser words; not listed: the editor; a viewer: read-only", () => {
    const rules = rulesFor("league");
    const locked = panel({ stages: stageOf("league", "Spring League"), stageTableRules: rules, formatLockedStageIds: [A] });
    expect(stateOf(locked)).toBe("locked");
    expect(locked).toContain(UI["stageCard.locked"]!);
    expect(locked.split('data-testid="stage-tiebreaks-locked"').length - 1, "one lock line").toBe(1);
    expect(stateOf(panel({ stageTableRules: rules }))).toBe("editor");
    expect(stateOf(panel({ stageTableRules: rules, formatLockedStageIds: [B] })), "another stage's lock").toBe("editor");
    expect(stateOf(panel({ stageTableRules: rules, canEdit: false }))).toBe("readonly");
  });
});

describe("the cross-group line reads the panel's stage rows (§5.9)", () => {
  const group = { id: A, seq: 1, kind: "group", name: "Groups", config: {}, progression: null, status: "active" };
  const ko = (take: Record<string, unknown>[]) => ({
    id: B,
    seq: 2,
    kind: "single_elim",
    name: "Knockout",
    config: {},
    progression: { sources: [{ stage: "previous", take }] },
    status: "setup",
  });

  it("a group stage the next stage takes a best-Nth from shows it; a top-N take does not", () => {
    const rules = rulesFor("group");
    const best = panel({ stages: [group, ko([{ kind: "topNPerGroup", n: 2 }, { kind: "bestNth", nth: 3, count: 2 }])], stageTableRules: rules });
    expect(best).toContain('data-testid="stage-tiebreaks-cross-group"');
    const top = panel({ stages: [group, ko([{ kind: "topNPerGroup", n: 2 }])], stageTableRules: rules });
    expect(top).not.toContain('data-testid="stage-tiebreaks-cross-group"');
  });
});
