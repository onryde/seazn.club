// Match Day's court stream, the desk's side (court stream spec 2026-11-14 §5; web plan Task 12), rendered to markup: who is offered
// "Stream this court", the status chip a linked court wears, the per-match Stream switch in each of its states, and that none of it
// speaks English to a reader of another language. apps/web vitest is `environment: "node"`, so these are what the server paints;
// the link → QR → switch → phone beat → withdraw journey in a real browser is e2e/match-day.spec.ts ("court stream").
//
// Expected copy is read from the dictionaries by key, as the other Match Day suites do; the rules (what shows for whom) are the
// plan's Task 12 table, written out here, never computed by the code under test.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import en from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import nl from "@/dictionaries/nl/ui.json";
import type { Dict } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";
import type { MatchDayCandidate, MatchDayCourt, MatchDayCourtStream, MatchDayFixture, MatchDayQueued } from "@/lib/match-day/types";
import {
  canLinkCourt, lastWorkingMinute, linkFailureKey, phoneKey, switchFailureKey, switchSpec, youtubeTargets,
} from "@/lib/match-day/court-stream";
import { CourtFocus, type MatchDayCtx } from "@/components/v2/match-day/court-focus";
import { CandidateRows, FreeCourtBody } from "@/components/v2/match-day/candidate-list";
import { CourtList } from "@/components/v2/match-day/court-list";
import { TargetPicker } from "@/components/v2/match-day/court-stream-sheet";
import { levelWords } from "@/lib/score/levels";
import publicEn from "@/dictionaries/en/public.json";
import type { StreamTarget } from "@/server/api-v1/schemas";

const DICTS = { en, es, fr, nl } as Record<string, Dict>;
const dict = en as Dict;

const baseCtx = (o: Partial<MatchDayCtx> = {}, d: Dict = dict): MatchDayCtx => ({
  competitionId: "comp-1",
  orgSlug: "acme",
  compSlug: "summer",
  locale: "en",
  tz: "Europe/London",
  dict: d,
  scoreDict: publicEn as Dict,
  viewerPlan: "pro",
  readOnly: false,
  frozen: false,
  orgId: "org-1",
  ...o,
});

const fx = (o: Partial<MatchDayFixture> = {}): MatchDayFixture => ({
  id: "f-1",
  division_id: "d-1",
  division_name: "Open singles",
  division_slug: "open-singles",
  fixture_no: 1,
  sport_key: "badminton",
  stage_label: "Round robin",
  round: { code: "R1", label: "Round 1", coded: false },
  home: "Zara Khan",
  away: "Ella Brooks",
  home_entrant_id: "e-z",
  away_entrant_id: "e-e",
  headline: "0 – 0",
  summary: null,
  serving: null,
  started_at: "2026-10-31T11:20:00.000Z",
  called_at: null,
  stream: null,
  scorer_attention: null,
  live_video: null,
  live_seazn: false,
  format_line: null,
  court_stream: false,
  own_stream_code: false,
  ...o,
});

const queued = (o: Partial<MatchDayFixture> = {}): MatchDayQueued => ({
  ...fx({ id: "q-1", home: "Isha Rao", away: "Lily Chen", headline: null, started_at: null, ...o }),
  planned_at: "2026-10-31T12:20:00.000Z",
  estimated_at: "2026-10-31T12:20:00.000Z",
});

const link = (o: Partial<MatchDayCourtStream> = {}): MatchDayCourtStream => ({
  link_id: "link-1",
  target_label: "Riverside CC on YouTube",
  expires_at: "2026-11-01T00:00:00.000Z",
  phone: "waiting",
  refusal: null,
  tail_ends_at: null,
  ...o,
});

const court = (o: Partial<MatchDayCourt> = {}): MatchDayCourt => ({
  court_id: "c-2",
  court_name: "Court 2",
  venue_id: "venue-1",
  venue_name: "Main Hall",
  sport_noun: "court",
  state: "playing",
  current: fx(),
  in_use_by: null,
  free_since: null,
  queue: [queued()],
  closure: null,
  stream_link: null,
  ...o,
});

