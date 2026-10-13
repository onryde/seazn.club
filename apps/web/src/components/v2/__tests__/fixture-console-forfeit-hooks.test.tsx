// W2b Task 11 (UI-1; spec §5.5, §7) — the organiser's forfeit dialog, driven through its REAL clicks. Replaces B07a
// Task 10's hook test for the old side menu + free-text reason prompt (R59(c)): the hooks moved with the controls,
// and `core.forfeit` is still authority-only on the scorer pad (`AUTHORITY_ONLY_EVENT_TYPES`, v3/pad-host.tsx), so the
// bench's and the matrix's tap drivers author it HERE — `score-forfeit`, then `forfeit-who-<side>`,
// `forfeit-why-<reason>`, `forfeit-confirm`.
//
// Same identity discipline as `scorepad/v3/__tests__/tap-hooks.test.tsx`: a hook is proven to sit on the RIGHT control,
// never merely to exist — the per-side test asserts WHICH entrant the send names, so a hook pair swapped between the
// two sides fails even though both still render. The dialog renders only after a click, which `renderToStaticMarkup`
// can never show, so this file uses `_hook-harness.tsx`'s `renderIsland` (one level: the console, then the dialog).
//
// Expected values are the rules': X-RS-1 / D3 as amended by rulings 112 and 113 for the chips (until something is played
// a walkover or Neither — after a bare Start too, beside a disqualification; once something is played retired or
// disqualified; never withdrew — PF-2), and ruling 118 for chess (its Start is play, so a bare Start offers the
// retirement), §7 for the refusal (the dialog closes, the reason shows on the console).
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { foldMatch } from "@seazn/engine/core";
import { builtinModules } from "@seazn/engine/sports";
import { defaultLineupPair, makeEnvelope, onePlayEvent } from "@seazn/engine/testkit";
import type { EventEnvelope } from "@seazn/engine/core";
import { FixtureConsole } from "@/components/v2/fixture-console";
import { ForfeitDialog, forfeitDialogModel } from "@/components/v2/forfeit-dialog";
import type { EventIn, SideInfo, SportInfo } from "@/components/v2/fixture-console";
import { propsOf, renderIsland, textOf, type Props } from "@/components/__tests__/_hook-harness";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { messages, type MessageKey } from "@/lib/messages";
import { t as tRuntime } from "@/lib/i18n-runtime";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return {
    ...actual,
    apiV1: vi.fn((url: string) => {
      if (url.includes("/events")) return Promise.resolve([] as EventIn[]);
      return Promise.resolve({ status: "in_play", last_seq: 1, summary: null, state: null, outcome: null });
    }),
  };
});

const en = (key: MessageKey) => tRuntime(messages, key);

const generic = builtinModules.find((m) => m.key === "generic")!;
const CFG = generic.configSchema.parse(Object.values(generic.variants)[0] ?? {});
const sport: SportInfo = { key: "generic", config: {}, scorerLabel: "Scorer", positionGroups: [], roles: [], lineupSize: 0, benchMax: 0 };

const HOME: SideInfo = { id: "home-1", name: "Riverside FC", members: [], lineup: [] };
const AWAY: SideInfo = { id: "away-1", name: "Summit Athletic", members: [], lineup: [] };
const LINEUPS = defaultLineupPair(generic.positions);
const START = makeEnvelope(1, { type: "core.start", payload: {} });
/** Ruling 112's "something is played": generic's own generator draws the event, never a typed one. */
const PLAY = onePlayEvent(generic, CFG, LINEUPS, [START]);
if (PLAY === null) throw new Error("generic: its generator draws no sport event after the start");
/** The two in-play ledgers: a bare Start (nothing played), and the Start then the sport's own event. */
const LEDGERS = { started: [START], in_play: [START, PLAY] };
/** A ledger as the console holds it: the page's `listEvents` rows. */
const rowsOf = (ledger: readonly EventEnvelope[]): EventIn[] =>
  ledger.map((e) => ({ id: e.id, seq: e.seq, type: e.type, payload: e.payload, recorded_at: "2026-10-09T10:00:00Z", voids_event_id: e.voids ?? null }));

