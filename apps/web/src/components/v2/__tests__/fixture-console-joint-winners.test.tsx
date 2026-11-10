// W4 app B, B5b Task 13 (X-CH-4, X-CH-6; owner pick 4A) - "Declare joint winners" beside Settle in the organiser's match
// console, and its Undo. apps/web vitest is node-env: these prove the OFFER GATE and the markup, never a tap (the tap runs
// in e2e/bracket-finish.spec.ts, X-CH-4). The gate under test is the console's own read of the ONE shared predicate
// (`lib/joint-winners.ts`, which the server also reads), fed the live console state.
//
// The offered set below is typed from the rulebook row, plan Task 12: "status `scheduled`, `in_play`, `abandoned`
// (awaiting settle) or `needs_decision`" on a final (`is_final`, not `third_place`, no owed DE reset) with both seats and no
// decided result. It is NOT read back from JOINT_WINNERS_OPEN_STATUSES, so a drift in the code's set moves this test red.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { builtinModules } from "@seazn/engine/sports";
import { FixtureConsole } from "@/components/v2/fixture-console";
import type { EventIn, LiveState, SideInfo, SportInfo } from "@/components/v2/fixture-console";
import en from "@/dictionaries/en/ui.json";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/o/org/c/comp/d/div/f/1",
  useSearchParams: () => new URLSearchParams(""),
}));
vi.mock("@/components/ui/confirm-provider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/ui/confirm-provider")>()),
  useConfirm: () => async () => true,
}));

const football = builtinModules.find((m) => m.key === "football")!;
const CFG = football.configSchema.parse((football.variants as Record<string, unknown> | undefined)?.["11-a-side"] ?? {});
const sport: SportInfo = { key: "football", config: {}, scorerLabel: "Referee", positionGroups: [], roles: [], lineupSize: 11, benchMax: 5 };
const side = (id: string, name: string, withdrawn = false): SideInfo => ({ id, name, members: [], lineup: [], ...(withdrawn ? { withdrawn: true } : {}) });

const EV = (id: string, seq: number, type: string, payload: unknown = {}): EventIn => ({
  id, seq, type, payload, recorded_at: "2026-11-10T10:00:00.000Z", recorded_by: "user-1", voids_event_id: null, device_link_id: null,
});

interface Over {
  status?: string;
  outcome?: unknown;
  events?: EventIn[];
  is_final?: boolean;
  third_place?: boolean;
  conditional?: boolean;
  joint_winners_at?: string | null;
  stageKind?: string | null;
  canOrganise?: boolean;
  home?: SideInfo | null;
  away?: SideInfo | null;
}
function html(over: Over = {}): string {
  const status = over.status ?? "scheduled";
  const live: LiveState = {
    status, last_seq: 0, summary: null, state: status === "scheduled" ? null : {}, outcome: over.outcome ?? null,
  };
  return renderToStaticMarkup(
    <FixtureConsole
      fixture={{
        id: "f1", status, scheduled_at: null, venue_name: null, court_name: null, round_no: 3,
        is_final: over.is_final ?? true,
        third_place: over.third_place ?? false,
        conditional: over.conditional ?? false,
        joint_winners_at: over.joint_winners_at ?? null,
      }}
      sport={sport}
      home={over.home !== undefined ? over.home : side("e-home", "Riverside FC")}
      away={over.away !== undefined ? over.away : side("e-away", "Summit Athletic")}
      initialState={live}
      initialEvents={over.events ?? (status === "scheduled" ? [] : [EV("ev-1", 1, "core.start")])}
      canEdit
      canOrganise={over.canOrganise ?? true}
      stageKind={over.stageKind === undefined ? "knockout" : over.stageKind}
      deviceHandover
      recorderNames={{ "user-1": "Dana Okafor" }}
      scorePadV2={{ moduleVersion: football.version, resolvedConfig: CFG, initialEvents: [], entitlements: {}, stageKind: null, identity: { recordedBy: "user-1", deviceLinkId: null } }}
      viewerPlan="community"
    />,
  );
}