const focus = (c: MatchDayCourt, ctx: MatchDayCtx = baseCtx()) =>
  renderToStaticMarkup(
    <CourtFocus
      ctx={ctx}
      court={c}
      backLabel="All courts"
      onBack={() => {}}
      onChanged={() => {}}
      onRefused={() => {}}
      refreshKey="k"
      divisions={null}
    />,
  );

const list = (courts: MatchDayCourt[], d: Dict = dict) =>
  renderToStaticMarkup(
    <CourtList courts={courts} selectedId={null} dict={d} words={levelWords(publicEn as Dict)} locale="en" tz="Europe/London" onSelect={() => {}} />,
  );

/** A tag's `disabled` attribute (the class `disabled:…` is not it). */
const isDisabled = (tag: string): boolean => / disabled=""/.test(tag);
const has = (html: string, testId: string): boolean => html.includes(`data-testid="${testId}"`);
const count = (html: string, testId: string): number => html.split(`data-testid="${testId}"`).length - 1;
/** React's text escaping, for matching a dictionary string that carries an apostrophe. */
const esc = (v: string): string => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");

describe("Stream this court (who is offered it)", () => {
  it("shows on a court with no link to an editor of an unfrozen competition", () => {
    const html = focus(court());
    expect(has(html, "md-cs-link")).toBe(true);
    expect(html).toContain("Stream this court");
  });

  it.each([
    ["a view-only reader", { readOnly: true }],
    ["a billing-frozen competition", { frozen: true }],
    ["a page that gave no organisation to ask", { orgId: undefined }],
  ] as const)("is absent for %s", (_who, o) => {
    expect(has(focus(court(), baseCtx(o)), "md-cs-link")).toBe(false);
  });

  it("is absent once the court is linked (the band takes over)", () => {
    const html = focus(court({ stream_link: link() }));
    expect(has(html, "md-cs-link")).toBe(false);
    expect(has(html, "md-cs-band")).toBe(true);
  });

  it("the rule, as a function: the same four answers", () => {
    const ok = { readOnly: false, frozen: false, orgId: "o" };
    expect(canLinkCourt(ok, { stream_link: null })).toBe(true);
    expect(canLinkCourt({ ...ok, readOnly: true }, { stream_link: null })).toBe(false);
    expect(canLinkCourt({ ...ok, frozen: true }, { stream_link: null })).toBe(false);
    expect(canLinkCourt(ok, { stream_link: link() })).toBe(false);
  });
});

describe("the phone's status chip", () => {
  it.each([
    ["unpaired", "No phone yet"],
    ["waiting", "Phone waiting"],
    ["live", "Live"],
    ["offline", "Phone offline"],
  ] as const)("reads %s as %s in the focus and on the court's row", (phone, words) => {
    const c = court({ stream_link: link({ phone }) });
    const html = focus(c);
    expect(html).toMatch(new RegExp(`data-testid="md-cs-chip" data-phone="${phone}"[^>]*>.*?${words}`));
    expect(list([c])).toMatch(new RegExp(`data-testid="md-cs-chip" data-phone="${phone}"[^>]*>.*?${words}`));
  });

  it("is on no row of a court with no link", () => {
    expect(has(list([court()]), "md-cs-chip")).toBe(false);
  });

  it("a live phone is the row's one Live: the match badge does not repeat it, and returns when the phone is not live", () => {
    const streaming = court({ current: fx({ stream: "live" }) });
    expect(list([{ ...streaming, stream_link: link({ phone: "live" }) }]).split('data-md-stream="live"').length - 1).toBe(0);
    expect(list([{ ...streaming, stream_link: link({ phone: "waiting" }) }]).split('data-md-stream="live"').length - 1).toBe(1);
  });

  it("says the channel, how long the link works (the minute before midnight) and a refused automatic start in the stream panel's words", () => {
    const html = focus(court({ stream_link: link({ refusal: "no_credit" }) }));
    expect(html).toContain("Riverside CC on YouTube");
    expect(html).toContain(t(dict, "matchDay.courtStream.until", { time: "23:59" }));
    expect(html).toContain(esc(t(dict, "stream.auto.refused", { reason: t(dict, "stream.auto.refusal.no_credit") })));
  });

  it("names the last minute of the day, not the midnight that would read as already over", () => {
    expect(lastWorkingMinute("2026-11-01T00:00:00.000Z")).toBe("2026-10-31T23:59:00.000Z");
  });
});