/** `in_play`: something was played; `started`: Start pressed, nothing played (ruling 112); `scheduled`: before the start. */
type Shape = "in_play" | "started" | "scheduled";
function baseProps(shape: Shape, noNextMatch = false) {
  const ledger = shape === "scheduled" ? [] : LEDGERS[shape];
  const status = shape === "scheduled" ? "scheduled" : "in_play";
  const live = { status, last_seq: ledger.length, summary: null, state: shape === "scheduled" ? null : foldMatch(generic, CFG, LINEUPS, ledger), outcome: null };
  return {
    fixture: { id: "f1", status, scheduled_at: null, venue_name: null, court_name: null, round_no: 1, no_next_match: noNextMatch },
    sport,
    home: HOME,
    away: AWAY,
    initialState: live,
    initialEvents: rowsOf(ledger),
    canEdit: true,
    canOrganise: true,
    stageKind: null,
    viewerPlan: "community" as const,
    scorePadV2: {
      moduleVersion: generic.version,
      resolvedConfig: CFG,
      initialEvents: [],
      entitlements: {},
      stageKind: null,
      identity: { recordedBy: "user-1", deviceLinkId: null },
    },
  };
}

type Component = (props: Props) => ReactNode;
const byTestid = (tree: ReactElement[], testid: string) => tree.filter((e) => propsOf(e)["data-testid"] === testid);
const click = (el: ReactElement | undefined) => (propsOf(el!).onClick as () => void)();

/** The console, and the `<ForfeitDialog/>` element its `score-forfeit` opens (the only child handed `model` AND `forfeit`). */
function openConsole(shape: Shape, noNextMatch = false) {
  const island = renderIsland(FixtureConsole, baseProps(shape, noNextMatch));
  const dialogEl = () => island.tree().find((e) => typeof e.type === "function" && propsOf(e).model !== undefined && propsOf(e).forfeit !== undefined);
  const toggles = byTestid(island.tree(), "score-forfeit");
  expect(toggles, 'exactly one data-testid="score-forfeit"').toHaveLength(1);
  expect(toggles[0]!.type).toBe("button");
  expect(textOf(toggles[0]!)).toContain(en("score.forfeit"));
  expect(dialogEl(), "the dialog mounts only once Forfeit is clicked").toBeUndefined();
  click(toggles[0]);
  const el = dialogEl();
  if (el === undefined) throw new Error("score-forfeit did not open the forfeit dialog");
  return { island, el, dialogEl };
}

/** The dialog island, with its `forfeit` / `onClose` / `onRefused` doubled so a test reads what it sends. */
type Send = (p: unknown) => Promise<{ ok: true } | { ok: false; message: string }>;
function driveDialog(el: ReactElement, forfeit = vi.fn<Send>(async () => ({ ok: true }))) {
  const onClose = vi.fn();
  const onRefused = vi.fn();
  const dialog = renderIsland(el.type as Component, { ...propsOf(el), forfeit, onClose, onRefused });
  return { dialog, forfeit, onClose, onRefused, tree: () => dialog.tree() };
}

beforeEach(() => {
  vi.useFakeTimers();
  // The dialog registers its keydown trap on `document` in an effect.
  vi.stubGlobal("document", { addEventListener: () => {}, removeEventListener: () => {}, activeElement: null });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.mocked(apiV1).mockClear();
});

