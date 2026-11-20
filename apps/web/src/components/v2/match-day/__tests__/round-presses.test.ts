// Match Day online, Task 7 - the round panel's board "+5 min" and "Pair next round" presses, and the billing freeze's word for each of the
// three START writes the panel sends (open, resend, +5). Pure: the reducers and runners run with a fake `post`, no DOM.
//
// Where an expected value comes from: the routes are the server's own (`extend-checkin`, the stage's `generate`: the same path the stage
// rail presses); the freeze's sentence is the dictionary's entry for its key, in all four locales, and the generic failure's is the
// OTHER entry (so a mapper that falls through to "failed" is told apart from one that says the freeze); the freeze is 402
// `PAYMENT_REQUIRED` (lib/client-v1.ts). Anti-vacuity: every sweep counts what it checked.
import { describe, expect, it } from "vitest";
import en from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import nl from "@/dictionaries/nl/ui.json";
import { ApiV1Error } from "@/lib/client-v1";
import type { Dict } from "@/lib/i18n-constants";
import { t, plural } from "@/lib/i18n-runtime";
import type { OpenRoundView } from "@/lib/open-round";
import { emptyExtendTally } from "@/lib/checkin-extend";
import { extendFailureText } from "../../checkin-extend-ui";
import { openNoticeText, resendNoticeText } from "../../desk/open-round-control";
import {
  boardExtendRunner,
  boardExtendUi,
  initialBoardExtend,
  initialPairNext,
  pairNextPath,
  pairNextRunner,
  pairNextUi,
  type BoardExtendAction,
  type PairNextAction,
} from "../round-presses";

const LOCALES = { en, es, fr, nl } as const;
const FROZEN_KEY = "runsheet.round.err.frozen";

const view: OpenRoundView = {
  stageId: "s1",
  stageName: "Swiss",
  roundNo: 2,
  state: "paired",
  openedAt: null,
  deadlineAt: null,
  windowMinutes: 10,
  staggered: false,
  batches: [],
  staggerSpanMinutes: 0,
  scheduledAt: null,
  press: "open",
  pairings: [],
  extendableBoards: 0,
  extendWindows: [],
  extendRefusals: emptyExtendTally(),
  earlierInPlay: [],
};

describe("the billing freeze (402 PAYMENT_REQUIRED) on a START write: its own sentence in every locale, never the generic failure", () => {
  it("the open's, the resend's and the +5's answers say the freeze and not 'failed', in en, es, fr and nl", () => {
    let checked = 0;
    for (const [locale, dict] of Object.entries(LOCALES)) {
      const d = dict as unknown as Dict;
      const msg = (key: string, vars?: Record<string, string | number>) => t(d, key as never, vars);
      const pl = (key: string, n: number, vars?: Record<string, string | number>) => plural(d, key, n, locale as never, vars);
      const frozen = dict[FROZEN_KEY as keyof typeof dict] as string;
      const generic = {
        open: dict["runsheet.round.err.failed" as keyof typeof dict] as string,
        resend: dict["runsheet.round.resendFailed" as keyof typeof dict] as string,
        extend: dict["externalPlay.checkinExtend.refused.failed" as keyof typeof dict] as string,
      };
      expect(frozen.length, `${locale}: the freeze sentence exists`).toBeGreaterThan(0);
      expect(openNoticeText({ kind: "failed", code: "PAYMENT_REQUIRED" }, view, msg as never, pl as never), `${locale}: open`).toEqual([frozen]);
      expect(resendNoticeText({ kind: "failed", code: "PAYMENT_REQUIRED" }, msg as never, pl as never), `${locale}: resend`).toBe(frozen);
      expect(extendFailureText("PAYMENT_REQUIRED", { t: msg as never, plural: pl as never, hm: () => null }), `${locale}: extend`).toBe(frozen);
      // the generic words are different sentences, so the equality above cannot hold for a mapper that fell through to them
      for (const g of Object.values(generic)) expect(g, `${locale}: the generic sentence is not the freeze's`).not.toBe(frozen);
      // and a code that is not the freeze still reads as before
      expect(openNoticeText({ kind: "failed", code: "SOMETHING_ELSE" }, view, msg as never, pl as never), `${locale}: other open`).toEqual([generic.open]);
      expect(resendNoticeText({ kind: "failed", code: "SOMETHING_ELSE" }, msg as never, pl as never), `${locale}: other resend`).toBe(generic.resend);
      expect(extendFailureText("SOMETHING_ELSE", { t: msg as never, plural: pl as never, hm: () => null }), `${locale}: other extend`).toBe(generic.extend);
      checked += 6;
    }
    expect(checked, "anti-vacuity: 4 locales x 6 answers").toBe(24);
  });
});

