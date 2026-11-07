// ST-G26 (W4 app A Task 23) — the division share card reads the first TABLE snapshot, and a division that is only a
// bracket names its champion (owner pick, R24 item 6, option A: "Champion name large, with a trophy").
//
// The card drew `standings[0]` — whatever the unordered query returned first. A knockout writes a placement snapshot
// when it completes (rank only, every count zero), so a knockout-only division's preview was an all-zero table, and a
// group-then-knockout division's preview was whichever of its snapshots came back first.
//
// `next/og`'s ImageResponse is captured and its tree rendered to markup (as `opengraph-image-locale.test.tsx`). The
// champion is the rulebook's: the winner of the bracket's settled final. Stage kinds are swept from the ENGINE's
// declarations (`StageKind.options`, `BRACKET_STAGE_KINDS`); every word is the locale's own dictionary value.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { StageKind } from "@seazn/engine/core";
import { BRACKET_STAGE_KINDS, placementTable } from "@seazn/engine/competition";
import en from "@/dictionaries/en/public.json";
import es from "@/dictionaries/es/public.json";
import fr from "@/dictionaries/fr/public.json";
import nl from "@/dictionaries/nl/public.json";

const captured: { tree: ReactElement | null } = { tree: null };
vi.mock("next/og", () => ({
  ImageResponse: class {
    constructor(tree: unknown) {
      captured.tree = tree as ReactElement;
    }
  },
}));

type Snap = { stage_id: string; pool_id: string | null; rows: unknown[] };
type Stage = { id: string; seq: number; kind: string; name: string; status: string; table_rules: null };
type Fx = Record<string, unknown>;
const state = vi.hoisted(() => ({
  locale: "en",
  youth: false,
  kind: "individual",
  champion: "Maya Kapoor",
  stages: [] as unknown[],
  fixtures: [] as unknown[],
  standings: [] as unknown[],
}));

vi.mock("@/lib/db", () => ({ sql: async () => [{ youth: state.youth }] }));
vi.mock("@/server/og/poster-image", () => ({ posterImageDataUrl: vi.fn(async () => null) }));
vi.mock("@/server/public-site/data", () => ({
  getPublicDivision: async () => ({
    org: { id: "o1", name: "Harbourside Badminton Club", slug: "hbc", branded: false, branding: {}, logo: null, about: null, default_locale: state.locale, card_payments: false },
    competition: { id: "c1", name: "Harbourside Open 2026", slug: "open-2026", branding: {} },
    division: { id: "d1", name: "Men's Singles A", slug: "msa" },
    entrants: [
      { id: "e1", kind: state.kind, display_name: state.champion },
      { id: "e2", kind: state.kind, display_name: "Leo Ng" },
      { id: "e3", kind: state.kind, display_name: "Clara Dunn" },
      { id: "e4", kind: state.kind, display_name: "Dmitri Volkov" },
    ],
    stages: state.stages,
    pools: [],
    fixtures: state.fixtures,
    standings: state.standings,
  }),
}));

import DivisionOg from "../[orgSlug]/[competitionSlug]/[divisionSlug]/opengraph-image";

const DICTS: Record<string, Record<string, string>> = {
  en: en as Record<string, string>,
  es: es as Record<string, string>,
  fr: fr as Record<string, string>,
  nl: nl as Record<string, string>,
};
const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
const line = (l: string, k: string) => DICTS[l]![k]!.replace("{brand}", "seazn.club");
/** The trophy is drawn as an SVG in the card (no emoji font in satori): its viewBox, anchored on `="`. */
const TROPHY = `viewBox="0 0 64 64"`;

