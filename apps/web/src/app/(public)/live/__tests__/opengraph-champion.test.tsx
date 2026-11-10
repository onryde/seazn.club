// ST-G26 (W4 app A Task 23) — the division share card reads the first TABLE snapshot, and a division whose FINAL stage
// is a bracket names its champion once that bracket is complete (owner pick, R24 item 6, option A: "Champion name large,
// with a trophy"; extended past bracket-only divisions by the owner's B6b fix-round-1 ruling).
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
    const model = standingsCardModel({ ...base, rows: [], names: { e1: "Maya Kapoor" }, title: { kind: "champion", champion: "ghost" } });
    expect(model.champion).toBeNull();
    expect(model.fallbackKey).toBe("og.standings.empty");
    // The positive pair: an id it does carry is crowned.
    expect(standingsCardModel({ ...base, rows: [], names: { e1: "Maya Kapoor" }, title: { kind: "champion", champion: "e1" } }).champion?.name).toBe("Maya Kapoor");
  });
});

// W4 B2a (X-CH-1, X-CH-3; C16): the card names what the title crowned — one champion, BOTH joint winners, nobody for a
// vacant title — and the Plate never titles a division. Differential: the pre-W4 card read `data.standings[0]` /
// the first finished final, so a joint final named nobody and a Plate (stored last) crowned its own winner.
describe("W4 B2a the OG card names the title: champion, joint winners, vacant", () => {
  const jointFinal = (stageId: string): Fx[] => [
    ...bracket(stageId).slice(0, 2),
    { id: "kf", stage_id: stageId, round_no: 2, seq_in_round: 1, home_entrant_id: "e1", away_entrant_id: "e2", status: "decided", outcome: null, is_final: true, joint_winners_at: "2026-11-10T10:00:00Z" },
  ];
  const vacantFinal = (stageId: string): Fx[] => [
    ...bracket(stageId).slice(0, 2),
    { id: "kf", stage_id: stageId, round_no: 2, seq_in_round: 1, home_entrant_id: "e1", away_entrant_id: "e2", status: "forfeited", outcome: { kind: "double_walkover" }, is_final: true },
  ];

  it("JOINT: both names on one line, the Joint winners label, ONE trophy — in every locale's own words", async () => {
    let checked = 0;
    for (const locale of Object.keys(DICTS)) {
      Object.assign(state, { locale, stages: [stage("ko", 1, "knockout")], fixtures: jointFinal("ko"), standings: [placement("ko")] });
      const html = await draw();
      const both = DICTS[locale]!["title.jointNames"]!.replace("{a}", "Maya Kapoor").replace("{b}", "Leo Ng");
      expect(html, locale).toContain(`>${esc(both)}<`);
      expect(html, locale).toContain(`>${esc(line(locale, "title.joint"))}<`);
      expect(html, locale).not.toContain(`>${esc(line(locale, "table.champion"))}<`);
      expect(html.split(TROPHY).length - 1, `${locale}: one trophy`).toBe(1);
      checked++;
    }
    expect(checked).toBe(4);
  });

  it("VACANT: no name and no trophy — the card falls back to the empty line (a bracket has no table to show)", async () => {
    Object.assign(state, { stages: [stage("ko", 1, "knockout")], fixtures: vacantFinal("ko"), standings: [placement("ko")] });
    const html = await draw();
    expect(html).not.toContain(TROPHY);
    for (const name of ["Maya Kapoor", "Leo Ng", "Clara Dunn", "Dmitri Volkov"]) expect(html, name).not.toContain(name);
    expect(html).toContain(`>${esc(line("en", "og.standings.empty"))}<`);
  });

  it("a Knockout + Plate division crowns the MAIN draw's winner, never the plate's (C16)", async () => {
    // The Plate is stored AFTER the main draw (seq 2) and feeds from its losers; its own final is won by e3.
    const plateFinal: Fx[] = [{ id: "pf", stage_id: "pl", round_no: 2, seq_in_round: 1, home_entrant_id: "e3", away_entrant_id: "e4", status: "decided", outcome: { kind: "win", winner: "e3", loser: "e4" }, is_final: true }];
    Object.assign(state, {
      stages: [stage("ko", 1, "knockout"), { ...stage("pl", 2, "knockout"), feeds_from: [{ stageId: "ko", side: "losers" }] }],
      fixtures: [...bracket("ko"), ...plateFinal],
      standings: [placement("ko"), { stage_id: "pl", pool_id: null, rows: [] }],
    });
    const html = await draw();
    expect(html).toContain(`>${esc("Maya Kapoor")}<`);
    expect(html).toContain(`>${esc(line("en", "table.champion"))}<`);
    expect(html).not.toContain("Clara Dunn");
    // The positive pair, same rows without the graph: the old rule crowned the plate (seq).
    Object.assign(state, { stages: [stage("ko", 1, "knockout"), stage("pl", 2, "knockout")] });
    expect(await draw()).toContain(`>${esc("Clara Dunn")}<`);
  });

  it("the model: a joint pair with one name missing from the public list names nobody (never half a crown)", async () => {
    const { standingsCardModel } = await import("@/server/og/model");
    const base = { orgName: "o", competitionName: "c", divisionName: "d", logo: null, branding: [], youth: false, entrantKind: "individual", rules: null, rows: [] };
    const joint = { kind: "joint" as const, winners: ["e1", "e2"] as [string, string] };
    expect(standingsCardModel({ ...base, names: { e1: "A" }, title: joint }).champion).toBeNull();
    expect(standingsCardModel({ ...base, names: { e1: "A", e2: "B" }, title: joint }).champion).toMatchObject({ name: "A & B", joint: true });
    expect(standingsCardModel({ ...base, names: { e1: "A", e2: "B" }, title: { kind: "vacant" } }).champion).toBeNull();
  });
});

