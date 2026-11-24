// Task 35 Part B (owner 2026-11-24: "when phone is pair then can we close the QR automatically and also in match day court
// scanning"). The court's QR sheet (court-stream-sheet.tsx, a modal the focus owns) closes by itself, ONCE, when the court's phone
// pairs while it is open: the desk's read goes from no phone to a phone, or to another link's phone. A re-poll of the same phone
// closes nothing, so the organiser can open it again; re-opened, it still only READS the QR (GET), never makes a code.
//
// The rule is the Phone tab's (`closeCodeOnPair`, lib/stream-pair.ts). What the court's read can tell is `courtPairSeen`'s:
// the desk names no pairing, so a phone is paired exactly when its status is not the server's no-pairing answer, and the link is
// the identity. Expected values come from the server's own declarations (the schema's enum, `courtPhoneStatus` with no pairing),
// never from courtPairSeen. While the sheet waits for a phone the focus asks the page for the day (`onRead`, a plain read: never
// `onChanged`, which also clears the court's refusal notice) every COURT_SHEET_PAIR_POLL_MS — the band's quiet cadence is 90 s,
// and the sheet would stand open that long after the phone had the code. Nothing polls otherwise.
//
// One sport, on purpose: the court stream reads no sport. Driven through `renderIsland` (node, no DOM): the focus's own state, the
// poll through fake timers, and the sheet's own reads with the v1 transport doubled.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderIsland, propsOf } from "@/components/__tests__/_hook-harness";
import en from "@/dictionaries/en/ui.json";
import publicEn from "@/dictionaries/en/public.json";
import type { Dict } from "@/lib/i18n-constants";
import type { MatchDayCourt, MatchDayCourtStream } from "@/lib/match-day/types";
import { COURT_SHEET_PAIR_POLL_MS, courtPairSeen } from "@/lib/match-day/court-stream";
import { closeCodeOnPair, STREAM_POLL_MS, type PairSeen } from "@/lib/stream-pair";
import { QUIET_POLL_MS } from "@/components/v2/desk/band-poll";
import { MatchDayCourtStream as CourtStreamSchema } from "@/server/api-v1/schemas/fixtures";
import { courtPhoneStatus } from "@/server/relay/domain/court-stream";
import { CourtFocus, type MatchDayCtx } from "../court-focus";
import { CourtStreamBand, CourtStreamSheet, LinkCourtAction } from "../court-stream-sheet";

const apiV1 = vi.fn<(url: string, options?: { method?: string; json?: unknown; signal?: AbortSignal }) => Promise<unknown>>(async () => []);
vi.mock("@/lib/client-v1", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/client-v1")>()),
  apiV1: (url: string, options?: { method?: string; json?: unknown; signal?: AbortSignal }) => apiV1(url, options),
}));

const ctx: MatchDayCtx = {
  competitionId: "comp-1",
  orgSlug: "acme",
  compSlug: "summer",
  locale: "en",
  tz: "Europe/London",
  dict: en as Dict,
  scoreDict: publicEn as Dict,
  viewerPlan: "pro",
  readOnly: false,
  frozen: false,
  orgId: "org-1",
};

/** The server's own word for a court with no pairing (`courtPhoneStatus`, the desk read's derivation). */
const NO_PAIRING = courtPhoneStatus({ pairing: null, openState: null }, new Date("2026-10-31T12:00:00.000Z"));
/** Every status a linked court's phone can read, from the read's own schema. */
const STATUSES = CourtStreamSchema.shape.phone.options;
const PAIRED_STATUSES = STATUSES.filter((s) => s !== NO_PAIRING);

const link = (o: Partial<MatchDayCourtStream> = {}): MatchDayCourtStream => ({
  link_id: "link-1",
  target_label: "Riverside CC on YouTube",
  expires_at: "2026-11-01T00:00:00.000Z",
  phone: NO_PAIRING,
  refusal: null,
  tail_ends_at: null,
  ...o,
});

const court = (stream_link: MatchDayCourtStream | null, o: Partial<MatchDayCourt> = {}): MatchDayCourt => ({
  court_id: "c-2",
  court_name: "Court 2",
  venue_id: "venue-1",
  venue_name: "Main Hall",
  sport_noun: "court",
  state: "free",
  current: null,
  in_use_by: null,
  free_since: null,
  queue: [],
  closure: null,
  stream_link,
  ...o,
});

type FocusProps = Parameters<typeof CourtFocus>[0];
const props = (c: MatchDayCourt, onRead: () => void = () => {}, over: Partial<FocusProps> = {}): FocusProps => ({
  ctx,
  court: c,
  backLabel: "All courts",
  onBack: () => {},
  onChanged: () => {},
  onRead,
  onRefused: () => {},
  refreshKey: "k",
  divisions: null,
  ...over,
});