const stage = (id: string, seq: number, kind: string, status = "complete"): Stage => ({ id, seq, kind, name: id, status, table_rules: null });
/** A four-entrant bracket, settled the way the rulebook reads it: e1 beats e4, e2 beats e3, e1 wins the final. */
const bracket = (stageId: string, finalStatus = "decided"): Fx[] => [
  { id: "k1", stage_id: stageId, round_no: 1, seq_in_round: 1, home_entrant_id: "e1", away_entrant_id: "e4", status: "decided", outcome: { kind: "win", winner: "e1", loser: "e4" }, is_final: false },
  { id: "k2", stage_id: stageId, round_no: 1, seq_in_round: 2, home_entrant_id: "e2", away_entrant_id: "e3", status: "decided", outcome: { kind: "win", winner: "e2", loser: "e3" }, is_final: false },
  {
    id: "kf", stage_id: stageId, round_no: 2, seq_in_round: 1, home_entrant_id: "e1", away_entrant_id: "e2", status: finalStatus,
    outcome: finalStatus === "decided" ? { kind: "win", winner: "e1", loser: "e2" } : null, is_final: true,
  },
];
/** The placement snapshot `completeStageIfReady` writes for a finished bracket: the engine's own `placementTable`. */
const placement = (stageId: string): Snap => ({ stage_id: stageId, pool_id: null, rows: placementTable(["e1", "e2", "e3", "e4"]).rows as unknown[] });
const table = (stageId: string, poolId: string | null, order: string[]): Snap => ({
  stage_id: stageId,
  pool_id: poolId,
  rows: order.map((entrantId, i) => ({ entrantId, rank: i + 1, played: 3, points: 9 - 3 * i })),
});

async function draw(): Promise<string> {
  captured.tree = null;
  await DivisionOg({ params: Promise.resolve({ orgSlug: "hbc", competitionSlug: "open-2026", divisionSlug: "msa" }) });
  if (!captured.tree) throw new Error("ImageResponse was never constructed");
  return renderToStaticMarkup(captured.tree);
}

beforeEach(() => {
  Object.assign(state, { locale: "en", youth: false, kind: "individual", champion: "Maya Kapoor", stages: [], fixtures: [], standings: [] });
});

describe("ST-G26 a bracket-only division's OG card names its champion", () => {
  it("every bracket kind, finished: the champion's name with the trophy and the Champion label, never a table", async () => {
    const kinds = StageKind.options.filter((k) => BRACKET_STAGE_KINDS.has(k));
    let checked = 0;
    for (const kind of kinds) {
      Object.assign(state, { stages: [stage("ko", 1, kind)], fixtures: bracket("ko"), standings: [placement("ko")] });
      const html = await draw();
      expect(html, kind).toContain(`>${esc("Maya Kapoor")}<`);
      expect(html, kind).toContain(TROPHY);
      expect(html, kind).toContain(`>${esc(line("en", "table.champion"))}<`);
      // The placement snapshot is not drawn: no row reads "P 0" / "Pts 0", nor the losers' names.
      expect(html, kind).not.toContain(">P 0<");
      expect(html, kind).not.toContain("Leo Ng");
      expect(html, kind).not.toContain(`>${esc(line("en", "og.standings.empty"))}<`);
      checked++;
    }
    expect(checked, "anti-vacuity: the engine's bracket kinds").toBe(BRACKET_STAGE_KINDS.size);
  });

  for (const locale of Object.keys(DICTS)) {
    it(`${locale}: the Champion label is ${locale}'s own word`, async () => {
      Object.assign(state, { locale, stages: [stage("ko", 1, "knockout")], fixtures: bracket("ko"), standings: [placement("ko")] });
      const html = await draw();
      expect(html).toContain(`>${esc(line(locale, "table.champion"))}<`);
    });
  }

  it("a youth division of individuals never prints the champion's name: the youth line instead, no trophy", async () => {
    Object.assign(state, { youth: true, stages: [stage("ko", 1, "knockout")], fixtures: bracket("ko"), standings: [placement("ko")] });
    const html = await draw();
    expect(html).not.toContain("Maya Kapoor");
    expect(html).not.toContain(TROPHY);
    expect(html).toContain(`>${esc(line("en", "og.standings.youth"))}<`);
  });

  it("a youth division of TEAMS names its champion (a team name names a side, not a child)", async () => {
    Object.assign(state, { youth: true, kind: "team", champion: "Harbour Hawks", stages: [stage("ko", 1, "knockout")], fixtures: bracket("ko"), standings: [placement("ko")] });
    const html = await draw();
    expect(html).toContain(`>${esc("Harbour Hawks")}<`);
    expect(html).toContain(TROPHY);
  });

  it("a bracket still being played crowns nobody: the empty line, no trophy, no name", async () => {
    Object.assign(state, { stages: [stage("ko", 1, "knockout", "active")], fixtures: bracket("ko", "scheduled"), standings: [] });
    const html = await draw();
    expect(html).not.toContain(TROPHY);
    expect(html).not.toContain("Maya Kapoor");
    expect(html).toContain(`>${esc(line("en", "og.standings.empty"))}<`);
  });

  it("a 43-character champion is printed whole, smaller than a short one", async () => {
    const long = "Harbourside Shuttlers Badminton Club Ladies";
    expect(long).toHaveLength(43);
    const sizeOf = (html: string, name: string) => {
      const m = new RegExp(`font-size:(\\d+)px[^>]*>${esc(name)}<`).exec(html);
      if (!m) throw new Error(`no sized node for ${name}`);
      return Number(m[1]);
    };
    Object.assign(state, { stages: [stage("ko", 1, "knockout")], fixtures: bracket("ko"), standings: [placement("ko")] });
    const short = sizeOf(await draw(), "Maya Kapoor");
    Object.assign(state, { champion: long });
    const html = await draw();
    expect(html).toContain(`>${esc(long)}<`);
    expect(sizeOf(html, long)).toBeLessThan(short);
  });
});

