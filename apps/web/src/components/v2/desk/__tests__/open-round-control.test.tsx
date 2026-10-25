// T16 (D12, canvas OpenRoundPhone / OpenRoundConfirmPhone / OpenRoundDesktop), retargeted by phase 2 (Task 10). The Open round control
// that rendered each state on a stage card is deleted; this file now covers what is KEPT in open-round-control.tsx because the
// Arbiter Panel's round column reads it: the confirmation shown BEFORE anything is sent (how many players, which pairings), the
// invite state of a pairing, the count of players a press reaches, and the rule for drawing a staggered round's check-in groups.
// (How the column lays them out is arbiter/__tests__/round-column.test.tsx's.) Copy is read from the dictionaries, never typed
// here; the window's minutes come from the window module itself.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DictProvider } from "@/components/i18n/dict-provider";
import esUi from "@/dictionaries/es/ui.json";
import frUi from "@/dictionaries/fr/ui.json";
import nlUi from "@/dictionaries/nl/ui.json";
import type { Dict, Locale } from "@/lib/i18n-constants";
import { fmtTime } from "@/lib/format";
import { messages } from "@/lib/messages";
import type { OpenRoundBatch, OpenRoundPairing, OpenRoundView } from "@/lib/open-round";
import { CHECKIN_BATCH_GAP_MS, CHECKIN_BATCH_SIZE, DEADLINE_AFTER_MS } from "@/server/external-play/window";
import { OpenRoundConfirmBody, inviteState, owedPlayers, timedBatches } from "../open-round-control";
import { emptyExtendTally } from "@/lib/checkin-extend";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const en = messages as unknown as Record<string, string>;
const TZ = "Europe/London";
const OPENED = "2026-10-16T18:04:00.000Z"; // 19:04 in London (BST)
const pl = (key: string, n: number, vars: Record<string, string | number> = {}) =>
  Object.entries({ count: n, ...vars }).reduce(
    (s, [k, v]) => s.replaceAll(`{${k}}`, String(v)),
    en[`${key}.${n === 1 ? "one" : "other"}`]!,
  );
const t = (key: string, vars: Record<string, string | number> = {}) =>
  Object.entries(vars).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, String(v)), en[key]!);
/** React escapes text; compare against the escaped form. */
const esc = (s: string) => s.replaceAll("&", "&amp;").replaceAll("'", "&#x27;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const P = (n: number, o: Partial<OpenRoundPairing> = {}): OpenRoundPairing => ({
  fixtureId: `f${n}`,
  boardNo: n,
  whiteName: `White ${n}`,
  blackName: `Black ${n}`,
  invitedAt: null,
  owedSeats: 2,
  canResend: false,
  ...o,
});
const ROUND = (o: Partial<OpenRoundView> = {}): OpenRoundView => ({
  stageId: "s1",
  stageName: "Swiss",
  roundNo: 4,
  state: "paired",
  openedAt: null,
  deadlineAt: null,
  windowMinutes: DEADLINE_AFTER_MS / 60_000,
  staggered: false,
  batches: [],
  staggerSpanMinutes: 0,
  scheduledAt: "2026-10-16T19:00:00.000Z",
  press: "open",
  earlierInPlay: [],
  pairings: [P(1), P(2), P(3)],
  extendableBoards: 0,
  extendWindows: [],
  extendRefusals: emptyExtendTally(),
  ...o,
});
/** The `msg` / `plural` the column hands the helpers (`useMsg` / `useMsgPlural`), over the English catalogue. */
const msg = (key: string, vars: Record<string, string | number> = {}) => t(key, vars);
const plural = (key: string, n: number, vars: Record<string, string | number> = {}) => pl(key, n, vars);
/** A pairing's invite state as the column prints it (a fragment: text and, once invited, a <time>). */
const stateOf = (p: OpenRoundPairing) => renderToStaticMarkup(<>{inviteState(p, (iso) => fmtTime(TZ, iso), msg, plural)}</>);