const of = (tree: ReactElement[], type: unknown) => tree.find((el) => el.type === type);
const sheetIn = (island: { tree: () => ReactElement[] }) => of(island.tree(), CourtStreamSheet);
const showQr = (island: { tree: () => ReactElement[] }) => (propsOf(of(island.tree(), CourtStreamBand)!).onShowQr as () => void)();
const openToLink = (island: { tree: () => ReactElement[] }) => (propsOf(of(island.tree(), LinkCourtAction)!).onOpen as () => void)();

describe("courtPairSeen — the desk's read of a court's phone, as the close-on-pair rule reads it", () => {
  it("swept over the schema's statuses: the server's no-pairing answer → nothing paired; every other → paired, named by its link; no link → nothing", () => {
    expect(STATUSES, "PREMISE: the no-pairing answer is one of the read's statuses").toContain(NO_PAIRING);
    expect(PAIRED_STATUSES.length, "PREMISE: there are paired statuses to sweep").toBeGreaterThan(0);
    let checked = 0;
    for (const phone of STATUSES) {
      expect(courtPairSeen(link({ phone })), phone).toEqual(phone === NO_PAIRING ? null : { id: "link-1" });
      checked++;
    }
    expect(checked).toBe(STATUSES.length);
    expect(courtPairSeen(null), "a court with no link").toBeNull();
  });

  it("the rule over the court's reads: empty, the same phone re-polled (its status moving), a new pairing, another link's phone, a re-pair after Stop streaming", () => {
    const closesAt = (start: PairSeen, reads: (MatchDayCourtStream | null)[]): number[] => {
      const at: number[] = [];
      let prev = start;
      reads.map(courtPairSeen).forEach((next, i) => {
        if (closeCodeOnPair(prev, next)) at.push(i);
        prev = next;
      });
      return at;
    };
    const A = (phone: MatchDayCourtStream["phone"]) => link({ link_id: "link-a", phone });
    const B = (phone: MatchDayCourtStream["phone"]) => link({ link_id: "link-b", phone });
    expect(closesAt(null, [null, null]), "empty: no link, read after read").toEqual([]);
    expect(closesAt(null, [A(NO_PAIRING), A(NO_PAIRING)]), "linked, no phone yet").toEqual([]);
    let checked = 0;
    for (const s of PAIRED_STATUSES) {
      expect(closesAt(courtPairSeen(A(NO_PAIRING)), [A(s)]), `no phone → ${s}: a phone paired`).toEqual([0]);
      // The same phone, its status moving through every paired status and back: one pairing, nothing closes.
      expect(closesAt(courtPairSeen(A(s)), [...PAIRED_STATUSES.map(A), A(s)]), `${s} re-polled`).toEqual([]);
      checked++;
    }
    expect(checked).toBe(PAIRED_STATUSES.length);
    const paired = PAIRED_STATUSES[0]!;
    expect(closesAt(courtPairSeen(A(paired)), [B(paired)]), "another link's phone").toEqual([0]);
    // Stop streaming (the link withdrawn), linked again, re-polled, then the phone pairs on the new link: once.
    expect(closesAt(courtPairSeen(A(paired)), [null, B(NO_PAIRING), B(NO_PAIRING), B(paired), B(paired)])).toEqual([3]);
  });
});

