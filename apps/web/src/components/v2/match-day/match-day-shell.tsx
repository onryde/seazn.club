"use client";
// Match Day (spec 2026-10-31 §6, task A3): "court list + focus" (owner pick C). The header — "Match Day · <weekday date>", the
// competition, "N courts · N playing · N free", the division chips — then the court list and the focused court: two columns
// from md, and on a phone the list as home with a court opening full-screen over it ("‹ All courts" back). One DOM, branched
// with max-md:/md:hidden (AGENTS.md "The phone composition").
//
// SSR-first, then polled through the competition desk's own schedule (desk/band-poll.ts): fast while a match is playing or
// called, slow while the day is quiet, paused while the tab is hidden. A poll that fails (a rare race on the server, task A2
// m1) or answers something that is not a view (a cut-off 200, review M1) keeps the last view and tries again on the next tick.
//
// The court the organiser opened stays opened only while it is on the list: when the filter or the day takes it away, the page
// says so and goes back to the list — never silently onto a different court (review M6), and a phone sent back to the list is
// not jumped into the court again if it returns (M6b). A refused call or undo is kept per
// court through the refresh it triggers, until dismissed or another court is opened (review M5).
//
// Needs you (spec §6.3, §9; task A4): on a match day the competition's whole Needs-you list lives HERE, behind one attention
// button in the header — "11 need you · 3 results owed" — that opens the desk's own list (`NeedsYou`, reused) with the results
// owed first, each with Enter result. No list, no button. A middle-dot line never leaves a dot dangling at a wrap (`DotLine`).
//
// Task B4 (owner rulings Q1, 2026-10-31):
//  - "Playing, no court": the matches in play with no court (an untimed bracket match, an online board) list under the courts
//    and open a panel of their own (`NoCourtFocus`) — and on a day with no courts at all they ARE the list, rather than "No
//    courts to run yet". Only a day with neither says so, and says what to do;
//  - a view-only member (`readOnly`) gets the same page with nothing that writes, and without the Needs-you list;
//  - Needs you's unscheduled row carries "Find a court": the first free court's candidates, opened in place (`?court=` when
//    the link is opened another way), or back to the list when no court is free.
//
// Match Day online (plan 2026-11-05-match-day-all-in-one.md Task 6; always on since Task 10 retired the flag and the Arbiter page): the
// view's online chess rounds are a third block of the list after the courts and the no-court rows (online-list.tsx), and a round or a
// board opens in the focus column exactly as a court does - on a phone full-screen, with the merged back label, and "left the list"
// (never another row) when a poll takes it away. `?board=` and `?round=` read like `?court=`: a value naming a listed row opens it, any
// other is ignored with no notice (a board the viewer plays on is never listed). Needs you's board and round rows open in place.
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import Link from "@/components/ui/console-link";
import { fmtPublicDate } from "@/lib/format";
import type { Dict, Locale } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";
import { routes } from "@/lib/routes";
import type { Severity } from "@/lib/division-phase";
import type { FrozenNames } from "@/lib/match-day/frozen-names";
import type { MatchDayBoard, MatchDayOnlineRound, MatchDayView } from "@/lib/match-day/types";
import { nextRoundOf, orderOnlineRounds, resolveOnlineFocus, type OnlineOpened, type Reader } from "@/lib/match-day/online";
import { boardName, onlineRoundTitle } from "@/lib/match-day/online-copy";
import type { ViewerPlan } from "@/lib/viewer-plan";
import {
  filterByVenues,
  filterCourts,
  filterNoCourt,
  filterOnlineRounds,
  headerCountParts,
  initialVenueSelection,
  isLive,
  matchLabel,
  needsYouButtonParts,
  needsYouOrder,
  needsYouTone,
  noCourtNoun,
  courtsAtClock,
  openedFromParams,
  orderCourts,
  parseVenueParam,
  resolveDayFocus,
  scopeCourtNames,
  sharedNoun,
  venueOptions,
  venueParamOf,
  viewAfterPoll,
  freezeSeenAfterPoll,
  withVenueParam,
  type Opened,
} from "@/lib/match-day/view";
import { browserBandPollDeps, startBandPolling } from "@/components/v2/desk/band-poll";
import { NeedsYou } from "@/components/v2/desk/needs-you";
import { CourtFocus, NoCourtFocus, fixtureHref, type MatchDayCtx } from "./court-focus";
import { CourtList, NoCourtList } from "./court-list";
import { BoardFocus } from "./board-focus";
import { meetingKeysOf, useArbiterJoins } from "./online/arbiter-joins";
import { OnlineList } from "./online-list";
import { RoundFocus } from "./round-focus";
import { levelWords } from "@/lib/score/levels";
import { VenueFilter } from "./venue-filter";
import { MatchDayCodeSheet } from "./match-day-code-sheet";
import { RefreshLine } from "./refresh-line";
import { useDayRefresh } from "./use-day-refresh";