describe("the Stream switch", () => {
  const sw = (html: string) => html.match(/<button[^>]*data-testid="md-cs-switch"[^>]*>/g) ?? [];

  it("is on the current match and each queued match of a linked court, off by default, free to turn for a writer", () => {
    const html = focus(court({ stream_link: link(), queue: [queued({ id: "q-1" }), queued({ id: "q-2", court_stream: true })] }));
    const buttons = sw(html);
    expect(buttons).toHaveLength(3);
    expect(buttons.map((b) => /aria-checked="(true|false)"/.exec(b)![1])).toEqual(["false", "false", "true"]);
    for (const b of buttons) {
      expect(b).toContain('role="switch"');
      expect(isDisabled(b)).toBe(false);
    }
    expect(html).toContain(">Stream<");
  });

  it("is locked with the match's own code named, wherever the court is linked", () => {
    const html = focus(court({ stream_link: link(), current: fx({ own_stream_code: true }), queue: [] }));
    expect(isDisabled(sw(html)[0]!)).toBe(true);
    expect(html).toContain("This match has its own stream code");
  });

  it("on a court with no link shows only a switch that is already ON, locked, 'Court not streaming'", () => {
    const html = focus(court({ queue: [queued({ id: "q-1" }), queued({ id: "q-2", court_stream: true })] }));
    const buttons = sw(html);
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toContain('aria-checked="true"');
    expect(isDisabled(buttons[0]!)).toBe(true);
    expect(html).toContain("Court not streaming");
  });

  it("on a court with no link and nothing on shows none", () => {
    expect(count(focus(court()), "md-cs-switch")).toBe(0);
  });

  it("is on a called match as it is on a playing one", () => {
    const html = focus(court({ state: "called", stream_link: link(), current: fx({ called_at: "2026-10-31T11:00:00.000Z", started_at: null }), queue: [] }));
    expect(count(html, "md-cs-switch")).toBe(1);
  });

  it("the rule, as a function (the table in the plan)", () => {
    const f = (court_stream: boolean, own_stream_code = false) => ({ court_stream, own_stream_code });
    expect(switchSpec(f(false), true, true)).toEqual({ on: false, lock: null });
    expect(switchSpec(f(true), true, true)).toEqual({ on: true, lock: null });
    expect(switchSpec(f(false, true), true, true)).toEqual({ on: false, lock: "own_code" });
    expect(switchSpec(f(true), false, true)).toEqual({ on: true, lock: "not_streaming" });
    expect(switchSpec(f(false), false, true)).toBeNull();
    expect(switchSpec(f(false), true, false)).toBeNull();
    expect(switchSpec(f(true), true, false)).toEqual({ on: true, lock: "locked" });
  });

  it("a refused switch is said by the server's own code", () => {
    expect(switchFailureKey("has_own_stream_code")).toBe("matchDay.courtStream.ownCode");
    expect(switchFailureKey("court_not_streaming")).toBe("matchDay.courtStream.notStreaming");
    expect(switchFailureKey("")).toBe("matchDay.refusal.other");
    expect(linkFailureKey("court_already_streaming")).toBe("matchDay.courtStream.alreadyStreaming");
    expect(linkFailureKey("anything else")).toBe("matchDay.refusal.other");
  });
});

