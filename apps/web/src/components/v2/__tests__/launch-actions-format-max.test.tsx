// W5 B4 (stress F8; owner 2026-11-21): a division whose field is past its format's max entrants cannot start - the server
// refuses it (FORMAT_TOO_MANY_ENTRANTS, usecases/stages/generate-tx.ts), so Start is disabled before the click and says why in
// the reader's language. The max is the engine-derived one (`formatMaxEntrants`, pinned against the real generators in
// lib/__tests__/format-max-entrants.test.ts); the expected copy is the dictionary's own entry with the numbers put in, never the
// component's output. Sport-agnostic: the gate reads stage kinds and a count, no sport.
import { describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import en from "@/dictionaries/en/ui.json";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import { formatMaxEntrants } from "@/lib/format-max-entrants";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/o/acme/c/champs/d/u12",
}));

import { LaunchActions } from "../launch-actions";

type LaunchProps = Parameters<typeof LaunchActions>[0];
const LEAGUE = { kind: "league", progression: null, config: { legs: 1 } };
const KNOCKOUT = { kind: "knockout", progression: null, config: {} };

const props = (over: Partial<LaunchProps>): LaunchProps =>
  ({
    divisionId: "d1",
    orgSlug: "acme",
    compSlug: "champs",
    divSlug: "u12",
    status: "scheduled",
    canEdit: true,
    fixtures: [],
    fixturesExist: false,
    entrantNames: {},
    stages: [LEAGUE],
    competitionStatus: "published",
    competitionVisibility: "public",
    viewerPlan: "community",
    activeEntrants: 2,
    ...over,
  }) as LaunchProps;

function render(over: Partial<LaunchProps>) {
  const tree = renderIsland(LaunchActions, props(over)).tree();
  const start = tree.find((n) => propsOf(n)["data-testid"] === "launch-start-division") as ReactElement | undefined;
  const reason = tree.find((n) => propsOf(n)["data-testid"] === "launch-start-too-many") as ReactElement | undefined;
  return { start, reason, text: tree.map((n) => textOf(n)).join(" ") };
}

const copy = (max: number, entrants: number) =>
  (en as Record<string, string>)["roundrobin.refusal.FORMAT_TOO_MANY_ENTRANTS"]!.replace("{max}", String(max)).replace("{entrants}", String(entrants));

describe("Start is disabled, with the server's reason, when the field is past its format's max (W5 B4, F8)", () => {
  const max = formatMaxEntrants(LEAGUE)!;

  it("premise: the league has a max, and its copy exists in English", () => {
    expect(max).toBeGreaterThan(2);
    expect((en as Record<string, string>)["roundrobin.refusal.FORMAT_TOO_MANY_ENTRANTS"]).toContain("{max}");
  });

  it("at the max: Start is live and nothing is said", () => {
    const at = render({ activeEntrants: max });
    expect(at.start, "Start renders").toBeDefined();
    expect(propsOf(at.start!).disabled).toBe(false);
    expect(propsOf(at.start!)["aria-describedby"]).toBeUndefined();
    expect(at.reason).toBeUndefined();
  });

  it("one past the max: Start is disabled and the reason names both numbers, tied to the button", () => {
    const over = render({ activeEntrants: max + 1 });
    expect(propsOf(over.start!).disabled).toBe(true);
    expect(over.reason, "the reason renders").toBeDefined();
    expect(textOf(over.reason!)).toBe(copy(max, max + 1));
    expect(propsOf(over.start!)["aria-describedby"]).toBe(propsOf(over.reason!).id);
  });

  it("the ENTRY stage is judged, by seq, whatever order the list arrives in", () => {
    // The league is seq 1, listed second: it is the stage Start draws, so its max binds.
    const leagueFirst = render({ stages: [{ ...KNOCKOUT, seq: 2 }, { ...LEAGUE, seq: 1 }], activeEntrants: max + 1 });
    expect(propsOf(leagueFirst.start!).disabled).toBe(true);
    // A knockout first: a field of max + 1 is well inside a bracket's max, so Start stays live.
    expect(formatMaxEntrants(KNOCKOUT)!, "premise").toBeGreaterThan(max + 1);
    const knockoutFirst = render({ stages: [{ ...LEAGUE, seq: 2 }, { ...KNOCKOUT, seq: 1 }], activeEntrants: max + 1 });
    expect(propsOf(knockoutFirst.start!).disabled).toBe(false);
  });

  it("no stages (the empty case) and a format no field bounds: Start is never gated by the field", () => {
    expect(propsOf(render({ stages: [], activeEntrants: 100_000 }).start!).disabled).toBe(false);
    expect(propsOf(render({ stages: [{ kind: "ladder", progression: null, config: {} }], activeEntrants: 100_000 }).start!).disabled).toBe(false);
  });

  it("a four-digit max reads in the reader's grouping (en: 1,428), as the builder's card says it", () => {
    const SWISS = { kind: "swiss", progression: null, config: {} };
    const swissMax = formatMaxEntrants(SWISS)!;
    expect(swissMax, "premise: a Swiss max past 999").toBeGreaterThan(999);
    const over = render({ stages: [SWISS], activeEntrants: swissMax + 1 });
    const fmt = new Intl.NumberFormat("en");
    expect(textOf(over.reason!)).toBe(
      (en as Record<string, string>)["roundrobin.refusal.FORMAT_TOO_MANY_ENTRANTS"]!.replace("{max}", fmt.format(swissMax)).replace("{entrants}", fmt.format(swissMax + 1)),
    );
  });

  it("a viewer who cannot edit sees neither Start nor the reason", () => {
    const viewer = render({ canEdit: false, activeEntrants: max + 1 });
    expect(viewer.start).toBeUndefined();
    expect(viewer.reason).toBeUndefined();
  });
});