describe("UI-1: the organiser's forfeit dialog carries stable hooks and sends the closed vocabulary", () => {
  it.each([
    ["home", HOME, AWAY],
    ["away", AWAY, HOME],
  ] as const)("after play: forfeit-who-%s names ITS OWN side and forfeits ITS OWN entrant; why is retired/disqualified only", async (sideKey, own, other) => {
    const { el } = openConsole("in_play");
    const d = driveDialog(el);
    expect(byTestid(d.tree(), "forfeit-who-both"), "no Neither once something is played").toHaveLength(0);
    const who = byTestid(d.tree(), `forfeit-who-${sideKey}`);
    expect(who, `exactly one data-testid="forfeit-who-${sideKey}"`).toHaveLength(1);
    expect(who[0]!.type).toBe("button");
    expect(textOf(who[0]!)).toContain(own.name);
    expect(textOf(who[0]!)).not.toContain(other.name);
    expect(byTestid(d.tree(), "forfeit-why-retired"), "the reasons appear once a side is chosen").toHaveLength(0);

    const confirm = () => byTestid(d.tree(), "forfeit-confirm")[0]!;
    expect(propsOf(confirm()).disabled, "Confirm is blocked with nothing chosen").toBe(true);
    click(who[0]);
    expect(propsOf(byTestid(d.tree(), `forfeit-who-${sideKey}`)[0]!)["aria-pressed"]).toBe(true);
    expect(propsOf(confirm()).disabled, "Confirm is blocked with only the side chosen").toBe(true);
    const offered = ["walkover", "retired", "disqualified", "withdrew"].filter((r) => byTestid(d.tree(), `forfeit-why-${r}`).length > 0);
    expect(offered, "after play: retired or disqualified (X-RS-1, ruling 112); withdrew is the cascade's (PF-2)").toEqual(["retired", "disqualified"]);
    const retired = byTestid(d.tree(), "forfeit-why-retired")[0]!;
    expect(retired.type).toBe("input");
    expect(propsOf(retired).type).toBe("radio");
    (propsOf(retired).onChange as () => void)();

    expect(propsOf(confirm()).disabled).toBe(false);
    expect(textOf(confirm()), "one specific Confirm").toBe(en("forfeitDialog.confirm.retired"));
    // GN-RT-1: a generic retirement is the walkover credit (GN-WO-1: no score) KEEPING THE RECORDED SCORE — the one
    // played event's points, read off the ledger this console holds.
    const played = PLAY.payload as { by: string; points: number };
    const [homeScore, awayScore] = played.by === LINEUPS.home.entrantId ? [played.points, 0] : [0, played.points];
    expect(homeScore + awayScore, "rig: the played event scored").toBeGreaterThan(0);
    expect(textOf(byTestid(d.tree(), "forfeit-preview")[0]!), "GN-RT-1: the recorded score stands").toBe(
      tRuntime(messages, "forfeitDialog.preview", { home: HOME.name, homeScore, away: AWAY.name, awayScore }),
    );
    click(confirm());
    await vi.waitFor(() => expect(d.onClose).toHaveBeenCalledTimes(1));
    expect(d.forfeit).toHaveBeenCalledTimes(1);
    expect(d.forfeit).toHaveBeenCalledWith({ by: own.id, reason: "retired" });
    expect(d.onRefused).not.toHaveBeenCalled();
  });

  it("X-RS-1 (rulings 112, 113): after Start with nothing played, the console offers Neither, the walkover and the disqualification, never the retirement — a side's walkover names the OTHER side's win", async () => {
    // The console-wiring witness: the same fixture `in_play` above offers neither (its ledger holds a played event).
    // What decides it is the console's reading of its own ledger, handed to the engine's admission.
    const { el } = openConsole("started");
    const d = driveDialog(el);
    for (const w of ["home", "away", "both"]) expect(byTestid(d.tree(), `forfeit-who-${w}`), w).toHaveLength(1);
    click(byTestid(d.tree(), "forfeit-who-away")[0]);
    const offered = ["walkover", "retired", "disqualified", "withdrew"].filter((r) => byTestid(d.tree(), `forfeit-why-${r}`).length > 0);
    expect(offered, "a bare Start: the walkover beside disqualified (R4); no retirement until something is played (ruling 113); withdrew is the cascade's (PF-2)").toEqual(["walkover", "disqualified"]);
    (propsOf(byTestid(d.tree(), "forfeit-why-walkover")[0]!).onChange as () => void)();
    const confirm = byTestid(d.tree(), "forfeit-confirm")[0]!;
    expect(textOf(confirm)).toBe(en("forfeitDialog.confirm.walkover"));
    click(confirm);
    await vi.waitFor(() => expect(d.onClose).toHaveBeenCalledTimes(1));
    expect(d.forfeit).toHaveBeenCalledWith({ by: AWAY.id, reason: "walkover" });
  });

  it("X-RS-1 (ruling 112): after Start with nothing played, Neither walks over — a double walkover, `by: \"both\"`", async () => {
    const { el } = openConsole("started");
    const d = driveDialog(el);
    click(byTestid(d.tree(), "forfeit-who-both")[0]);
    const offered = ["walkover", "retired", "disqualified", "withdrew"].filter((r) => byTestid(d.tree(), `forfeit-why-${r}`).length > 0);
    expect(offered).toEqual(["walkover"]);
    (propsOf(byTestid(d.tree(), "forfeit-why-walkover")[0]!).onChange as () => void)();
    const confirm = byTestid(d.tree(), "forfeit-confirm")[0]!;
    expect(textOf(confirm)).toBe(en("forfeitDialog.confirm.doubleWalkover"));
    click(confirm);
    await vi.waitFor(() => expect(d.onClose).toHaveBeenCalledTimes(1));
    expect(d.forfeit).toHaveBeenCalledWith({ by: "both", reason: "walkover" });
  });

  it("ruling 118: a chess console after a bare Start offers the retirement — the console reads its ledger with the fixture's OWN module — and Confirm sends it; the Start voided takes it back", async () => {
    // Single-sport: boardgame is the one module declaring its Start play (ruling 118: Seazn records no chess moves, so
    // a game in progress is a game played). The generic console above, on the same bare Start, offers no retirement —
    // the positive pair: what moves the chips is the module the console hands `forfeitPlayRecorded`, nothing else.
    const chess = builtinModules.find((m) => m.key === "boardgame")!;
    expect(chess.startIsPlay, "rig: chess declares its Start play").toBe(true);
    const chessCfg = chess.configSchema.parse(Object.values(chess.variants)[0] ?? {});
    const chessLineups = defaultLineupPair(chess.positions);
    const chessSport: SportInfo = { ...sport, key: "boardgame" };
    const open = (ledger: EventEnvelope[]) => {
      vi.mocked(apiV1).mockImplementation(((url: string) => {
        if (url.includes("/events")) return Promise.resolve(rowsOf(ledger));
        return Promise.resolve({ status: "in_play", last_seq: ledger.length, summary: null, state: foldMatch(chess, chessCfg, chessLineups, ledger), outcome: null });
      }) as typeof apiV1);
      const base = baseProps("started");
      const live = { status: "in_play", last_seq: ledger.length, summary: null, state: foldMatch(chess, chessCfg, chessLineups, ledger), outcome: null };
      const island = renderIsland(FixtureConsole, {
        ...base,
        sport: chessSport,
        initialState: live,
        initialEvents: rowsOf(ledger),
        scorePadV2: { ...base.scorePadV2, moduleVersion: chess.version, resolvedConfig: chessCfg },
      });
      click(byTestid(island.tree(), "score-forfeit")[0]);
      const el = island.tree().find((e) => typeof e.type === "function" && propsOf(e).model !== undefined && propsOf(e).forfeit !== undefined);
      if (el === undefined) throw new Error("score-forfeit did not open the chess forfeit dialog");
      const d = driveDialog(el);
      click(byTestid(d.tree(), "forfeit-who-away")[0]);
      const offered = ["walkover", "retired", "disqualified", "withdrew"].filter((r) => byTestid(d.tree(), `forfeit-why-${r}`).length > 0);
      return { d, offered };
    };
    const original = vi.mocked(apiV1).getMockImplementation()!;
    try {
      const started = open([START]);
      expect(started.offered, "chess after a bare Start: walkover (FIDE 6.7.1), retired and disqualified (ruling 118); withdrew is the cascade's (PF-2)").toEqual(["walkover", "retired", "disqualified"]);
      (propsOf(byTestid(started.d.tree(), "forfeit-why-retired")[0]!).onChange as () => void)();
      const confirm = byTestid(started.d.tree(), "forfeit-confirm")[0]!;
      expect(textOf(confirm)).toBe(en("forfeitDialog.confirm.retired"));
      click(confirm);
      await vi.waitFor(() => expect(started.d.onClose).toHaveBeenCalledTimes(1));
      expect(started.d.forfeit).toHaveBeenCalledWith({ by: AWAY.id, reason: "retired" });
      // The take-back: the Start voided is nothing played again — the walkover only.
      const voided = open([START, makeEnvelope(2, { type: "core.void", payload: {} }, START.id)]);
      expect(voided.offered, "chess, the Start voided").toEqual(["walkover"]);
    } finally {
      vi.mocked(apiV1).mockImplementation(original);
    }
  });

  it("X-RS-1 (rulings 112, 113; R112 review M-1): ONE mounted console follows its ledger through resyncs — [start] → [start, play] → [start, play, void play] — and its dialog's reasons move with it each time", async () => {
    // The state read is HELD at one object across every resync (a server answer that did not move). The ledger the
    // console re-reads (`listEvents` since 0) is then its only moving input, so the reasons can only follow it through
    // `forfeitPlayRecorded(events)` and the model's memo. If either memo drops its dependency, the reasons go stale.
    const HELD = foldMatch(generic, CFG, LINEUPS, [START]);
    const voidOfPlay = makeEnvelope(3, { type: "core.void", payload: {} }, PLAY.id);
    let ledger: EventEnvelope[] = [START];
    const original = vi.mocked(apiV1).getMockImplementation()!;
    vi.mocked(apiV1).mockImplementation(((url: string, init?: { method?: string }) => {
      // The forfeit write loses a race (SEQ_CONFLICT), which is what makes the console resync.
      if (url.endsWith("/events") && init?.method === "POST") return Promise.reject(new ApiV1Error("Score moved", 409, "SEQ_CONFLICT"));
      if (url.includes("/events")) return Promise.resolve(rowsOf(ledger));
      return Promise.resolve({ status: "in_play", last_seq: ledger.length, summary: null, state: HELD, outcome: null });
    }) as typeof apiV1);
    try {
      const props = { ...baseProps("started"), initialState: { status: "in_play", last_seq: 1, summary: null, state: HELD, outcome: null } };
      const island = renderIsland(FixtureConsole, props);
      click(byTestid(island.tree(), "score-forfeit")[0]);
      type M = { who: readonly string[]; why: (w: string) => readonly string[] };
      const dialogEl = () => island.tree().find((e) => typeof e.type === "function" && propsOf(e).model !== undefined && propsOf(e).forfeit !== undefined);
      const live = () => (propsOf(dialogEl()!) as { live?: M | null }).live!;
      const reading = () => ({ who: [...live().who], why: [...live().why("home")] });
      // Expected values: X-RS-1 as amended by rulings 112 and 113. Nothing played: Neither and the walkover, beside
      // disqualified (R4) — no retirement (ruling 113). Something played: no Neither, no walkover, the retirement. Withdrew
      // is never the dialog's (PF-2).
      const NOTHING = { who: ["home", "away", "both"], why: ["walkover", "disqualified"] };
      const PLAYED = { who: ["home", "away"], why: ["retired", "disqualified"] };
      const steps: [string, EventEnvelope[], typeof NOTHING][] = [
        ["[start, play]", [START, PLAY], PLAYED],
        ["[start, play, void play]", [START, PLAY, voidOfPlay], NOTHING],
      ];
      expect(reading(), "[start]").toEqual(NOTHING);
      let resyncs = 0;
      for (const [name, next, want] of steps) {
        ledger = next;
        const before = vi.mocked(apiV1).mock.calls.filter(([u]) => u.includes("since_seq=0")).length;
        await (propsOf(dialogEl()!).forfeit as (p: unknown) => Promise<unknown>)({ by: AWAY.id, reason: "disqualified" });
        await vi.waitFor(() => expect(vi.mocked(apiV1).mock.calls.filter(([u]) => u.includes("since_seq=0")).length, `${name}: the console re-read its ledger`).toBe(before + 1));
        await vi.waitFor(() => expect(reading(), name).toEqual(want));
        resyncs++;
      }
      expect(resyncs).toBe(2);
    } finally {
      vi.mocked(apiV1).mockImplementation(original);
    }
  });

  it("before play: Neither walks over — a double walkover, its own Confirm, `by: \"both\"`", async () => {
    const { el } = openConsole("scheduled");
    const d = driveDialog(el);
    for (const w of ["home", "away", "both"]) expect(byTestid(d.tree(), `forfeit-who-${w}`), w).toHaveLength(1);
    expect(textOf(byTestid(d.tree(), "forfeit-who-both")[0]!)).toBe(en("forfeitDialog.who.both"));
    expect(byTestid(d.tree(), "forfeit-guidance-no-next-match")).toHaveLength(0);
    click(byTestid(d.tree(), "forfeit-who-both")[0]);
    const offered = ["walkover", "retired", "disqualified", "withdrew"].filter((r) => byTestid(d.tree(), `forfeit-why-${r}`).length > 0);
    expect(offered).toEqual(["walkover"]);
    (propsOf(byTestid(d.tree(), "forfeit-why-walkover")[0]!).onChange as () => void)();
    const confirm = byTestid(d.tree(), "forfeit-confirm")[0]!;
    expect(textOf(confirm)).toBe(en("forfeitDialog.confirm.doubleWalkover"));
    click(confirm);
    await vi.waitFor(() => expect(d.onClose).toHaveBeenCalledTimes(1));
    expect(d.forfeit).toHaveBeenCalledWith({ by: "both", reason: "walkover" });
  });

  it("X-DW-3: on a fixture with no next match the guidance replaces Neither (the page's server-side reading)", () => {
    const { el } = openConsole("scheduled", true);
    const d = driveDialog(el);
    expect(byTestid(d.tree(), "forfeit-who-both")).toHaveLength(0);
    const g = byTestid(d.tree(), "forfeit-guidance-no-next-match");
    expect(g).toHaveLength(1);
    expect(textOf(g[0]!)).toBe(en("forfeitDialog.guidance.noNextMatch"));
    expect(byTestid(d.tree(), "forfeit-who-home"), "a side's walkover is still offered").toHaveLength(1);
  });

  it("Review Focus 4: a double tap on Confirm sends ONE forfeit (the synchronous guard), and Confirm is blocked while sending", async () => {
    const { el } = openConsole("in_play");
    let answer!: (v: { ok: true }) => void;
    const forfeit = vi.fn<Send>(() => new Promise<{ ok: true }>((r) => (answer = r)));
    const d = driveDialog(el, forfeit);
    click(byTestid(d.tree(), "forfeit-who-away")[0]);
    (propsOf(byTestid(d.tree(), "forfeit-why-disqualified")[0]!).onChange as () => void)();
    const confirm = byTestid(d.tree(), "forfeit-confirm")[0]!;
    click(confirm);
    click(confirm);
    expect(forfeit).toHaveBeenCalledTimes(1);
    expect(propsOf(byTestid(d.tree(), "forfeit-confirm")[0]!).disabled, "blocked while the first send is in flight").toBe(true);
    answer({ ok: true });
    await vi.waitFor(() => expect(d.onClose).toHaveBeenCalledTimes(1));
    expect(forfeit).toHaveBeenCalledWith({ by: AWAY.id, reason: "disqualified" });
  });

  it("the console's own send: Confirm POSTs `core.forfeit {by, reason}` through the console's one write", async () => {
    const { el } = openConsole("in_play");
    const r = await (propsOf(el).forfeit as (p: unknown) => Promise<unknown>)({ by: AWAY.id, reason: "retired" });
    expect(r).toEqual({ ok: true });
    const posts = vi.mocked(apiV1).mock.calls.filter(([url, init]) => url.endsWith("/events") && (init as { method?: string } | undefined)?.method === "POST");
    expect(posts, "exactly one event POST").toHaveLength(1);
    const json = (posts[0]![1] as { json: { type: string; payload: unknown } }).json;
    expect(json.type).toBe("core.forfeit");
    expect(json.payload).toEqual({ by: AWAY.id, reason: "retired" });
  });

  it("§7: a refused forfeit closes the dialog and the console shows the reason (`forfeit-refusal`), localized by code", async () => {
    vi.mocked(apiV1).mockImplementationOnce(() => Promise.reject(new ApiV1Error("Match already decided", 409, "ALREADY_DECIDED")));
    const { island, el, dialogEl } = openConsole("in_play");
    expect(byTestid(island.tree(), "forfeit-refusal"), "no refusal before a send").toHaveLength(0);
    const r = (await (propsOf(el).forfeit as (p: unknown) => Promise<{ ok: boolean; message?: string }>)({ by: AWAY.id, reason: "retired" }));
    expect(r).toEqual({ ok: false, message: en("engineError.ALREADY_DECIDED") });
    (propsOf(dialogEl()!).onRefused as (m: string) => void)(r.message!);
    expect(dialogEl(), "the refusal closed the dialog").toBeUndefined();
    const line = byTestid(island.tree(), "forfeit-refusal");
    expect(line).toHaveLength(1);
    expect(textOf(line[0]!)).toBe(en("engineError.ALREADY_DECIDED"));
    // Design audit 1.4: ONE red-banner treatment on the console — the refusal wears the console's own error banner
    // (fixture-console's `error` line), not a second bordered, rounded-lg, red-800 style. role=alert stays. The banner's
    // classes are READ from that line in the source, never typed here, so the two cannot drift apart.
    const src = readFileSync(new URL("../fixture-console.tsx", import.meta.url), "utf8");
    const banners = [...src.matchAll(/<p className="([^"]+)">\{error\}<\/p>/gu)];
    expect(banners, "the console's error banner, once").toHaveLength(1);
    const house = banners[0]![1]!.split(/\s+/u);
    const cls = new Set(String(propsOf(line[0]!).className).split(/\s+/u));
    expect(house.filter((token) => !cls.has(token)), "the refusal wears every class of the console's error banner").toEqual([]);
    // Design review M-2: the banner's text is red-700 on red-50 (≈5.9:1); red-600 measured 4.4:1, under AA for 14px.
    expect([cls.has("text-red-700"), cls.has("text-red-600")], "AA red on the banner").toEqual([true, false]);
    for (const token of ["border", "border-red-200", "rounded-lg", "text-red-800"]) expect(cls.has(token), `no second style: ${token}`).toBe(false);
    expect(propsOf(line[0]!).role).toBe("alert");
    // Reopening the dialog clears the old refusal.
    click(byTestid(island.tree(), "score-forfeit")[0]);
    expect(byTestid(island.tree(), "forfeit-refusal")).toHaveLength(0);
    expect(dialogEl()).toBeDefined();
  });

  it("the dialog reports a refusal instead of closing: onRefused, never onClose", async () => {
    const { el } = openConsole("in_play");
    const d = driveDialog(el, vi.fn<Send>(async () => ({ ok: false, message: "nope" })));
    click(byTestid(d.tree(), "forfeit-who-home")[0]);
    (propsOf(byTestid(d.tree(), "forfeit-why-retired")[0]!).onChange as () => void)();
    click(byTestid(d.tree(), "forfeit-confirm")[0]);
    await vi.waitFor(() => expect(d.onRefused).toHaveBeenCalledWith("nope"));
    expect(d.onClose).not.toHaveBeenCalled();
  });
});