// Ruling O14 (2026-11-16, superseding R11): a waiting-to-be-called (candidate) row of a LINKED free court carries the Stream switch, so
// the day's first match is switched on before it is called. Rows are written out from the ruling, not computed by the code under test.
describe("the Stream switch on a waiting-to-be-called (candidate) row", () => {
  const cand = (o: Partial<MatchDayCandidate> = {}, f: Partial<MatchDayFixture> = {}): MatchDayCandidate => ({
    fixture: fx({ id: "k-1", started_at: null, headline: null, ...f }),
    source: "this_court", from_court_name: null, first_in_queue: false, waiting_minutes: 0, behind_minutes: 0, planned_at: null, blocked: null, ...o,
  });
  const free = (o: Partial<MatchDayCourt> = {}) => court({ state: "free", current: null, queue: [], ...o });
  const rows = (c: MatchDayCourt, candidates: MatchDayCandidate[], ctx: MatchDayCtx = baseCtx()) =>
    renderToStaticMarkup(<CandidateRows ctx={ctx} court={c} candidates={candidates} onCall={() => {}} />);
  const sw = (html: string) => html.match(/<button[^>]*data-testid="md-cs-switch"[^>]*>/g) ?? [];

  it("the court's own next match, on a linked court: a switch, off by default, free to turn, beside Call", () => {
    const html = rows(free({ stream_link: link() }), [cand(), cand({}, { id: "k-2", court_stream: true })]);
    const buttons = sw(html);
    expect(buttons).toHaveLength(2);
    expect(buttons.map((b) => /aria-checked="(true|false)"/.exec(b)![1])).toEqual(["false", "true"]);
    for (const b of buttons) expect(isDisabled(b)).toBe(false);
    expect(count(html, "md-candidate")).toBe(2);
  });

  it("on a court with no link a candidate that is off has none; the one switched on shows it locked, 'Court not streaming'", () => {
    expect(count(rows(free(), [cand()]), "md-cs-switch")).toBe(0);
    const html = rows(free(), [cand({}, { court_stream: true })]);
    expect(sw(html)).toHaveLength(1);
    expect(isDisabled(sw(html)[0]!)).toBe(true);
    expect(html).toContain("Court not streaming");
  });

  it("a match that waits on ANOTHER court, or on none, is judged on its own court: no switch to turn on here, an ON one locked", () => {
    const html = rows(free({ stream_link: link() }), [
      cand({ source: "other_court", from_court_name: "Court 9" }, { id: "k-3" }),
      cand({ source: "no_court" }, { id: "k-4" }),
      cand({ source: "no_court" }, { id: "k-5", court_stream: true }),
    ]);
    const buttons = sw(html);
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toContain('aria-checked="true"');
    expect(isDisabled(buttons[0]!)).toBe(true);
  });

  it("its own stream code locks it, naming why; a view-only or frozen desk sees only an ON one, locked", () => {
    const linked = free({ stream_link: link() });
    expect(rows(linked, [cand({}, { own_stream_code: true })])).toContain("This match has its own stream code");
    for (const o of [{ readOnly: true }, { frozen: true }] as const) {
      const html = rows(linked, [cand(), cand({}, { id: "k-2", court_stream: true })], baseCtx(o));
      expect(sw(html)).toHaveLength(1);
      expect(isDisabled(sw(html)[0]!)).toBe(true);
    }
  });

  it("a blocked candidate (a player busy elsewhere) keeps its switch: the intent is the match's, not the call's", () => {
    const html = rows(free({ stream_link: link() }), [cand({ blocked: { kind: "player_busy", person_name: "Zara", court_name: "Court 4" } })]);
    expect(sw(html)).toHaveLength(1);
  });
});