describe("the pairing's invite state and the players a press reaches", () => {
  const DEADLINE = new Date(Date.parse(OPENED) + DEADLINE_AFTER_MS).toISOString();

  it("the empty case first: a round with no pairing owes nobody an invite, and has no state to word", () => {
    expect(owedPlayers(ROUND({ pairings: [] }))).toBe(0);
    expect(owedPlayers(ROUND({ pairings: [P(1, { owedSeats: 0 })] })), "a pairing that owes nothing counts nothing").toBe(0);
  });

  it("paired, not opened: two players owed per board, and every pairing reads 'Not invited'", () => {
    const round = ROUND();
    expect(owedPlayers(round), "3 boards x 2 seats, counted from the fixtures above").toBe(6);
    let checked = 0;
    for (const p of round.pairings) {
      expect(stateOf(p), `board ${p.boardNo}`).toBe(esc(en["runsheet.round.notInvited"]!));
      checked += 1;
    }
    expect(checked, "anti-vacuity: pairings worded").toBe(3);
  });

  it("opened, everyone invited: nobody owed, and each pairing says WHEN it was invited", () => {
    const round = ROUND({ state: "open", openedAt: OPENED, deadlineAt: DEADLINE, press: "none", pairings: [P(1, { owedSeats: 0, invitedAt: OPENED }), P(2, { owedSeats: 0, invitedAt: OPENED })] });
    expect(owedPlayers(round)).toBe(0);
    for (const p of round.pairings) {
      const h = stateOf(p);
      expect(h, `board ${p.boardNo}: the invite word`).toContain(esc(en["runsheet.round.invited"]!));
      // React serialises the prop as `dateTime` (the browser's DOM lowercases it).
      expect(h, `board ${p.boardNo}: its <time>`).toContain(`dateTime="${OPENED}"`);
      expect(h).toContain(`>${fmtTime(TZ, OPENED)}<`);
      expect(h, "nobody still to invite").not.toContain(esc(en["runsheet.round.notInvited"]!));
    }
  });

  it("opened with someone still owed ('reinvite'): counts ONLY the uninvited, and states each pairing's own invite", () => {
    const round = ROUND({
      state: "open",
      openedAt: OPENED,
      deadlineAt: DEADLINE,
      press: "reinvite",
      pairings: [P(1, { owedSeats: 0, invitedAt: OPENED }), P(2, { owedSeats: 1, invitedAt: OPENED }), P(3)],
    });
    expect(owedPlayers(round), "board 1 owes none, board 2 one, board 3 two").toBe(3);
    expect(stateOf(round.pairings[0]!)).not.toContain(esc(en["runsheet.round.stillToInvite.one"]!.split("{count}")[1]!));
    expect(stateOf(round.pairings[1]!), "invited, one seat still owed").toContain(esc(pl("runsheet.round.stillToInvite", 1)));
    expect(stateOf(round.pairings[2]!), "never invited").toBe(esc(en["runsheet.round.notInvited"]!));
  });

  it("a board past inviting with no stamp (a game made another way) reads 'No invite needed', never 'Not invited'", () => {
    const h = stateOf(P(1, { owedSeats: 0, invitedAt: null }));
    expect(h).toBe(esc(en["runsheet.round.noInviteOwed"]!));
    expect(h).not.toContain(esc(en["runsheet.round.notInvited"]!));
  });
});

