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
import { engineEntrantKinds } from "@/lib/__tests__/_engine-entrant-kinds";
import { builtinModules } from "@seazn/engine/sports";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

const REFUSED_FOR_CHESS = ["americano", "mexicano"];
// Every template but the Triple round robin, which no sport is offered (owner ruling 2026-11-01, Match Day D1;
// triple-rr-retired.test.tsx sweeps it).
const OFFERED_KEYS = STAGE_TEMPLATES.map((t) => t.key).filter((k) => k !== "triple_rr");

type Stage = { name: string; kind: string; config: Record<string, unknown> | null; progression: null };

function mount(sport_key: string, variant_key: string, stages: Stage[]) {
  return renderIsland(DivisionSettings, {
    division: { id: "d1", name: "Open", sport_key, variant_key, config: {}, logo_url: null, logo_storage_path: null },
    orgId: "org1",
    entrantKinds: engineEntrantKinds(sport_key),
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
    expect(s.values).toEqual(OFFERED_KEYS.filter((k) => !REFUSED_FOR_CHESS.includes(k)));
    expect(s.values).toHaveLength(OFFERED_KEYS.length - 2);
    expect(s.value).toBe("league");
  });

  it("empty case: a chess division with no stages yet is offered the same list and opens at league", () => {
    const s = formatSelect(mount("boardgame", "blitz", []));
    expect(s.values).toEqual(OFFERED_KEYS.filter((k) => !REFUSED_FOR_CHESS.includes(k)));
    expect(s.value).toBe("league");
  });

  it("a chess division stored with americano (or mexicano) before the ruling still shows it: listed and selected, the other one absent", () => {
    const a = formatSelect(mount("boardgame", "blitz", [AMERICANO]));
    expect(a.value).toBe("americano");
    expect(a.values).toEqual(OFFERED_KEYS.filter((k) => k !== "mexicano"));
    const m = formatSelect(mount("boardgame", "blitz", [MEXICANO]));
    expect(m.value).toBe("mexicano");
    expect(m.values).toEqual(OFFERED_KEYS.filter((k) => k !== "americano"));
  });

  it("the positive pair: a badminton division is offered every template, americano and mexicano among them", () => {
    const s = formatSelect(mount("badminton", "bwf", [LEAGUE]));
    expect(s.values).toEqual(OFFERED_KEYS);
    for (const k of REFUSED_FOR_CHESS) expect(s.values).toContain(k);
  });
});

// C9 fix round 1 (I5): the same two formats are offered to no division whose ENGINE entrant model holds no individuals
// or no pairs - an americano stage rotates individual players into pair entrants. The expected list is derived from the
// engine's declaration (engineEntrantKinds), never from templatesForSport.
describe("division Settings offers no pair format where the entrant model cannot play it (C9 fix round 1, I5)", () => {
  it("every registered sport: the format select lists every live template, less americano and mexicano where the engine's kinds lack individuals or pairs (counts)", () => {
    let swept = 0;
    let refusing = 0;
    for (const m of builtinModules) {
      const kinds = engineEntrantKinds(m.key);
      const playsPairs = m.key !== "boardgame" && kinds.includes("individual") && kinds.includes("pair");
      const s = formatSelect(mount(m.key, Object.keys(m.variants)[0] ?? "standard", [LEAGUE]));
      expect(s.values, `${m.key} (${kinds.join("/")})`).toEqual(playsPairs ? OFFERED_KEYS : OFFERED_KEYS.filter((k) => !REFUSED_FOR_CHESS.includes(k)));
      if (!playsPairs) refusing++;
      swept++;
    }
    expect(swept).toBe(builtinModules.length);
    expect(refusing).toBeGreaterThan(1);
    expect(refusing).toBeLessThan(swept);
  });

  it("a football division stored with americano still shows it, listed and selected - and mexicano stays absent", () => {
    const a = formatSelect(mount("football", "standard", [AMERICANO]));
    expect(a.value).toBe("americano");
    expect(a.values).toEqual(OFFERED_KEYS.filter((k) => k !== "mexicano"));
  });
});
