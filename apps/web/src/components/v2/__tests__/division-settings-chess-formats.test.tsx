// Chess is individual-only (owner ruling 2026-10-26; follow-up to #1027): the division Settings format select offers a
// chess division no americano or mexicano, except the structure a division stored before the ruling already plays —
// that one stays listed and selected, so the division still shows what it is (re-applying it is the server's refusal).
//
// The harness is division-settings-format-i18n.test.tsx's (renderIsland reaches the select inside the closed Group);
// useMsg is left real here, so options are compared by their `value`, which is the template key.
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { renderIsland, propsOf, walk } from "@/components/__tests__/_hook-harness";
import { DivisionSettings } from "@/components/v2/division-settings";
import { STAGE_TEMPLATES } from "@/lib/format-templates";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

const REFUSED_FOR_CHESS = ["americano", "mexicano"];
const ALL_KEYS = STAGE_TEMPLATES.map((t) => t.key);

type Stage = { name: string; kind: string; config: Record<string, unknown> | null; progression: null };

function mount(sport_key: string, variant_key: string, stages: Stage[]) {
  return renderIsland(DivisionSettings, {
    division: { id: "d1", name: "Open", sport_key, variant_key, config: {}, logo_url: null, logo_storage_path: null },
    orgId: "org1",
    structureLocked: false,
    lockedFields: [],
    stages,
    canEdit: true,
    divisionPathPrefix: "/o/org/c/comp/d/",
    fixturesHref: "/o/org/c/comp/d/div/fixtures",
    embed: <div />,
    danger: <div />,
    autoPosts: false,
    canAutoPost: false,
    showSeeds: true,
    viewerPlan: "community",
    onlineChessOffered: true,
  });
}

/** The format select's own option values, and the value it opens at. */
function formatSelect(h: ReturnType<typeof mount>): { values: string[]; value: unknown } {
  const select = h.tree().find((e) => e.type === "select" && propsOf(e)["data-testid"] === "format-template");
  if (!select) throw new Error('format <select data-testid="format-template"> not found');
  const values = walk((propsOf(select).children as ReactNode) ?? null)
    .filter((e) => e.type === "option")
    .map((e) => String(propsOf(e).value));
  return { values, value: propsOf(select).value };
}

const AMERICANO: Stage = { name: "Americano", kind: "americano", config: { mode: "americano", courtCount: 2, rounds: 7 }, progression: null };
const MEXICANO: Stage = { name: "Mexicano", kind: "americano", config: { mode: "mexicano", courtCount: 2, rounds: 7 }, progression: null };
const LEAGUE: Stage = { name: "League", kind: "league", config: { legs: 1 }, progression: null };

describe("division Settings offers a chess division no americano or mexicano (follow-up to #1027)", () => {
  it("a chess league: every template but americano and mexicano is an option, the league selected (counts)", () => {
    const s = formatSelect(mount("boardgame", "blitz", [LEAGUE]));
    expect(s.values).toEqual(ALL_KEYS.filter((k) => !REFUSED_FOR_CHESS.includes(k)));
    expect(s.values).toHaveLength(ALL_KEYS.length - 2);
    expect(s.value).toBe("league");
  });

  it("empty case: a chess division with no stages yet is offered the same list and opens at league", () => {
    const s = formatSelect(mount("boardgame", "blitz", []));
    expect(s.values).toEqual(ALL_KEYS.filter((k) => !REFUSED_FOR_CHESS.includes(k)));
    expect(s.value).toBe("league");
  });

  it("a chess division stored with americano (or mexicano) before the ruling still shows it: listed and selected, the other one absent", () => {
    const a = formatSelect(mount("boardgame", "blitz", [AMERICANO]));
    expect(a.value).toBe("americano");
    expect(a.values).toEqual(ALL_KEYS.filter((k) => k !== "mexicano"));
    const m = formatSelect(mount("boardgame", "blitz", [MEXICANO]));
    expect(m.value).toBe("mexicano");
    expect(m.values).toEqual(ALL_KEYS.filter((k) => k !== "americano"));
  });

  it("the positive pair: a badminton division is offered every template, americano and mexicano among them", () => {
    const s = formatSelect(mount("badminton", "bwf", [LEAGUE]));
    expect(s.values).toEqual(ALL_KEYS);
    for (const k of REFUSED_FOR_CHESS) expect(s.values).toContain(k);
  });
});