// Owner ruling (B6b fix round 1, OG pick A): a division whose FINAL stage is a bracket gets the champion card once that
// bracket is complete — a group or a league that feeds a knockout included, not only a bracket-only division. While
// the final bracket is still being played, the card stays the table it was.
describe("ST-G26 a division whose final stage is a bracket names its champion once that bracket is complete", () => {
  it("every table kind, then every bracket kind, the final decided: the champion, the trophy and the Champion label — no table", async () => {
    const tableKinds = StageKind.options.filter((k) => !BRACKET_STAGE_KINDS.has(k));
    const bracketKinds = StageKind.options.filter((k) => BRACKET_STAGE_KINDS.has(k));
    let checked = 0;
    for (const first of tableKinds) {
      for (const final of bracketKinds) {
        Object.assign(state, {
          stages: [stage("s1", 1, first), stage("ko", 2, final)],
          fixtures: bracket("ko"),
          // Stage then pool order, as the read hands it over: the first stage's tables, then the bracket's placement.
          standings: [table("s1", "pA", ["e3", "e1"]), table("s1", "pB", ["e2", "e4"]), placement("ko")],
        });
        const html = await draw();
        const at = `${first} -> ${final}`;
        expect(html, at).toContain(`>${esc("Maya Kapoor")}<`);
        expect(html, at).toContain(TROPHY);
        expect(html, at).toContain(`>${esc(line("en", "table.champion"))}<`);
        // The first stage's table is not drawn under the crown.
        expect(html, at).not.toContain(">Pts 9<");
        expect(html, at).not.toContain(`>${esc("Clara Dunn")}<`);
        checked++;
      }
    }
    expect(checked, "anti-vacuity: the engine's table kinds x bracket kinds").toBe(tableKinds.length * bracketKinds.length);
    expect(checked).toBeGreaterThan(0);
  });

  it("a group then a knockout still being played: the group's Pool A table, no trophy", async () => {
    Object.assign(state, {
      stages: [stage("sg", 1, "group"), stage("ko", 2, "knockout", "active")],
      fixtures: bracket("ko", "scheduled"),
      standings: [table("sg", "pA", ["e3", "e1"]), table("sg", "pB", ["e2", "e4"])],
    });
    const html = await draw();
    expect(html).toContain(`>${esc("Clara Dunn")}<`);
    expect(html).toContain(">Pts 9<");
    expect(html).not.toContain(TROPHY);
    expect(html).not.toContain(`>${esc(line("en", "table.champion"))}<`);
  });

  it("a youth division of individuals whose final stage is a finished knockout: the youth line, never the name", async () => {
    Object.assign(state, {
      youth: true,
      stages: [stage("sg", 1, "group"), stage("ko", 2, "knockout")],
      fixtures: bracket("ko"),
      standings: [table("sg", "pA", ["e3", "e1"]), placement("ko")],
    });
    const html = await draw();
    expect(html).not.toContain("Maya Kapoor");
    expect(html).not.toContain(TROPHY);
    expect(html).toContain(`>${esc(line("en", "og.standings.youth"))}<`);
  });
});

describe("ST-G26 the share card reads the first TABLE snapshot", () => {
  it("a finished knockout then a league (the league is the final stage): the league's table, though the knockout's placement snapshot reads first", async () => {
    Object.assign(state, {
      stages: [stage("ko", 1, "knockout"), stage("lg", 2, "league")],
      fixtures: bracket("ko"),
      standings: [placement("ko"), table("lg", null, ["e3", "e1"])],
    });
    const html = await draw();
    expect(html).toContain(`>${esc("Clara Dunn")}<`);
    expect(html).toContain(">Pts 9<");
    expect(html).not.toContain(">P 0<");
    // The final stage is a table, so the card is that table — the knockout's winner is not crowned here.
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