const OFFER = 'data-testid="joint-winners-open"';
const UNDO = 'data-testid="joint-winners-undo"';
const DECLARED = 'data-testid="joint-winners-declared"';
const HELD_EVENTS = [EV("ev-1", 1, "core.start"), EV("ev-2", 2, "core.abandon")];

describe("B5b T13: the Declare joint winners offer (X-CH-6)", () => {
  // The EMPTY case first: a fixture with no seats has nothing to rule on, whatever else is true of it.
  it("empty case: a final with no seats offers nothing (neither seat, one seat)", () => {
    expect(html({ home: null, away: null })).not.toContain(OFFER);
    expect(html({ away: null })).not.toContain(OFFER);
    expect(html({ home: null })).not.toContain(OFFER);
  });

  it("offered on each X-CH-6 state: scheduled, in play, abandoned awaiting its settle, held level (with Settle beside it)", () => {
    const cases: { name: string; over: Over; settle: boolean }[] = [
      { name: "scheduled", over: { status: "scheduled" }, settle: false },
      { name: "in_play", over: { status: "in_play" }, settle: false },
      { name: "abandoned (held)", over: { status: "abandoned", events: HELD_EVENTS }, settle: true },
      { name: "needs_decision (held level)", over: { status: "needs_decision", outcome: { kind: "draw" } }, settle: true },
    ];
    let checked = 0;
    for (const c of cases) {
      const out = html(c.over);
      expect(out, c.name).toContain(OFFER);
      expect(out, `${c.name}: the declared banner is not shown`).not.toContain(DECLARED);
      expect(out, `${c.name}: no Undo on an open final`).not.toContain(UNDO);
      // X-CH-5: the settle stays offered beside it where the state holds one - and ONLY there.
      expect(out.includes('data-testid="settle-open"'), `${c.name}: Settle`).toBe(c.settle);
      checked++;
    }
    expect(checked, "anti-vacuity: four offered states checked").toBe(4);
  });

  it("not offered on the four refused finals: a semi-final, a third-place match, a decided final, a final already declared", () => {
    const refused: { name: string; over: Over }[] = [
      { name: "semi-final (not a final)", over: { is_final: false } },
      { name: "third-place match", over: { third_place: true } },
      { name: "decided final", over: { status: "decided", outcome: { kind: "win", winner: "e-home", loser: "e-away" } } },
      { name: "already declared", over: { status: "decided", joint_winners_at: "2026-11-10T12:00:00.000Z" } },
    ];
    let checked = 0;
    for (const r of refused) {
      expect(html(r.over), r.name).not.toContain(OFFER);
      checked++;
    }
    expect(checked, "anti-vacuity: four refusals checked").toBe(4);
  });

  it("also not offered: a finalized final, a double-elimination grand final, a conditional reset, both finalists withdrawn, a scorer", () => {
    const refused: { name: string; over: Over }[] = [
      { name: "finalized", over: { status: "finalized", outcome: { kind: "win", winner: "e-home", loser: "e-away" } } },
      { name: "double-elimination", over: { stageKind: "double_elim" } },
      { name: "conditional reset", over: { conditional: true } },
      { name: "both finalists withdrawn", over: { home: side("e-home", "Riverside FC", true), away: side("e-away", "Summit Athletic", true) } },
      { name: "an official scorer (canOrganise false)", over: { canOrganise: false } },
    ];
    let checked = 0;
    for (const r of refused) {
      expect(html(r.over), r.name).not.toContain(OFFER);
      checked++;
    }
    expect(checked).toBe(5);
    // The positive pair for the withdrawn case: ONE finalist out is still ruled (the server only refuses two).
    expect(html({ home: side("e-home", "Riverside FC", true) })).toContain(OFFER);
  });
});