/** How often the page re-reads the closures against its clock: a break is minutes, so a minute is exact enough (m1). */
const CLOCK_TICK_MS = 60_000;

export interface MatchDayShellProps {
  competitionId: string;
  competitionName: string;
  orgSlug: string;
  compSlug: string;
  /** The organisation (its channels are what a court streams to); absent, a court cannot be linked from here. */
  orgId?: string;
  locale: Locale;
  /** The competition's live divisions, for the filter chips. */
  divisions: { id: string; name: string }[];
  initial: MatchDayView;
  /** The `ui` dictionary's `matchDay.*` keys, and the borrowed ones the page lists (page.tsx). */
  dict: Dict;
  /** The `public` dictionary's scoreboard keys (`LiveScoreBody`). */
  scoreDict: Dict;
  /** The organisation's plan class, for the scorer QR's paywall copy. */
  viewerPlan: ViewerPlan;
  /** A member who may view but not edit (B4, owner ruling Q1b): the page with nothing that writes. */
  readOnly?: boolean;
  /** The competition is billing-frozen (task F1): no Call and no Undo call, and the page says why. */
  frozen?: boolean;
  /** PB3 item 7: the org's billing-frozen competitions (at most three, this one first, and a count of the rest), named under the
   *  banner. REQUIRED, so a mount that forgets it fails to compile instead of quietly dropping the names; pass
   *  `NO_FROZEN_NAMES` where there is nothing to name. Only read when `frozen` and not `readOnly`, the banner's own condition. */
  frozenNames: FrozenNames;
  /** `?court=<id>`: the court to open first (Needs you's "Find a court" link, opened another way). Ignored when not on the list. */
  focusCourtId?: string | null;
  /** `?venue=`: the venue filter's choice as the URL wrote it ("all", or venue ids), absent for the default (E2 item 5). */
  venueParam?: string | readonly string[] | null;
  /** `?board=<fixture id>`: the board to open first, read as `focusCourtId` is. Ignored when not on the list. */
  focusBoardId?: string | null;
  /** `?round=<stage id>:<round no>`: the round to open first (`onlineRoundKey`), read as `focusCourtId` is. Ignored when not on the list. */
  focusRoundKey?: string | null;
}

/** How long after a tail countdown reaches 0 the day is read once more (the server's stop lands after it). */
const TAIL_RECHECK_MS = 12_000;

