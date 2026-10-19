// T16 (D12, canvas OpenRoundPhone / OpenRoundConfirmPhone / OpenRoundDesktop)
// — the organiser's Open round control, as it renders each state the reader
// (listOpenRounds, driven against the database in open-round-view.test.ts)
// hands it, and the confirmation it shows BEFORE anything is sent: how many
// players, and which pairings. Copy is read from the dictionaries, never typed
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
import { OpenRoundConfirmBody, OpenRoundControl } from "../open-round-control";

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
  ...o,
});
const html = (round: OpenRoundView) => renderToStaticMarkup(<OpenRoundControl round={round} tz={TZ} />);
const pairingTestIds = (h: string) => [...h.matchAll(/data-testid="open-round-(pending|already)-([^"]+)"/g)].map((m) => `${m[1]}:${m[2]}`);

describe("OpenRoundControl — each state", () => {
  it("the empty case first: a round with no pairings offers nothing to open (the reader never sends one; the guard is here anyway)", () => {
    const h = html(ROUND({ pairings: [] }));
    expect(h).toContain(esc(en["externalPlay.openRound.noFixtures"]!));
    expect(h).not.toContain('data-testid="open-round-cta"');
    expect(h).not.toContain("data-uninvited-count");
  });

  it("paired, not opened: says so, counts the boards and players, offers Open round, every pairing 'Not invited' by colour", () => {
    const h = html(ROUND());
    expect(h).toContain('data-testid="open-round"');
    expect(h).toContain('data-state="paired"');
    expect(h).toContain('data-uninvited-count="6"');
    expect(h).toContain(esc(t("runsheet.round.heading", { round: 4 })));
    expect(h).toContain(esc(en["runsheet.round.paired"]!));
    expect(h).toContain(esc(pl("runsheet.round.pairedLede", 3, { players: 6 })));
    expect(h, "the OTHER state's words").not.toContain(esc(en["externalPlay.openRound.alreadyOpen"]!));
    expect(h).toMatch(new RegExp(`data-testid="open-round-cta"[^>]*>${esc(en["runsheet.round.openCta"]!)}<`));
    // React serialises the prop as `dateTime` (the browser's DOM lowercases it).
    expect(h).toContain('dateTime="2026-10-16T19:00:00.000Z"');
    expect(pairingTestIds(h)).toEqual(["pending:f1", "pending:f2", "pending:f3"]);
    let named = 0;
    for (const n of [1, 2, 3]) {
      // White first: the names are the board's colours, not home/away.
      expect(h.indexOf(`White ${n}`), `board ${n}`).toBeLessThan(h.indexOf(`Black ${n}`));
      expect(h).toContain(esc(t("arbiter.boardNo", { n })));
      named += 1;
    }
    expect(named, "anti-vacuity: pairings named").toBe(3);
    expect(h.split(esc(en["runsheet.round.notInvited"]!)).length - 1, "one 'Not invited' per pairing").toBe(3);
  });

  it("opened, everyone invited: 'already open' and no Open press; each pairing's invite time; a resend only where the reader allows one", () => {
    const h = html(
      ROUND({
        state: "open",
        openedAt: OPENED,
        deadlineAt: new Date(Date.parse(OPENED) + DEADLINE_AFTER_MS).toISOString(),
        press: "none",
        pairings: [P(1, { owedSeats: 0, invitedAt: OPENED, canResend: true }), P(2, { owedSeats: 0, invitedAt: OPENED })],
      }),
    );
    expect(h).toContain('data-state="open"');
    expect(h).toContain('data-uninvited-count="0"');
    expect(h).toContain(esc(en["externalPlay.openRound.alreadyOpen"]!));
    expect(h).toContain(esc(t("runsheet.round.openUntil", { time: fmtTime(TZ, Date.parse(OPENED) + DEADLINE_AFTER_MS) })));
    expect(h).not.toContain('data-testid="open-round-cta"');
    expect(pairingTestIds(h)).toEqual(["already:f1", "already:f2"]);
    expect(h.split(`dateTime="${OPENED}"`).length - 1, "each pairing's <time>").toBe(2);
    expect(h).toContain(`>${fmtTime(TZ, OPENED)}<`);
    expect(h).toContain('data-testid="open-round-resend-f1"');
    expect(h, "f2: the reader allows no resend").not.toContain('data-testid="open-round-resend-f2"');
    expect(h).not.toContain(esc(en["runsheet.round.notInvited"]!));
  });

  it("opened with someone still owed ('reinvite'): counts ONLY the uninvited, offers 'Invite N players', states each pairing's own invite", () => {
    const h = html(
      ROUND({
        state: "open",
        openedAt: OPENED,
        deadlineAt: new Date(Date.parse(OPENED) + DEADLINE_AFTER_MS).toISOString(),
        press: "reinvite",
        pairings: [P(1, { owedSeats: 0, invitedAt: OPENED }), P(2, { owedSeats: 1, invitedAt: OPENED }), P(3)],
      }),
    );
    expect(h).toContain('data-uninvited-count="3"');
    expect(h).toContain(esc(pl("runsheet.round.owed", 3)));
    expect(h).toMatch(new RegExp(`data-testid="open-round-cta"[^>]*>${esc(pl("runsheet.round.inviteCta", 3))}<`));
    expect(pairingTestIds(h)).toEqual(["already:f1", "pending:f2", "pending:f3"]);
    expect(h).toContain(esc(pl("runsheet.round.stillToInvite", 1)));
    expect(h.split(esc(en["runsheet.round.notInvited"]!)).length - 1, "only the board nobody on was invited").toBe(1);
  });

  it("a board past inviting with no stamp (a game made another way) reads 'No invite needed', never 'Not invited'", () => {
    const h = html(ROUND({ state: "open", openedAt: OPENED, press: "none", pairings: [P(1, { owedSeats: 0, invitedAt: null })] }));
    expect(h).toContain(esc(en["runsheet.round.noInviteOwed"]!));
    expect(h).not.toContain(esc(en["runsheet.round.notInvited"]!));
  });

  it("'reopen': opened but nobody reached — says so, and the press is Open round again", () => {
    const h = html(ROUND({ state: "open", openedAt: OPENED, press: "reopen" }));
    expect(h).toContain(esc(en["runsheet.round.reopenState"]!));
    expect(h).toMatch(new RegExp(`data-testid="open-round-cta"[^>]*>${esc(en["runsheet.round.openCta"]!)}<`));
  });

  it.each([["es", esUi], ["fr", frUi], ["nl", nlUi]] as [Locale, Dict][])("%s: real translations, not the English copied", (locale, dict) => {
    const h = renderToStaticMarkup(
      <DictProvider dict={dict} locale={locale}>
        <OpenRoundControl round={ROUND()} tz={TZ} />
      </DictProvider>,
    );
    const d = dict as unknown as Record<string, string>;
    expect(d["runsheet.round.paired"]).not.toBe(en["runsheet.round.paired"]);
    expect(h).toContain(esc(d["runsheet.round.paired"]!));
    expect(h).toContain(esc(d["runsheet.round.openCta"]!));
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
// The view has computed `batches` since the capacity build and its test pins the numbers, but nothing drew them, so the
// desk read "open until 14:14" - the LAST group's deadline - while group 0's no-shows were already reaching the organiser.
// Single-sport by construction: online play, and so the batches, exist only for `boardgame`.
describe("OpenRoundControl - the check-in groups of an opened, staggered round (final review I-1)", () => {
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
  const dicts: [Locale, Dict][] = [["en", messages as unknown as Dict], ["es", esUi], ["fr", frUi], ["nl", nlUi]];
  const at = (d: Dict, key: string) => (d as unknown as Record<string, string>)[key]!;
  const fill = (s: string, vars: Record<string, string | number>) =>
    Object.entries(vars).reduce((acc, [k, v]) => acc.replaceAll(`{${k}}`, String(v)), s);
  const render = (round: OpenRoundView, locale: Locale, dict: Dict) =>
    renderToStaticMarkup(
      <DictProvider dict={dict} locale={locale}>
        <OpenRoundControl round={round} tz={TZ} />
      </DictProvider>,
    );
  /** The rows as drawn: index, the three fields' text, and the ISO instants the row carries. */
  const rowsOf = (h: string) =>
    [...h.matchAll(/<li([^>]*data-testid="open-round-batch-(\d+)"[^>]*)>(.*?)<\/li>/gs)].map((m) => {
      const attr = (name: string) => new RegExp(`${name}="([^"]*)"`).exec(m[1]!)?.[1];
      const field = (name: string) => new RegExp(`data-field="${name}"[^>]*>([^<]*)<`).exec(m[3]!)?.[1];
      return {
        i: Number(m[2]),
        opensAt: attr("data-opens-at"),
        closesAt: attr("data-closes-at"),
        boards: field("boards"),
        opens: field("opens"),
        closes: field("closes"),
      };
    });
  /** What a row must read for batch `b` in a dictionary: from the input and the dictionary, never from the component. */
  const expected = (b: OpenRoundBatch, d: Dict) => ({
    boards: esc(
      b.fromBoard === b.toBoard
        ? fill(at(d, "arbiter.boardNo"), { n: b.fromBoard })
        : fill(at(d, "runsheet.round.batchBoards"), { from: b.fromBoard, to: b.toBoard }),
    ),
    opens: esc(fill(at(d, "runsheet.round.batchOpens"), { time: fmtTime(TZ, b.opensAt!) })),
    closes: esc(fill(at(d, "runsheet.round.batchCloses"), { time: fmtTime(TZ, b.closesAt!) })),
  });

  it.each([2, 3, 10])("%s groups: one row per group, each with ITS boards, its opening and its closing, in all four locales", (n) => {
    const batches = batchesOf(n);
    let checked = 0;
    for (const [locale, dict] of dicts) {
      const rows = rowsOf(render(OPENED_ROUND(batches), locale, dict));
      expect(rows, `${locale}: one row per batch`).toHaveLength(n);
      rows.forEach((row, i) => {
        const want = expected(batches[i]!, dict);
        expect(row.i, `${locale}: rows in batch order`).toBe(i);
        expect([row.boards, row.opens, row.closes], `${locale}: row ${i}`).toEqual([want.boards, want.opens, want.closes]);
        expect([row.opensAt, row.closesAt], `${locale}: row ${i} instants`).toEqual([batches[i]!.opensAt, batches[i]!.closesAt]);
        expect(`${row.boards}${row.opens}${row.closes}`, `${locale}: row ${i} has no unfilled placeholder`).not.toMatch(/\{[a-z]+\}/);
        checked += 1;
      });
    }
    expect(checked, "anti-vacuity: rows checked").toBe(4 * n);
  });

  it("a group of one board reads 'Board n', not 'Boards n-n'", () => {
    const batches = [...batchesOf(2), { ...batchesOf(3)[2]!, fromBoard: 2 * S + 1, toBoard: 2 * S + 1 }];
    const rows = rowsOf(render(OPENED_ROUND(batches), "en", messages as unknown as Dict));
    expect(rows).toHaveLength(3);
    expect(rows[2]!.boards).toBe(esc(t("arbiter.boardNo", { n: 2 * S + 1 })));
    expect(rows[0]!.boards).toBe(esc(t("runsheet.round.batchBoards", { from: 1, to: S })));
  });

  it("the earlier group's deadline is on the card: no single 'open until' that names only the LAST group's close", () => {
    const batches = batchesOf(3);
    const h = renderToStaticMarkup(<OpenRoundControl round={OPENED_ROUND(batches)} tz={TZ} />);
    const openUntil = esc(en["runsheet.round.openUntil"]!.split("{time}")[0]!);
    expect(h, "the single line that read the last group's deadline as the round's").not.toContain(openUntil);
    const rows = rowsOf(h);
    expect(rows.length, "premise: more than one group").toBeGreaterThan(1);
    // Premise: the first group closes strictly before the last, so a single line could not have told them apart.
    expect(Date.parse(rows[0]!.closesAt!)).toBeLessThan(Date.parse(rows[rows.length - 1]!.closesAt!));
    expect(h).toContain(esc(fmtTime(TZ, batches[0]!.closesAt!)));
    expect(h).toContain(esc(en["runsheet.round.batchesLede"]!));
  });

  it("the empty case and the pair: no groups (a round with no batches, one batch, a staggered flag over one batch, or two batches the flag does not stagger) draw no list and keep the 'open until' line", () => {
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
      const h = renderToStaticMarkup(<OpenRoundControl round={round} tz={TZ} />);
      expect(rowsOf(h), name).toEqual([]);
      expect(h, name).not.toContain('data-testid="open-round-batches"');
      expect(h, `${name}: the one deadline is the truth`).toContain(esc(t("runsheet.round.openUntil", { time: fmtTime(TZ, round.deadlineAt!) })));
      checked += 1;
    }
    expect(checked, "anti-vacuity").toBe(4);
  });

  it("no times to draw, no rows: a round not yet opened, and one opened but reaching nobody ('reopen'), list nothing", () => {
    const unopened = batchesOf(3).map((b) => ({ ...b, opensAt: null, closesAt: null }));
    const paired = ROUND({ staggered: true, batches: unopened, staggerSpanMinutes: 4 });
    const reopen = OPENED_ROUND(batchesOf(3), { press: "reopen" });
    for (const round of [paired, reopen]) {
      const h = renderToStaticMarkup(<OpenRoundControl round={round} tz={TZ} />);
      expect(rowsOf(h), `${round.state}/${round.press}`).toEqual([]);
      expect(h).not.toContain('data-testid="open-round-batches"');
    }
  });

  it("a re-invite press on a staggered round still lists every group (the card shows the groups; the confirm names the earliest deadline)", () => {
    const batches = batchesOf(3);
    const round = OPENED_ROUND(batches, { press: "reinvite", pairings: [P(1, { owedSeats: 1, invitedAt: OPENED })] });
    expect(rowsOf(renderToStaticMarkup(<OpenRoundControl round={round} tz={TZ} />))).toHaveLength(3);
  });
});
