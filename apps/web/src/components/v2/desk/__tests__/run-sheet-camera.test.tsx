// T16 (brief step 11, canvas RunSheetDesktop / RunSheetPhone) — an online
// chess board's chips on the run sheet: its camera ("Camera ok", or "N camera
// flags" leading to the arbiter panel on THIS board), moves made off Seazn,
// and a hold for the organiser ("Needs a decision", leading to the board's
// card in the online-play queue above the sheet). A held board owes its
// result, so "Needs result" keeps it and counts it.
//
// The chips read `RunSheetOnlinePlay` (listRunSheetOnlinePlay — its producers
// are driven against the database in external-play-flagged-and-run-sheet,
// -sweep and -result tests). Here: what each value SHOWS, row and sheet, and
// that StagesPanel threads the map and the arbiter link down. Copy from the
// dictionary, never typed here.
import { describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import { RunSheetRow } from "@/components/v2/desk/run-sheet-row";
import { RunSheet, runSheetKeeps, type RunSheetFilter } from "@/components/v2/desk/run-sheet";
import { StagesPanel } from "@/components/v2/stages-panel";
import { buildRunSheet, type RunSheetFixture, type RunSheetOnlinePlay } from "@/lib/run-sheet-groups";
import { messages } from "@/lib/messages";
import { CAMERA_POLICIES } from "@/lib/camera-policy";
import { NEEDS_REASONS } from "@/server/external-play/types";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(""),
}));
vi.mock("@/components/ui/confirm-provider", () => ({ useConfirm: () => vi.fn(async () => false) }));

const TZ = "UTC";
const NOW_MS = Date.UTC(2026, 9, 12, 19, 0, 0);
const ARBITER = "/o/org/c/comp/d/div/arbiter?fixture=f1";
const MATCH = `Alpha ${messages["schedule.vs"]} Bravo`;

function fx(o: Partial<RunSheetFixture> = {}): RunSheetFixture {
  return {
    id: "f1",
    stage_id: "s1",
    fixture_no: 7,
    round_no: 1,
    seq_in_round: 1,
    scheduled_at: "2026-10-12T18:30:00.000Z",
    status: "in_play",
    court_name: null,
    court_id: null,
    venue_name: null,
    officials: [],
    outcome: null,
    home_entrant_id: "e1",
    away_entrant_id: "e2",
    home_slot_label: null,
    away_slot_label: null,
    lane: null,
    is_final: false,
    third_place: false,
    conditional: false,
    ext_key: null,
    ...o,
  };
}

const online = (o: Partial<RunSheetOnlinePlay> = {}): RunSheetOnlinePlay => ({
  cameraPolicy: "required",
  cameraFlagCount: 0,
  connectionProblemCount: 0,
  offSeaznFlagCount: 0,
  held: null,
  live: true,
  unopened: false,
  ...o,
});

function row(opts: { onlinePlay?: RunSheetOnlinePlay; arbiterHref?: string | null; fixture?: RunSheetFixture } = {}): ReactElement[] {
  return renderIsland(RunSheetRow, {
    fixture: opts.fixture ?? fx(),
    href: "/o/org/c/comp/d/div/f/7",
    tz: TZ,
    orgTz: TZ,
    nowMs: NOW_MS,
    canEdit: true,
    entrantNames: { e1: "Alpha", e2: "Bravo" },
    onlinePlay: opts.onlinePlay,
    arbiterHref: opts.arbiterHref === null ? undefined : (opts.arbiterHref ?? ARBITER),
  }).tree();
}
/** The opening tag of the element carrying this testid, or null. */
const tagOf = (h: string, testId: string) => h.match(new RegExp(`<[a-z]+[^>]*data-testid="${testId}"[^>]*>`))?.[0] ?? null;
const chips = (tree: ReactElement[], id: string) => [...new Set(tree.filter((el) => propsOf(el)["data-testid"] === id))];
/** The filter chip's count (run-sheet-filters.test.tsx's reader). */
function chipCount(html: string, filter: RunSheetFilter): number | null {
  const chip = new RegExp(`<button[^>]*data-filter="${filter}"[^>]*>([\\s\\S]*?)</button>`).exec(html);
  expect(chip, `no "${filter}" chip in the rendered sheet`).not.toBeNull();
  const count = /<span[^>]*>(\d+)<\/span>\s*$/.exec(chip![1]!);
  return count ? Number(count[1]) : null;
}
const plural = (key: string, n: number) => messages[`${key}.${n === 1 ? "one" : "other"}` as keyof typeof messages].replace("{count}", String(n));