describe("a free court's whole queue (B2: the 2nd and later matches are switched on before the court is called)", () => {
  // Three matches queued on the free court, each with its own pair of names so "appears once" is a count of names.
  const trio = [
    queued({ id: "q-1", home: "Aiko Tan", away: "Bo Wen" }),
    queued({ id: "q-2", home: "Cleo Park", away: "Dev Shah" }),
    queued({ id: "q-3", home: "Esi Boateng", away: "Finn Roy" }),
  ];
  // What the server's candidates hold for such a court: the next ready match per division, "Due here next" (q-1; one division).
  const next = (): MatchDayCandidate => ({
    fixture: trio[0]!, source: "this_court", from_court_name: null, first_in_queue: false, waiting_minutes: 0, behind_minutes: 0,
    planned_at: null, blocked: null,
  });
  const body = (c: MatchDayCourt, load: Parameters<typeof FreeCourtBody>[0]["load"] = { status: "ready", candidates: [next()] }, ctx = baseCtx()) =>
    renderToStaticMarkup(<FreeCourtBody ctx={ctx} court={c} load={load} onCall={() => {}} onRetry={() => {}} />);
  const free = (o: Partial<MatchDayCourt> = {}) => court({ state: "free", current: null, queue: trio, ...o });
  const names = ["Aiko Tan", "Cleo Park", "Esi Boateng"];
  /** How often a match's name is VISIBLE: its switch's accessible name carries it too (`Stream: …`), which is counted apart. */
  const once = (html: string, needle: string): number => html.replace(/aria-label="[^"]*"/g, "").split(needle).length - 1;
  const switchesNamed = (html: string, needle: string): number => html.split(`aria-label="${t(dict, "matchDay.courtStream.switch")}: `).filter((p) => p.startsWith(needle)).length;

  it("a LINKED free court: all three matches appear exactly once, and each carries a Stream switch", () => {
    const html = body(free({ stream_link: link() }));
    for (const n of names) {
      expect(once(html, n), `${n} listed once`).toBe(1);
      expect(switchesNamed(html, n), `${n} has one switch`).toBe(1);
    }
    expect(count(html, "md-candidate")).toBe(1);
    expect(count(html, "md-queue-row")).toBe(2);
    expect(count(html, "md-cs-switch")).toBe(3);
    // the queue keeps its places: the match already shown above is place 1, so the list here starts at 2
    expect(html).toContain(">2</span>");
    expect(html).toContain(">3</span>");
  });

  it("an UNLINKED free court is unchanged: only the next match, no queue, no switch", () => {
    const html = body(free());
    expect(once(html, "Aiko Tan")).toBe(1);
    for (const n of ["Cleo Park", "Esi Boateng"]) expect(html).not.toContain(n);
    expect(count(html, "md-queue-row")).toBe(0);
    expect(count(html, "md-cs-switch")).toBe(0);
  });

  it("while its candidates load, or if they fail, a linked court still lists its queue, and a later load does not repeat it", () => {
    for (const load of [{ status: "loading" }, { status: "failed" }] as const) {
      const html = body(free({ stream_link: link() }), load);
      expect(count(html, "md-queue-row")).toBe(3);
    }
  });

  it("a linked free court whose only queued match is the one the candidates show says nothing more (no empty list)", () => {
    const html = body(free({ stream_link: link(), queue: [trio[0]!] }));
    expect(count(html, "md-queue-row")).toBe(0);
    expect(html).not.toContain(t(dict, "matchDay.queue.title"));
    expect(html).not.toContain(t(dict, "matchDay.queue.empty"));
  });

  it("a view-only reader of a linked free court sees the queue with no switch that is off (only an ON one, locked)", () => {
    const withOn = [trio[0]!, queued({ id: "q-2", home: "Cleo Park", away: "Dev Shah", court_stream: true }), trio[2]!];
    const html = body(free({ stream_link: link(), queue: withOn }), undefined, baseCtx({ readOnly: true }));
    expect(count(html, "md-queue-row")).toBe(2);
    expect(count(html, "md-cs-switch")).toBe(1);
  });
});