describe("B5b T13: a joint final in the console (X-CH-4)", () => {
  const JOINT: Over = { status: "decided", joint_winners_at: "2026-11-10T12:00:00.000Z" };

  it("names both finalists, offers Undo, and offers neither scoring nor Settle nor the declaration", () => {
    const out = html(JOINT);
    expect(out).toContain(DECLARED);
    expect(out).toContain(UNDO);
    expect(out).toContain(en["jointWinners.undo"]);
    expect(out, "both finalists named").toContain("Riverside FC");
    expect(out).toContain("Summit Athletic");
    expect(out).not.toContain(OFFER);
    expect(out, "FINAL_JOINT_WINNERS_DECLARED: no pad to score on").not.toContain('data-testid="score-pad"');
    expect(out).not.toContain('data-testid="settle-open"');
    expect(out, "no Finalize on a result nobody scored").not.toContain('data-testid="score-finalize"');
  });

  it("the Undo is organiser-only: a scorer sees the declaration but no Undo", () => {
    const out = html({ ...JOINT, canOrganise: false });
    expect(out).not.toContain(UNDO);
    expect(out).not.toContain(OFFER);
  });

  it("the Undo renders ONLY on a joint final", () => {
    for (const over of [{ status: "scheduled" }, { status: "in_play" }, { status: "decided", outcome: { kind: "win", winner: "e-home", loser: "e-away" } }] as Over[]) {
      expect(html(over), String(over.status)).not.toContain(UNDO);
    }
  });
});

// ---- the confirm sheet and the copy ------------------------------------------------------------------------------
import es from "@/dictionaries/es/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import nl from "@/dictionaries/nl/ui.json";
import { JointWinnersSheet } from "@/components/v2/joint-winners-block";

const LONG_A = "Riverside Athletic Club Under-19 Women's"; // 41 chars
const LONG_B = "The Old Grammar School Alumni Veterans XI"; // 41 chars
const fill = (tpl: string, a: string, b: string) => tpl.replace("{a}", a).replace("{b}", b);

describe("B5b T13: the confirm sheet names both finalists", () => {
  const sheet = (a: string, b: string) =>
    renderToStaticMarkup(
      <JointWinnersSheet msg={(k, v) => fill((en as Record<string, string>)[k] ?? k, String(v?.a ?? ""), String(v?.b ?? ""))} home={{ name: a }} away={{ name: b }} sending={false} onConfirm={() => {}} onClose={() => {}} />,
    );

  it("the sentence is the copy's own, with BOTH names in it, wrapping (no truncate) at a 41-character name each", () => {
    const out = sheet(LONG_A, LONG_B);
    expect(out).toContain(fill(en["jointWinners.confirm"]!, LONG_A.replace("'", "&#x27;"), LONG_B));
    const sentence = out.slice(out.indexOf('data-testid="joint-winners-confirm-text"'));
    expect(sentence.slice(0, sentence.indexOf("</p>"))).toMatch(/class="[^"]*\bmin-w-0\b[^"]*\bbreak-words\b/);
    expect(sentence.slice(0, sentence.indexOf("</p>"))).not.toMatch(/\btruncate\b/);
    expect(out, "the ruling button carries the action's own name").toContain(`>${en["jointWinners.action"]}<`);
    expect(out).toContain(`>${en["editor.cancel"]}<`);
  });

  it("every locale carries the nine keys, non-empty, translated, and keeps the {a} and {b} slots", () => {
    const keys = ["jointWinners.title", "jointWinners.body", "jointWinners.action", "jointWinners.confirmTitle", "jointWinners.confirm", "jointWinners.undo", "jointWinners.declaredTitle", "jointWinners.declaredBody", "bracket.jointWinners", "bracket.titleVacant"] as const;
    let checked = 0;
    for (const [loc, dict] of [["es", es], ["fr", fr], ["nl", nl]] as const) {
      for (const k of keys) {
        const v = (dict as Record<string, string>)[k];
        expect(v, `${loc} ${k}`).toBeTruthy();
        expect(v, `${loc} ${k} is not the English string`).not.toBe((en as Record<string, string>)[k]);
        if (k === "jointWinners.confirm" || k === "jointWinners.declaredBody") expect(v).toMatch(/\{a\}.*\{b\}/);
        checked++;
      }
    }
    expect(checked, "anti-vacuity").toBe(30);
  });
});