export function MatchDayShell({
  competitionId,
  competitionName,
  orgSlug,
  compSlug,
  orgId,
  locale,
  divisions,
  initial,
  dict,
  scoreDict,
  viewerPlan,
  readOnly = false,
  frozen = false,
  frozenNames,
  focusCourtId = null,
  venueParam = null,
  focusBoardId = null,
  focusRoundKey = null,
}: MatchDayShellProps) {
  const [view, setView] = useState<MatchDayView>(initial);
  /** What the organiser opened - a court, a match on no court, an online round or board (its name kept to say so if it leaves the
   *  list); null until one is. A `?court=`, `?board=` or `?round=` that names a listed row opens it; any other value opens nothing. */
  const [opened, setOpened] = useState<Opened | null>(() =>
    openedFromParams(
      dict,
      { courts: initial.courts, online_rounds: initial.online_rounds },
      { court: focusCourtId, board: focusBoardId, round: focusRoundKey },
    ),
  );
  /** On a phone: the list (false) or one court full-screen (true). Desktop shows both and ignores it. A `?court=` that names a
   *  court on the list opens it full-screen, as tapping it would. */
  const [phoneOpen, setPhoneOpen] = useState(() => opened !== null);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  /** The address as the browser has it NOW (fix round 1, I3). On Back, Next rebuilds this page from its router cache with the server
   *  props it was first rendered with - the `?venue=` the address carried then, which is none if the filter was set afterwards - so
   *  `venueParam` goes stale while the address itself is right (the filter writes it). The address wins whenever the router gives
   *  one; the prop speaks outside the app router (the static suites) and is what the server painted the first time. */
  const address = useSearchParams();
  /** The venues listed (E2 item 5): the address's choice, else the venues with a match today, else all. Display only. A court the
   *  page was asked to open (`?court=`) is never hidden by it: its venue is added. */
  const [venues, setVenues] = useState<ReadonlySet<string>>(() => {
    const picked = initialVenueSelection(initial.courts, initial.venues_today, parseVenueParam(address === null ? venueParam : address.getAll("venue")));
    const asked = focusCourtId === null ? undefined : initial.courts.find((c) => c.court_id === focusCourtId);
    return asked === undefined || picked.has(asked.venue_id) ? picked : new Set([...picked, asked.venue_id]);
  });
  const [notice, setNotice] = useState<{ courtId: string; message: string } | null>(null);
  /** The Needs-you list, open under the header. */
  const [needsOpen, setNeedsOpen] = useState(false);
  const needsId = useId();
  /** The Match Day code sheet (MD-1 Task 2), open over the page. Editors only: a viewer never sees its button. */
  const [codeOpen, setCodeOpen] = useState(false);

  // One read of the day for the poll, the Refresh button and a court's tail countdown reaching 0 (use-day-refresh.ts).
  // A poll whose online rounds read failed keeps the online rounds the page holds, and one whose held or flagged read failed for a division keeps
  // that division's board rows (`viewAfterPoll`): the board panel open on a game stays open, and nothing else of the list is held.
  // B5: `freezeSeen` (below) is lifted by a poll asked after the 402 that says the competition is no longer frozen; the poll's own `startedAt` orders it.
  const [freezeSeen, setFreezeSeen] = useState<number | null>(null);
  /** B5 fix round 1: the freeze the LOAD painted (the `frozen` prop) is lifted by the latest poll that answered for the competition: `false` lifts it, `true`
   *  says it again, and `null` (that poll's freeze read failed) or no flag at all (an older server) is no evidence, so the last answer stands. Before this the
   *  prop was for good, so a page opened during a freeze kept every press inert after the room came back, until a reload. */
  const [pollFrozen, setPollFrozen] = useState<boolean | null>(null);
  const takeView = useCallback((next: MatchDayView, startedAt: number) => {
    setView((prev) => viewAfterPoll(prev, next));
    setFreezeSeen((seenAt) => freezeSeenAfterPoll(seenAt, next.frozen, startedAt));
    setPollFrozen((last) => (typeof next.frozen === "boolean" ? next.frozen : last));
  }, []);
  /** The competition's billing freeze as the page knows it NOW: what the load painted, unless a poll has since said it is not frozen. A 402 (`freezeSeen`) is
   *  folded in separately, by the panels' reader. */
  const frozenNow = frozen && pollFrozen !== false;
  const { refresh, busy: refreshing, failed: refreshFailed, lastOkAt } = useDayRefresh(competitionId, takeView);
  const refreshNow = useCallback(() => void refresh({ manual: true }), [refresh]);
  /** A press in the round panel changed the day: the quiet read, with a stable identity (the panel's runners are built over it). */
  const refreshQuiet = useCallback(() => void refresh(), [refresh]);
  /** MD-R30: a press in the round panel was answered 402. The `frozen` prop is read when the page loads, so a freeze that lands under an open page would
   *  leave every press standing until a reload; this keeps what the server just said (the browser's clock at that 402) and folds it into the reader
   *  (`readerOf`). B5: it is no longer for good - a poll asked after it that says `frozen: false` takes it back (`freezeSeenAfterPoll`). */
  const onFrozen = useCallback(() => setFreezeSeen(Date.now()), []);
  /** A court's tail countdown ended: quiet, and one read per second however many countdowns end on the same tick. */
  const lastTailRead = useRef(0);
  const tailTimers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const refreshOnTailEnd = useCallback(() => {
    const at = Date.now();
    if (at - lastTailRead.current < 1000) return;
    lastTailRead.current = at;
    void refresh();
    // The server stops the session a little after the countdown reaches 0, so one more read follows (one per tail end).
    const id = setTimeout(() => {
      tailTimers.current.delete(id);
      void refresh();
    }, TAIL_RECHECK_MS);
    tailTimers.current.add(id);
  }, [refresh]);
  useEffect(() => {
    const timers = tailTimers.current;
    return () => {
      for (const id of timers) clearTimeout(id);
      timers.clear();
    };
  }, []);

  /** The online rounds the page draws: the view's own (empty when no division of the competition plays online). */
  const online = view.online_rounds;
  const live = isLive({ courts: view.courts, playing_no_court: view.playing_no_court, online_rounds: online });
  useEffect(() => startBandPolling(live, () => void refresh(), browserBandPollDeps()), [live, refresh]);

  // The clock (fix round 1, m1): a closure is true at the view's `now`, and a poll is 90 seconds or a quiet day's minutes away, so
  // a break that begins or ends in between must show at once. Starts at the view's own `now` (the server and the first client render
  // agree), then ticks each minute on the browser's clock. A clock running behind the server's cannot un-close a court: the
  // closure was read at the view's `now`, and reading it at an earlier instant gives the same answer. Only courts whose closure
  // moved are touched.
  const [clock, setClock] = useState(() => Date.parse(initial.now));
  useEffect(() => {
    const id = setInterval(() => setClock(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(id);
  }, []);
  const allCourts = useMemo(() => courtsAtClock(view.courts, clock), [view.courts, clock]);

  const filter = chosen.size === 0 ? null : chosen;
  // Listed by group — playing, called, up next, in use elsewhere, free — and the first of that list is the desktop's default focus.
  const venueChoices = useMemo(() => venueOptions(allCourts), [allCourts]);
  const venueFilterOn = venueChoices.length > 1;
  const courts = useMemo(
    () => orderCourts(filterCourts(venueFilterOn ? scopeCourtNames(filterByVenues(allCourts, venues), venues) : allCourts, filter)),
    [allCourts, venues, venueFilterOn, filter],
  );
  const noCourt = useMemo(() => filterNoCourt(view.playing_no_court, filter), [view.playing_no_court, filter]);
  // The online block: the division chips narrow it, `orderOnlineRounds` lists it (check-in or in progress, paired, over), and it is the
  // LAST place the default focus looks - a court first, then a match on no court, then the first round.
  const onlineRounds = useMemo(() => orderOnlineRounds(filterOnlineRounds(online, filter), clock), [online, filter, clock]);
  const focus = resolveDayFocus(courts, noCourt, onlineRounds, opened);
  const focused = focus.kind === "court" ? focus.court : null;
  const focusedMatch = focus.kind === "match" ? focus.fixture : null;
  const focusedRound = focus.kind === "round" ? focus.round : null;
  const focusedBoard = focus.kind === "board" ? focus : null;
  // A phone whose court left the list is back on the list (review M6b): it stays there when the court returns, rather than
  // jumping back into a court the organiser was told had gone. React's render-phase adjustment, not an effect.
  // B13: a board or round that is NOT on the page's rounds while the poll's rounds read FAILED is not "no longer on this list" - the page did not read the
  // rounds (it holds the last answer, `viewAfterPoll`), so a fresh Needs-you row can name a board the held rounds never listed. The press is kept
  // (`opened` stands), the page says the rounds could not be read, and the panel opens by itself when a poll that ANSWERS lists the board; one that
  // answers without it is the plain notice. A phone stays where it is: it is dropped to the list only by a board that really left.
  const reading = focus.kind === "lost" && view.online_failed === true && (opened?.kind === "board" || opened?.kind === "round");
  if (phoneOpen && focus.kind === "lost" && !reading) setPhoneOpen(false);
  // Same adjustment for the Needs-you list (fix round 1, m5): once a poll empties it, the button goes and the list is CLOSED,
  // so rows arriving later bring the button back closed rather than reopening the list unasked. A view-only reader never has it.
  const needsYou = readOnly ? [] : view.needs_you;
  if (needsOpen && needsYou.length === 0) setNeedsOpen(false);
  /** A phone shows one court (a match, a round, a board) full-screen only while what it opened is still there. */
  const phoneCourt = phoneOpen && (focused !== null || focusedMatch !== null || focusedRound !== null || focusedBoard !== null);
  const noun = sharedNoun(courts.length > 0 ? courts : allCourts);
  const ctx: MatchDayCtx = { competitionId, orgSlug, compSlug, locale, tz: view.tz, dict, scoreDict, viewerPlan, readOnly, frozen: frozenNow, orgId, viewNow: view.now, onTailEnd: refreshOnTailEnd };
  const words = levelWords(scoreDict);
  /** The round or board in focus, for the list's highlight (`aria-current`). */
  const selectedOnline: OnlineOpened | null =
    focusedBoard !== null
      ? { kind: "board", id: focusedBoard.board.fixtureId, name: boardName(dict, focusedBoard.board) }
      : focusedRound !== null
        ? { kind: "round", key: focusedRound.key, name: onlineRoundTitle(dict, focusedRound) }
        : null;
  /** What the online panels read for who may press what (`mayPress`): the viewer's role, the club's flag (the round's own) and the
   *  competition's billing freeze (the `frozen` prop, the flag that hides Call and Undo). */
  const readerOf = (r: MatchDayOnlineRound): Reader => ({ editor: !readOnly, offered: r.offered, frozen: frozenNow || freezeSeen !== null });
  /** The board in focus's cameras (Task 9): the joins live HERE, keyed on the focused board's watchable sides and the day's own poll, so a poll
   *  that hands the panel a new board object keeps the same keys and re-joins nothing, and leaving the board leaves both meetings. */
  // B7 (T9 m5): the keys follow the board the TILES are drawn from - the panel's own read of the focused board when it has one (`BoardFocus` hands it up),
  // the day's row until then. Keyed on the board's id: an answer left over from another board is never read for this one.
  const [boardAnswer, setBoardAnswer] = useState<{ id: string; answer: MatchDayBoard } | null>(null);
  const onBoardAnswer = useCallback((id: string, answer: MatchDayBoard | null) => setBoardAnswer(answer === null ? null : { id, answer }), []);
  const keyedBoard = focusedBoard === null ? null : boardAnswer !== null && boardAnswer.id === focusedBoard.board.fixtureId ? boardAnswer.answer : focusedBoard.board;
  const cameraKeys = focusedBoard === null || keyedBoard === null ? [] : meetingKeysOf(keyedBoard, readerOf(focusedBoard.round));
  const joins = useArbiterJoins(cameraKeys, lastOkAt);
  /** The phone's way back from a round or a board (ruling MD-R27): the list, on every day. A board is not a court, so the courts' noun
   *  ("All courts") stays with the courts' own panels. */
  const onlineBackLabel = t(dict, "matchDay.back.list");
  const needsTone = needsYouTone(needsYou);
  const date = fmtPublicDate(locale, "UTC", `${view.date}T12:00:00Z`, { weekday: "long", day: "numeric", month: "short" });

  /** The phone's Back from a BOARD (MD-R35): the list again, AND the board out of focus. A board's meetings are joined for as long as it is the focus
   *  (`cameraKeys` above), and a phone that went back to the list hides its panel without closing it, so its cameras would stay joined behind the
   *  list, holding the vendor's capacity for nobody. The control is the phone's own (`md:hidden`): a desktop has no Back, and its focus is untouched. */
  const leaveBoard = () => {
    setPhoneOpen(false);
    setOpened(null);
  };

  const toTop = () => {
    if (typeof window !== "undefined" && window.matchMedia("(max-width: 767.98px)").matches) window.scrollTo({ top: 0 });
  };
  const open = (courtId: string) => {
    setOpened({ kind: "court", id: courtId, name: courts.find((c) => c.court_id === courtId)?.court_name ?? "" });
    setNotice((n) => (n !== null && n.courtId === courtId ? n : null));
    setPhoneOpen(true);
    toTop();
  };
  const openMatch = (f: MatchDayView["playing_no_court"][number]) => {
    setOpened({ kind: "match", id: f.id, name: matchLabel(dict, f) });
    setNotice(null);
    setPhoneOpen(true);
    toTop();
  };
  /** A division's chip is added when the chips would hide what is being opened: Needs you names a board whatever the filter says, and
   *  opening it must show it, never "left the list" for a row that was only filtered out. */
  const showDivision = (divisionId: string) =>
    setChosen((prev) => (prev.size === 0 || prev.has(divisionId) ? prev : new Set([...prev, divisionId])));
  /** An online round opened from the list, Needs you or the address, by its key. */
  const openRound = (key: string) => {
    const round = online.find((r) => r.key === key);
    // A round the list does not hold has no title to say if it is lost: "" (the notice then says it without a name), never its `stage:round` key.
    setOpened({ kind: "round", id: key, name: round === undefined ? "" : onlineRoundTitle(dict, round) });
    if (round !== undefined) showDivision(round.division_id);
    setNotice(null);
    setPhoneOpen(true);
    toTop();
  };
  /** An online board opened from the list or Needs you, by its fixture id (never by the row object: a poll hands a new one each time). */
  const openBoard = (fixtureId: string) => {
    const found = resolveOnlineFocus(online, { kind: "board", id: fixtureId, name: "" });
    // Likewise a board the list does not hold: "" and not its fixture id (a UUID is no word to put in front of an organiser).
    setOpened({ kind: "board", id: fixtureId, name: found.kind === "board" ? boardName(dict, found.board) : "" });
    if (found.kind === "board") showDivision(found.round.division_id);
    setNotice(null);
    setPhoneOpen(true);
    toTop();
  };
  /** Needs you's "Find a court", in place (R2): the court the server chose — the first free one the division's ready match may
   *  be called onto — opened on its candidates, or the list when none is free. */
  const findCourt = (courtId: string | null) => {
    setNeedsOpen(false);
    if (courtId !== null) {
      // The court is named by the server whatever the venue filter lists: show its venue rather than send the organiser to a
      // "left the list" notice for a court that is simply not listed.
      const venue = allCourts.find((c) => c.court_id === courtId)?.venue_id;
      if (venue !== undefined && !venues.has(venue)) chooseVenues(new Set([...venues, venue]));
      open(courtId);
    }
    else {
      setPhoneOpen(false);
      toTop();
    }
  };
  /** A new venue selection: held, and written to the address (`?venue=`) so a reload and Back bring it back. */
  const chooseVenues = (next: ReadonlySet<string>) => {
    setVenues(next);
    if (typeof window !== "undefined") {
      window.history.replaceState(null, "", withVenueParam(window.location.href, venueParamOf(next, venueChoices)));
    }
  };
  const toggle = (divisionId: string) =>
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(divisionId)) next.delete(divisionId);
      else next.add(divisionId);
      return next;
    });

  return (
    <div data-testid="match-day" className="min-w-0">
      <header data-testid="md-header" className={`mb-5 min-w-0${phoneCourt ? " max-md:hidden" : ""}`}>
        <div className="flex min-w-0 flex-col gap-3 md:flex-row md:items-start md:justify-between md:gap-6">
          <div className="min-w-0">
            <h1 className="page-title min-w-0 [overflow-wrap:anywhere]">{t(dict, "matchDay.title", { date })}</h1>
            {/* The competition on a line of its own and the counts on the next: a "·" between the two hung at the end of the
                line whenever a phone wrapped them (A3 carry-in). */}
            <p className="mt-2 min-w-0 text-sm">
              <Link
                href={routes.competition(orgSlug, compSlug)}
                aria-label={t(dict, "matchDay.backToCompetition", { competition: competitionName })}
                className="font-medium text-purple-800 underline-offset-2 [overflow-wrap:anywhere] hover:underline"
              >
                {competitionName}
              </Link>
            </p>
            <RefreshLine dict={dict} lastOkAt={lastOkAt} busy={refreshing} failed={refreshFailed} onRefresh={refreshNow} />
            <DotLine
              testId="md-counts"
              className="mt-0.5 text-sm text-slate-600"
              parts={headerCountParts(dict, locale, noun, courts, noCourt, onlineRounds)}
            />
            {readOnly && (
              <p data-testid="md-read-only" className="mt-2 text-xs text-slate-600">
                {t(dict, "matchDay.readOnly")}
              </p>
            )}
            {/* A viewer is told the page is view-only already; the freeze is the editor's news (task F1). */}
            {frozenNow && !readOnly && (
              <p data-testid="md-frozen" className="mt-2 text-xs text-amber-800">
                {t(dict, "matchDay.frozen")}
              </p>
            )}
            {/* PB3 item 7: which competitions are over the limit, so the organiser knows what to archive. The label sits on its own line, then
                one wrapping row of 44px targets (Match Day is the phone-at-the-venue page; a 16px inline link two words from the next one is a
                mis-tap). The competition on screen is first and plain (a link to this page would be a link to itself); the rest link to their
                own pages; "+N more" closes the row. PB3 review m1. */}
            {frozenNow && !readOnly && frozenNames.shown.length > 0 && (
              <div data-testid="md-frozen-names" className="mt-1 min-w-0 text-xs text-amber-800">
                <p>{t(dict, "matchDay.frozenNames")}</p>
                <ul className="m-0 flex list-none flex-wrap items-center gap-x-4 p-0">
                  {frozenNames.shown.map((c) => (
                    <li key={c.id} className="min-w-0 max-w-full">
                      {c.id === competitionId ? (
                        <span className="inline-flex min-h-11 max-w-full items-center font-medium [overflow-wrap:anywhere]">{c.name}</span>
                      ) : (
                        <Link
                          href={routes.competition(orgSlug, c.slug)}
                          className="inline-flex min-h-11 max-w-full items-center font-medium underline underline-offset-2 [overflow-wrap:anywhere]"
                        >
                          {c.name}
                        </Link>
                      )}
                    </li>
                  ))}
                  {frozenNames.more > 0 && (
                    <li className="inline-flex min-h-11 items-center">{t(dict, "matchDay.frozenMore", { count: frozenNames.more })}</li>
                  )}
                </ul>
              </div>
            )}
          </div>
          {!readOnly && (
            <button
              type="button"
              data-testid="md-code-open"
              aria-haspopup="dialog"
              onClick={() => setCodeOpen(true)}
              className="btn btn-ghost inline-flex min-h-11 shrink-0 items-center max-md:w-full md:order-last"
            >
              {t(dict, "matchDay.code.title")}
            </button>
          )}
          {needsTone !== null && (
            <button
              type="button"
              data-testid="md-needs-you-toggle"
              data-severity={needsTone}
              aria-expanded={needsOpen}
              aria-controls={needsId}
              onClick={() => setNeedsOpen((o) => !o)}
              className={`inline-flex min-h-11 min-w-0 shrink-0 items-center gap-2.5 rounded-xl px-3.5 py-2 text-left text-sm font-semibold ring-1 ring-inset transition max-md:w-full md:max-w-[22rem] ${NEEDS_TONE[needsTone]}`}
            >
              <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${NEEDS_DOT[needsTone]}`} />
              <DotLine className="min-w-0 flex-1" parts={needsYouButtonParts(dict, { ...view, needs_you: needsYou }, locale)} />
              <svg
                aria-hidden
                viewBox="0 0 16 16"
                className={`h-4 w-4 shrink-0 fill-none stroke-current transition-transform motion-reduce:transition-none ${needsOpen ? "rotate-180" : ""}`}
                strokeWidth="1.75"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M4 6l4 4 4-4" />
              </svg>
            </button>
          )}
        </div>
        {needsTone !== null && (
          <div id={needsId} data-testid="md-needs-you" hidden={!needsOpen} className="mt-4 min-w-0 [&_[data-testid=desk-needs-you]]:mb-0">
            {needsOpen && (
              <NeedsYou
                dict={dict}
                items={needsYouOrder(needsYou)}
                onAlt={(it) => findCourt(it.alt?.court_id ?? null)}
                onOpenBoard={(fixtureId) => {
                  setNeedsOpen(false);
                  openBoard(fixtureId);
                }}
                onOpenRound={(key) => {
                  setNeedsOpen(false);
                  openRound(key);
                }}
              />
            )}
          </div>
        )}
        {(venueFilterOn || divisions.length > 1) && (
          <div className="mt-3 flex min-w-0 flex-wrap items-start gap-2">
            {venueFilterOn && <VenueFilter dict={dict} locale={locale} options={venueChoices} selected={venues} onChange={chooseVenues} />}
            {divisions.length > 1 && (
              <div role="group" aria-label={t(dict, "matchDay.filter.label")} className="flex min-w-0 flex-wrap gap-2">
                <button
                  type="button"
                  aria-pressed={filter === null}
                  onClick={() => setChosen(new Set())}
                  className={chipClass(filter === null)}
                >
                  {t(dict, "matchDay.filter.all")}
                </button>
                {divisions.map((d) => (
                  <button
                    key={d.id}
                    type="button"
                    data-testid="md-division-chip"
                    aria-pressed={chosen.has(d.id)}
                    onClick={() => toggle(d.id)}
                    className={chipClass(chosen.has(d.id))}
                  >
                    {d.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </header>
      {codeOpen && !readOnly && (
        <MatchDayCodeSheet
          competitionId={competitionId}
          dict={dict}
          locale={locale}
          today={view.date}
          zone={view.tz}
          courts={view.courts}
          venuesToday={view.venues_today}
          onClose={() => setCodeOpen(false)}
        />
      )}

      {courts.length === 0 && noCourt.length === 0 && onlineRounds.length === 0 ? (
        <div data-testid="md-empty" className="card p-6">
          <p className="font-semibold text-slate-900">{t(dict, "matchDay.empty.title")}</p>
          <p className="mt-1 text-sm text-slate-600">
            {filter === null ? t(dict, "matchDay.empty.body") : t(dict, "matchDay.empty.filtered")}
          </p>
          {filter === null && (
            <Link href={routes.competitionSchedule(orgSlug, compSlug)} className="btn btn-ghost mt-4 min-h-11">
              {t(dict, "matchDay.empty.schedule")}
            </Link>
          )}
        </div>
      ) : (
        <div className="min-w-0 md:grid md:grid-cols-[minmax(0,17rem)_minmax(0,1fr)] md:items-start md:gap-6 lg:grid-cols-[minmax(0,21rem)_minmax(0,1fr)]">
          {reading && (
            <div data-testid="md-reading" role="status" className="card mb-4 min-w-0 p-5 md:col-start-2 md:row-start-1 md:mb-0">
              <p className="font-semibold text-slate-900 [overflow-wrap:anywhere]">{t(dict, "matchDay.focus.reading")}</p>
            </div>
          )}
          {focus.kind === "lost" && !reading && (
            <div data-testid="md-lost" role="status" className="card mb-4 min-w-0 p-5 md:col-start-2 md:row-start-1 md:mb-0">
              <p className="font-semibold text-slate-900 [overflow-wrap:anywhere]">
                {focus.name === "" ? t(dict, "matchDay.focus.leftUnnamed") : t(dict, "matchDay.focus.left", { court: focus.name })}
              </p>
              <p className="mt-1 text-sm text-slate-600">{t(dict, "matchDay.focus.pick")}</p>
            </div>
          )}
          <div data-testid="md-list" className={`grid min-w-0 gap-5 md:col-start-1 md:row-start-1${phoneCourt ? " max-md:hidden" : ""}`}>
            {courts.length > 0 && (
              <CourtList courts={courts} selectedId={focused?.court_id ?? null} dict={dict} words={words} locale={locale} tz={view.tz} onSelect={open} viewNow={view.now} onTailEnd={refreshOnTailEnd} />
            )}
            <NoCourtList
              fixtures={noCourt}
              noun={noCourtNoun(noCourt)}
              selectedId={focusedMatch?.id ?? null}
              dict={dict}
              words={words}
              hrefOf={(f) => fixtureHref(ctx, f)}
              openLabel={t(dict, readOnly ? "matchDay.focus.openMatch" : "matchDay.focus.openPad")}
              onSelect={openMatch}
            />
            <OnlineList rounds={onlineRounds} selected={selectedOnline} dict={dict} locale={locale} nowMs={clock} onOpenRound={openRound} onOpenBoard={openBoard} />
          </div>
          {focused !== null && (
            <CourtFocus
              ctx={ctx}
              court={focused}
              backLabel={t(dict, `matchDay.back.${noun}`)}
              onBack={() => setPhoneOpen(false)}
              onChanged={() => {
                setNotice(null);
                void refresh();
              }}
              onRead={() => void refresh()}
              onRefused={(message) => {
                setNotice({ courtId: focused.court_id, message });
                void refresh();
              }}
              notice={notice !== null && notice.courtId === focused.court_id ? notice.message : null}
              onDismissNotice={() => setNotice(null)}
              refreshKey={view.now}
              divisions={filter}
              hiddenOnPhone={!phoneCourt}
            />
          )}
          {focusedMatch !== null && (
            <NoCourtFocus
              key={focusedMatch.id}
              ctx={ctx}
              fixture={focusedMatch}
              backLabel={t(dict, courts.length > 0 ? `matchDay.back.${noun}` : "matchDay.back.list")}
              onBack={() => setPhoneOpen(false)}
              onChanged={() => void refresh()}
              hiddenOnPhone={!phoneCourt}
            />
          )}
          {focusedRound !== null && (
            <RoundFocus
              key={focusedRound.key}
              ctx={ctx}
              round={focusedRound}
              next={nextRoundOf(online, focusedRound)}
              reader={readerOf(focusedRound)}
              nowMs={clock}
              backLabel={onlineBackLabel}
              onBack={() => setPhoneOpen(false)}
              onChanged={refreshQuiet}
              onFrozen={onFrozen}
              onOpenBoard={openBoard}
              onOpenRound={openRound}
              hiddenOnPhone={!phoneCourt}
            />
          )}
          {focusedBoard !== null && (
            <BoardFocus
              key={focusedBoard.board.fixtureId}
              ctx={ctx}
              round={focusedBoard.round}
              row={focusedBoard.board}
              reader={readerOf(focusedBoard.round)}
              nowMs={clock}
              refreshKey={lastOkAt}
              joins={joins}
              backLabel={onlineBackLabel}
              onBack={leaveBoard}
              onChanged={refreshQuiet}
              onFrozen={onFrozen}
              onAnswer={onBoardAnswer}
              hiddenOnPhone={!phoneCourt}
            />
          )}
        </div>
      )}
    </div>
  );
}

/** The header button's tone, from its most urgent row (the Needs-you list's own severities). */
const NEEDS_TONE: Record<Severity, string> = {
  red: "bg-red-50 text-red-900 ring-red-200 hover:bg-red-100",
  amber: "bg-amber-50 text-amber-950 ring-amber-200 hover:bg-amber-100",
  slate: "bg-white text-slate-800 ring-slate-200 hover:bg-slate-50",
};
const NEEDS_DOT: Record<Severity, string> = { red: "bg-red-600", amber: "bg-amber-600", slate: "bg-slate-500" };

/**
 * Words joined by a middle dot that never dangles (A3 carry-in: on a phone the header's "·" hung at the end of a wrapped line).
 * Each part carries its dot IN FRONT of it, and every part is pulled left by the dot's width inside a box that clips its left
 * edge: a part that starts a line has its dot in the clipped strip, a part beside another shows it. So a wrap — wherever the
 * reader's width and language put it — never ends or starts a line on a dot. The dot is decoration (aria-hidden).
 */
export function DotLine({ parts, className = "", testId }: { parts: readonly ReactNode[]; className?: string; testId?: string }) {
  return (
    <span data-testid={testId} className={`flex min-w-0 flex-wrap gap-x-[1.25em] overflow-hidden ${className}`}>
      {parts.map((p, i) => (
        <span key={i} data-dot-part className="-ml-[1.25em] inline-flex min-w-0">
          <span aria-hidden data-dot className="inline-block w-[1.25em] shrink-0 text-center">
            ·
          </span>
          <span className="min-w-0 [overflow-wrap:anywhere]">{p}</span>
        </span>
      ))}
    </span>
  );
}

function chipClass(on: boolean): string {
  return `inline-flex min-h-11 items-center rounded-full px-3 text-xs font-medium ring-1 ring-inset transition md:min-h-8 ${
    on ? "bg-purple-600 text-white ring-purple-600" : "bg-white text-purple-800 ring-purple-200 hover:bg-purple-50"
  }`;
}