describe("the tail countdown (O16: \"Video ends in 12 s\")", () => {
  const NOW = "2026-10-31T12:00:00.000Z";
  const plus = (ms: number): string => new Date(Date.parse(NOW) + ms).toISOString();
  const free = (l: MatchDayCourtStream) => court({ state: "free", current: null, queue: [], stream_link: l });
  const tail = (html: string): string | null => /<span data-testid="md-cs-tail"[^>]*>([^<]*)<\/span>/.exec(html)?.[1] ?? null;
  const focused = (l: MatchDayCourtStream, viewNow: string | undefined = NOW, d: Dict = dict) => focus(free(l), baseCtx({ viewNow }, d));
  const listed = (l: MatchDayCourtStream) =>
    renderToStaticMarkup(
      <CourtList courts={[free(l)]} selectedId={null} dict={dict} words={levelWords(publicEn as Dict)} locale="en" tz="Europe/London" onSelect={() => {}} viewNow={NOW} />,
    );

  it("12 s before the tail ends the focus's status block says 'Video ends in 12 s', in tabular figures", () => {
    const html = focused(link({ tail_ends_at: plus(12_000) }));
    expect(tail(html)).toBe("Video ends in 12 s");
    expect(html).toMatch(/<span data-testid="md-cs-tail"[^>]*class="[^"]*\btabular-nums\b/);
    // inside the court's band, under the link's own lines
    expect(html.indexOf('data-testid="md-cs-status"')).toBeLessThan(html.indexOf('data-testid="md-cs-tail"'));
    expect(html.indexOf('data-testid="md-cs-tail"')).toBeLessThan(html.indexOf('data-testid="md-cs-show"'));
  });

  it("the court's card in the list carries it too", () => {
    expect(tail(listed(link({ tail_ends_at: plus(12_000) })))).toBe("Video ends in 12 s");
    expect(has(listed(link()), "md-cs-tail")).toBe(false);
  });

  it("rounds a part-second UP (0.4 s left still reads 1 s), and counts the tail down second by second", () => {
    expect(tail(focused(link({ tail_ends_at: plus(400) })))).toBe("Video ends in 1 s");
    expect(tail(focused(link({ tail_ends_at: plus(30_000) })))).toBe("Video ends in 30 s");
    expect(tail(focused(link({ tail_ends_at: plus(29_001) })))).toBe("Video ends in 30 s");
    expect(tail(focused(link({ tail_ends_at: plus(29_000) })))).toBe("Video ends in 29 s");
  });

  it("is gone at 0 and after it: the court then reads its normal state", () => {
    expect(has(focused(link({ tail_ends_at: plus(0) })), "md-cs-tail")).toBe(false);
    expect(has(focused(link({ tail_ends_at: plus(-1_000) })), "md-cs-tail")).toBe(false);
    expect(has(listed(link({ tail_ends_at: plus(0) })), "md-cs-tail")).toBe(false);
  });

  it("is gone when the session has ended or the next match started (the server reads tail_ends_at null)", () => {
    expect(has(focused(link({ tail_ends_at: null })), "md-cs-tail")).toBe(false);
    expect(has(listed(link({ tail_ends_at: null })), "md-cs-tail")).toBe(false);
  });

  it("a court with no link has no band and no countdown", () => {
    expect(has(focus(court({ state: "free", current: null, queue: [], stream_link: null }), baseCtx({ viewNow: NOW })), "md-cs-tail")).toBe(false);
  });

  it("with no server instant to anchor to it draws nothing until the page mounts (so the server's markup and the browser's first render agree)", () => {
    expect(has(focus(free(link({ tail_ends_at: plus(12_000) })), baseCtx()), "md-cs-tail")).toBe(false);
  });

  it.each(["es", "fr", "nl"] as const)("speaks %s, with the seconds in place", (locale) => {
    const html = focused(link({ tail_ends_at: plus(12_000) }), NOW, DICTS[locale]);
    const words = tail(html)!;
    expect(words).toContain("12");
    expect(words).not.toBe("Video ends in 12 s");
    expect(words).not.toContain("{seconds}");
  });
});

describe("view-only and frozen desks: the status and nothing that writes", () => {
  const linked = court({ stream_link: link({ phone: "offline" }), queue: [queued({ id: "q-1" }), queued({ id: "q-2", court_stream: true })] });

  it.each([
    ["view-only", { readOnly: true }],
    ["frozen", { frozen: true }],
  ] as const)("%s: the chip, no link, QR or withdraw, and no switch that can be turned", (_name, o) => {
    const html = focus(linked, baseCtx(o));
    expect(has(html, "md-cs-chip")).toBe(true);
    for (const id of ["md-cs-link", "md-cs-show", "md-cs-withdraw"]) expect(has(html, id), id).toBe(false);
    const buttons = html.match(/<button[^>]*data-testid="md-cs-switch"[^>]*>/g) ?? [];
    expect(buttons).toHaveLength(1);
    expect(isDisabled(buttons[0]!)).toBe(true);
    expect(buttons[0]).toContain('aria-checked="true"');
  });

  it("an editor of an unfrozen competition gets Show court QR and Stop streaming, named for the court", () => {
    const html = focus(linked);
    expect(html).toContain(">Show court QR<");
    expect(html).toContain("Stop streaming Court 2");
  });
});