describe("ST-G26 the champion model's guard", () => {
  it("a champion id the public entrant list does not carry prints no crown over a blank name: the table's fallback", async () => {
    const { standingsCardModel } = await import("@/server/og/model");
    const base = { orgName: "o", competitionName: "c", divisionName: "d", logo: null, branding: [], youth: false, entrantKind: "individual", rules: null };
    const model = standingsCardModel({ ...base, rows: [], names: { e1: "Maya Kapoor" }, championId: "ghost" });
    expect(model.champion).toBeNull();
    expect(model.fallbackKey).toBe("og.standings.empty");
    // The positive pair: an id it does carry is crowned.
    expect(standingsCardModel({ ...base, rows: [], names: { e1: "Maya Kapoor" }, championId: "e1" }).champion?.name).toBe("Maya Kapoor");
  });
});

describe("ST-G26 the share card reads the first TABLE snapshot", () => {
  it("a group then a finished knockout: the group's Pool A table, even when the knockout's placement snapshot comes first", async () => {
    Object.assign(state, {
      stages: [stage("sg", 1, "group"), stage("ko", 2, "knockout")],
      fixtures: bracket("ko"),
      standings: [placement("ko"), table("sg", "pA", ["e3", "e1"]), table("sg", "pB", ["e2", "e4"])],
    });
    const html = await draw();
    expect(html).toContain(`>${esc("Clara Dunn")}<`);
    expect(html).toContain(">Pts 9<");
    expect(html).not.toContain(">P 0<");
    // Not a bracket-only division: no champion card.
    expect(html).not.toContain(TROPHY);
  });

  it("every table kind alone: its snapshot is drawn as the table it always was (no trophy)", async () => {
    const kinds = StageKind.options.filter((k) => !BRACKET_STAGE_KINDS.has(k));
    let checked = 0;
    for (const kind of kinds) {
      Object.assign(state, { stages: [stage("s1", 1, kind)], fixtures: [], standings: [table("s1", null, ["e2", "e1"])] });
      const html = await draw();
      expect(html, kind).toContain(`>${esc("Leo Ng")}<`);
      expect(html, kind).toContain(">P 3<");
      expect(html, kind).toContain(">Pts 9<");
      expect(html, kind).not.toContain(TROPHY);
      checked++;
    }
    expect(checked, "anti-vacuity: the engine's table kinds").toBeGreaterThan(0);
    expect(checked + BRACKET_STAGE_KINDS.size).toBe(StageKind.options.length);
  });
});