describe("boardExtendUi - one request at a time, an answer lands only on the request in flight", () => {
  const done = (fixtureId: string, boardNo: number): BoardExtendAction => ({
    type: "done",
    fixtureId,
    boardNo,
    outcome: { ok: true, result: { fixtureId, addedMinutes: 5, deadlineAt: "2026-11-20T18:10:00.000Z", extensionsLeft: 2 } as never },
  });

  it("EMPTY CASE FIRST: nothing in flight, no answer", () => {
    expect(initialBoardExtend()).toEqual({ busy: null, notice: null });
  });

  it("a second press while one is out changes nothing; an answer for another board is dropped; the right one lands with its board", () => {
    let s = boardExtendUi(initialBoardExtend(), { type: "extend", fixtureId: "a" });
    expect(s.busy).toBe("a");
    expect(boardExtendUi(s, { type: "extend", fixtureId: "b" }), "R1: one request at a time").toBe(s);
    expect(boardExtendUi(s, done("b", 2)), "R3: not the request in flight").toBe(s);
    s = boardExtendUi(s, done("a", 1));
    expect(s.busy).toBeNull();
    expect(s.notice).toMatchObject({ fixtureId: "a", boardNo: 1, kind: "answered" });
    expect(boardExtendUi(s, done("a", 1)), "an answer with nothing in flight is dropped").toBe(s);
  });

  it("the SEQUENCE: a new press clears the last answer; clear drops it; a failure keeps its code", () => {
    let s = boardExtendUi(boardExtendUi(initialBoardExtend(), { type: "extend", fixtureId: "a" }), done("a", 1));
    expect(s.notice).not.toBeNull();
    s = boardExtendUi(s, { type: "extend", fixtureId: "b" });
    expect(s.notice, "the old answer is gone while the new request is out").toBeNull();
    s = boardExtendUi(s, { type: "done", fixtureId: "b", boardNo: 2, outcome: { ok: false, code: "PAYMENT_REQUIRED" } });
    expect(s.notice).toMatchObject({ fixtureId: "b", kind: "failed", code: "PAYMENT_REQUIRED" });
    expect(boardExtendUi(s, { type: "clear" }).notice).toBeNull();
    const idle = initialBoardExtend();
    expect(boardExtendUi(idle, { type: "clear" }), "clearing nothing changes nothing").toBe(idle);
  });
});

describe("boardExtendRunner - the board's own extend route, one request at a time", () => {
  it("posts extend-checkin for the board, then refreshes; a double tap is one request", async () => {
    const posts: string[] = [];
    const actions: BoardExtendAction[] = [];
    let refreshed = 0;
    let release: (v: unknown) => void = () => {};
    const gate = new Promise((r) => (release = r));
    const runner = boardExtendRunner({
      dispatch: (a) => actions.push(a),
      post: (path) => {
        posts.push(path);
        return gate;
      },
      refresh: () => (refreshed += 1),
    });
    const first = runner.extend("fx-1", 4);
    const second = await runner.extend("fx-1", 4);
    expect(second, "the second tap is refused before the network").toBe(false);
    release({ fixtureId: "fx-1", addedMinutes: 5, deadlineAt: "2026-11-20T18:10:00.000Z", extensionsLeft: 2 });
    expect(await first).toBe(true);
    expect(posts).toEqual(["/api/v1/fixtures/fx-1/external-play/extend-checkin"]);
    expect(refreshed, "refreshed after the answer").toBe(1);
    expect(actions.map((a) => a.type)).toEqual(["extend", "done"]);
  });

  it("a refusal keeps the door's code and does not refresh; the runner is free again afterwards", async () => {
    const actions: BoardExtendAction[] = [];
    let refreshed = 0;
    let n = 0;
    const runner = boardExtendRunner({
      dispatch: (a) => actions.push(a),
      post: () => (n++ === 0 ? Promise.reject(new ApiV1Error("frozen", 402, "PAYMENT_REQUIRED", { feature_key: "competitions.max_active" })) : Promise.resolve({})),
      refresh: () => (refreshed += 1),
    });
    await runner.extend("fx-1", 4);
    expect(actions[1]).toMatchObject({ type: "done", outcome: { ok: false, code: "PAYMENT_REQUIRED" } });
    expect(refreshed).toBe(0);
    expect(await runner.extend("fx-1", 4), "free again").toBe(true);
  });
});