describe("the channel picker", () => {
  const target = (id: string, youtube: StreamTarget["youtube"]): StreamTarget => ({
    id,
    kind: youtube ? "youtube" : "custom",
    label: `Dest ${id}`,
    watchUrl: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    keyHint: null,
    inUse: null,
    youtube,
  } as StreamTarget);
  const yt = { connectionId: "c1", channelId: "UC1", channelTitle: "Riverside Live", privacy: "public", madeForKids: false, status: "connected", liveState: "enabled", termsOutdated: false, openBroadcasts: 0 } as StreamTarget["youtube"];
  const pick = (list: StreamTarget[], d: Dict = dict) =>
    renderToStaticMarkup(<TargetPicker dict={d} state={{ status: "ok", list }} value={null} onChange={() => {}} />);

  it("lists the YouTube channels only", () => {
    const html = pick([target("a", yt), target("b", null)]);
    expect(count(html, "md-cs-target")).toBe(1);
    expect(html).toContain("Dest a");
    expect(html).not.toContain("Dest b");
    expect(html).toContain("YouTube channel");
    expect(youtubeTargets([target("a", yt), target("b", null)])).toHaveLength(1);
  });

  it("with none says why and links the Streaming page to connect one", () => {
    const html = pick([target("b", null)]);
    expect(has(html, "md-cs-youtube-only")).toBe(true);
    expect(html).toContain("A court streams to a connected YouTube channel, one video per match.");
    expect(html).toMatch(/data-testid="md-cs-connect-youtube"[^>]*href="\/streaming"|href="\/streaming"[^>]*data-testid="md-cs-connect-youtube"/);
    expect(html).toContain("Connect YouTube");
    expect(count(html, "md-cs-target")).toBe(0);
  });
});

describe("no hard-coded English", () => {
  const linkedFull = court({ stream_link: link({ refusal: "destination_in_use" }), current: fx({ own_stream_code: true }), queue: [queued({ id: "q-1", court_stream: true })] });
  const keys = [
    "phone.waiting", "until", "withdraw", "show", "switch", "ownCode",
  ] as const;

  it.each(["es", "fr", "nl"] as const)("%s: every court-stream line is that language's, none is the English one", (lang) => {
    const d = DICTS[lang]!;
    const html = focus(linkedFull, baseCtx({ locale: lang, dict: d }, d));
    const vars = { time: "23:59", court: "Court 2" };
    for (const k of keys) {
      const words = t(d, `matchDay.courtStream.${k}`, vars);
      expect(html, `${lang} ${k}`).toContain(esc(words));
      expect(words, `${lang} ${k} is not the English line`).not.toBe(t(dict, `matchDay.courtStream.${k}`, vars));
    }
    for (const english of ["Show court QR", "Stop streaming", "Phone waiting", "Works until", "This match has its own stream code"]) {
      expect(html, `${lang}: ${english}`).not.toContain(english);
    }
    expect(list([{ ...linkedFull }], d)).toContain(esc(t(d, phoneKey("waiting"))));
  });

  it("the Dutch picker and the Dutch link action", () => {
    const d = DICTS.nl!;
    expect(focus(court(), baseCtx({ dict: d }, d))).toContain(esc(t(d, "matchDay.courtStream.link")));
    const none = renderToStaticMarkup(<TargetPicker dict={d} state={{ status: "ok", list: [] }} value={null} onChange={() => {}} />);
    expect(none).toContain(esc(t(d, "matchDay.courtStream.youtubeOnly")));
    expect(none).not.toContain("A court streams to");
  });
});