// Fix round 1 (review M-1, M-2).
describe("UI-1 fix round 1: the preview follows the ledger, and an old refusal does not outlive the next write", () => {
  it("M-1: the console hands the open dialog its CURRENT model as `live`; the chips stay the snapshot taken at open", async () => {
    // A resync while the dialog is open (here the one a SEQ_CONFLICT answer triggers) brings an empty ledger: the match
    // is back before play. `live` follows it (Neither returns); `model`, the chips, does not.
    vi.mocked(apiV1).mockImplementationOnce(() => Promise.reject(new ApiV1Error("Score moved", 409, "SEQ_CONFLICT")));
    const { el, dialogEl } = openConsole("in_play");
    type M = { who: readonly string[] };
    const at = () => propsOf(dialogEl()!) as { model: M; live?: M | null };
    expect(at().live, "the console passes its current model").toBeTruthy();
    expect(at().live!.who, "at open, the current model IS the snapshot's reading").toEqual(["home", "away"]);
    await (propsOf(el).forfeit as (p: unknown) => Promise<unknown>)({ by: AWAY.id, reason: "retired" });
    await vi.waitFor(() => expect(at().live!.who, "after the resync: before play again").toEqual(["home", "away", "both"]));
    expect(at().model.who, "the chips stay the snapshot").toEqual(["home", "away"]);
  });

  it("M-1: the dialog's preview reads `live` — a goal recorded after it opened moves the credited score (FB-RT-1)", () => {
    // FB-RT-1 (FDC Art. 28): the side that retires concedes the awarded 3-0, or the real margin where that is worse.
    const football = builtinModules.find((m) => m.key === "football")!;
    const cfg = football.configSchema.parse(Object.values(football.variants)[0] ?? {});
    const l = defaultLineupPair(football.positions);
    const fold = (goals: number) => {
      const ledger: EventEnvelope[] = [makeEnvelope(1, { type: "core.start", payload: {} })];
      for (let i = 0; i < goals; i++) ledger.push(makeEnvelope(i + 2, { type: "football.goal", payload: { by: l.home.entrantId } }));
      // Ruling 112: a goal is the sport's own event — something is played whenever one was scored.
      return forfeitDialogModel(football, cfg, foldMatch(football, cfg, l, ledger), { noNextMatch: false, playRecorded: goals > 0 });
    };
    const props = (live: ReturnType<typeof fold> | null) => ({
      msg: (key: MessageKey, vars?: Record<string, string | number>) => tRuntime(messages, key, vars),
      model: fold(1),
      live,
      home: { id: l.home.entrantId, name: HOME.name },
      away: { id: l.away.entrantId, name: AWAY.name },
      forfeit: vi.fn<Send>(async () => ({ ok: true })),
      onClose: vi.fn(),
      onRefused: vi.fn(),
    });
    const previewWith = (live: ReturnType<typeof fold> | null) => {
      const d = renderIsland(ForfeitDialog as unknown as Component, props(live));
      click(byTestid(d.tree(), "forfeit-who-away")[0]);
      (propsOf(byTestid(d.tree(), "forfeit-why-retired")[0]!).onChange as () => void)();
      return textOf(byTestid(d.tree(), "forfeit-preview")[0]!);
    };
    const line = (h: number, a: number) => tRuntime(messages, "forfeitDialog.preview", { home: HOME.name, homeScore: h, away: AWAY.name, awayScore: a });
    expect(previewWith(null), "no current model: the snapshot taken at 1-0").toBe(line(3, 0));
    expect(previewWith(fold(4)), "the ledger moved to 4-0 under the open dialog").toBe(line(4, 0));
  });

  it("M-2: a forfeit refusal clears on the console's next write — here an Abandon — not only when the dialog reopens", async () => {
    vi.mocked(apiV1).mockImplementationOnce(() => Promise.reject(new ApiV1Error("Score moved", 409, "SEQ_CONFLICT")));
    const { island, el, dialogEl } = openConsole("in_play");
    const r = await (propsOf(el).forfeit as (p: unknown) => Promise<{ ok: boolean; message?: string }>)({ by: AWAY.id, reason: "retired" });
    expect(r).toEqual({ ok: false, message: en("score.seqConflict") });
    (propsOf(dialogEl()!).onRefused as (m: string) => void)(r.message!);
    expect(byTestid(island.tree(), "forfeit-refusal"), "the refusal shows").toHaveLength(1);
    // The next write: Abandon…, its prompt, a reason.
    const abandon = island.tree().find((e) => e.type === "button" && textOf(e) === en("score.abandon"));
    click(abandon);
    const prompt = island.tree().find((e) => typeof e.type === "function" && propsOf(e).title === en("score.abandonPrompt"));
    expect(prompt, "Abandon opened its prompt").toBeDefined();
    (propsOf(prompt!).onSubmit as (reason: string) => void)("rain");
    await vi.waitFor(() => expect(byTestid(island.tree(), "forfeit-refusal"), "the old refusal is gone").toHaveLength(0));
    const posts = vi.mocked(apiV1).mock.calls.filter(([url, init]) => url.endsWith("/events") && (init as { method?: string } | undefined)?.method === "POST");
    expect(posts.map(([, init]) => (init as { json: { type: string } }).json.type), "the abandon was the write that cleared it").toEqual(["core.forfeit", "core.abandon"]);
  });
});