describe("pairNextRunner - MD-R15: the stage rail's own generate route, with its refusals kept", () => {
  it("the path is the stage's generate route (the one the rail's Pair next presses)", () => {
    expect(pairNextPath("st-9")).toBe("/api/v1/stages/st-9/generate");
  });

  it("posts {} to it, names the round the answer says it paired (else the one asked for), then refreshes; a second tap is one request", async () => {
    const posts: { path: string; body: unknown }[] = [];
    const actions: PairNextAction[] = [];
    let refreshed = 0;
    let release: (v: unknown) => void = () => {};
    const gate = new Promise((r) => (release = r));
    const runner = pairNextRunner({
      dispatch: (a) => actions.push(a),
      post: (path, body) => {
        posts.push({ path, body });
        return gate;
      },
      refresh: () => (refreshed += 1),
    });
    const first = runner.pair("st-9", 3);
    expect(await runner.pair("st-9", 3), "a double tap").toBe(false);
    release({ created: 4, existing: 0, swiss_paired_round: 3, swiss_next_round: "unpairable" });
    await first;
    expect(posts).toEqual([{ path: "/api/v1/stages/st-9/generate", body: {} }]);
    expect(refreshed).toBe(1);
    const last = actions[actions.length - 1]!;
    expect(last).toMatchObject({ type: "done", outcome: { ok: true, round: 3, caution: { verdict: "unpairable", round: 3 } } });
  });

  it("an answer that names no round says the round that was asked for, and no caution", async () => {
    const actions: PairNextAction[] = [];
    const runner = pairNextRunner({ dispatch: (a) => actions.push(a), post: () => Promise.resolve({ created: 2, existing: 0 }), refresh: () => {} });
    await runner.pair("st-9", 5);
    expect(actions[actions.length - 1]).toMatchObject({ outcome: { ok: true, round: 5, caution: null } });
  });

  it("a refusal keeps its code and its details, does not refresh, and an unreadable failure is UNKNOWN", async () => {
    const actions: PairNextAction[] = [];
    let refreshed = 0;
    const errs = [new ApiV1Error("no", 409, "SWISS_NO_ROUND_LEFT", { canAddRound: true }), new ApiV1Error("frozen", 402, "PAYMENT_REQUIRED", { feature_key: "competitions.max_active" }), new Error("network")];
    let i = 0;
    const runner = pairNextRunner({ dispatch: (a) => actions.push(a), post: () => Promise.reject(errs[i++]), refresh: () => (refreshed += 1) });
    for (let k = 0; k < errs.length; k += 1) await runner.pair("st-9", 2);
    const outcomes = actions.filter((a): a is Extract<PairNextAction, { type: "done" }> => a.type === "done").map((a) => a.outcome);
    expect(outcomes).toEqual([
      { ok: false, code: "SWISS_NO_ROUND_LEFT", extra: { canAddRound: true } },
      { ok: false, code: "PAYMENT_REQUIRED", extra: { feature_key: "competitions.max_active" } },
      { ok: false, code: "UNKNOWN", extra: {} },
    ]);
    expect(refreshed).toBe(0);
  });
});

describe("pairNextUi - one request at a time; the answer stays on screen after the press itself has gone", () => {
  it("EMPTY CASE FIRST: idle, no answer; an answer with nothing in flight is dropped", () => {
    const idle = initialPairNext();
    expect(idle).toEqual({ busy: false, notice: null });
    expect(pairNextUi(idle, { type: "done", outcome: { ok: true, round: 2, caution: null } })).toBe(idle);
  });

  it("pair -> busy; a second pair is refused; done lands the notice and frees it", () => {
    const s1 = pairNextUi(initialPairNext(), { type: "pair" });
    expect(s1.busy).toBe(true);
    expect(pairNextUi(s1, { type: "pair" })).toBe(s1);
    const s2 = pairNextUi(s1, { type: "done", outcome: { ok: true, round: 2, caution: null } });
    expect(s2).toEqual({ busy: false, notice: { kind: "paired", round: 2, caution: null } });
    expect(pairNextUi(s2, { type: "pair" }).notice, "a new press clears the old answer").toBeNull();
  });
});