describe("the row's online chips", () => {
  it("the empty case first: not an online board ⇒ no camera, off-Seazn or held chip", () => {
    const tree = row();
    for (const id of ["run-sheet-camera-chip", "run-sheet-off-seazn-chip", "run-sheet-online-held-chip"]) {
      expect(chips(tree, id), id).toHaveLength(0);
    }
    // The positive pair: the same row with an entry does render a chip.
    expect(chips(row({ onlinePlay: online() }), "run-sheet-camera-chip")).toHaveLength(1);
  });

  it("'Camera ok' only for a REQUIRED camera on a game being played with no open flag — every policy × live, counted", () => {
    let checked = 0;
    for (const policy of CAMERA_POLICIES) {
      for (const live of [true, false]) {
        const tree = row({ onlinePlay: online({ cameraPolicy: policy, live }) });
        const ok = chips(tree, "run-sheet-camera-chip");
        const want = policy === "required" && live;
        expect(ok.length, `${policy} live=${live}`).toBe(want ? 1 : 0);
        if (want) {
          expect(propsOf(ok[0]!)["data-state"]).toBe("ok");
          expect(textOf(ok[0]), "a fact, not a link").toContain(messages["runsheet.camera.ok"]);
          expect(propsOf(ok[0]!).href, "not a control").toBeUndefined();
        }
        checked++;
      }
    }
    expect(checked).toBe(CAMERA_POLICIES.length * 2);
    expect(CAMERA_POLICIES.length, "anti-vacuity: the policy vocabulary").toBeGreaterThanOrEqual(3);
  });

  it("open camera flags: 'N camera flags', amber, leading to the arbiter panel on THIS board — whatever the policy and state", () => {
    let checked = 0;
    for (const n of [1, 2]) {
      for (const live of [true, false]) {
        const tree = row({ onlinePlay: online({ cameraFlagCount: n, live, cameraPolicy: "optional" }) });
        const [chip, ...more] = chips(tree, "run-sheet-camera-chip");
        expect(more, "one camera chip").toHaveLength(0);
        expect(propsOf(chip!)["data-state"]).toBe("flagged");
        expect(textOf(chip)).toBe(plural("runsheet.camera.flag", n));
        expect(propsOf(chip!).href).toBe(ARBITER);
        // Label in name: the visible words, then the match.
        expect(propsOf(chip!)["aria-label"]).toBe(
          messages["runsheet.online.flagName"].replace("{chip}", plural("runsheet.camera.flag", n)).replace("{match}", MATCH),
        );
        checked++;
      }
    }
    expect(checked).toBe(4);
  });

  // T16 fix round 1, I3 (carry progress.md:1006, T14 round 5): `camera_connection_problems` is OUR safeguard's
  // connection, never the player's — a quiet fact, never styled as an accusation, never counted with camera_lost,
  // and never on its own what takes "Camera ok" away. The arbiter panel already draws it neutral.
  it("I3: our side's connection problems — their own QUIET chip; 'Camera ok' stays; never the amber camera chip", () => {
    let checked = 0;
    for (const n of [1, 3]) {
      const tree = row({ onlinePlay: online({ connectionProblemCount: n }) });
      const [quiet, ...more] = chips(tree, "run-sheet-connection-chip");
      expect(more, "one connection chip").toHaveLength(0);
      expect(textOf(quiet), "the arbiter panel's own words").toBe(messages["arbiter.flag.connection.chipPlain"]);
      expect(propsOf(quiet!).href, "it still leads to the panel, where it is reviewed").toBe(ARBITER);
      const cls = String(propsOf(quiet!).className);
      expect(cls, "never the amber evidence tone").not.toMatch(/fef3c7|713f12|amber/);
      expect(cls).toMatch(/\bborder-slate-200\b/);
      const camera = chips(tree, "run-sheet-camera-chip");
      expect(camera.map((c) => propsOf(c)["data-state"]), `${n}: "Camera ok" stays — the player's camera was not lost`).toEqual(["ok"]);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("I3, the other direction: a lost camera beside our connection problems — the amber chip counts ONLY the lost camera", () => {
    const tree = row({ onlinePlay: online({ cameraFlagCount: 1, connectionProblemCount: 2 }) });
    const camera = chips(tree, "run-sheet-camera-chip");
    expect(camera.map((c) => propsOf(c)["data-state"]), "amber, and no 'Camera ok'").toEqual(["flagged"]);
    expect(textOf(camera[0]), "one camera flag, not three").toBe(plural("runsheet.camera.flag", 1));
    expect(chips(tree, "run-sheet-connection-chip")).toHaveLength(1);
    // And the empty case: neither ⇒ no connection chip.
    expect(chips(row({ onlinePlay: online() }), "run-sheet-connection-chip")).toHaveLength(0);
  });

  it("moves made off Seazn: its own chip, to the arbiter panel; a camera flag and an off-Seazn flag each show", () => {
    const tree = row({ onlinePlay: online({ cameraFlagCount: 1, offSeaznFlagCount: 2 }) });
    const off = chips(tree, "run-sheet-off-seazn-chip");
    expect(off).toHaveLength(1);
    expect(textOf(off[0])).toBe(messages["arbiter.flag.outOfBand.chip"]);
    expect(propsOf(off[0]!).href).toBe(ARBITER);
    expect(chips(tree, "run-sheet-camera-chip")).toHaveLength(1);
  });

  it("no arbiter link handed down: the flag chips still SHOW (plain text) — evidence is never suppressed", () => {
    const tree = row({ onlinePlay: online({ cameraFlagCount: 1, offSeaznFlagCount: 1 }), arbiterHref: null });
    for (const id of ["run-sheet-camera-chip", "run-sheet-off-seazn-chip"]) {
      const [c] = chips(tree, id);
      expect(c, id).toBeDefined();
      expect(propsOf(c!).href, id).toBeUndefined();
    }
  });

  it("held for the organiser: 'Needs a decision' leads to the board's card - in the panel when the page offers it, in the queue on the tab when it does not - every reason, counted", () => {
    // The queue (and its `#external-play-queue-row-<id>` anchor) is mounted only where the panel is NOT offered, so with a panel
    // link handed down the anchor would be a tap that does nothing. The differential, per reason:
    //   offered     -> the panel opened ON this board (`?fixture=`), never the anchor
    //   not offered -> the anchor to the board's card in the tab's queue, never a panel link
    let checked = 0;
    for (const reason of NEEDS_REASONS) {
      const held = online({ held: reason, live: false });
      const [chip, ...more] = chips(row({ onlinePlay: held }), "run-sheet-online-held-chip");
      expect(more, reason).toHaveLength(0);
      expect(textOf(chip), reason).toBe(messages["score.status.needs_decision"]);
      expect(propsOf(chip!).href, `${reason}: offered`).toBe(ARBITER);
      expect(propsOf(chip!)["data-reason"], reason).toBe(reason);

      const [bare, ...bareMore] = chips(row({ onlinePlay: held, arbiterHref: null }), "run-sheet-online-held-chip");
      expect(bareMore, `${reason}: not offered`).toHaveLength(0);
      expect(textOf(bare), `${reason}: not offered still says it`).toBe(messages["score.status.needs_decision"]);
      expect(propsOf(bare!).href, `${reason}: not offered`).toBe("#external-play-queue-row-f1");
      expect(propsOf(bare!)["data-reason"], `${reason}: not offered`).toBe(reason);
      checked++;
    }
    expect(checked).toBe(NEEDS_REASONS.length);
    expect(NEEDS_REASONS.length, "anti-vacuity: the reasons swept").toBeGreaterThan(0);
  });

  it("a fixture the engine already holds keeps ITS chip: one 'Needs a decision', never two", () => {
    const tree = row({ fixture: fx({ status: "needs_decision" }), onlinePlay: online({ held: "tiebreak_owed" }) });
    expect(chips(tree, "run-sheet-held-chip")).toHaveLength(1);
    expect(chips(tree, "run-sheet-online-held-chip")).toHaveLength(0);
  });
});

describe("the sheet: a held online board owes its result", () => {
  const STAGES = [{ id: "s1", kind: "league", name: "League", seq: 1 }];
  // Not past its slot: by the clock alone it owes nothing yet.
  const early = fx({ id: "f1", fixture_no: 1, status: "scheduled", scheduled_at: "2026-10-12T20:00:00.000Z" });
  const plain = fx({ id: "f2", fixture_no: 2, status: "scheduled", scheduled_at: "2026-10-12T20:00:00.000Z" });
  const ctx = (onlinePlay?: Record<string, RunSheetOnlinePlay>) => ({ stageId: null, tz: TZ, today: "2026-10-12", nowMs: NOW_MS, matchMinutes: 60, onlinePlay });
  const sheet = (filter: RunSheetFilter, onlinePlay?: Record<string, RunSheetOnlinePlay>) =>
    renderToStaticMarkup(
      <RunSheet
        blocks={buildRunSheet({ fixtures: [early, plain], stages: STAGES, tz: TZ, nowMs: NOW_MS })}
        stages={STAGES}
        tz={TZ}
        orgTz={TZ}
        nowMs={NOW_MS}
        matchMinutes={60}
        entrantNames={{ e1: "Alpha", e2: "Bravo" }}
        canEdit
        hrefFor={(f) => `/f/${f.fixture_no}`}
        filter={filter}
        onFilter={() => {}}
        stageId={null}
        onlinePlay={onlinePlay}
        arbiterHrefFor={(id) => `/arbiter?fixture=${id}`}
      />,
    );
  const rowsIn = (h: string) => [...h.matchAll(/<li data-fixture-no="(\d+)"/g)].map((m) => Number(m[1]));

  it("premise: neither row is owed by the clock — 'Needs result' is empty without the map", () => {
    expect(runSheetKeeps(early, "needs_result", ctx())).toBe(false);
    expect(rowsIn(sheet("needs_result"))).toEqual([]);
  });

  it("held ⇒ kept under 'Needs result' and counted; the other row is not; a released hold (held: null) is not", () => {
    const map = { f1: online({ held: "provider_error", live: false }) };
    expect(runSheetKeeps(early, "needs_result", ctx(map))).toBe(true);
    expect(runSheetKeeps(plain, "needs_result", ctx(map)), "the positive pair").toBe(false);
    const h = sheet("needs_result", map);
    expect(rowsIn(h)).toEqual([1]);
    expect(chipCount(h, "needs_result"), "the filter's count").toBe(1);
    expect(chipCount(sheet("needs_result"), "needs_result"), "the positive pair: no map, no count").toBe(0);
    expect(runSheetKeeps(early, "needs_result", ctx({ f1: online({ held: null }) })), "released").toBe(false);
  });

  it("the sheet hands each row ITS OWN entry and arbiter link", () => {
    const h = sheet("all", { f2: online({ cameraFlagCount: 1 }) });
    const rowOf = (no: number) => /<li data-fixture-no="\d+"[\s\S]*?<\/li>/g.exec(h.slice(h.indexOf(`<li data-fixture-no="${no}"`)))![0];
    expect(rowOf(2)).toContain('href="/arbiter?fixture=f2"');
    expect(rowOf(1)).not.toContain("run-sheet-camera-chip");
  });
});

describe("D12: a board of an online round nobody has opened owes nothing yet", () => {
  const STAGES = [{ id: "s1", kind: "league", name: "League", seq: 1 }];
  // Two hours past its slot (matchMinutes 60, now 19:00): by the clock alone it owes a result.
  const due = fx({ id: "f1", fixture_no: 1, status: "scheduled", scheduled_at: "2026-10-12T17:00:00.000Z" });
  const ctx = (onlinePlay?: Record<string, RunSheetOnlinePlay>) => ({ stageId: null, tz: TZ, today: "2026-10-12", nowMs: NOW_MS, matchMinutes: 60, onlinePlay });
  const unopened = { f1: online({ unopened: true, live: false, cameraPolicy: "off" }) };
  const sheet = (onlinePlay?: Record<string, RunSheetOnlinePlay>) =>
    renderToStaticMarkup(
      <RunSheet
        blocks={buildRunSheet({ fixtures: [due], stages: STAGES, tz: TZ, nowMs: NOW_MS })}
        stages={STAGES}
        tz={TZ}
        orgTz={TZ}
        nowMs={NOW_MS}
        matchMinutes={60}
        entrantNames={{ e1: "Alpha", e2: "Bravo" }}
        canEdit
        hrefFor={(f) => `/f/${f.fixture_no}`}
        filter="needs_result"
        onFilter={() => {}}
        stageId={null}
        onlinePlay={onlinePlay}
      />,
    );

  it("premise: past its slot with no map, it IS kept under 'Needs result' and counted", () => {
    expect(runSheetKeeps(due, "needs_result", ctx())).toBe(true);
    expect(chipCount(sheet(), "needs_result")).toBe(1);
  });

  it("unopened ⇒ not kept, not counted; the positive pair (opened) is", () => {
    expect(runSheetKeeps(due, "needs_result", ctx(unopened))).toBe(false);
    expect(chipCount(sheet(unopened), "needs_result")).toBe(0);
    expect(runSheetKeeps(due, "needs_result", ctx({ f1: online({ unopened: false, live: false }) }))).toBe(true);
  });

  it("the row says 'Round not opened' — and only for an unopened board", () => {
    const shown = chips(row({ fixture: due, onlinePlay: unopened.f1 }), "run-sheet-round-unopened");
    expect(shown).toHaveLength(1);
    expect(textOf(shown[0])).toBe(messages["runsheet.round.notOpenedChip"]);
    expect(chips(row({ fixture: due, onlinePlay: online({ live: false }) }), "run-sheet-round-unopened")).toHaveLength(0);
    expect(chips(row({ fixture: due }), "run-sheet-round-unopened"), "not an online board").toHaveLength(0);
  });
});

describe("StagesPanel threads the map and the arbiter link to the run sheet", () => {
  const stage = { id: "s1", seq: 1, kind: "league", name: "League", config: {}, progression: null, status: "active" };
  const fixture = {
    id: "f-s1", stage_id: "s1", pool_id: null, round_no: 1, seq_in_round: 1, fixture_no: 1,
    home_entrant_id: "e1", away_entrant_id: "e2", scheduled_at: "2026-03-01T10:00:00Z", venue: null, court_label: null,
    court_id: null, court_name: null, status: "in_play", outcome: null,
  };
  const props = {
    divisionId: "d1", competitionId: "c1", orgSlug: "org", compSlug: "comp", divSlug: "div",
    stages: [stage], fixtures: [fixture], entrantNames: { e1: "Alpha", e2: "Bravo" },
    canEdit: true, tz: "UTC", orgTz: "UTC", canExport: false, viewerPlan: "community" as const, phase: "scheduled" as const,
  };

  it("an entry for the row ⇒ its chips, the camera chip leading to the arbiter panel for THAT fixture when the page offers the panel; no map ⇒ none", () => {
    const entry = { "f-s1": online({ cameraFlagCount: 2, held: "aborted" }) };
    const h = renderToStaticMarkup(<StagesPanel {...props} onlinePlay={entry} arbiterHref="/o/org/c/comp/d/div/arbiter" />);
    // Typed from the route's contract, not built with the helper.
    expect(h).toContain('href="/o/org/c/comp/d/div/arbiter?fixture=f-s1"');
    // The held chip, offered: the panel on THIS board, and no dead anchor (nothing on the tab carries it while the panel is offered).
    expect(tagOf(h, "run-sheet-online-held-chip"), "offered: the held chip leads into the panel").toContain('href="/o/org/c/comp/d/div/arbiter?fixture=f-s1"');
    expect(h).not.toContain("#external-play-queue-row-f-s1");
    // The pair: the page did not offer the panel (`arbiterHref` absent), the camera chip is still there but leads nowhere.
    const notOffered = renderToStaticMarkup(<StagesPanel {...props} onlinePlay={entry} />);
    expect(notOffered, "the chip renders without the link").toContain("run-sheet-camera-chip");
    expect(notOffered, "no link into the panel").not.toContain("/arbiter");
    // ... and the held chip is the other half of the differential: with no panel offered the queue IS on the tab, so it scrolls to it.
    expect(tagOf(notOffered, "run-sheet-online-held-chip"), "not offered: the held chip leads to the queue's card").toContain('href="#external-play-queue-row-f-s1"');
    const bare = renderToStaticMarkup(<StagesPanel {...props} />);
    expect(bare, "the positive pair: the same row renders").toContain('data-fixture-no="1"');
    expect(bare).not.toContain("run-sheet-camera-chip");
    expect(bare).not.toContain("run-sheet-online-held-chip");
  });
});