// Design review M-4 — the withdrawn header's composition truncates its names ONLY on the phone strip with its details
// closed, as the header's one line always did; opening the details (or ≥768, where `max-md:` is inert) wraps the line
// between whole items so both names are read in full. The static header test sees the closed state only; this drives
// the details toggle through the island.
describe("M-4: a withdrawn side's header line wraps once the phone details are open", () => {
  it("closed: a nowrap phone line of truncating names; opened: a wrapping line, names whole", () => {
    const base = baseProps("scheduled");
    const island = renderIsland(FixtureConsole, {
      ...base,
      fixture: { ...base.fixture, status: "forfeited", away_unseated_name: "Charlie Gone" },
      away: null,
      initialState: { ...base.initialState, status: "forfeited", outcome: { kind: "award", winner: HOME.id, loser: "e-gone", reason: "withdrew" } },
    } as never);
    const h1 = () => island.tree().find((e) => e.type === "h1")!;
    const nameSpan = (name: string) => island.tree().find((e) => e.type === "span" && propsOf(e).children === name);
    const cls = (e: ReactElement | undefined) => String(propsOf(e!).className).split(/\s+/u);
    expect(byTestid(island.tree(), "console-withdrawn"), "premise: the withdrawn composition is on").toHaveLength(1);
    expect(cls(h1()), "closed: the phone line does not wrap").toEqual(expect.arrayContaining(["flex", "flex-wrap", "max-md:flex-nowrap"]));
    expect(cls(nameSpan("Charlie Gone")), "closed: her name truncates on the phone").toContain("max-md:truncate");
    expect(cls(nameSpan(HOME.name)), "closed: the opponent truncates on the phone").toContain("max-md:truncate");
    const toggle = island.tree().find((e) => propsOf(e)["aria-label"] === en("console.phone.showDetails"));
    expect(toggle, "the phone details toggle").toBeDefined();
    click(toggle);
    expect(cls(h1()), "opened: the line wraps").toContain("flex-wrap");
    expect(cls(h1()), "opened: never nowrap").not.toContain("max-md:flex-nowrap");
    expect(cls(nameSpan("Charlie Gone")), "opened: her name whole").not.toContain("max-md:truncate");
    expect(cls(nameSpan(HOME.name)), "opened: the opponent whole").not.toContain("max-md:truncate");
  });
});