describe("CourtFocus — the court's QR sheet closes once the court's phone pairs (Task 35 Part B)", () => {
  beforeEach(() => {
    apiV1.mockReset().mockImplementation(async () => []);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("opened on the court's QR: the phone pairing closes it; re-polled it stays shut; re-opened on that phone it stays open while the phone's status moves", async () => {
    const island = renderIsland(CourtFocus, props(court(link())));
    expect(sheetIn(island), "PREMISE: nothing open yet").toBeUndefined();
    showQr(island);
    expect(propsOf(sheetIn(island)!).linkId, "opened on the court's link").toBe("link-1");
    island.rerender(props(court(link())));
    expect(sheetIn(island), "the same read again (no phone): still open").toBeDefined();
    const [first, ...rest] = PAIRED_STATUSES;
    island.rerender(props(court(link({ phone: first }))));
    expect(sheetIn(island), `the phone paired (${first}): closed by itself`).toBeUndefined();
    island.rerender(props(court(link({ phone: first }))));
    expect(sheetIn(island), "re-polled: it stays shut — nothing reopens it").toBeUndefined();
    showQr(island);
    expect(sheetIn(island), "Show court QR still opens it").toBeDefined();
    let checked = 0;
    for (const s of [...rest, first!]) {
      island.rerender(props(court(link({ phone: s }))));
      expect(sheetIn(island), `the same phone, now ${s}: still open`).toBeDefined();
      checked++;
    }
    expect(checked).toBe(PAIRED_STATUSES.length);
  });

  it("re-opened after the close, the sheet READS the court's QR (one GET of the list) and never POSTs a link", async () => {
    const island = renderIsland(CourtFocus, props(court(link())));
    showQr(island);
    island.rerender(props(court(link({ phone: PAIRED_STATUSES[0] }))));
    expect(sheetIn(island), "PREMISE: closed by the pairing").toBeUndefined();
    showQr(island);
    const sheet = renderIsland(CourtStreamSheet, propsOf(sheetIn(island)!) as Parameters<typeof CourtStreamSheet>[0]);
    await vi.waitFor(() => expect(apiV1).toHaveBeenCalled());
    const calls = apiV1.mock.calls.map(([url, o]) => `${o?.method ?? "GET"} ${url}`);
    expect(calls).toEqual(["GET /api/v1/competitions/comp-1/court-streams"]);
    sheet.unmount();
  });

  it("the EMPTY case: opened to LINK a court — no link, then the link landed with no phone, change nothing; the phone pairing on the new link closes it", () => {
    const island = renderIsland(CourtFocus, props(court(null)));
    openToLink(island);
    expect(propsOf(sheetIn(island)!).linkId, "opened to link").toBeNull();
    island.rerender(props(court(null)));
    expect(sheetIn(island), "no link, re-read").toBeDefined();
    island.rerender(props(court(link())));
    expect(sheetIn(island), "linked (the board read after Link): no phone yet, still open on the QR it made").toBeDefined();
    expect(propsOf(sheetIn(island)!).linkId, "the same sheet: the one that linked").toBeNull();
    island.rerender(props(court(link({ phone: PAIRED_STATUSES[0] }))));
    expect(sheetIn(island), "the phone paired on the new link: closed").toBeUndefined();
  });

  it("a re-pair after Stop streaming and a new link closes it; so does another link's phone read in its place", () => {
    const paired = PAIRED_STATUSES[0]!;
    const island = renderIsland(CourtFocus, props(court(link({ link_id: "link-a", phone: paired }))));
    showQr(island);
    expect(sheetIn(island), "PREMISE: opened on a court whose phone is already paired").toBeDefined();
    island.rerender(props(court(null)));
    expect(sheetIn(island), "the link withdrawn (another desk): no phone, nothing closes").toBeDefined();
    island.rerender(props(court(link({ link_id: "link-b" }))));
    expect(sheetIn(island), "linked again, no phone yet").toBeDefined();
    island.rerender(props(court(link({ link_id: "link-b", phone: paired }))));
    expect(sheetIn(island), "the phone paired on the new link: closed").toBeUndefined();

    const other = renderIsland(CourtFocus, props(court(link({ link_id: "link-a", phone: paired }))));
    showQr(other);
    other.rerender(props(court(link({ link_id: "link-b", phone: paired }))));
    expect(sheetIn(other), "another link's phone in the next read: closed").toBeUndefined();
  });

  it("kept for the court it was opened on: another court's paired phone, read while that court is focused, never closes this court's sheet", () => {
    const island = renderIsland(CourtFocus, props(court(link())));
    showQr(island);
    island.rerender(props(court(link({ link_id: "link-9", phone: PAIRED_STATUSES[0] }), { court_id: "c-9", court_name: "Court 9" })));
    expect(sheetIn(island), "another court focused: its sheet is not drawn").toBeUndefined();
    island.rerender(props(court(link())));
    expect(sheetIn(island), "back on Court 2, still waiting for its phone: the sheet is still open").toBeDefined();
    // The return trip: re-shown on Court 2 whose phone is ALREADY paired, away to Court 9 (paired on its own link) and back. Court
    // 9's pairing against Court 2's is two courts, not a new pairing: the re-shown sheet stays.
    const paired = PAIRED_STATUSES[0]!;
    const reshown = renderIsland(CourtFocus, props(court(link({ phone: paired }))));
    showQr(reshown);
    reshown.rerender(props(court(link({ link_id: "link-9", phone: paired }), { court_id: "c-9", court_name: "Court 9" })));
    reshown.rerender(props(court(link({ phone: paired }))));
    expect(sheetIn(reshown), "back on Court 2, the same phone: the re-shown sheet is still open").toBeDefined();
  });

  describe("the poll while the sheet waits for the court's phone", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    it("the cadence is the Phone tab's own read cadence, well inside the band's quiet one", () => {
      expect(COURT_SHEET_PAIR_POLL_MS).toBe(STREAM_POLL_MS);
      expect(COURT_SHEET_PAIR_POLL_MS * 6, "PREMISE: the band alone would leave it open six polls longer").toBeLessThanOrEqual(QUIET_POLL_MS);
    });

    it("reads the day every COURT_SHEET_PAIR_POLL_MS while open on a court with no phone — and stops when the phone pairs (the sheet closes)", async () => {
      const onRead = vi.fn();
      const onChanged = vi.fn();
      const island = renderIsland(CourtFocus, props(court(link()), onRead, { onChanged }));
      await vi.advanceTimersByTimeAsync(COURT_SHEET_PAIR_POLL_MS * 3);
      expect(onRead, "closed: nothing reads").toHaveBeenCalledTimes(0);
      showQr(island);
      await vi.advanceTimersByTimeAsync(COURT_SHEET_PAIR_POLL_MS * 3);
      expect(onRead, "open, no phone: one read per interval").toHaveBeenCalledTimes(3);
      expect(onChanged, "a plain read: never the change callback that clears the court's notice").toHaveBeenCalledTimes(0);
      island.rerender(props(court(link({ phone: PAIRED_STATUSES[0] })), onRead, { onChanged }));
      expect(sheetIn(island)).toBeUndefined();
      await vi.advanceTimersByTimeAsync(COURT_SHEET_PAIR_POLL_MS * 3);
      expect(onRead, "paired and closed: the reads stop").toHaveBeenCalledTimes(3);
      expect(vi.getTimerCount(), "and no timer is left behind").toBe(0);
      island.unmount();
    });

    it("a focus handed no reader (the static mounts) starts no timer, sheet open or not", async () => {
      const island = renderIsland(CourtFocus, props(court(link()), undefined, { onRead: undefined }));
      showQr(island);
      expect(sheetIn(island), "PREMISE: the sheet is open and waiting").toBeDefined();
      expect(vi.getTimerCount()).toBe(0);
      island.unmount();
    });

    it("nothing to wait for, nothing read: open on a court already paired, or opened to link before the link exists; the reads start once the link lands", async () => {
      const onRead = vi.fn();
      const paired = renderIsland(CourtFocus, props(court(link({ phone: PAIRED_STATUSES[0] })), onRead));
      showQr(paired);
      await vi.advanceTimersByTimeAsync(COURT_SHEET_PAIR_POLL_MS * 3);
      expect(onRead, "already paired").toHaveBeenCalledTimes(0);
      paired.unmount();
      const linking = renderIsland(CourtFocus, props(court(null), onRead));
      openToLink(linking);
      await vi.advanceTimersByTimeAsync(COURT_SHEET_PAIR_POLL_MS * 3);
      expect(onRead, "no link yet").toHaveBeenCalledTimes(0);
      linking.rerender(props(court(link()), onRead));
      await vi.advanceTimersByTimeAsync(COURT_SHEET_PAIR_POLL_MS * 2);
      expect(onRead, "linked, waiting for the phone").toHaveBeenCalledTimes(2);
      linking.unmount();
      await vi.advanceTimersByTimeAsync(COURT_SHEET_PAIR_POLL_MS * 3);
      expect(onRead, "unmounted: nothing more").toHaveBeenCalledTimes(2);
    });

    it("a parent re-render with a NEW onRead (the shell passes an inline arrow) neither restarts the cadence nor calls the old one", async () => {
      const first = vi.fn();
      const second = vi.fn();
      const island = renderIsland(CourtFocus, props(court(link()), first));
      showQr(island);
      await vi.advanceTimersByTimeAsync(COURT_SHEET_PAIR_POLL_MS * 0.6);
      island.rerender(props(court(link()), second));
      await vi.advanceTimersByTimeAsync(COURT_SHEET_PAIR_POLL_MS * 0.6);
      expect([first.mock.calls.length, second.mock.calls.length], "one interval elapsed in all: the new callback, once").toEqual([0, 1]);
      island.unmount();
    });

    it("a hidden tab reads nothing; visible again, the reads go on", async () => {
      const onRead = vi.fn();
      const doc = { visibilityState: "hidden" };
      vi.stubGlobal("document", doc);
      const island = renderIsland(CourtFocus, props(court(link()), onRead));
      showQr(island);
      await vi.advanceTimersByTimeAsync(COURT_SHEET_PAIR_POLL_MS * 3);
      expect(onRead, "hidden").toHaveBeenCalledTimes(0);
      doc.visibilityState = "visible";
      await vi.advanceTimersByTimeAsync(COURT_SHEET_PAIR_POLL_MS * 2);
      expect(onRead, "visible").toHaveBeenCalledTimes(2);
      island.unmount();
    });
  });
});