describe("OpenRoundConfirmBody — what will happen, stated before it happens", () => {
  const body = (round: OpenRoundView) => renderToStaticMarkup(<OpenRoundConfirmBody round={round} tz={TZ} />);

  it("a first open: HOW MANY players and TO WHOM, the window in the module's own minutes, the scheduled time as only what players saw", () => {
    const h = body(ROUND());
    expect(h).toContain(esc(pl("runsheet.round.confirmBody", 6)));
    let named = 0;
    for (const n of [1, 2, 3]) {
      expect(h).toContain(`White ${n}`);
      expect(h).toContain(`Black ${n}`);
      named += 1;
    }
    expect(named, "anti-vacuity: invitees named").toBe(3);
    expect(h).toContain(esc(t("runsheet.round.confirmWindow", { minutes: DEADLINE_AFTER_MS / 60_000 })));
    expect(h).toContain(esc(t("runsheet.round.confirmScheduled", { time: fmtTime(TZ, "2026-10-16T19:00:00.000Z") })));
    expect(h, "nobody invited before: no 'already invited' note").not.toContain('data-testid="open-round-already-note"');
  });

  it("a reinvite: counts and lists ONLY the uninvited (no double invite), says who was already invited, and keeps the round's own deadline", () => {
    const deadline = new Date(Date.parse(OPENED) + DEADLINE_AFTER_MS).toISOString();
    const h = body(
      ROUND({
        state: "open",
        openedAt: OPENED,
        deadlineAt: deadline,
        press: "reinvite",
        pairings: [P(1, { owedSeats: 0, invitedAt: OPENED }), P(2, { owedSeats: 1, invitedAt: OPENED }), P(3)],
      }),
    );
    expect(h).toContain(esc(pl("runsheet.round.confirmBodyReinvite", 3)));
    expect(h).not.toContain("White 1");
    expect(h).toContain("White 2");
    expect(h).toContain("White 3");
    // Board 1's two seats and board 2's one: three players already invited.
    expect(h).toMatch(new RegExp(`data-testid="open-round-already-note"[^>]*>${esc(pl("runsheet.round.reopenNotice", 3))}<`));
    expect(h).toContain(esc(t("runsheet.round.confirmWindowReinvite", { time: fmtTime(TZ, deadline) })));
    expect(h, "the window does not restart on a reinvite").not.toContain(esc(t("runsheet.round.confirmWindow", { minutes: DEADLINE_AFTER_MS / 60_000 })));
  });

  // Capacity test 12, the organiser's half (spec §3.2.1, §8.1): a round that staggers must not say "straight away".
  describe("a staggered round (capacity test 12)", () => {
    const BATCHES = [0, 1, 2].map((i) => ({
      fromBoard: 10 * i + 1,
      toBoard: 10 * i + 10,
      offsetMs: i * CHECKIN_BATCH_GAP_MS,
      opensAt: null,
      closesAt: null,
    }));
    /** Minutes from the Open press to the last batch, from the constants: two gaps. */
    const SPAN = (2 * CHECKIN_BATCH_GAP_MS) / 60_000;
    const STAGGERED = () => ROUND({ staggered: true, batches: BATCHES, staggerSpanMinutes: SPAN });
    const dicts: [Locale, Dict][] = [["en", messages as unknown as Dict], ["es", esUi], ["fr", frUi], ["nl", nlUi]];
    const at = (d: Dict, key: string) => (d as unknown as Record<string, string>)[key]!;
    const render = (round: OpenRoundView, locale: Locale, dict: Dict) =>
      renderToStaticMarkup(
        <DictProvider dict={dict} locale={locale}>
          <OpenRoundConfirmBody round={round} tz={TZ} />
        </DictProvider>,
      );

    it("states the stagger - the last group opens SPAN minutes after the press, each board has the window from ITS group - and never 'straight away', in all four locales", () => {
      let checked = 0;
      for (const [locale, dict] of dicts) {
        const h = render(STAGGERED(), locale, dict);
        const want = at(dict, "runsheet.round.confirmWindowStaggered").replace("{span}", String(SPAN)).replace("{minutes}", String(DEADLINE_AFTER_MS / 60_000));
        expect(h, `${locale}: the staggered sentence with the constants' own minutes`).toContain(esc(want));
        expect(h, `${locale}: never the unstaggered 'straight away' sentence`).not.toContain(esc(at(dict, "runsheet.round.confirmWindow").split("{minutes}")[0]!));
        expect(want, `${locale}: no unfilled placeholder`).not.toMatch(/\{[a-z]+\}/);
        checked += 1;
      }
      expect(checked, "locales checked").toBe(4);
      expect(SPAN, "premise: the span is not the window (the two numbers are told apart)").not.toBe(DEADLINE_AFTER_MS / 60_000);
    });

    it("the pair: a round of one batch (or off) keeps the unstaggered sentence, and a staggered flag with a single batch does too", () => {
      for (const round of [ROUND(), ROUND({ staggered: true, batches: [BATCHES[0]!], staggerSpanMinutes: 0 })]) {
        const h = render(round, "en", messages as unknown as Dict);
        expect(h).toContain(esc(t("runsheet.round.confirmWindow", { minutes: DEADLINE_AFTER_MS / 60_000 })));
        expect(h).not.toContain(esc(en["runsheet.round.confirmWindowStaggered"]!.split("{span}")[0]!));
      }
    });

    it("a reinvite press keeps ITS sentence (the earliest deadline), staggered or not", () => {
      const deadline = new Date(Date.parse(OPENED) + DEADLINE_AFTER_MS).toISOString();
      const h = render(
        ROUND({ ...STAGGERED(), state: "open", openedAt: OPENED, deadlineAt: deadline, press: "reinvite", pairings: [P(1, { owedSeats: 1, invitedAt: OPENED })] }),
        "en",
        messages as unknown as Dict,
      );
      expect(h).toContain(esc(t("runsheet.round.confirmWindowReinvite", { time: fmtTime(TZ, deadline) })));
      expect(h).not.toContain(esc(en["runsheet.round.confirmWindowStaggered"]!.split("{span}")[0]!));
    });
  });

  it("an untimed round states no scheduled time", () => {
    expect(body(ROUND({ scheduledAt: null }))).not.toContain(esc(en["runsheet.round.confirmScheduled"]!.split("(")[0]!));
  });

  // T16 fix round 1, R1: opening a round while an earlier one is still being played is allowed; the confirmation
  // names each earlier round's games still in play, one line per round, counted in the locale's plural.
  it("R1: names each earlier round's games still in play — and nothing when none is (the empty case first)", () => {
    expect(body(ROUND())).not.toContain('data-testid="open-round-earlier"');
    const h = body(ROUND({ earlierInPlay: [{ roundNo: 2, games: 1 }, { roundNo: 3, games: 4 }] }));
    const lines = [...h.matchAll(/data-earlier-round="(\d+)"[^>]*>([^<]*)</g)].map((m) => [Number(m[1]), m[2]]);
    expect(lines).toEqual([
      [2, esc(en["runsheet.round.confirmEarlierInPlay.one"]!.replace("{round}", "2").replace("{count}", "1"))],
      [3, esc(en["runsheet.round.confirmEarlierInPlay.other"]!.replace("{round}", "3").replace("{count}", "4"))],
    ]);
    expect(h, "a note, not a refusal: the press stays").toMatch(/data-testid="open-round-earlier"[^>]*role="note"|role="note"[^>]*data-testid="open-round-earlier"/);
  });
});

