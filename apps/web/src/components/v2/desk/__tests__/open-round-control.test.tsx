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
import type { OpenRoundPairing, OpenRoundView } from "@/lib/open-round";
import { DEADLINE_AFTER_MS } from "@/server/external-play/window";
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
  scheduledAt: "2026-10-16T19:00:00.000Z",
  press: "open",
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

  it("an untimed round states no scheduled time", () => {
    expect(body(ROUND({ scheduledAt: null }))).not.toContain(esc(en["runsheet.round.confirmScheduled"]!.split("(")[0]!));
  });
});