// ─── The check-in groups an opened, staggered round lists (final review I-1; spec §3.2.1, "What the organiser sees") ────────
// The view has computed `batches` since the capacity build and its test pins the numbers, but nothing drew them, so the desk read
// "open until 14:14" - the LAST group's deadline - while group 0's no-shows were already reaching the organiser. `timedBatches` is
// the one rule for whether groups are drawn and which; the Arbiter Panel's check-in hero draws what it returns (its own markup is
// round-column.test.tsx's). The tests call the exported rule directly, including its named refusals.
// Single-sport by construction: online play, and so the batches, exist only for `boardgame`.
describe("timedBatches - the check-in groups of an opened, staggered round (final review I-1)", () => {
  const S = CHECKIN_BATCH_SIZE;
  const OPENED_MS = Date.parse(OPENED);
  /** The view builder's input: batch i is boards i*S+1..(i+1)*S, opening i gaps after the press and closing a window later. */
  const batchesOf = (n: number): OpenRoundBatch[] =>
    Array.from({ length: n }, (_, i) => ({
      fromBoard: i * S + 1,
      toBoard: (i + 1) * S,
      offsetMs: i * CHECKIN_BATCH_GAP_MS,
      opensAt: new Date(OPENED_MS + i * CHECKIN_BATCH_GAP_MS).toISOString(),
      closesAt: new Date(OPENED_MS + i * CHECKIN_BATCH_GAP_MS + DEADLINE_AFTER_MS).toISOString(),
    }));
  const OPENED_ROUND = (batches: OpenRoundBatch[], o: Partial<OpenRoundView> = {}): OpenRoundView =>
    ROUND({
      state: "open",
      openedAt: OPENED,
      press: "none",
      staggered: batches.length > 1,
      batches,
      staggerSpanMinutes: Math.ceil(((batches.length - 1) * CHECKIN_BATCH_GAP_MS) / 60_000),
      deadlineAt: batches[batches.length - 1]!.closesAt,
      pairings: [P(1, { owedSeats: 0, invitedAt: OPENED })],
      ...o,
    });

  it.each([2, 3, 10])("%s groups: one entry per group, in batch order, each with ITS boards, its opening and its closing", (n) => {
    const batches = batchesOf(n);
    const drawn = timedBatches(OPENED_ROUND(batches));
    expect(drawn, "premise: a staggered, opened, fully timed round draws its groups").not.toBeNull();
    expect(drawn, "one per batch").toHaveLength(n);
    let checked = 0;
    drawn!.forEach((g, i) => {
      expect([g.fromBoard, g.toBoard, g.opensAt, g.closesAt], `group ${i}`).toEqual([batches[i]!.fromBoard, batches[i]!.toBoard, batches[i]!.opensAt, batches[i]!.closesAt]);
      checked += 1;
    });
    expect(checked, "anti-vacuity: groups checked").toBe(n);
    // The point of the finding: group 0 closes strictly BEFORE the last group, so one "open until" line could not have told them apart.
    expect(Date.parse(drawn![0]!.closesAt)).toBeLessThan(Date.parse(drawn![n - 1]!.closesAt));
  });

  it("the empty case and the pair: no groups (a round with no batches, one batch, a staggered flag over one batch, or two batches the flag does not stagger) draw nothing", () => {
    const one = batchesOf(1);
    const cases: [string, OpenRoundView][] = [
      ["no batches at all", OPENED_ROUND(one, { batches: [], staggered: false })],
      ["one batch, not staggered", OPENED_ROUND(one, { staggered: false })],
      ["one batch under a staggered flag", OPENED_ROUND(one, { staggered: true })],
      // The confirmation reads the same pair of facts (staggered AND more than one batch): a round it would call
      // unstaggered ("they can check in straight away") must not draw groups either.
      ["two batches under an unstaggered flag", OPENED_ROUND(batchesOf(2), { staggered: false })],
    ];
    let checked = 0;
    for (const [name, round] of cases) {
      expect(timedBatches(round), name).toBeNull();
      checked += 1;
    }
    expect(checked, "anti-vacuity").toBe(4);
    expect(timedBatches(OPENED_ROUND(batchesOf(2))), "the pair: two staggered batches DO draw").toHaveLength(2);
  });

  it("no times to draw: a round not yet opened, and one opened but reaching nobody ('reopen'), draw nothing", () => {
    const unopened = batchesOf(3).map((b) => ({ ...b, opensAt: null, closesAt: null }));
    const paired = ROUND({ staggered: true, batches: unopened, staggerSpanMinutes: 4 });
    const reopen = OPENED_ROUND(batchesOf(3), { press: "reopen" });
    for (const round of [paired, reopen]) expect(timedBatches(round), `${round.state}/${round.press}`).toBeNull();
  });

  // The named refusal of `timedBatches`: the producer never makes either state (one open row feeds every batch) but the type allows
  // both, and a row with a hole in it is worse than no list. Each case is one broken batch among otherwise complete ones.
  it("a batch with only one of its two times, or a round with only some groups timed, draws nothing", () => {
    const full = batchesOf(3);
    const cases: [string, OpenRoundBatch[]][] = [
      ["a group with a start and no close", full.map((b, i) => (i === 1 ? { ...b, closesAt: null } : b))],
      ["a group with a close and no start", full.map((b, i) => (i === 1 ? { ...b, opensAt: null } : b))],
      ["the LAST group untimed, the others timed", full.map((b, i) => (i === 2 ? { ...b, opensAt: null, closesAt: null } : b))],
      ["the FIRST group untimed, the others timed", full.map((b, i) => (i === 0 ? { ...b, opensAt: null, closesAt: null } : b))],
    ];
    let checked = 0;
    for (const [name, batches] of cases) {
      expect(batches.length, `${name}: premise - more than one group, so only the times can refuse it`).toBeGreaterThan(1);
      const round = OPENED_ROUND(batches, { deadlineAt: full[2]!.closesAt });
      expect(round.staggered && round.press !== "reopen", `${name}: premise - every other condition for drawing holds`).toBe(true);
      expect(timedBatches(round), name).toBeNull();
      checked += 1;
    }
    expect(checked, "anti-vacuity: cases checked").toBe(4);
    // The pair: the same round with every time present DOES draw, so the refusal above is the times and nothing else.
    expect(timedBatches(OPENED_ROUND(full))).toHaveLength(3);
  });

  it("a re-invite press on a staggered round still lists every group (the card shows the groups; the confirm names the earliest deadline)", () => {
    const round = OPENED_ROUND(batchesOf(3), { press: "reinvite", pairings: [P(1, { owedSeats: 1, invitedAt: OPENED })] });
    expect(timedBatches(round)).toHaveLength(3);
  });
});
