// The Arbiter Panel round column, BEFORE a round opens (spec 2026-10-24-arbiter-round-column-design.md §5.4, plan Task 5):
// one block per open-able round with its Open round press, confirmation, notice and pairings; the division-not-started line;
// the empty line with a link to the Fixtures tab; nothing at all when the page said "not here".
//
// Two ways of looking, on purpose. `renderToStaticMarkup` reads what a person would see (copy comes from the English
// dictionary, never typed here; the lede's player count comes from the FIXTURE, never from `owedPlayers`). The hook harness
// (`renderIsland`, no DOM in this workspace) drives the REAL seam: each block's own `useOpenRound`, its reducer and runner,
// with the network doubled at `apiV1` - because a pure view cannot see whether the press it renders is wired to anything
// (AGENTS recurring class 1 and 2).
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import { DictProvider } from "@/components/i18n/dict-provider";
import { ConfirmDialog } from "@/components/v2/confirm-dialog";
import enUi from "@/dictionaries/en/ui.json";
import esUi from "@/dictionaries/es/ui.json";
import frUi from "@/dictionaries/fr/ui.json";
import nlUi from "@/dictionaries/nl/ui.json";
import { CHECKIN_EXTEND_STEP_MINUTES, emptyExtendTally, type CheckinExtendState } from "@/lib/checkin-extend";
import type { Dict, Locale } from "@/lib/i18n-constants";
import { messages } from "@/lib/messages";
import type { ArbiterBoard, ArbiterRound } from "@/lib/arbiter-view";
import { INVITE_WORD_KEYS, type SeatInviteWord } from "@/lib/invite-status";
import type { OpenRoundPairing, OpenRoundResult, OpenRoundView } from "@/lib/open-round";
import { routes } from "@/lib/routes";
import { DEADLINE_AFTER_MS } from "@/server/external-play/window";
import { owedPlayers } from "../../desk/open-round-control";
import { initialOpenRoundUi, type OpenRoundUiState } from "../../desk/open-round-state";
import type { OpenRoundHandle } from "../../desk/use-open-round";
import {
  CheckinHero,
  OpenRoundBlockView,
  RoundColumn,
  WaitingList,
  type CheckinHeroProps,
  type RoundColumnData,
  type RoundColumnProps,
  type WaitingListProps,
} from "../round-column";

const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

type Call = { url: string; json?: unknown; resolve: (v: unknown) => void; reject: (e: unknown) => void };
const net = vi.hoisted(() => ({ calls: [] as Call[] }));
vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return {
    ...actual,
    apiV1: (url: string, options?: { json?: unknown }) =>
      new Promise((resolve, reject) => net.calls.push({ url, json: options?.json, resolve, reject })),
  };
});

const en = messages as unknown as Record<string, string>;
const TZ = "Europe/London";
const SLUGS = { org: "club", comp: "autumn", div: "open" };

const t = (key: string, vars: Record<string, string | number> = {}) =>
  Object.entries(vars).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, String(v)), en[key]!);
const pl = (key: string, n: number, vars: Record<string, string | number> = {}) =>
  Object.entries({ count: n, ...vars }).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, String(v)), en[`${key}.${n === 1 ? "one" : "other"}`]!);
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
const VIEW = (o: Partial<OpenRoundView> = {}): OpenRoundView => ({
  stageId: "s1",
  stageName: "Swiss",
  roundNo: 1,
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
const DATA = (o: Partial<RoundColumnData> = {}): RoundColumnData => ({ views: [], held: [], flagged: [], ownFlagged: 0, tz: TZ, awaitsStart: false, ...o });

/** The handle ArbiterPanel shares for the round ON SCREEN. Every press is a spy: a before-phase block must never use it. */
const sharedHandle = () => {
  const spies = { ask: vi.fn(), cancel: vi.fn(), open: vi.fn(), resend: vi.fn(), extend: vi.fn() };
  const handle: OpenRoundHandle = { state: initialOpenRoundUi(), ...spies };
  return { handle, spies };
};
const COLUMN = (o: Partial<RoundColumnProps> = {}): RoundColumnProps => ({
  round: null,
  requested: null,
  data: DATA(),
  nowMs: null,
  slugs: SLUGS,
  openRound: sharedHandle().handle,
  on: { select: () => {}, extendBoard: () => {} },
  roundExtend: null,
  ...o,
});
// The column mounts the queue, which formats through `useFmt` and so needs a DictProvider (the panel is always inside one).
const underEnglish = (node: ReactNode) => renderToStaticMarkup(<DictProvider dict={enUi as unknown as Dict} locale="en">{node}</DictProvider>);
const column = (o: Partial<RoundColumnProps> = {}) => underEnglish(<RoundColumn {...COLUMN(o)} />);

const NO_ON = { ask: () => {}, cancel: () => {}, open: () => {} };
const block = (view: OpenRoundView, state: Partial<OpenRoundUiState> = {}, showStage = false) =>
  renderToStaticMarkup(<OpenRoundBlockView view={view} state={{ ...initialOpenRoundUi(), ...state }} tz={TZ} showStage={showStage} on={NO_ON} />);

/** A round on screen: the panel's own state, which is not the before phase. */
const ON_SCREEN: ArbiterRound = { stageId: "s1", stageName: "Swiss", roundNo: 1, timeControl: null, boards: [], ownBoards: 0, current: true, extendableBoards: 0 };

// ---- markup probes ---------------------------------------------------------------------------------------------

const ATTR = (testid: string) => `data-testid="${testid}"`;
const count = (h: string, testid: string) => h.split(ATTR(testid)).length - 1;
/** The opening tag of the element carrying a test id, or null. */
const tagOf = (h: string, testid: string): string | null => new RegExp(`<[a-z0-9]+\\b[^>]*${ATTR(testid)}[^>]*>`).exec(h)?.[0] ?? null;
/** The inner markup of the first element whose opening tag contains `attr` (balanced on its own tag name). */
function innerAttr(h: string, attr: string): string | null {
  const open = new RegExp(`<([a-z0-9]+)\\b[^>]*${attr}[^>]*>`).exec(h);
  if (!open) return null;
  const re = new RegExp(`<(/?)${open[1]}\\b[^>]*>`, "g");
  const from = open.index + open[0].length;
  re.lastIndex = from;
  let depth = 1;
  for (let m = re.exec(h); m; m = re.exec(h)) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return h.slice(from, m.index);
  }
  throw new Error(`unbalanced <${open[1]}> for ${attr}`);
}
const inner = (h: string, testid: string): string | null => innerAttr(h, ATTR(testid));
/** The text of the element with this id (an aria-labelledby target); throws when there is none, so a dangling reference is a failure. */
function textOfId(h: string, id: string): string {
  const i = innerAttr(h, ` id="${id}"`);
  if (i === null) throw new Error(`aria-labelledby points at no element: ${id}`);
  return i.replace(/<[^>]*>/g, "");
}
/** The accessible name of an element from its opening tag: its aria-label, else the text of its aria-labelledby targets, in order. */
function nameOf(h: string, tag: string): string {
  const label = /aria-label="([^"]*)"/.exec(tag)?.[1];
  if (label) return label;
  const ids = /aria-labelledby="([^"]*)"/.exec(tag)?.[1];
  return ids ? ids.split(" ").map((id) => textOfId(h, id)).join(" ") : "";
}
const textIn = (h: string, testid: string): string | null => {
  const i = inner(h, testid);
  return i === null ? null : i.replace(/<[^>]*>/g, "");
};
const classOf = (tag: string) => /class="([^"]*)"/.exec(tag)?.[1] ?? "";
const tagsNamed = (h: string, name: string) => [...h.matchAll(new RegExp(`<${name}\\b[^>]*>`, "g"))].map((m) => m[0]);
const SCROLLERS = /<[a-z0-9]+\b[^>]*class="[^"]*\boverflow-(?:x-|y-)?(?:auto|scroll)\b[^"]*"[^>]*>/g;

// ---- the column -------------------------------------------------------------------------------------------------

describe("RoundColumn: phase none and not-before", () => {
  it("phase none (the page said 'not here' or 'you play on it'): renders nothing, whatever there is to open", () => {
    let checked = 0;
    for (const requested of ["unavailable", "own"] as const) {
      expect(column({ requested, data: DATA({ views: [VIEW()] }) }), requested).toBe("");
      checked += 1;
    }
    expect(checked, "anti-vacuity: requests checked").toBe(2);
  });

  it("a round on screen is not the before phase: the playing column, with no before marker, no start line, no empty line and no before-phase press", () => {
    // Tasks 6 and 7 draw the check-in and playing columns. A view waiting to open is still offered while a round plays (as the NEXT
    // round, `arbiter-column-next`); what must not leak is the before branch: its marker, its two empty lines and its press testid.
    const h = column({ round: ON_SCREEN, data: DATA({ views: [VIEW({ roundNo: 2 })] }) });
    expect(h).not.toContain('data-phase="before"');
    expect(h).toContain('data-phase="playing"');
    for (const id of ["arbiter-column-start-first", "arbiter-column-nothing", "arbiter-column-open-cta"]) expect(h, id).not.toContain(ATTR(id));
    expect(count(h, "arbiter-column-next"), "the offered round is the playing phase's next-round press").toBe(1);
  });
});

describe("RoundColumn: before the round opens", () => {
  it("the landmark: an aside named 'This round', in the before phase, one real box placed in track 2 and first on a phone", () => {
    const h = column();
    const root = tagOf(h, "arbiter-round-column")!;
    expect(root).toMatch(/^<aside\b/);
    expect(root).toContain(`aria-label="${esc(en["arbiter.column.label"]!)}"`);
    expect(root).toContain('data-phase="before"');
    // Spec §5.1, the paths with no board grid: the aside is first below md and sits in the second track from md.
    expect(classOf(root)).toMatch(/(^|\s)max-md:order-\[-1\](\s|$)/);
    expect(classOf(root)).toMatch(/(^|\s)md:col-start-2(\s|$)/);
    expect(classOf(root), "row 1 by name: independent of the aside's place in the DOM").toMatch(/(^|\s)md:row-start-1(\s|$)/);
    // A landmark is never display: contents; and a truncating name needs min-w-0 on its ancestors.
    expect(classOf(root)).not.toMatch(/(^|\s)(max-md:|md:)?contents(\s|$)/);
    expect(classOf(root)).toMatch(/(^|\s)min-w-0(\s|$)/);
  });

  it("before, started, nothing to open: the empty line and a link to the Fixtures tab, never to the arbiter route", () => {
    const h = column({ data: DATA({ views: [], awaitsStart: false }) });
    expect(textIn(h, "arbiter-column-nothing")).toBe(esc(`${en["arbiter.column.nothingPaired"]!}${en["arbiter.column.toFixtures"]!}`));
    expect(count(h, "arbiter-column-nothing")).toBe(1);
    const fixtures = routes.division(SLUGS.org, SLUGS.comp, SLUGS.div, "fixtures");
    const hrefs = [...inner(h, "arbiter-column-nothing")!.matchAll(/<a\b[^>]*\bhref="([^"]*)"/g)].map((m) => m[1]);
    expect(hrefs, "exactly one link").toEqual([esc(fixtures)]);
    expect(hrefs[0]).not.toBe(esc(routes.divisionArbiter(SLUGS.org, SLUGS.comp, SLUGS.div)));
    expect(h, "the other empty-state words are absent").not.toContain(ATTR("arbiter-column-start-first"));
    expect(h).not.toContain(ATTR("arbiter-column-open"));
  });

  it("before, not started: the start line wins and the empty line is absent", () => {
    const h = column({ data: DATA({ views: [], awaitsStart: true }) });
    expect(textIn(h, "arbiter-column-start-first")).toBe(esc(en["externalPlay.openRound.startFirst"]!));
    expect(h).not.toContain(ATTR("arbiter-column-nothing"));
    expect(h).not.toContain(en["arbiter.column.nothingPaired"]!);
  });

  it("before, not started: no press is offered even if a view were handed over (the division's start is the organiser's first press)", () => {
    const h = column({ data: DATA({ views: [VIEW()], awaitsStart: true }) });
    expect(h).toContain(ATTR("arbiter-column-start-first"));
    for (const id of ["arbiter-column-open", "arbiter-column-open-cta", "arbiter-column-nothing"]) expect(h, id).not.toContain(ATTR(id));
  });

  it("before, one view: heading, paired lede, Open round, pairings; the lede counts players from the FIXTURE, not from owedPlayers", () => {
    // Board 2 owes one seat and board 3 none, so `owedPlayers` is 3 while the round has 3 boards and 6 seats.
    const view = VIEW({ roundNo: 4, pairings: [P(1), P(2, { owedSeats: 1 }), P(3, { owedSeats: 0 })] });
    expect(owedPlayers(view), "premise: the two counts differ").toBe(3);
    const h = column({ data: DATA({ views: [view] }) });
    expect(count(h, "arbiter-column-open")).toBe(1);
    expect(h).toContain(esc(t("runsheet.round.heading", { round: 4 })));
    expect(h).toContain(esc(pl("runsheet.round.pairedLede", 3, { players: 6 })));
    expect(h, "never the owed count").not.toContain(esc(pl("runsheet.round.pairedLede", 3, { players: 3 })));
    expect(textIn(h, "arbiter-column-open-cta")).toBe(esc(en["runsheet.round.openCta"]!));
    expect(h, "nothing is confirming yet").not.toContain(ATTR("arbiter-column-confirm"));
    const ids = [...h.matchAll(/data-testid="arbiter-column-pairing-([^"]+)"/g)].map((m) => m[1]);
    expect(ids).toEqual(["f1", "f2", "f3"]);
    let named = 0;
    for (const n of [1, 2, 3]) {
      const row = inner(h, `arbiter-column-pairing-f${n}`)!;
      expect(row).toContain(esc(t("arbiter.boardNo", { n })));
      expect(row.indexOf(`White ${n}`), "white first").toBeGreaterThan(-1);
      expect(row.indexOf(`White ${n}`)).toBeLessThan(row.indexOf(`Black ${n}`));
      named += 1;
    }
    expect(named, "anti-vacuity: pairings named").toBe(3);
    expect(h, "the empty and start lines are absent").not.toContain(ATTR("arbiter-column-nothing"));
    expect(h).not.toContain(ATTR("arbiter-column-start-first"));
  });

  it("before, one view of one pairing: the singular lede", () => {
    const h = column({ data: DATA({ views: [VIEW({ pairings: [P(1)] })] }) });
    expect(h).toContain(esc(pl("runsheet.round.pairedLede", 1, { players: 2 })));
  });

  it("before, two stages: each block names its stage; one stage: no stage name", () => {
    const swiss = VIEW({ stageId: "s1", stageName: "Swiss Open", roundNo: 2 });
    const rapid = VIEW({ stageId: "s2", stageName: "Rapid Playoff", roundNo: 5, pairings: [P(7)] });
    const two = column({ data: DATA({ views: [swiss, rapid] }) });
    expect(count(two, "arbiter-column-open")).toBe(2);
    expect(count(two, "arbiter-column-open-cta"), "one press per block").toBe(2);
    // In the reader's order, each stage's name inside its OWN block.
    const blocks = two.split(ATTR("arbiter-column-open") + " ").slice(1);
    expect(blocks[0]).toContain("Swiss Open");
    expect(blocks[0]).not.toContain("Rapid Playoff");
    expect(blocks[1]).toContain("Rapid Playoff");
    expect(blocks[1]).not.toContain("Swiss Open");
    expect(two).toContain(esc(t("arbiter.roundLine", { stage: "Swiss Open", round: 2 })));
    expect(two).toContain(esc(t("arbiter.roundLine", { stage: "Rapid Playoff", round: 5 })));

    const one = column({ data: DATA({ views: [swiss] }) });
    expect(one).not.toContain("Swiss Open");
    expect(one).toContain(esc(t("runsheet.round.heading", { round: 2 })));
    // "More than one STAGE has a view": two views of one stage still name no stage.
    const sameStage = column({ data: DATA({ views: [swiss, VIEW({ stageId: "s1", stageName: "Swiss Open", roundNo: 3 })] }) });
    expect(count(sameStage, "arbiter-column-open")).toBe(2);
    expect(sameStage).not.toContain("Swiss Open");
  });

  it("only views with press 'open' reach the column's blocks: the reader's other presses are not before-phase blocks", () => {
    const h = column({ data: DATA({ views: [VIEW({ press: "none", roundNo: 1 }), VIEW({ press: "open", roundNo: 2 })] }) });
    expect(count(h, "arbiter-column-open")).toBe(1);
    expect(h).toContain(esc(t("runsheet.round.heading", { round: 2 })));
    expect(h).not.toContain(esc(t("runsheet.round.heading", { round: 1 })));
  });
});

describe("RoundColumn: landmark names and the empty-view guard", () => {
  it("two stages that share a round number: each pairings region, and each block, has its own name (landmark-unique)", () => {
    const a = VIEW({ stageId: "s1", stageName: "Swiss Open", roundNo: 2 });
    const b = VIEW({ stageId: "s2", stageName: "Rapid Playoff", roundNo: 2 });
    const h = column({ data: DATA({ views: [a, b] }) });
    const regions = tagsNamed(h, "div").filter((tag) => tag.includes(ATTR("arbiter-column-pairings")));
    expect(regions, "anti-vacuity: both regions drawn").toHaveLength(2);
    const names = regions.map((tag) => nameOf(h, tag));
    expect(new Set(names).size, `distinct names: ${names.join(" | ")}`).toBe(2);
    expect(names[0]).toContain("Swiss Open");
    expect(names[0]).not.toContain("Rapid Playoff");
    expect(names[1]).toContain("Rapid Playoff");
    expect(names[1]).not.toContain("Swiss Open");
    for (const name of names) expect(name).toContain(esc(t("runsheet.round.pairingsLabel", { round: 2 })));
    const sections = tagsNamed(h, "section").map((tag) => nameOf(h, tag));
    expect(new Set(sections).size, `the blocks are distinct too: ${sections.join(" | ")}`).toBe(2);
    // Every id the names point at is unique on the page.
    const ids = [...h.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
    expect(ids.length, "anti-vacuity: ids checked").toBeGreaterThanOrEqual(4);
    expect(new Set(ids).size).toBe(ids.length);

    // One stage: no stage in the name, just the existing words.
    const one = column({ data: DATA({ views: [a] }) });
    expect(nameOf(one, tagOf(one, "arbiter-column-pairings")!)).toBe(esc(t("runsheet.round.pairingsLabel", { round: 2 })));
  });

  it("a view with no pairing is refused: no block and no press, the 'nothing paired' line stands, and its stage is not counted", () => {
    // The reader never sends one (open-round-view.ts skips a group with no playable board), but its type allows it.
    const empty = VIEW({ stageId: "s1", stageName: "Swiss Open", pairings: [] });
    const alone = column({ data: DATA({ views: [empty] }) });
    for (const id of ["arbiter-column-open", "arbiter-column-open-cta"]) expect(alone, id).not.toContain(ATTR(id));
    expect(textIn(alone, "arbiter-column-nothing")).toBe(esc(`${en["arbiter.column.nothingPaired"]!}${en["arbiter.column.toFixtures"]!}`));

    const real = VIEW({ stageId: "s2", stageName: "Rapid Playoff", roundNo: 3 });
    const mixed = column({ data: DATA({ views: [empty, real] }) });
    expect(count(mixed, "arbiter-column-open"), "only the real one draws").toBe(1);
    expect(mixed).not.toContain(ATTR("arbiter-column-nothing"));
    expect(mixed, "one stage has a block, so no stage is named").not.toContain("Rapid Playoff");
    expect(mixed).toContain(esc(t("runsheet.round.heading", { round: 3 })));
  });
});

// ---- the pure block ---------------------------------------------------------------------------------------------

describe("OpenRoundBlockView: state in, markup out", () => {
  it("confirming: OpenRoundConfirmBody with the earlier-in-play line, titled for this round, its button counting the players", () => {
    const view = VIEW({ roundNo: 3, earlierInPlay: [{ roundNo: 2, games: 3 }] });
    const h = block(view, { confirming: true });
    const dialog = inner(h, "arbiter-column-confirm")!;
    expect(dialog, "the confirmation holds the body").not.toBeNull();
    expect(dialog).toContain(ATTR("open-round-earlier"));
    expect(dialog).toContain('data-earlier-round="2"');
    expect(dialog).toContain(esc(pl("runsheet.round.confirmEarlierInPlay", 3, { round: 2 })));
    expect(dialog).toContain(esc(pl("runsheet.round.confirmBody", 6)));
    expect(dialog).toContain(esc(t("runsheet.round.confirmTitle", { round: 3 })));
    expect(textIn(h, "arbiter-column-confirm-confirm")).toBe(esc(pl("runsheet.round.confirmCta", 6)));
    expect(h).toContain(ATTR("arbiter-column-confirm-cancel"));
    // The invitees the press reaches are listed (anti-vacuity: the body is the real one).
    let named = 0;
    for (const n of [1, 2, 3]) {
      expect(dialog).toContain(`White ${n}`);
      named += 1;
    }
    expect(named).toBe(3);
  });

  it("not confirming: no confirmation, and no earlier-in-play line (the empty case)", () => {
    const h = block(VIEW({ earlierInPlay: [{ roundNo: 2, games: 3 }] }), { confirming: false });
    expect(h).not.toContain(ATTR("arbiter-column-confirm"));
    expect(h).not.toContain(ATTR("open-round-earlier"));
  });

  it("idle: the CTA is enabled and not busy", () => {
    const cta = tagOf(block(VIEW()), "arbiter-column-open-cta")!;
    expect(cta).not.toContain('disabled=""');
    expect(cta).not.toContain("aria-busy");
  });

  it("busy: the CTA is disabled and busy (a double click sends one POST)", () => {
    const cta = tagOf(block(VIEW(), { busy: { kind: "open" } }), "arbiter-column-open-cta")!;
    expect(cta).toContain('disabled=""');
    expect(cta).toContain('aria-busy="true"');
  });

  it("busy while confirming: the confirmation's own button is held too", () => {
    const h = block(VIEW(), { confirming: true, busy: { kind: "open" } });
    expect(tagOf(h, "arbiter-column-confirm-confirm")).toContain('disabled=""');
    expect(tagOf(h, "arbiter-column-confirm-cancel")).toContain('disabled=""');
    const idle = block(VIEW(), { confirming: true });
    expect(tagOf(idle, "arbiter-column-confirm-confirm")).not.toContain('disabled=""');
  });

  it("already_open notice: a press from a page made stale by an open elsewhere reads 'already open' and invites nobody", () => {
    const result: OpenRoundResult = { opened: false, reason: "already_open", skipped: [] };
    const h = block(VIEW(), { notice: { kind: "answered", result } });
    expect(tagOf(h, "arbiter-column-open-notice")).toContain('role="status"');
    expect(textIn(h, "arbiter-column-open-notice")).toBe(esc(en["externalPlay.openRound.alreadyOpen"]!));
    expect(h, "invited nobody: no count").not.toContain(esc(pl("externalPlay.openRound.invited", 0)));
  });

  it("no notice: the notice region is absent (the empty case)", () => {
    expect(block(VIEW())).not.toContain(ATTR("arbiter-column-open-notice"));
  });

  it("an open that reached some boards: the server's player count, then each skipped board by its number and reason; a failure by its code", () => {
    const result: OpenRoundResult = { opened: true, invited: 4, retrying: 0, skipped: [{ fixtureId: "f2", reason: "send_failed" }] };
    const h = block(VIEW(), { notice: { kind: "answered", result } });
    const skip = t("runsheet.round.skipLine", { board: t("arbiter.boardNo", { n: 2 }), reason: en["externalPlay.openRound.skipped.sendFailed"]! });
    expect(textIn(h, "arbiter-column-open-notice")).toBe(esc(`${pl("externalPlay.openRound.invited", 4)}${skip}`));
    const failed = block(VIEW(), { notice: { kind: "failed", code: "ROUND_CHANGED" } });
    expect(textIn(failed, "arbiter-column-open-notice")).toBe(esc(en["runsheet.round.err.roundChanged"]!));
  });

  it("a view the reader says has no Open press (press not 'open') offers no press and no confirmation, even if asked", () => {
    let checked = 0;
    for (const press of ["none", "reopen", "reinvite"] as const) {
      const h = block(VIEW({ press }), { confirming: true });
      expect(h, press).not.toContain(ATTR("arbiter-column-open-cta"));
      expect(h, press).not.toContain(ATTR("arbiter-column-confirm"));
      expect(h, press).toContain(ATTR("arbiter-column-pairings"));
      checked += 1;
    }
    expect(checked, "anti-vacuity: presses checked").toBe(3);
  });

  it("each control is bound to ITS press: the CTA asks, the confirmation opens, its cancel cancels (handlers, not markup)", () => {
    // A static render cannot see an onClick (AGENTS class 2), so the pure view is mounted in the hook harness with spied presses.
    const on = { ask: vi.fn(), cancel: vi.fn(), open: vi.fn() };
    const mount = (state: Partial<OpenRoundUiState>) =>
      renderIsland(OpenRoundBlockView, { view: VIEW(), state: { ...initialOpenRoundUi(), ...state }, tz: TZ, showStage: false, on }).tree();
    const idle = mount({});
    const cta = idle.filter((n) => propsOf(n)["data-testid"] === "arbiter-column-open-cta");
    expect(cta, "one press").toHaveLength(1);
    (propsOf(cta[0]!).onClick as () => void)();
    expect([on.ask.mock.calls.length, on.open.mock.calls.length, on.cancel.mock.calls.length], "the CTA only asks").toEqual([1, 0, 0]);
    expect(propsOf(cta[0]!).disabled).toBe(false);

    const dialogs = (tree: ReactElement[]) => [...new Set(tree.filter((n) => n.type === ConfirmDialog))];
    expect(propsOf(dialogs(idle)[0]!).open, "closed until asked").toBe(false);
    const confirming = dialogs(mount({ confirming: true }));
    expect(confirming).toHaveLength(1);
    const d = propsOf(confirming[0]!);
    expect(d.open).toBe(true);
    expect(d.testId).toBe("arbiter-column-confirm");
    on.ask.mockClear();
    (d.onConfirm as () => void)();
    expect([on.ask.mock.calls.length, on.open.mock.calls.length, on.cancel.mock.calls.length], "confirm only opens").toEqual([0, 1, 0]);
    on.open.mockClear();
    (d.onCancel as () => void)();
    expect([on.ask.mock.calls.length, on.open.mock.calls.length, on.cancel.mock.calls.length], "cancel only cancels").toEqual([0, 0, 1]);

    const busy = mount({ busy: { kind: "open" } }).filter((n) => propsOf(n)["data-testid"] === "arbiter-column-open-cta");
    expect(propsOf(busy[0]!).disabled, "busy holds the press").toBe(true);
  });

  it("every control in the column is at least 44px tall", () => {
    const view = VIEW();
    const surfaces = [
      block(view, { confirming: true, notice: { kind: "answered", result: { opened: false, reason: "already_open", skipped: [] } } }),
      column({ data: DATA({ views: [view] }) }),
      column({ data: DATA({ views: [] }) }),
    ];
    const controls = surfaces.flatMap((h) => [...tagsNamed(h, "button"), ...tagsNamed(h, "a")]);
    // The block alone has the press and the confirmation's two buttons; the column adds one press; the empty line one link.
    expect(controls.length, "anti-vacuity: controls checked").toBe(5);
    for (const tag of controls) expect(classOf(tag), tag).toMatch(/(^|\s)min-h-11(\s|$)/);
  });

  it("the pairings list scrolls, so it is reachable: focusable, a region, named; and no scroller in the block is left unreachable", () => {
    // The build scrolls its pairings (a long round must not push the notice off the page), so the other branch - a list with
    // no overflow at all - is the one asserted ABSENT: the pairings container IS the scroller.
    const view = VIEW({ roundNo: 6 });
    const h = block(view, { confirming: true });
    const list = tagOf(h, "arbiter-column-pairings")!;
    expect(classOf(list)).toMatch(/(^|\s)overflow-y-auto(\s|$)/);
    expect(list).toContain('tabindex="0"');
    expect(list).toContain('role="region"');
    expect(nameOf(h, list)).toBe(esc(t("runsheet.round.pairingsLabel", { round: 6 })));
    // AGENTS class 23: every scroller in the markup (this list, and the confirmation's invitee list) is focusable and named.
    const scrollers = h.match(SCROLLERS) ?? [];
    expect(scrollers.length, "anti-vacuity: scrollers checked (pairings + invitees)").toBeGreaterThanOrEqual(2);
    for (const tag of scrollers) {
      expect(tag, tag).toContain('tabindex="0"');
      expect(nameOf(h, tag).length, `named: ${tag}`).toBeGreaterThan(0);
    }
  });

  it("a pairing's names wrap (break-words, never truncated) and min-w-0 runs down the whole chain: block, region, list, row, names", () => {
    const long = "A".repeat(43);
    const h = block(VIEW({ pairings: [P(1, { whiteName: long, blackName: long })] }));
    const names = /<span\b[^>]*data-field="names"[^>]*>/.exec(inner(h, "arbiter-column-pairing-f1")!)?.[0];
    expect(names, "the names span").toBeDefined();
    const MINW = /(^|\s)min-w-0(\s|$)/;
    const chain: [string, string | undefined][] = [
      ["block", tagOf(h, "arbiter-column-open") ?? undefined],
      ["region", tagOf(h, "arbiter-column-pairings") ?? undefined],
      ["list", /<ul\b[^>]*>/.exec(inner(h, "arbiter-column-pairings")!)?.[0]],
      ["row", tagOf(h, "arbiter-column-pairing-f1") ?? undefined],
      ["names", names],
    ];
    for (const [name, tag] of chain) expect(classOf(tag ?? ""), name).toMatch(MINW);
    expect(chain.length, "anti-vacuity: links checked").toBe(5);
    expect(classOf(names!)).toMatch(/(^|\s)break-words(\s|$)/);
    expect(classOf(names!), "wraps, does not truncate").not.toMatch(/(^|\s)truncate(\s|$)/);
    expect(h.split(long).length - 1, "both 43-character names are in the markup in full").toBe(2);
  });
});

// ---- the wiring: each block's own handle, through the real hook, reducer and runner -----------------------------

const flush = () => new Promise((r) => setTimeout(r, 0));
type BlockProps = { state: OpenRoundUiState; on: { ask(): void; cancel(): void; open(): void }; view: OpenRoundView };
/** The wrapper elements RoundColumn mounts per view: the only elements it renders that carry a `view` and are not the pure view. */
const wrappers = (tree: ReactElement[]) => [...new Set(tree.filter((n) => n.type !== OpenRoundBlockView && typeof n.type === "function" && propsOf(n).view !== undefined))];
/** Mount one wrapper as its own island (its own hooks), and read what it hands the pure view. */
function mountBlock(el: ReactElement) {
  const island = renderIsland(el.type as (p: Record<string, unknown>) => ReactNode, propsOf(el));
  const read = () => propsOf(island.tree().find((n) => n.type === OpenRoundBlockView)!) as unknown as BlockProps;
  return { read };
}

describe("RoundColumn: each block presses its OWN round (the seam, through the real hook)", () => {
  beforeEach(() => {
    net.calls.length = 0;
    router.refresh.mockReset();
  });

  const S1 = VIEW({ stageId: "s1", stageName: "Swiss", roundNo: 2 });
  const S2 = VIEW({ stageId: "s2", stageName: "Rapid", roundNo: 5, pairings: [P(7), P(8)] });

  it("the empty case first: nothing asked, nothing sent", () => {
    const { handle } = sharedHandle();
    const ui = renderIsland(RoundColumn, COLUMN({ data: DATA({ views: [S1, S2] }), openRound: handle }));
    const blocks = wrappers(ui.tree());
    expect(blocks, "anti-vacuity: one wrapper per view").toHaveLength(2);
    for (const b of blocks) expect(mountBlock(b).read().state.confirming).toBe(false);
    expect(net.calls).toHaveLength(0);
  });

  it("Open round only ASKS; the confirmation sends ONE open-round for this block's stage and round; a double press sends nothing more", async () => {
    const { handle, spies } = sharedHandle();
    const ui = renderIsland(RoundColumn, COLUMN({ data: DATA({ views: [S1, S2] }), openRound: handle }));
    const [a, b] = wrappers(ui.tree()).map(mountBlock) as [ReturnType<typeof mountBlock>, ReturnType<typeof mountBlock>];

    a.read().on.ask();
    expect(a.read().state.confirming, "asked").toBe(true);
    expect(b.read().state.confirming, "the other block is its own round").toBe(false);
    expect(net.calls, "asking sends nothing").toHaveLength(0);

    a.read().on.open();
    a.read().on.open();
    expect(net.calls.map((c) => [c.url, c.json])).toEqual([["/api/v1/stages/s1/open-round", { roundNo: 2 }]]);
    expect(a.read().state.busy).toEqual({ kind: "open" });

    // A press from a page made stale by an open elsewhere: the server's answer is "already open".
    const answer: OpenRoundResult = { opened: false, reason: "already_open", skipped: [] };
    net.calls[0]!.resolve(answer);
    await flush();
    expect(a.read().state.busy).toBeNull();
    expect(a.read().state.confirming, "answered: the confirmation closes").toBe(false);
    expect(a.read().state.notice).toEqual({ kind: "answered", result: answer });
    expect(router.refresh).toHaveBeenCalledTimes(1);
    expect(b.read().state.notice, "the other block heard nothing").toBeNull();

    // The shared handle is the round ON SCREEN's; a before-phase block must not borrow it.
    for (const [name, spy] of Object.entries(spies)) expect(spy, name).not.toHaveBeenCalled();
  });

  it("the second block presses its own stage and round, not the first's", () => {
    const ui = renderIsland(RoundColumn, COLUMN({ data: DATA({ views: [S1, S2] }) }));
    const b = mountBlock(wrappers(ui.tree())[1]!);
    expect(b.read().view.stageId).toBe("s2");
    b.read().on.ask();
    b.read().on.open();
    expect(net.calls.map((c) => [c.url, c.json])).toEqual([["/api/v1/stages/s2/open-round", { roundNo: 5 }]]);
  });

  it("Cancel closes the confirmation and sends nothing", () => {
    const ui = renderIsland(RoundColumn, COLUMN({ data: DATA({ views: [S1] }) }));
    const a = mountBlock(wrappers(ui.tree())[0]!);
    a.read().on.ask();
    a.read().on.cancel();
    expect(a.read().state.confirming).toBe(false);
    expect(net.calls).toHaveLength(0);
  });
});

// ---- another locale ---------------------------------------------------------------------------------------------

describe("the column under another locale: every word comes from that dictionary", () => {
  const fill = (s: string, vars: Record<string, string | number>) => Object.entries(vars).reduce((acc, [k, v]) => acc.replaceAll(`{${k}}`, String(v)), s);
  const under = (dict: Dict, locale: Locale, node: ReactNode) => renderToStaticMarkup(<DictProvider dict={dict} locale={locale}>{node}</DictProvider>);

  it.each([["es", esUi], ["fr", frUi], ["nl", nlUi]] as [Locale, Dict][])("%s: block, confirmation, landmark and empty line are that locale's, not English", (locale, dict) => {
    const d = dict as unknown as Record<string, string>;
    const view = VIEW({ roundNo: 4 }); // 3 boards, 6 players
    const state = { ...initialOpenRoundUi(), confirming: true };
    const h = under(dict, locale, <OpenRoundBlockView view={view} state={state} tz={TZ} showStage={false} on={NO_ON} />);
    const expected = {
      lede: fill(d["runsheet.round.pairedLede.other"]!, { count: 3, players: 6 }),
      cta: d["runsheet.round.openCta"]!,
      heading: fill(d["runsheet.round.heading"]!, { round: 4 }),
      caption: fill(d["runsheet.round.pairingsLabel"]!, { round: 4 }),
      board: fill(d["arbiter.boardNo"]!, { n: 1 }),
      title: fill(d["runsheet.round.confirmTitle"]!, { round: 4 }),
      confirm: fill(d["runsheet.round.confirmCta.other"]!, { count: 6 }),
      cancel: d["confirm.cancel"]!,
    };
    for (const [what, text] of Object.entries(expected)) expect(h, `${locale} ${what}`).toContain(esc(text));
    // Premise: these really differ from the English, so containing them proves the locale was used.
    expect(expected.lede).not.toBe(pl("runsheet.round.pairedLede", 3, { players: 6 }));
    expect(expected.cta).not.toBe(en["runsheet.round.openCta"]);
    expect(h).not.toContain(esc(en["runsheet.round.openCta"]!));
    expect(h).not.toContain(esc(pl("runsheet.round.pairedLede", 3, { players: 6 })));
    expect(Object.keys(expected).length, "anti-vacuity: words checked").toBe(8);

    const col = under(dict, locale, <RoundColumn {...COLUMN()} />);
    expect(tagOf(col, "arbiter-round-column")).toContain(`aria-label="${esc(d["arbiter.column.label"]!)}"`);
    expect(textIn(col, "arbiter-column-nothing")).toBe(esc(`${d["arbiter.column.nothingPaired"]!}${d["arbiter.column.toFixtures"]!}`));
  });
});

// ---- copy -------------------------------------------------------------------------------------------------------

describe("the column's own keys, in four locales", () => {
  const KEYS = ["arbiter.column.label", "arbiter.column.nothingPaired", "arbiter.column.toFixtures"] as const;
  // Spec §9 is the authority for the English.
  const SPEC_EN: Record<(typeof KEYS)[number], string> = {
    "arbiter.column.label": "This round",
    "arbiter.column.nothingPaired": "No round is paired yet. Pair the next round on the Fixtures tab.",
    "arbiter.column.toFixtures": "Go to Fixtures",
  };
  // No em dash and no arrow in a dictionary string the column renders (built from code points, never typed).
  const BANNED = [0x2014, 0x2192, 0x2190, 0x2197].map((c) => String.fromCharCode(c));
  const locales: [string, Record<string, unknown>][] = [["en", enUi], ["es", esUi], ["fr", frUi], ["nl", nlUi]];

  it("English is the spec's; es, fr and nl are real translations (not the English copied); none carries a dash or an arrow", () => {
    let checked = 0;
    for (const [locale, dict] of locales) {
      for (const key of KEYS) {
        const v = dict[key];
        expect(typeof v, `${locale} ${key}`).toBe("string");
        expect((v as string).length, `${locale} ${key}`).toBeGreaterThan(0);
        if (locale === "en") expect(v).toBe(SPEC_EN[key]);
        else expect(v, `${locale} ${key} is translated`).not.toBe(SPEC_EN[key]);
        for (const ch of BANNED) expect(v as string, `${locale} ${key}`).not.toContain(ch);
        checked += 1;
      }
    }
    expect(checked, "anti-vacuity: 3 keys x 4 locales").toBe(12);
  });
});

// ==== CHECK-IN: the hero and the waiting list (plan Task 6, spec §5.3) ===========================================================
//
// Fixtures first. Every window is by offset from NOW, so the edges are exact. A board's snapshot `refusal` is what the server said
// when the page was read; the clock-dependent tests choose it to DIFFER from the live reading where that is the point.

const NOW = Date.parse("2026-10-24T12:00:00.000Z");
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
const win = (from: number, to: number, over: Partial<CheckinExtendState> = {}): CheckinExtendState => ({
  canExtend: true,
  refusal: null,
  extensionsLeft: 3,
  opensAt: iso(NOW + from),
  deadlineAt: iso(NOW + to),
  ...over,
});
/** Opened ten minutes ago, closes in `closesIn` minutes. */
const OPEN = (closesIn = 8) => win(-10 * MIN, closesIn * MIN);
/** A later group: opens `opensIn` minutes from now. */
const AHEAD = (opensIn = 15) => win(opensIn * MIN, (opensIn + 10) * MIN, { canExtend: false, refusal: "not_open" });
const seat = (here: boolean, invites: SeatInviteWord[] = []) => ({ here, invites });

let nextBoard = 0;
function board(o: Partial<ArbiterBoard> = {}): ArbiterBoard {
  nextBoard += 1;
  return {
    fixtureId: `fx-${nextBoard}`,
    fixtureNo: nextBoard,
    boardNo: nextBoard,
    white: { name: `Wendy ${nextBoard}`, personId: null },
    black: { name: `Blake ${nextBoard}`, personId: null },
    state: { kind: "checking_in" },
    clock: null,
    cameraPolicy: "off",
    videoOverridden: false,
    cameraReport: null,
    sides: { home: { state: "none", endedAt: null, evidenceAt: null }, away: { state: "none", endedAt: null, evidenceAt: null } },
    canResync: false,
    playable: true,
    canSettle: false,
    whiteSide: "home",
    tiebreakOwed: false,
    noResultOffer: { kind: "void" },
    checkin: null,
    seats: null,
    flags: [],
    ...o,
  };
}
/** A checking_in board in `window` with its two seats. */
const checking = (window: CheckinExtendState | null, white: ReturnType<typeof seat> | null, black: ReturnType<typeof seat> | null, o: Partial<ArbiterBoard> = {}) =>
  board({ state: { kind: "checking_in" }, checkin: window, seats: white && black ? { white, black } : null, ...o });
const playing = (o: Partial<ArbiterBoard> = {}) => board({ state: { kind: "live", moveNo: 3 }, ...o });
const ROUND = (boards: ArbiterBoard[], o: Partial<ArbiterRound> = {}): ArbiterRound => ({ ...ON_SCREEN, boards, ...o });
const checkinColumn = (boards: ArbiterBoard[], o: Partial<RoundColumnProps> = {}) => column({ round: ROUND(boards), nowMs: NOW, ...o });

const clockOf = (h: string) => ({
  kind: /data-kind="([^"]*)"/.exec(tagOf(h, "arbiter-checkin-clock") ?? "")?.[1] ?? null,
  text: textIn(h, "arbiter-checkin-clock"),
});
const progressbarTag = (h: string) => /<div\b[^>]*role="progressbar"[^>]*>/.exec(h)?.[0] ?? null;

describe("RoundColumn: the check-in hero", () => {
  it("the landmark: the same aside in the check-in phase, holding the hero and NOT the waiting list", () => {
    const h = checkinColumn([checking(OPEN(), seat(true), seat(false))]);
    expect(tagOf(h, "arbiter-round-column")).toContain('data-phase="checkin"');
    expect(count(h, "arbiter-checkin-hero")).toBe(1);
    // The waiting list is placed by the panel in the board group (C9), never inside the column.
    expect(h).not.toContain(ATTR("arbiter-waiting"));
    for (const id of ["arbiter-column-open", "arbiter-column-start-first", "arbiter-column-nothing"]) expect(h, id).not.toContain(ATTR(id));
    const hero = tagOf(h, "arbiter-checkin-hero")!;
    expect(hero).toMatch(/^<section\b/);
    expect(nameOf(h, hero)).toBe(esc(t("runsheet.round.heading", { round: ON_SCREEN.roundNo })));
  });

  it("hero, empty tally: no board in an open window prints no '0 of 0' and no bar, and the clock still says when the next group opens", () => {
    const h = checkinColumn([checking(AHEAD(15), seat(true), seat(true))]);
    expect(count(h, "arbiter-checkin-hero")).toBe(1);
    expect(h).not.toContain(ATTR("arbiter-checkin-tally"));
    expect(progressbarTag(h)).toBeNull();
    expect(h).not.toContain(pl("arbiter.column.checkin.tally", 0, { count: 0, total: 0 }));
    expect(h).not.toMatch(/\b0 of 0\b/);
    expect(clockOf(h).kind).toBe("opens");
    // And past its deadline (no window open, none to come): the same absence, the clock says closed.
    const closed = checkinColumn([checking(win(-20 * MIN, -1 * MIN, { canExtend: false, refusal: "closed" }), seat(false), seat(false))]);
    expect(closed).not.toContain(ATTR("arbiter-checkin-tally"));
    expect(progressbarTag(closed)).toBeNull();
    expect(clockOf(closed).kind).toBe("closed");
  });

  it("hero clock: closes / opens / closed, one string each, from the dictionary", () => {
    // One board whose window is [NOW + 10 min, NOW + 20 min).
    const boards = [checking(win(10 * MIN, 20 * MIN), seat(false), seat(false))];
    const at = (offsetMs: number) => clockOf(checkinColumn(boards, { nowMs: NOW + offsetMs }));
    const before = at(0);
    expect(before.kind).toBe("opens");
    expect(before.text).toBe(`${esc(en["arbiter.column.checkin.opensIn"]!)}10:00`);
    const inside = at(10 * MIN);
    expect(inside.kind).toBe("closes");
    expect(inside.text).toBe(`${esc(en["arbiter.column.checkin.closesIn"]!)}10:00`);
    expect(at(15 * MIN + 30_000).text, "counts down: 04:30 left").toBe(`${esc(en["arbiter.column.checkin.closesIn"]!)}04:30`);
    const after = at(20 * MIN);
    expect(after.kind).toBe("closed");
    expect(after.text, "closed: the label alone, no digits").toBe(esc(en["arbiter.column.checkin.closed"]!));
    // One string each: the three labels are three different sentences.
    const labels = ["arbiter.column.checkin.closesIn", "arbiter.column.checkin.opensIn", "arbiter.column.checkin.closed"].map((k) => en[k]);
    expect(new Set(labels).size, "anti-vacuity: three distinct strings").toBe(3);
    // A running clock is a timer a screen reader is not made to read every second.
    const h = checkinColumn(boards, { nowMs: NOW + 12 * MIN });
    const timer = /<[a-z]+\b[^>]*role="timer"[^>]*>/.exec(h)?.[0];
    expect(timer, "digits are a timer").toBeDefined();
    expect(timer).not.toContain("aria-live");
  });

  it("clock edges: at deadlineAt - 1 ms 'closes', at deadlineAt 'closed'; at opensAt - 1 ms 'opens', at opensAt 'closes' (Review Focus 3)", () => {
    const boards = [checking(win(10 * MIN, 20 * MIN), seat(false), seat(false))];
    const at = (offsetMs: number) => clockOf(checkinColumn(boards, { nowMs: NOW + offsetMs }));
    const deadline = 20 * MIN;
    expect(at(deadline - 1)).toEqual({ kind: "closes", text: `${esc(en["arbiter.column.checkin.closesIn"]!)}00:01` });
    expect(at(deadline)).toEqual({ kind: "closed", text: esc(en["arbiter.column.checkin.closed"]!) });
    const opens = 10 * MIN;
    expect(at(opens - 1)).toEqual({ kind: "opens", text: `${esc(en["arbiter.column.checkin.opensIn"]!)}00:01` });
    expect(at(opens)).toEqual({ kind: "closes", text: `${esc(en["arbiter.column.checkin.closesIn"]!)}10:00` });
  });

  it("a later group opening the instant the first closes: the clock hands over without a gap and without a 'closed'", () => {
    const boards = [checking(win(-10 * MIN, 5 * MIN), seat(false), seat(false)), checking(win(5 * MIN, 15 * MIN), seat(false), seat(false))];
    const at = (offsetMs: number) => clockOf(checkinColumn(boards, { nowMs: NOW + offsetMs }));
    expect(at(5 * MIN - 1).text).toBe(`${esc(en["arbiter.column.checkin.closesIn"]!)}00:01`);
    expect(at(5 * MIN)).toEqual({ kind: "closes", text: `${esc(en["arbiter.column.checkin.closesIn"]!)}10:00` });
  });

  it("before mount (nowMs null): no digits and no timer, but the label stays - read from the snapshot", () => {
    const open = checkinColumn([checking(OPEN(), seat(false), seat(false))], { nowMs: null });
    expect(clockOf(open)).toEqual({ kind: "closes", text: esc(en["arbiter.column.checkin.closesIn"]!) });
    expect(open).not.toContain('role="timer"');
    const ahead = checkinColumn([checking(AHEAD(), seat(false), seat(false))], { nowMs: null });
    expect(clockOf(ahead)).toEqual({ kind: "opens", text: esc(en["arbiter.column.checkin.opensIn"]!) });
    const closed = checkinColumn([checking(win(-20 * MIN, -1 * MIN, { canExtend: false, refusal: "closed" }), seat(false), seat(false))], { nowMs: null });
    expect(clockOf(closed)).toEqual({ kind: "closed", text: esc(en["arbiter.column.checkin.closed"]!) });
    // The tally reads the same snapshot, so the first paint does not disagree with itself.
    expect(open).toContain(ATTR("arbiter-checkin-tally"));
  });

  it("the countdown is the column's one large element: Barlow tabular digits at text-3xl, text-4xl from lg, in Ink", () => {
    const h = checkinColumn([checking(OPEN(), seat(false), seat(false))]);
    const digits = /<[a-z]+\b[^>]*role="timer"[^>]*>/.exec(h)![0];
    const cls = classOf(digits);
    for (const re of [/(^|\s)tabular-nums(\s|$)/, /(^|\s)text-3xl(\s|$)/, /(^|\s)lg:text-4xl(\s|$)/, /(^|\s)text-\[#2e1065\](\s|$)/]) expect(cls, String(re)).toMatch(re);
    expect(cls).toContain("--font-barlow");
  });

  it("hero tally: 3 of 4 players checked in, and the progress bar says the same", () => {
    const boards = [
      checking(OPEN(), seat(true), seat(false)),
      checking(OPEN(), seat(true), seat(true)),
      // A later group's seats are not in the denominator, here or not.
      checking(AHEAD(), seat(true), seat(true)),
    ];
    const h = checkinColumn(boards);
    expect(textIn(h, "arbiter-checkin-tally")).toBe(esc(pl("arbiter.column.checkin.tally", 4, { count: 3, total: 4 })));
    const bar = progressbarTag(h)!;
    expect(bar).toContain('aria-valuenow="3"');
    expect(bar).toContain('aria-valuemax="4"');
    expect(bar).toContain('aria-valuemin="0"');
    expect(bar, "named by the tally line it repeats").toContain('aria-labelledby="');
    expect(nameOf(h, bar)).toBe(esc(pl("arbiter.column.checkin.tally", 4, { count: 3, total: 4 })));
    expect(h).toContain("width:75%");
  });

  it("the tally's plural follows the TOTAL, not the count: 1 of 2 is 'players', and the singular needs a total of 1", () => {
    const h = checkinColumn([checking(OPEN(), seat(true), seat(false))]);
    expect(textIn(h, "arbiter-checkin-tally")).toBe(esc(pl("arbiter.column.checkin.tally", 2, { count: 1, total: 2 })));
    expect(textIn(h, "arbiter-checkin-tally"), "not the singular a count of 1 would pick").not.toBe(esc(pl("arbiter.column.checkin.tally", 1, { count: 1, total: 2 })));
    expect(en["arbiter.column.checkin.tally.other"]).toContain("players");
  });

  it("nobody here yet: '0 of 4' IS printed (the empty tally is 0 of 0, not 0 of 4), the bar is empty", () => {
    const h = checkinColumn([checking(OPEN(), seat(false), seat(false)), checking(OPEN(), seat(false), seat(false))]);
    expect(textIn(h, "arbiter-checkin-tally")).toBe(esc(pl("arbiter.column.checkin.tally", 4, { count: 0, total: 4 })));
    expect(progressbarTag(h)).toContain('aria-valuenow="0"');
    expect(h).toContain("width:0%");
  });

  it("everyone here: the bar is full", () => {
    const h = checkinColumn([checking(OPEN(), seat(true), seat(true))]);
    expect(textIn(h, "arbiter-checkin-tally")).toBe(esc(pl("arbiter.column.checkin.tally", 2, { count: 2, total: 2 })));
    expect(h).toContain("width:100%");
  });

  it("already playing: 2 boards; a held board is not counted; the finished clause shows only above zero", () => {
    const held = board({ state: { kind: "on_hold" } });
    const base = [checking(OPEN(), seat(true), seat(false)), playing(), board({ state: { kind: "starting" } }), held];
    const h = checkinColumn(base);
    expect(textIn(h, "arbiter-checkin-playing")).toBe(esc(pl("arbiter.column.alreadyPlaying", 2)));
    expect(h, "no finished board, no finished clause").not.toContain(ATTR("arbiter-checkin-finished"));
    const one = checkinColumn([...base, board({ state: { kind: "result", score: "1-0", noResult: false } })]);
    expect(textIn(one, "arbiter-checkin-finished")).toBe(esc(pl("arbiter.column.finished", 1)));
    expect(textIn(one, "arbiter-checkin-playing"), "a result is not playing").toBe(esc(pl("arbiter.column.alreadyPlaying", 2)));
    const two = checkinColumn([...base, board({ state: { kind: "result", score: "1-0", noResult: false } }), board({ state: { kind: "result", score: null, noResult: true } })]);
    expect(textIn(two, "arbiter-checkin-finished")).toBe(esc(pl("arbiter.column.finished", 2)));
  });

  it("a zero clause is never printed: no board playing means no 'already playing' line, a held board alone does not make one", () => {
    const only = checkinColumn([checking(OPEN(), seat(true), seat(false)), board({ state: { kind: "on_hold" } })]);
    expect(only).not.toContain(ATTR("arbiter-checkin-playing"));
    expect(only).not.toContain(ATTR("arbiter-checkin-finished"));
    expect(only).not.toContain(esc(pl("arbiter.column.alreadyPlaying", 0)));
    expect(only).not.toContain(esc(pl("arbiter.column.finished", 0)));
    // No clause, no empty box either: a blank flex child would still cost a row gap in the hero.
    expect(only, "no empty wrapper").not.toMatch(/<div class="[^"]*"><\/div>/);
    // Each clause is its own: a finished board alone does not print "0 boards already playing".
    const finishedOnly = checkinColumn([checking(OPEN(), seat(true), seat(false)), board({ state: { kind: "result", score: "1-0", noResult: false } })]);
    expect(textIn(finishedOnly, "arbiter-checkin-finished")).toBe(esc(pl("arbiter.column.finished", 1)));
    expect(finishedOnly).not.toContain(ATTR("arbiter-checkin-playing"));
    expect(finishedOnly).not.toContain(esc(pl("arbiter.column.alreadyPlaying", 0)));
  });

  it("the round's +5 is the node it is given, once; the column adds no arbiter-extend-round element of its own", () => {
    const standIn = <div data-testid="stand-in-round-extend">+5</div>;
    const h = checkinColumn([checking(OPEN(), seat(true), seat(false))], { roundExtend: standIn });
    expect(count(h, "stand-in-round-extend")).toBe(1);
    expect(inner(h, "arbiter-checkin-hero"), "inside the hero").toContain(ATTR("stand-in-round-extend"));
    expect(h).not.toContain("arbiter-extend-round");
    const none = checkinColumn([checking(OPEN(), seat(true), seat(false))], { roundExtend: null });
    expect(none).not.toContain("stand-in-round-extend");
    expect(none).not.toContain("arbiter-extend-round");
  });

  it("reinvite press shows only for press reinvite or reopen (and only when the round has a view)", () => {
    const boards = [checking(OPEN(), seat(false), seat(false))];
    const pairings = [P(1, { owedSeats: 2 }), P(2, { owedSeats: 1 })]; // 3 players owed
    const reinvite = checkinColumn(boards, { data: DATA({ views: [VIEW({ state: "open", press: "reinvite", pairings })] }) });
    expect(textIn(reinvite, "arbiter-column-reinvite")).toBe(esc(pl("runsheet.round.inviteCta", 3)));
    const reopen = checkinColumn(boards, { data: DATA({ views: [VIEW({ state: "open", press: "reopen", pairings })] }) });
    expect(textIn(reopen, "arbiter-column-reinvite")).toBe(esc(en["runsheet.round.openCta"]!));
    let absent = 0;
    for (const press of ["none", "open"] as const) {
      const h = checkinColumn(boards, { data: DATA({ views: [VIEW({ state: "open", press, pairings })] }) });
      expect(h, press).not.toContain(ATTR("arbiter-column-reinvite"));
      absent += 1;
    }
    expect(checkinColumn(boards, { data: DATA({ views: [] }) }), "no view").not.toContain(ATTR("arbiter-column-reinvite"));
    expect(checkinColumn(boards, { data: DATA({ views: [VIEW({ roundNo: 9, state: "open", press: "reinvite", pairings })] }) }), "another round's view").not.toContain(ATTR("arbiter-column-reinvite"));
    expect(absent, "anti-vacuity: refusing presses checked").toBe(2);
  });

  it("the reinvite press is quiet (not the primary fill) and 44px", () => {
    const h = checkinColumn([checking(OPEN(), seat(false), seat(false))], { data: DATA({ views: [VIEW({ state: "open", press: "reinvite" })] }) });
    const cls = classOf(tagOf(h, "arbiter-column-reinvite")!);
    expect(cls).toMatch(/(^|\s)min-h-11(\s|$)/);
    expect(cls, "secondary: no violet fill").not.toContain("bg-[#7c3aed]");
  });

  it("staggered: the groups, 'Boards 1 to 8', with opens and closes; there is no dash in the markup", () => {
    const batches = [
      { fromBoard: 1, toBoard: 8, offsetMs: 0, opensAt: iso(NOW - 10 * MIN), closesAt: iso(NOW + 8 * MIN) },
      { fromBoard: 9, toBoard: 16, offsetMs: 5 * MIN, opensAt: iso(NOW + 5 * MIN), closesAt: iso(NOW + 23 * MIN) },
      { fromBoard: 17, toBoard: 17, offsetMs: 10 * MIN, opensAt: iso(NOW + 10 * MIN), closesAt: iso(NOW + 28 * MIN) },
    ];
    const view = VIEW({ state: "open", press: "none", staggered: true, batches });
    const h = checkinColumn([checking(OPEN(), seat(true), seat(false))], { data: DATA({ views: [view] }) });
    const list = inner(h, "arbiter-column-batches")!;
    expect(list, "the batches are drawn").not.toBeNull();
    const rows = [...list.matchAll(/data-testid="arbiter-column-batch-(\d+)"/g)].map((m) => m[1]);
    expect(rows).toEqual(["0", "1", "2"]);
    // Europe/London on 2026-10-24 is still BST (+1): 12:00Z is 13:00.
    const row = (i: number) => (inner(h, `arbiter-column-batch-${i}`) ?? "").replace(/<[^>]*>/g, "");
    expect(row(0)).toBe(`${t("arbiter.column.batchBoards", { from: 1, to: 8 })}${t("runsheet.round.batchOpens", { time: "12:50" })}${t("runsheet.round.batchCloses", { time: "13:08" })}`);
    expect(row(1)).toContain(t("arbiter.column.batchBoards", { from: 9, to: 16 }));
    expect(row(1)).toContain(t("runsheet.round.batchOpens", { time: "13:05" }));
    expect(row(1)).toContain(t("runsheet.round.batchCloses", { time: "13:23" }));
    expect(row(2), "a group of one is a single board, not 'Boards 17 to 17'").toContain(t("arbiter.boardNo", { n: 17 }));
    expect(row(2)).not.toContain(t("arbiter.column.batchBoards", { from: 17, to: 17 }));
    expect(tagOf(h, "arbiter-column-batch-1")).toContain(`data-opens-at="${iso(NOW + 5 * MIN)}"`);
    // No dash of any kind in the column's markup, and none in the copy it reads.
    for (const code of [0x2013, 0x2014, 0x2192, 0x2190, 0x2197]) expect(h, `U+${code.toString(16)}`).not.toContain(String.fromCharCode(code));
    expect(en["arbiter.column.batchBoards"]).toBe("Boards {from} to {to}");
  });

  it("one group, a reopened round, or a group with a hole in its times: no group list (the single deadline stands)", () => {
    const boards = [checking(OPEN(), seat(true), seat(false))];
    const two = [
      { fromBoard: 1, toBoard: 8, offsetMs: 0, opensAt: iso(NOW - 10 * MIN), closesAt: iso(NOW + 8 * MIN) },
      { fromBoard: 9, toBoard: 16, offsetMs: 5 * MIN, opensAt: iso(NOW + 5 * MIN), closesAt: iso(NOW + 23 * MIN) },
    ];
    const cases: [string, OpenRoundView][] = [
      ["not staggered", VIEW({ state: "open", staggered: false, batches: two })],
      ["one batch", VIEW({ state: "open", staggered: true, batches: [two[0]!] })],
      ["reopen", VIEW({ state: "open", press: "reopen", staggered: true, batches: two })],
      ["a hole", VIEW({ state: "open", staggered: true, batches: [two[0]!, { ...two[1]!, closesAt: null }] })],
    ];
    for (const [name, view] of cases) expect(checkinColumn(boards, { data: DATA({ views: [view] }) }), name).not.toContain(ATTR("arbiter-column-batches"));
    expect(checkinColumn(boards, { data: DATA({ views: [VIEW({ state: "open", press: "none", staggered: true, batches: two })] }) }), "positive pair").toContain(ATTR("arbiter-column-batches"));
  });
});

// ---- the hero as a pure view: what its controls are bound to ---------------------------------------------------------

describe("CheckinHero: the reinvite press is the SHARED handle's, with its confirmation and answer", () => {
  const boards = [checking(OPEN(), seat(false), seat(false))];
  const props = (press: OpenRoundView["press"], state: Partial<OpenRoundUiState> = {}, spies = sharedHandle().spies): CheckinHeroProps => ({
    round: ROUND(boards),
    view: VIEW({ state: "open", press, pairings: [P(1, { owedSeats: 2 }), P(2, { owedSeats: 1 })] }),
    tz: TZ,
    nowMs: NOW,
    openRound: { state: { ...initialOpenRoundUi(), ...state }, ...spies },
    roundExtend: null,
  });
  const html = (p: CheckinHeroProps) => renderToStaticMarkup(<CheckinHero {...p} />);

  it("RoundColumn hands the hero the handle it was given (the round on screen's), not one of its own", () => {
    const { handle } = sharedHandle();
    const ui = renderIsland(RoundColumn, COLUMN({ round: ROUND(boards), nowMs: NOW, openRound: handle }));
    const heroEls = ui.tree().filter((n) => n.type === CheckinHero);
    expect(heroEls, "anti-vacuity: the hero is mounted once").toHaveLength(1);
    expect(propsOf(heroEls[0]!).openRound).toBe(handle);
  });

  it("the press ASKS; the confirmation opens and cancels through the handle; nothing is sent by the press", () => {
    const { spies } = sharedHandle();
    const tree = renderIsland(CheckinHero, props("reinvite", {}, spies)).tree();
    const press = tree.filter((n) => propsOf(n)["data-testid"] === "arbiter-column-reinvite");
    expect(press).toHaveLength(1);
    (propsOf(press[0]!).onClick as () => void)();
    expect([spies.ask.mock.calls.length, spies.open.mock.calls.length, spies.cancel.mock.calls.length, spies.resend.mock.calls.length]).toEqual([1, 0, 0, 0]);

    const dialogs = (state: Partial<OpenRoundUiState>) => [...new Set(renderIsland(CheckinHero, props("reinvite", state, spies)).tree().filter((n) => n.type === ConfirmDialog))];
    expect(propsOf(dialogs({})[0]!).open, "closed until asked").toBe(false);
    const d = propsOf(dialogs({ confirming: true })[0]!);
    expect(d.open).toBe(true);
    spies.ask.mockClear();
    (d.onConfirm as () => void)();
    expect([spies.ask.mock.calls.length, spies.open.mock.calls.length, spies.cancel.mock.calls.length], "confirm only opens").toEqual([0, 1, 0]);
    spies.open.mockClear();
    (d.onCancel as () => void)();
    expect([spies.ask.mock.calls.length, spies.open.mock.calls.length, spies.cancel.mock.calls.length], "cancel only cancels").toEqual([0, 0, 1]);
  });

  it("busy: the press is disabled and busy; the confirmation is held", () => {
    const h = html(props("reinvite", { busy: { kind: "open" } }));
    expect(tagOf(h, "arbiter-column-reinvite")).toContain('disabled=""');
    expect(tagOf(h, "arbiter-column-reinvite")).toContain('aria-busy="true"');
    const idle = html(props("reinvite"));
    expect(tagOf(idle, "arbiter-column-reinvite")).not.toContain('disabled=""');
    expect(tagOf(idle, "arbiter-column-reinvite")).not.toContain("aria-busy");
    // A resend in flight on a row holds the round's press too (R1: one request at a time).
    expect(tagOf(html(props("reinvite", { busy: { kind: "resend", fixtureId: "f1" } })), "arbiter-column-reinvite")).toContain('disabled=""');
  });

  it("the confirmation is the run sheet's: titled and labelled for reinvite, or for reopen; its body is OpenRoundConfirmBody", () => {
    const re = html(props("reinvite", { confirming: true }));
    const dialog = inner(re, "arbiter-column-reinvite-dialog")!;
    expect(dialog).toContain(esc(t("runsheet.round.confirmTitleReinvite", { round: ON_SCREEN.roundNo })));
    expect(textIn(re, "arbiter-column-reinvite-dialog-confirm")).toBe(esc(pl("runsheet.round.inviteCta", 3)));
    expect(dialog).toContain(esc(pl("runsheet.round.confirmBodyReinvite", 3)));
    const reopen = html(props("reopen", { confirming: true }));
    expect(inner(reopen, "arbiter-column-reinvite-dialog")).toContain(esc(t("runsheet.round.confirmTitleReopen", { round: ON_SCREEN.roundNo })));
    expect(textIn(reopen, "arbiter-column-reinvite-dialog-confirm")).toBe(esc(pl("runsheet.round.confirmCta", 3)));
    // The empty case: nothing asked, no dialog; and a press the reader refuses never opens one, even if state says confirming.
    expect(html(props("reinvite"))).not.toContain(ATTR("arbiter-column-reinvite-dialog"));
    expect(html(props("none", { confirming: true }))).not.toContain(ATTR("arbiter-column-reinvite-dialog"));
  });

  it("the answer to the press stands under it: a status line from the run sheet's own words", () => {
    const result: OpenRoundResult = { opened: true, invited: 3, retrying: 0, skipped: [] };
    const h = html(props("reinvite", { notice: { kind: "answered", result } }));
    expect(tagOf(h, "arbiter-column-reinvite-notice")).toContain('role="status"');
    expect(textIn(h, "arbiter-column-reinvite-notice")).toBe(esc(pl("externalPlay.openRound.invited", 3)));
    expect(html(props("reinvite"))).not.toContain(ATTR("arbiter-column-reinvite-notice"));
    // A successful reinvite leaves nobody owed, so the reader's press flips to none - and the answer must still be on screen.
    const flipped = html(props("none", { notice: { kind: "answered", result } }));
    expect(flipped).not.toContain(ATTR("arbiter-column-reinvite"));
    expect(textIn(flipped, "arbiter-column-reinvite-notice")).toBe(esc(pl("externalPlay.openRound.invited", 3)));
  });
});

// ---- the waiting list ------------------------------------------------------------------------------------------------

const WL = (o: Partial<WaitingListProps> = {}): WaitingListProps => ({
  boards: [],
  view: null,
  openRound: sharedHandle().handle,
  nowMs: NOW,
  on: { select: () => {}, extendBoard: () => {} },
  ...o,
});
const wl = (o: Partial<WaitingListProps> = {}) => renderToStaticMarkup(<WaitingList {...WL(o)} />);
const rowOf = (h: string, fixtureId: string) => innerAttr(h, `data-testid="arbiter-waiting-row" data-fixture-id="${fixtureId}"`);
const seatOf = (rowHtml: string, colour: "white" | "black") => innerAttr(rowHtml, `data-testid="arbiter-seat" data-colour="${colour}"`);
const seatTag = (rowHtml: string, colour: "white" | "black") =>
  new RegExp(`<[a-z]+\\b[^>]*data-testid="arbiter-seat" data-colour="${colour}"[^>]*>`).exec(rowHtml)?.[0] ?? null;
const chipsOf = (seatHtml: string) => [...seatHtml.matchAll(/<span\b[^>]*data-testid="arbiter-invite-word"[^>]*>/g)].map((m) => m[0]);

describe("WaitingList: who is not here", () => {
  it("empty case first: every open-window seat here means no list, no heading, no help line", () => {
    expect(wl({ boards: [checking(OPEN(), seat(true), seat(true))] })).toBe("");
    expect(wl({ boards: [] })).toBe("");
    // A board whose seats are not here but whose window has not opened is not waited on either (A6).
    expect(wl({ boards: [checking(AHEAD(), seat(false), seat(false))] })).toBe("");
    // A game under way is not waited on, whatever its seats say.
    expect(wl({ boards: [playing({ checkin: OPEN(), seats: { white: seat(false), black: seat(false) } })] })).toBe("");
    const h = wl({ boards: [checking(OPEN(), seat(true), seat(false))] });
    expect(h, "positive pair: one seat not here is a list").toContain(ATTR("arbiter-waiting"));
    expect(h).toContain(ATTR("arbiter-invite-help"));
  });

  it("a later group's board is not in the waiting list before its window opens (A6), and it joins when it opens", () => {
    const now = checking(OPEN(), seat(true), seat(false));
    const later = checking(AHEAD(15), seat(false), seat(false));
    const h = wl({ boards: [now, later] });
    expect([...h.matchAll(/data-testid="arbiter-waiting-row" data-fixture-id="([^"]+)"/g)].map((m) => m[1])).toEqual([now.fixtureId]);
    expect(h).not.toContain(later.fixtureId);
    expect(textIn(h, "arbiter-waiting-heading")).toBe(esc(pl("arbiter.column.waiting", 1)));
    // At the later group's opening (+15 min) the first board's window has already closed (+8 min), so the list now holds the later
    // group alone: the earlier board leaves it at its deadline as the later one joins at its opening.
    const opened = wl({ boards: [now, later], nowMs: NOW + 15 * MIN });
    expect([...opened.matchAll(/data-testid="arbiter-waiting-row" data-fixture-id="([^"]+)"/g)].map((m) => m[1])).toEqual([later.fixtureId]);
  });

  it("waiting seat not here: 'Not here yet' and one chip per invite word; seat here: 'Here' and no invite chip", () => {
    const b = checking(OPEN(), seat(false, ["sent", "bounced"]), seat(true, ["delivered"]));
    const h = wl({ boards: [b] });
    const row = rowOf(h, b.fixtureId)!;
    expect(row).toContain(esc(t("arbiter.boardNo", { n: b.boardNo })));
    const white = seatOf(row, "white")!;
    expect(seatTag(row, "white")).toContain('data-here="false"');
    expect(white).toContain(esc(b.white.name));
    expect(white).toContain(esc(en["arbiter.column.notHereYet"]!));
    expect(white).not.toContain(`>${esc(en["arbiter.column.here"]!)}<`);
    expect(chipsOf(white).map((c) => /data-word="([^"]*)"/.exec(c)?.[1])).toEqual(["sent", "bounced"]);
    const black = seatOf(row, "black")!;
    expect(seatTag(row, "black")).toContain('data-here="true"');
    expect(black).toContain(esc(b.black.name));
    expect(black).toContain(esc(en["arbiter.column.here"]!));
    expect(black).not.toContain(esc(en["arbiter.column.notHereYet"]!));
    expect(chipsOf(black), "a seat that is here shows no invite chip, whatever its words say").toHaveLength(0);
    // The colour word names the seat.
    expect(white).toContain(esc(en["arbiter.colour.white"]!));
    expect(black).toContain(esc(en["arbiter.colour.black"]!));
  });

  it("every invite word, one chip, its own words and its own colour pair (spec section 4)", () => {
    // The pairs are the spec's table, typed here once: violet for sent/delivered, amber for delayed, red for bounced/not delivered,
    // a neutral outline for not invited. The words are the engine's list (INVITE_WORD_KEYS), swept, not retyped.
    const PAIRS: Record<SeatInviteWord, { bg: string | null; fg: string }> = {
      sent: { bg: "bg-[#f3effc]", fg: "text-[#5b21b6]" },
      delivered: { bg: "bg-[#f3effc]", fg: "text-[#5b21b6]" },
      delayed: { bg: "bg-[#fef3c7]", fg: "text-[#713f12]" },
      bounced: { bg: "bg-[#fef2f2]", fg: "text-[#b42318]" },
      not_delivered: { bg: "bg-[#fef2f2]", fg: "text-[#b42318]" },
      not_invited: { bg: null, fg: "text-[#4a3a6b]" },
    };
    const words = Object.keys(INVITE_WORD_KEYS) as SeatInviteWord[];
    expect(Object.keys(PAIRS).sort(), "the table covers the declared words").toEqual([...words].sort());
    let checked = 0;
    for (const word of words) {
      const b = checking(OPEN(), seat(false, [word]), seat(true));
      const chips = chipsOf(seatOf(rowOf(wl({ boards: [b] }), b.fixtureId)!, "white")!);
      expect(chips, word).toHaveLength(1);
      const chip = chips[0]!;
      expect(chip).toContain(`data-word="${word}"`);
      const cls = classOf(chip);
      expect(cls, word).toContain(PAIRS[word].fg);
      if (PAIRS[word].bg !== null) expect(cls, word).toContain(PAIRS[word].bg!);
      else {
        expect(cls, "not invited: an outline, not a tinted fill").toMatch(/(^|\s)border(\s|$)/);
        expect(cls).not.toMatch(/bg-\[#(f3effc|fef3c7|fef2f2)\]/);
      }
      const text = textIn(wl({ boards: [b] }), "arbiter-invite-word");
      expect(text, word).toBe(esc(en[INVITE_WORD_KEYS[word]]!));
      checked += 1;
    }
    expect(checked, "anti-vacuity: six words").toBe(6);
    // 'Not here yet' is amber (the presence chip), the same pair as 'Delayed'.
    const h = wl({ boards: [checking(OPEN(), seat(false), seat(true))] });
    const cls = classOf(/<[a-z]+\b[^>]*data-field="presence"[^>]*>/.exec(h)![0]);
    expect(cls).toContain("bg-[#fef3c7]");
    expect(cls).toContain("text-[#713f12]");
  });

  it("'Here' is a live dot plus the word, never colour alone", () => {
    const h = wl({ boards: [checking(OPEN(), seat(true), seat(false))] });
    const white = seatOf(rowOf(h, /data-fixture-id="([^"]+)"/.exec(h)![1]!)!, "white")!;
    expect(white).toContain(esc(en["arbiter.column.here"]!));
    expect(white).toContain("bg-[#4ade80]");
    expect(white, "the dot is decoration: the word carries it").toContain('aria-hidden="true"');
  });

  it("a seat with no invite words (the loader could not read its mail) shows 'Not here yet' and no chip, and does not crash", () => {
    const b = checking(OPEN(), seat(false, []), seat(false, []));
    const row = rowOf(wl({ boards: [b] }), b.fixtureId)!;
    expect(chipsOf(row)).toHaveLength(0);
    expect(row.split(esc(en["arbiter.column.notHereYet"]!)).length - 1).toBe(2);
  });

  it("a seat skipped at open (no row, not stamped) is visible on the list with its 'Not invited' chip", () => {
    const b = checking(OPEN(), seat(false, ["not_invited"]), seat(false, ["delivered"]));
    const row = rowOf(wl({ boards: [b] }), b.fixtureId)!;
    const chip = chipsOf(seatOf(row, "white")!);
    expect(chip).toHaveLength(1);
    expect(chip[0]).toContain('data-word="not_invited"');
    expect(textIn(wl({ boards: [b] }), "arbiter-waiting")).toContain(esc(en["runsheet.round.notInvited"]!));
    // The same key the run sheet uses, not a second copy.
    expect(INVITE_WORD_KEYS.not_invited).toBe("runsheet.round.notInvited");
  });

  it("a board whose seats are null is listed too: both seats 'Not here yet', no chips - and the tally's denominator equals what the list shows", () => {
    // Open-window boards: A both here (the list does not show it), B one here, C seats unknown (null). 6 seats, 3 here.
    const a = checking(OPEN(), seat(true), seat(true));
    const b = checking(OPEN(), seat(true), seat(false, ["sent"]));
    const c = checking(OPEN(), null, null);
    const later = checking(AHEAD(), seat(true), seat(true));
    const boards = [a, b, c, later];
    const list = wl({ boards });
    const rowsListed = [...list.matchAll(/data-testid="arbiter-waiting-row" data-fixture-id="([^"]+)"/g)].map((m) => m[1]);
    expect(rowsListed).toEqual([b.fixtureId, c.fixtureId]);
    const rowC = rowOf(list, c.fixtureId)!;
    expect(rowC.split(esc(en["arbiter.column.notHereYet"]!)).length - 1, "both seats of the null board").toBe(2);
    expect(chipsOf(rowC)).toHaveLength(0);
    expect(list.split('data-here="false"').length - 1).toBe(3);

    const hero = checkinColumn(boards);
    const max = Number(/aria-valuemax="(\d+)"/.exec(progressbarTag(hero)!)![1]);
    const now = Number(/aria-valuenow="(\d+)"/.exec(progressbarTag(hero)!)![1]);
    expect([now, max], "from the fixtures: 3 open-window boards, 3 seats here").toEqual([3, 6]);
    const notHereListed = list.split('data-here="false"').length - 1;
    expect(notHereListed + now, "the denominator = seats not here (listed) + seats here (counted)").toBe(max);
  });

  it("rows keep board order, and the heading counts the boards listed", () => {
    const b1 = checking(OPEN(), seat(false), seat(false));
    const b2 = checking(OPEN(), seat(true), seat(false));
    const b3 = checking(OPEN(), seat(true), seat(true));
    const b4 = checking(OPEN(), seat(false), seat(true));
    const h = wl({ boards: [b1, b2, b3, b4] });
    expect([...h.matchAll(/data-testid="arbiter-waiting-row" data-fixture-id="([^"]+)"/g)].map((m) => m[1])).toEqual([b1.fixtureId, b2.fixtureId, b4.fixtureId]);
    expect(textIn(h, "arbiter-waiting-heading")).toBe(esc(pl("arbiter.column.waiting", 3)));
    const landmark = tagsNamed(h, "section").find((tag) => tag.includes(ATTR("arbiter-waiting")))!;
    expect(nameOf(h, landmark)).toBe(esc(pl("arbiter.column.waiting", 3)));
  });

  it("before mount (nowMs null): the snapshot's window stands, so the first paint lists the same boards", () => {
    const open = checking(OPEN(), seat(true), seat(false));
    const ahead = checking(AHEAD(), seat(false), seat(false));
    const h = wl({ boards: [open, ahead], nowMs: null });
    expect([...h.matchAll(/data-testid="arbiter-waiting-row" data-fixture-id="([^"]+)"/g)].map((m) => m[1])).toEqual([open.fixtureId]);
  });
});

describe("WaitingList: Resend", () => {
  const owned = (b: ArbiterBoard, canResend: boolean) => P(b.boardNo, { fixtureId: b.fixtureId, canResend });

  it("Resend shows only when the view says canResend; a seat that is Not delivered offers none, and the hero offers the round's press instead (C4)", () => {
    const stamped = checking(OPEN(), seat(false, ["delivered"]), seat(true));
    const released = checking(OPEN(), seat(false, ["not_delivered"]), seat(true));
    const view = VIEW({ state: "open", press: "reinvite", pairings: [owned(stamped, true), owned(released, false)] });
    const list = wl({ boards: [stamped, released], view });
    const resends = [...list.matchAll(/<button\b[^>]*data-testid="arbiter-waiting-resend"[^>]*>/g)].map((m) => m[0]);
    expect(resends, "anti-vacuity: one Resend, on one row").toHaveLength(1);
    expect(resends[0]).toContain(`data-fixture-id="${stamped.fixtureId}"`);
    expect(inner(list, "arbiter-waiting-resend")).toBe(esc(en["runsheet.round.resend"]!));
    expect(rowOf(list, stamped.fixtureId)).toContain(ATTR("arbiter-waiting-resend"));
    expect(rowOf(list, released.fixtureId), "the released seat has no Resend").not.toContain(ATTR("arbiter-waiting-resend"));
    expect(rowOf(list, released.fixtureId), "but it does say why it is waiting").toContain('data-word="not_delivered"');
    // The hero offers the round's press for it.
    const hero = checkinColumn([stamped, released], { data: DATA({ views: [view] }) });
    expect(hero).toContain(ATTR("arbiter-column-reinvite"));
  });

  it("no view for the round: no Resend on any row (the guard), and the rows are still listed", () => {
    const a = checking(OPEN(), seat(false, ["sent"]), seat(false));
    const b = checking(OPEN(), seat(false, ["delayed"]), seat(true));
    const h = wl({ boards: [a, b], view: null });
    expect(count(h, "arbiter-waiting-row"), "anti-vacuity: rows listed").toBe(2);
    expect(h).not.toContain(ATTR("arbiter-waiting-resend"));
    // A view that does not carry the board's pairing offers none for that board either.
    const noPairing = wl({ boards: [a, b], view: VIEW({ state: "open", press: "reinvite", pairings: [] }) });
    expect(count(noPairing, "arbiter-waiting-row")).toBe(2);
    expect(noPairing).not.toContain(ATTR("arbiter-waiting-resend"));
  });

  it("a Resend in flight holds every Resend (R1: one request at a time), and the answer stays on its own row", () => {
    const a = checking(OPEN(), seat(false, ["sent"]), seat(true));
    const b = checking(OPEN(), seat(false, ["sent"]), seat(true));
    const view = VIEW({ state: "open", press: "reinvite", pairings: [owned(a, true), owned(b, true)] });
    const idle = wl({ boards: [a, b], view });
    for (const tag of idle.match(/<button\b[^>]*data-testid="arbiter-waiting-resend"[^>]*>/g) ?? []) expect(tag).not.toContain('disabled=""');
    const busy = wl({ boards: [a, b], view, openRound: { ...sharedHandle().handle, state: { ...initialOpenRoundUi(), busy: { kind: "resend", fixtureId: a.fixtureId } } } });
    const tags = busy.match(/<button\b[^>]*data-testid="arbiter-waiting-resend"[^>]*>/g) ?? [];
    expect(tags, "anti-vacuity: both Resends drawn").toHaveLength(2);
    for (const tag of tags) expect(tag).toContain('disabled=""');
    expect(tags.find((tag) => tag.includes(a.fixtureId)), "the one in flight says so").toContain('aria-busy="true"');
    expect(tags.find((tag) => tag.includes(b.fixtureId))).not.toContain("aria-busy");

    const answered = wl({
      boards: [a, b],
      view,
      openRound: { ...sharedHandle().handle, state: { ...initialOpenRoundUi(), rowNotice: { fixtureId: a.fixtureId, notice: { kind: "resent", emailed: 1, retrying: 0 } } } },
    });
    expect(rowOf(answered, a.fixtureId)).toContain(esc(pl("runsheet.round.resent", 1)));
    expect(rowOf(answered, b.fixtureId), "the other row heard nothing").not.toContain('role="status"');
    expect(tagOf(answered, "arbiter-waiting-notice")).toContain('role="status"');
    // A refusal reads in the run sheet's words, too.
    const refused = wl({
      boards: [a],
      view,
      openRound: { ...sharedHandle().handle, state: { ...initialOpenRoundUi(), rowNotice: { fixtureId: a.fixtureId, notice: { kind: "failed", code: "WINDOW_CLOSED" } } } },
    });
    expect(textIn(refused, "arbiter-waiting-notice")).toBe(esc(en["externalPlay.resend.windowClosed"]!));
  });
});

describe("WaitingList: the row's +5 follows the live clock (C14)", () => {
  const extendTags = (h: string) => [...h.matchAll(/<button\b[^>]*data-testid="arbiter-waiting-extend"[^>]*>/g)].map((m) => m[0]);

  it("inside the window the row's +5 shows with its fixture id and presses left; at deadlineAt it is gone", () => {
    const b = checking(OPEN(8), seat(true), seat(false));
    const deadline = NOW + 8 * MIN;
    const inside = wl({ boards: [b], nowMs: deadline - 1 });
    const tags = extendTags(inside);
    expect(tags, "inside: one +5").toHaveLength(1);
    expect(tags[0]).toContain(`data-fixture-id="${b.fixtureId}"`);
    expect(inner(inside, "arbiter-waiting-extend")).toBe(esc(t("externalPlay.checkinExtend.board", { minutes: CHECKIN_EXTEND_STEP_MINUTES, left: 3 })));
    const atDeadline = wl({ boards: [b], nowMs: deadline });
    expect(extendTags(atDeadline), "at deadlineAt: no +5").toHaveLength(0);
    expect(atDeadline, "and the row left the list with its window").not.toContain(ATTR("arbiter-waiting-row"));
  });

  it("the gate is the LIVE reading, never the snapshot's canExtend: a stale 'not open' snapshot inside the window still offers it", () => {
    // The page was read before the window opened (canExtend false, refusal not_open); the clock is now inside it.
    const stale = checking(win(-2 * MIN, 8 * MIN, { canExtend: false, refusal: "not_open" }), seat(true), seat(false));
    expect(extendTags(wl({ boards: [stale], nowMs: NOW }))).toHaveLength(1);
  });

  it("...and the other way: a snapshot that says canExtend, on a board with no presses left, offers none (the row stays)", () => {
    const capped = checking(win(-10 * MIN, 8 * MIN, { canExtend: true, refusal: null, extensionsLeft: 0 }), seat(true), seat(false));
    const h = wl({ boards: [capped], nowMs: NOW });
    expect(h, "the row is still listed").toContain(ATTR("arbiter-waiting-row"));
    expect(extendTags(h)).toHaveLength(0);
    // With neither a Resend (no view) nor a +5, the row draws no actions box at all.
    expect(h, "no empty actions wrapper").not.toMatch(/<div class="[^"]*"><\/div>/);
  });

  it("before mount (nowMs null) the snapshot's word stands: offered when it says so, absent when it does not", () => {
    const offered = checking(OPEN(), seat(true), seat(false));
    const capped = checking(win(-10 * MIN, 8 * MIN, { canExtend: false, refusal: "cap_reached", extensionsLeft: 0 }), seat(true), seat(false));
    expect(extendTags(wl({ boards: [offered], nowMs: null }))).toHaveLength(1);
    expect(extendTags(wl({ boards: [capped], nowMs: null }))).toHaveLength(0);
  });
});

describe("WaitingList: the help line", () => {
  it("is the list's last line and says Delivered is not read", () => {
    const h = wl({ boards: [checking(OPEN(), seat(false, ["delivered"]), seat(true)), checking(OPEN(), seat(false), seat(false))] });
    const body = inner(h, "arbiter-waiting")!;
    const help = /<p\b[^>]*data-testid="arbiter-invite-help"[^>]*>([^<]*)<\/p>\s*$/.exec(body);
    expect(help, "the help line closes the list").not.toBeNull();
    expect(help![1]).toBe(esc(en["arbiter.invite.help"]!));
    expect(count(h, "arbiter-invite-help")).toBe(1);
    expect(en["arbiter.invite.help"]).toMatch(/not mean they have read/i);
  });
});

describe("WaitingList: what each control is bound to (handlers, not markup)", () => {
  const b = checking(OPEN(), seat(false, ["sent"]), seat(true));
  const view = VIEW({ state: "open", press: "reinvite", pairings: [P(b.boardNo, { fixtureId: b.fixtureId, canResend: true })] });

  it("the board label selects that board in place; Resend is the shared handle's; +5 asks the panel to extend that board", () => {
    const { handle, spies } = sharedHandle();
    const on = { select: vi.fn(), extendBoard: vi.fn() };
    const tree = renderIsland(WaitingList, WL({ boards: [b], view, openRound: handle, on })).tree();
    const byId = (id: string) => tree.filter((n) => propsOf(n)["data-testid"] === id);
    const label = byId("arbiter-waiting-board");
    expect(label, "the board label is a button").toHaveLength(1);
    expect(label[0]!.type).toBe("button");
    (propsOf(label[0]!).onClick as () => void)();
    expect(on.select.mock.calls).toEqual([[b.fixtureId]]);
    expect(on.extendBoard.mock.calls.length + spies.resend.mock.calls.length, "selecting does only that").toBe(0);

    const resend = byId("arbiter-waiting-resend");
    expect(resend).toHaveLength(1);
    (propsOf(resend[0]!).onClick as () => void)();
    expect(spies.resend.mock.calls).toEqual([[b.fixtureId]]);
    expect(on.extendBoard.mock.calls.length, "Resend does not extend").toBe(0);

    const extend = byId("arbiter-waiting-extend");
    expect(extend).toHaveLength(1);
    (propsOf(extend[0]!).onClick as () => void)();
    expect(on.extendBoard.mock.calls).toEqual([[b.fixtureId]]);
    expect(spies.resend.mock.calls.length, "+5 does not resend").toBe(1);
    expect(on.select.mock.calls.length, "the +5 select is the panel's, not the list's").toBe(1);
  });
});

describe("WaitingList: with several rows, each control acts on ITS row", () => {
  it("the second row's board label, Resend and +5 carry the second board's fixture, not the first's", () => {
    const first = checking(OPEN(), seat(false, ["sent"]), seat(true));
    const second = checking(OPEN(), seat(false, ["delivered"]), seat(true));
    const view = VIEW({ state: "open", press: "reinvite", pairings: [P(first.boardNo, { fixtureId: first.fixtureId, canResend: true }), P(second.boardNo, { fixtureId: second.fixtureId, canResend: true })] });
    const { handle, spies } = sharedHandle();
    const on = { select: vi.fn(), extendBoard: vi.fn() };
    const tree = renderIsland(WaitingList, WL({ boards: [first, second], view, openRound: handle, on })).tree();
    const press = (id: string, i: number) => {
      const els = tree.filter((n) => propsOf(n)["data-testid"] === id);
      expect(els, `anti-vacuity: ${id} on both rows`).toHaveLength(2);
      (propsOf(els[i]!).onClick as () => void)();
    };
    for (const i of [0, 1]) {
      press("arbiter-waiting-board", i);
      press("arbiter-waiting-resend", i);
      press("arbiter-waiting-extend", i);
    }
    const want = [first.fixtureId, second.fixtureId];
    expect(on.select.mock.calls.map((c) => c[0])).toEqual(want);
    expect(spies.resend.mock.calls.map((c) => c[0])).toEqual(want);
    expect(on.extendBoard.mock.calls.map((c) => c[0])).toEqual(want);
    expect(want[0], "premise: two different boards").not.toBe(want[1]);
  });
});

describe("WaitingList: layout rules", () => {
  it("every control is at least 44px tall", () => {
    const b = checking(OPEN(), seat(false, ["sent"]), seat(true));
    const view = VIEW({ state: "open", press: "reinvite", pairings: [P(b.boardNo, { fixtureId: b.fixtureId, canResend: true })] });
    const h = wl({ boards: [b], view });
    const controls = tagsNamed(h, "button");
    expect(controls.length, "anti-vacuity: board label, Resend, +5").toBe(3);
    for (const tag of controls) expect(classOf(tag), tag).toMatch(/(^|\s)min-h-11(\s|$)/);
  });

  it("a long player name wraps and min-w-0 runs down the chain: list, row, seat list, seat, name", () => {
    const long = "A".repeat(43);
    const b = checking(OPEN(), seat(false, ["sent"]), seat(false), { white: { name: long, personId: null }, black: { name: long, personId: null } });
    const h = wl({ boards: [b] });
    const row = rowOf(h, b.fixtureId)!;
    const MINW = /(^|\s)min-w-0(\s|$)/;
    const chain: [string, string | undefined][] = [
      ["list", tagOf(h, "arbiter-waiting") ?? undefined],
      ["row", new RegExp(`<li\\b[^>]*data-fixture-id="${b.fixtureId}"[^>]*>`).exec(h)?.[0]],
      ["seats", /<ul\b[^>]*>/.exec(row)?.[0]],
      ["seat", seatTag(row, "white") ?? undefined],
      ["name", /<span\b[^>]*data-field="name"[^>]*>/.exec(row)?.[0]],
    ];
    for (const [name, tag] of chain) expect(classOf(tag ?? ""), name).toMatch(MINW);
    expect(chain.length, "anti-vacuity: links checked").toBe(5);
    expect(classOf(chain[4]![1]!)).toMatch(/(^|\s)break-words(\s|$)/);
    expect(h.split(long).length - 1, "both names are in the markup in full").toBe(2);
  });

  it("no dash or arrow in the markup, and the list opens no scroll region of its own (any it opened would owe tabindex)", () => {
    const b = checking(OPEN(), seat(false, ["sent", "not_delivered"]), seat(false, ["not_invited"]));
    const h = wl({ boards: [b], view: VIEW({ state: "open", press: "reinvite", pairings: [P(b.boardNo, { fixtureId: b.fixtureId, canResend: true })] }) });
    for (const code of [0x2013, 0x2014, 0x2192, 0x2190, 0x2197]) expect(h, `U+${code.toString(16)}`).not.toContain(String.fromCharCode(code));
    expect(h.match(SCROLLERS) ?? [], "the list does not scroll on its own").toHaveLength(0);
  });
});

// ---- another locale, and the new copy ---------------------------------------------------------------------------------

describe("check-in under another locale: every word comes from that dictionary", () => {
  const fill = (s: string, vars: Record<string, string | number>) => Object.entries(vars).reduce((acc, [k, v]) => acc.replaceAll(`{${k}}`, String(v)), s);
  const under = (dict: Dict, locale: Locale, node: ReactNode) => renderToStaticMarkup(<DictProvider dict={dict} locale={locale}>{node}</DictProvider>);

  it.each([["es", esUi], ["fr", frUi], ["nl", nlUi]] as [Locale, Dict][])("%s: hero and waiting list", (locale, dict) => {
    const d = dict as unknown as Record<string, string>;
    const b = checking(OPEN(), seat(false, ["delivered"]), seat(true));
    const batches = [
      { fromBoard: 1, toBoard: 8, offsetMs: 0, opensAt: iso(NOW - 10 * MIN), closesAt: iso(NOW + 8 * MIN) },
      { fromBoard: 9, toBoard: 16, offsetMs: 5 * MIN, opensAt: iso(NOW + 5 * MIN), closesAt: iso(NOW + 23 * MIN) },
    ];
    const view = VIEW({ state: "open", press: "none", staggered: true, batches, pairings: [P(b.boardNo, { fixtureId: b.fixtureId, canResend: true })] });
    const hero = under(dict, locale, <RoundColumn {...COLUMN({ round: ROUND([b, playing()]), nowMs: NOW, data: DATA({ views: [view] }) })} />);
    const list = under(dict, locale, <WaitingList {...WL({ boards: [b], view })} />);
    const expected: Record<string, [string, string]> = {
      closesIn: [hero, d["arbiter.column.checkin.closesIn"]!],
      tally: [hero, fill(d["arbiter.column.checkin.tally.other"]!, { count: 1, total: 2 })],
      playing: [hero, fill(d["arbiter.column.alreadyPlaying.one"]!, { count: 1 })],
      batch: [hero, fill(d["arbiter.column.batchBoards"]!, { from: 1, to: 8 })],
      waiting: [list, fill(d["arbiter.column.waiting.one"]!, { count: 1 })],
      notHere: [list, d["arbiter.column.notHereYet"]!],
      here: [list, d["arbiter.column.here"]!],
      delivered: [list, d["arbiter.invite.delivered"]!],
      resend: [list, d["runsheet.round.resend"]!],
      help: [list, d["arbiter.invite.help"]!],
    };
    for (const [what, [markup, text]] of Object.entries(expected)) expect(markup, `${locale} ${what}`).toContain(esc(text));
    // Premises: these differ from the English, so containing them proves the locale was used; and no English leaks.
    for (const key of ["arbiter.column.checkin.closesIn", "arbiter.column.notHereYet", "arbiter.column.here", "arbiter.column.batchBoards", "arbiter.invite.help"]) {
      expect(d[key], `${locale} ${key} is translated`).not.toBe(en[key]);
    }
    for (const text of [en["arbiter.column.checkin.closesIn"]!, en["arbiter.column.notHereYet"]!, en["arbiter.invite.help"]!]) {
      expect(hero + list, `${locale}: English leaked`).not.toContain(esc(text));
    }
    expect(Object.keys(expected).length, "anti-vacuity: words checked").toBe(10);
  });
});

describe("the check-in keys, in four locales", () => {
  const SINGLE = [
    "arbiter.column.checkin.closesIn",
    "arbiter.column.checkin.opensIn",
    "arbiter.column.checkin.closed",
    "arbiter.column.here",
    "arbiter.column.notHereYet",
    "arbiter.column.batchBoards",
  ] as const;
  const PLURAL = ["arbiter.column.checkin.tally", "arbiter.column.alreadyPlaying", "arbiter.column.finished", "arbiter.column.waiting"] as const;
  // Spec section 9 is the authority for the English.
  const SPEC_EN: Record<string, string> = {
    "arbiter.column.checkin.closesIn": "Check-in closes in",
    "arbiter.column.checkin.opensIn": "Next check-in opens in",
    "arbiter.column.checkin.closed": "Check-in has closed",
    "arbiter.column.here": "Here",
    "arbiter.column.notHereYet": "Not here yet",
    "arbiter.column.batchBoards": "Boards {from} to {to}",
    "arbiter.column.checkin.tally.one": "{count} of {total} player checked in",
    "arbiter.column.checkin.tally.other": "{count} of {total} players checked in",
    "arbiter.column.alreadyPlaying.one": "{count} board already playing",
    "arbiter.column.alreadyPlaying.other": "{count} boards already playing",
    "arbiter.column.finished.one": "{count} board finished",
    "arbiter.column.finished.other": "{count} boards finished",
    "arbiter.column.waiting.one": "Waiting on {count} board",
    "arbiter.column.waiting.other": "Waiting on {count} boards",
  };
  const BANNED = [0x2014, 0x2013, 0x2192, 0x2190, 0x2197].map((c) => String.fromCharCode(c));
  const locales: [string, Record<string, unknown>][] = [["en", enUi], ["es", esUi], ["fr", frUi], ["nl", nlUi]];
  const KEYS = [...SINGLE, ...PLURAL.flatMap((k) => [`${k}.one`, `${k}.other`])];

  it("English is the spec's; es, fr and nl are real translations; none carries a dash or an arrow; every placeholder survives", () => {
    let checked = 0;
    for (const [locale, dict] of locales) {
      for (const key of KEYS) {
        const v = dict[key];
        expect(typeof v, `${locale} ${key}`).toBe("string");
        if (locale === "en") expect(v).toBe(SPEC_EN[key]);
        else {
          expect(v, `${locale} ${key} is translated`).not.toBe(SPEC_EN[key]);
          // The same placeholders as the English, no more and no fewer.
          const holes = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
          expect(holes(v as string), `${locale} ${key} placeholders`).toEqual(holes(SPEC_EN[key]!));
        }
        for (const ch of BANNED) expect(v as string, `${locale} ${key}`).not.toContain(ch);
        checked += 1;
      }
    }
    expect(checked, "anti-vacuity: 14 keys x 4 locales").toBe(56);
  });
});

// ==== PLAYING: the status, the next round and the queue's place (plan Task 7, spec §5.5 and §5.6) ================================
//
// Boards are built here by state, and every expected count is the number of boards BUILT, never read back from `playingTally`.

const over = (o: Partial<ArbiterBoard> = {}) => board({ state: { kind: "result", score: "1-0", noResult: false }, ...o });
const voided = (o: Partial<ArbiterBoard> = {}) => board({ state: { kind: "result", score: null, noResult: true }, ...o });
const starting = (o: Partial<ArbiterBoard> = {}) => board({ state: { kind: "starting" }, ...o });
const held = (o: Partial<ArbiterBoard> = {}) => board({ state: { kind: "on_hold" }, ...o });
/** Round 2 of stage s1 is on screen, so a view of round 3 is the NEXT round and a view of round 2 is the one already open. */
const R2 = (boards: ArbiterBoard[], o: Partial<ArbiterRound> = {}) => ROUND(boards, { roundNo: 2, ...o });
const NEXT = (o: Partial<OpenRoundView> = {}) => VIEW({ roundNo: 3, ...o });
const playingColumn = (boards: ArbiterBoard[], o: Partial<RoundColumnProps> = {}) => column({ round: R2(boards), nowMs: NOW, ...o });
const nextTag = (h: string) => tagOf(h, "arbiter-column-next");
const BAR = <div data-testid="arbiter-extend-round">the round bar</div>;

describe("RoundColumn: the playing status", () => {
  it("the landmark: the same aside in the playing phase, one real box placed like the before phase, holding the status", () => {
    const h = playingColumn([playing()]);
    const root = tagOf(h, "arbiter-round-column")!;
    expect(root).toMatch(/^<aside\b/);
    expect(root).toContain('data-phase="playing"');
    expect(root).toContain(`aria-label="${esc(en["arbiter.column.label"]!)}"`);
    expect(classOf(root)).toMatch(/(^|\s)max-md:order-\[-1\](\s|$)/);
    expect(classOf(root)).toMatch(/(^|\s)md:col-start-2(\s|$)/);
    expect(classOf(root)).not.toMatch(/(^|\s)(max-md:|md:)?contents(\s|$)/);
    expect(count(h, "arbiter-column-status")).toBe(1);
    for (const id of ["arbiter-checkin-hero", "arbiter-column-start-first", "arbiter-column-nothing"]) expect(h, id).not.toContain(ATTR(id));
  });

  it("'14 of 20 boards playing': starting and live count, a held board and a finished one do not; the finished clause is the finished boards", () => {
    const boards = [
      ...Array.from({ length: 12 }, () => playing()),
      ...Array.from({ length: 2 }, () => starting()),
      ...Array.from({ length: 2 }, () => over()),
      voided(),
      ...Array.from({ length: 3 }, () => held()),
    ];
    expect(boards.length, "premise: 20 boards on screen").toBe(20);
    const h = playingColumn(boards);
    expect(textIn(h, "arbiter-column-playing")).toBe(esc(pl("arbiter.column.playing", 20, { count: 14, total: 20 })));
    expect(textIn(h, "arbiter-column-playing")).toContain("14");
    expect(textIn(h, "arbiter-column-playing")).toContain("20");
    // Three finished: two results and one void (a void is over, "no result"); the three held boards are neither.
    expect(textIn(h, "arbiter-column-finished")).toBe(esc(pl("arbiter.column.finished", 3)));
  });

  it("the finished clause is shown only above zero, and the playing line is the plural of the TOTAL", () => {
    const none = playingColumn([playing(), starting()]);
    expect(none).not.toContain(ATTR("arbiter-column-finished"));
    expect(textIn(none, "arbiter-column-playing")).toBe(esc(pl("arbiter.column.playing", 2, { count: 2, total: 2 })));
    // One board: the singular. It is the total that agrees ("1 of 1 board"), and a lone board of several still reads "boards".
    expect(textIn(playingColumn([playing()]), "arbiter-column-playing")).toBe(esc(pl("arbiter.column.playing", 1, { count: 1, total: 1 })));
    expect(textIn(playingColumn([playing(), over()]), "arbiter-column-playing")).toBe(esc(pl("arbiter.column.playing", 2, { count: 1, total: 2 })));
    expect(pl("arbiter.column.playing", 1, { count: 1, total: 1 })).not.toBe(pl("arbiter.column.playing", 2, { count: 1, total: 2 }));
    // One finished board: the singular of the finished clause.
    expect(textIn(playingColumn([playing(), over()]), "arbiter-column-finished")).toBe(esc(pl("arbiter.column.finished", 1)));
  });

  it("every board over: '0 of 3 boards playing' beside '3 boards finished' (a total above zero is a real count)", () => {
    const h = playingColumn([over(), over(), over()]);
    expect(textIn(h, "arbiter-column-playing")).toBe(esc(pl("arbiter.column.playing", 3, { count: 0, total: 3 })));
    expect(textIn(h, "arbiter-column-finished")).toBe(esc(pl("arbiter.column.finished", 3)));
  });

  it("boards [] (a round whose every board is your own): no counts at all, and never '0 of 0'", () => {
    const h = column({ round: R2([], { ownBoards: 4 }), nowMs: NOW, roundExtend: BAR });
    expect(h).toContain('data-phase="playing"');
    for (const id of ["arbiter-column-playing", "arbiter-column-finished"]) expect(h, id).not.toContain(ATTR(id));
    expect(h).not.toContain(esc(pl("arbiter.column.playing", 0, { count: 0, total: 0 })));
    expect(h).not.toContain(esc(pl("arbiter.column.finished", 0)));
    // The status block itself stays: it carries the round's heading and the round bar (the empty case still has a round on screen).
    expect(count(h, "arbiter-column-status")).toBe(1);
    expect(inner(h, "arbiter-column-status")).toContain(ATTR("arbiter-extend-round"));
  });

  it("the block is named by the round: its heading, and it carries no countdown, no tally bar and no waiting list", () => {
    const h = playingColumn([playing()]);
    const tag = tagOf(h, "arbiter-column-status")!;
    expect(tag).toMatch(/^<section\b/);
    expect(nameOf(h, tag)).toBe(esc(t("runsheet.round.heading", { round: 2 })));
    for (const id of ["arbiter-checkin-clock", "arbiter-checkin-tally", "arbiter-waiting"]) expect(h, id).not.toContain(ATTR(id));
    expect(h).not.toContain('role="progressbar"');
    expect(h).not.toContain('role="timer"');
  });

  it("the playing block hosts the round bar's node: once, inside the status (C13)", () => {
    const h = playingColumn([playing()], { roundExtend: BAR });
    expect(count(h, "arbiter-extend-round"), "exactly one bar").toBe(1);
    expect(inner(h, "arbiter-column-status")).toContain(ATTR("arbiter-extend-round"));
    // ...and with none handed over (the panel mounts it elsewhere on that path), nothing stands in its place.
    expect(playingColumn([playing()], { roundExtend: null })).not.toContain(ATTR("arbiter-extend-round"));
  });
});

describe("RoundColumn: the next round while boards play", () => {
  const EARLIER = [
    { roundNo: 1, games: 1 },
    { roundNo: 2, games: 6 },
  ];

  it("quiet while boards play, and EVERY earlier-in-play entry inline, one sentence each (the singular and the plural differ)", () => {
    const h = playingColumn([playing(), over()], { data: DATA({ views: [NEXT({ earlierInPlay: EARLIER })] }) });
    expect(count(h, "arbiter-column-next"), "the press is offered").toBe(1);
    expect(textIn(h, "arbiter-column-next")).toBe(esc(en["runsheet.round.openCta"]!));
    expect(nextTag(h)).toContain('data-primary="false"');
    expect(nextTag(h)).toMatch(/^<button\b/);
    // Quiet = the panel's outline button, not the primary fill.
    expect(classOf(nextTag(h)!)).toContain("border-[#c9bdf0]");
    expect(classOf(nextTag(h)!)).not.toContain("bg-[#7c3aed]");
    const earlier = inner(h, "arbiter-column-earlier")!;
    const sentences = [...earlier.matchAll(/<span\b[^>]*data-earlier-round="(\d+)"[^>]*>([^<]*)<\/span>/g)].map((m) => [m[1], m[2]]);
    expect(sentences).toEqual([
      ["1", esc(pl("runsheet.round.confirmEarlierInPlay", 1, { round: 1 }))],
      ["2", esc(pl("runsheet.round.confirmEarlierInPlay", 6, { round: 2 }))],
    ]);
    expect(pl("runsheet.round.confirmEarlierInPlay", 1, { round: 1 }), "premise: one game and six games read differently").not.toBe(
      pl("runsheet.round.confirmEarlierInPlay", 6, { round: 1 }).replace("6", "1"),
    );
    expect(tagOf(h, "arbiter-column-earlier")).toContain('role="note"');
    // The warning is BESIDE the press: before it, in the same block.
    expect(h.indexOf(ATTR("arbiter-column-earlier"))).toBeLessThan(h.indexOf(ATTR("arbiter-column-next")));
  });

  it("no earlier round in play: no warning at all (the empty case)", () => {
    const h = playingColumn([playing()], { data: DATA({ views: [NEXT({ earlierInPlay: [] })] }) });
    expect(count(h, "arbiter-column-next")).toBe(1);
    expect(h).not.toContain(ATTR("arbiter-column-earlier"));
  });

  it("every board over: the SAME button is primary (data-primary, the accent fill)", () => {
    const views = [NEXT({ earlierInPlay: [] })];
    const h = playingColumn([over(), over(), voided()], { data: DATA({ views }) });
    expect(nextTag(h)).toContain('data-primary="true"');
    expect(nextTag(h)).toMatch(/^<button\b/);
    expect(classOf(nextTag(h)!)).toContain("bg-[#7c3aed]");
    expect(textIn(h, "arbiter-column-next")).toBe(esc(en["runsheet.round.openCta"]!));
    // Primary does not drop the warning when an earlier round still has games.
    const warned = playingColumn([over()], { data: DATA({ views: [NEXT({ earlierInPlay: [{ roundNo: 1, games: 2 }] })] }) });
    expect(nextTag(warned)).toContain('data-primary="true"');
    expect(count(warned, "arbiter-column-earlier")).toBe(1);
  });

  it("primary needs EVERY board over: one live board, one starting board, one HELD board, or no board on screen at all keeps it quiet", () => {
    const views = [NEXT()];
    const cases: [string, ArbiterBoard[]][] = [
      ["one live board", [over(), over(), playing()]],
      ["one starting board", [over(), starting()]],
      ["one held board", [over(), over(), held()]],
      ["every board is the organiser's own (nothing on screen to call over)", []],
    ];
    let checked = 0;
    for (const [what, boards] of cases) {
      const h = playingColumn(boards, { data: DATA({ views }) });
      expect(nextTag(h), what).toContain('data-primary="false"');
      expect(classOf(nextTag(h)!), what).not.toContain("bg-[#7c3aed]");
      checked += 1;
    }
    expect(checked, "anti-vacuity: cases checked").toBe(4);
    // The positive pair: take the live board away and the very same view turns primary.
    expect(nextTag(playingColumn([over(), over()], { data: DATA({ views }) }))).toContain('data-primary="true"');
  });

  it("the next round is not the round on screen, and a view the reader does not offer (press other than open) has no press", () => {
    const h = playingColumn([playing()], {
      data: DATA({ views: [VIEW({ roundNo: 2, press: "open" }), NEXT({ press: "none" }), NEXT({ roundNo: 4, press: "open" })] }),
    });
    expect(count(h, "arbiter-column-next")).toBe(1);
    expect(h).toContain(esc(t("runsheet.round.heading", { round: 4 })));
    expect(h, "round 3 has no open press").not.toContain(`data-round-no="3"`);
    expect(h, "the round on screen is not offered to open").not.toContain(`data-round-no="2"`);
  });

  it("a pinned older round never offers the next round's press; the same views on the current round do", () => {
    const views = [NEXT({ earlierInPlay: EARLIER })];
    const pinned = column({ round: R2([playing()], { current: false }), nowMs: NOW, data: DATA({ views }) });
    for (const id of ["arbiter-column-next", "arbiter-column-earlier", "arbiter-column-open"]) expect(pinned, id).not.toContain(ATTR(id));
    expect(pinned, "the status still stands").toContain(ATTR("arbiter-column-status"));
    const current = column({ round: R2([playing()], { current: true }), nowMs: NOW, data: DATA({ views }) });
    expect(count(current, "arbiter-column-next")).toBe(1);
  });

  it("no view to open: nothing is printed in its place (no 'nothing paired' line, no start line)", () => {
    const h = playingColumn([playing()], { data: DATA({ views: [] }) });
    for (const id of ["arbiter-column-next", "arbiter-column-open", "arbiter-column-nothing", "arbiter-column-start-first"]) expect(h, id).not.toContain(ATTR(id));
  });

  it("two stages with a round to open: each block is its own press, names its stage and carries its own warning", () => {
    const a = NEXT({ stageId: "s1", stageName: "Swiss Open", earlierInPlay: [{ roundNo: 2, games: 4 }] });
    const b = NEXT({ stageId: "s2", stageName: "Rapid Playoff", roundNo: 5, earlierInPlay: [] });
    const h = playingColumn([playing()], { data: DATA({ views: [a, b] }) });
    expect(count(h, "arbiter-column-next")).toBe(2);
    expect(count(h, "arbiter-column-earlier"), "only the first stage has games in play").toBe(1);
    const blocks = h.split(ATTR("arbiter-column-open") + " ").slice(1);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toContain("Swiss Open");
    expect(blocks[0]).toContain(ATTR("arbiter-column-earlier"));
    expect(blocks[1]).toContain("Rapid Playoff");
    expect(blocks[1]).not.toContain(ATTR("arbiter-column-earlier"));
  });

  it("the playing block keeps the heading and the lede and leaves the pairings list to the before phase", () => {
    const h = playingColumn([playing()], { data: DATA({ views: [NEXT({ pairings: [P(1), P(2)] })] }) });
    expect(h).toContain(esc(t("runsheet.round.heading", { round: 3 })));
    expect(h).toContain(esc(pl("runsheet.round.pairedLede", 2, { players: 4 })));
    expect(h).not.toContain(ATTR("arbiter-column-pairings"));
    expect(h).not.toContain(ATTR("arbiter-column-pairing-f1"));
  });

  it("it keeps the confirmation: asked, the run sheet's dialog names who is invited and the earlier games again", () => {
    const view = NEXT({ earlierInPlay: EARLIER });
    const h = renderToStaticMarkup(
      <OpenRoundBlockView view={view} state={{ ...initialOpenRoundUi(), confirming: true }} tz={TZ} showStage={false} on={NO_ON} playing={{ primary: false }} />,
    );
    expect(h).toContain(ATTR("arbiter-column-confirm"));
    expect(h).toContain(ATTR("open-round-earlier"));
    expect(count(h, "arbiter-column-next")).toBe(1);
  });

  it("every control is 44px tall and the warning wraps (break-words) in a min-w-0 chain", () => {
    const h = playingColumn([playing()], { data: DATA({ views: [NEXT({ earlierInPlay: EARLIER })] }) });
    expect(classOf(nextTag(h)!).split(/\s+/)).toContain("min-h-11");
    const earlier = tagOf(h, "arbiter-column-earlier")!;
    expect(classOf(earlier).split(/\s+/)).toContain("min-w-0");
    const spans = [...inner(h, "arbiter-column-earlier")!.matchAll(/<span\b[^>]*data-earlier-round[^>]*>/g)].map((m) => m[0]);
    expect(spans, "anti-vacuity: both sentences").toHaveLength(2);
    for (const s of spans) expect(classOf(s).split(/\s+/), s).toContain("break-words");
    expect(classOf(nextTag(h)!)).not.toMatch(/(^|\s)truncate(\s|$)/);
  });
});

describe("RoundColumn: the next round presses ITS OWN round (the seam, through the real hook)", () => {
  beforeEach(() => {
    net.calls.length = 0;
    router.refresh.mockReset();
  });
  const S1 = NEXT({ stageId: "s1", stageName: "Swiss", roundNo: 3, earlierInPlay: [{ roundNo: 2, games: 3 }] });
  const S2 = NEXT({ stageId: "s2", stageName: "Rapid", roundNo: 5, pairings: [P(7), P(8)] });

  it("the playing wrapper hands the pure view its `playing` emphasis, and asking/opening sends ONE open-round for this block's stage", () => {
    const { handle, spies } = sharedHandle();
    const ui = renderIsland(RoundColumn, COLUMN({ round: R2([playing()]), nowMs: NOW, data: DATA({ views: [S1, S2] }), openRound: handle }));
    const blocks = wrappers(ui.tree());
    expect(blocks, "anti-vacuity: one wrapper per next round").toHaveLength(2);
    const [a, b] = blocks.map(mountBlock) as [ReturnType<typeof mountBlock>, ReturnType<typeof mountBlock>];
    expect(propsOf(blocks[0]!).playing, "quiet while a board plays").toEqual({ primary: false });

    b.read().on.ask();
    expect(b.read().state.confirming).toBe(true);
    expect(a.read().state.confirming, "the first block is its own round").toBe(false);
    b.read().on.open();
    b.read().on.open();
    expect(net.calls.map((c) => [c.url, c.json])).toEqual([["/api/v1/stages/s2/open-round", { roundNo: 5 }]]);
    // The shared handle is the round ON SCREEN's; the next round's block must never borrow it.
    for (const [name, spy] of Object.entries(spies)) expect(spy, name).not.toHaveBeenCalled();
  });

  it("every board over flips the emphasis the wrapper hands down; the press is unchanged", () => {
    const ui = renderIsland(RoundColumn, COLUMN({ round: R2([over(), over()]), nowMs: NOW, data: DATA({ views: [S1] }) }));
    const [w] = wrappers(ui.tree());
    expect(propsOf(w!).playing).toEqual({ primary: true });
  });
});

describe("RoundColumn: the queue is the aside's first child in every phase", () => {
  const CARD_DATA = (round: ArbiterRound | null) =>
    DATA({
      views: [NEXT({ press: "open" }), VIEW({ roundNo: 1, press: "open" })],
      held: [
        {
          fixtureId: "h1",
          fixtureNo: 1,
          homeName: "Ada L.",
          awayName: "Bo M.",
          scheduledAt: null,
          reason: "aborted",
          lastError: null,
          whiteSide: "home",
          revokedSeat: null,
          roundNo: round?.roundNo ?? 1,
          boardNo: 4,
          stageName: "Swiss",
          canResync: false,
          seated: false,
          noResultOffer: { kind: "void" },
        },
      ],
      ownFlagged: 1,
    });
  const asideInner = (h: string) => {
    const i = inner(h, "arbiter-round-column");
    if (i === null) throw new Error("no aside in the markup");
    return i;
  };

  it("before, check-in and playing: the first element inside the aside is the queue, ahead of the phase block", () => {
    const checkinRound = ROUND([checking(OPEN(), seat(true), seat(false))]);
    const phases: [string, RoundColumnProps][] = [
      ["before", COLUMN({ round: null, data: CARD_DATA(null), nowMs: NOW })],
      ["checkin", COLUMN({ round: checkinRound, data: CARD_DATA(checkinRound), nowMs: NOW })],
      ["playing", COLUMN({ round: R2([playing()]), data: CARD_DATA(R2([])), nowMs: NOW })],
    ];
    const phaseBlock: Record<string, string> = { before: "arbiter-column-open", checkin: "arbiter-checkin-hero", playing: "arbiter-column-status" };
    let checked = 0;
    for (const [phase, props] of phases) {
      const h = column(props);
      expect(tagOf(h, "arbiter-round-column"), phase).toContain(`data-phase="${phase}"`);
      const first = /^<([a-z0-9]+)\b[^>]*>/.exec(asideInner(h))!;
      expect(first[0], `${phase}: the first child`).toContain(ATTR("arbiter-column-queue"));
      expect(h.indexOf(ATTR("arbiter-column-queue")), phase).toBeLessThan(h.indexOf(ATTR(phaseBlock[phase]!)));
      expect(count(h, "arbiter-column-queue"), `${phase}: one queue`).toBe(1);
      expect(count(h, "arbiter-column-card"), `${phase}: its card`).toBe(1);
      expect(textIn(h, "arbiter-column-own-flagged"), `${phase}: C11, the line is rendered through the column`).toBe(esc(pl("externalPlay.queue.ownFlagged", 1)));
      checked += 1;
    }
    expect(checked, "anti-vacuity: three phases").toBe(3);
  });

  it("with nothing to decide the queue is absent in every phase and the phase block is the first child", () => {
    const checkinRound = ROUND([checking(OPEN(), seat(true), seat(false))]);
    const propsByPhase: [string, RoundColumnProps][] = [
      ["before", COLUMN({ round: null, nowMs: NOW })],
      ["checkin", COLUMN({ round: checkinRound, nowMs: NOW })],
      ["playing", COLUMN({ round: R2([playing()]), nowMs: NOW })],
    ];
    for (const [phase, props] of propsByPhase) {
      const h = column(props);
      expect(h, phase).not.toContain(ATTR("arbiter-column-queue"));
      expect(asideInner(h), phase).not.toMatch(/^<[a-z0-9]+\b[^>]*arbiter-column-queue/);
    }
  });

  it("inside the aside no CSS order is used: source order is visual order (C10)", () => {
    const checkinRound = ROUND([checking(OPEN(), seat(true), seat(false))]);
    const cases: RoundColumnProps[] = [
      COLUMN({ round: null, data: CARD_DATA(null), nowMs: NOW }),
      COLUMN({ round: checkinRound, data: CARD_DATA(checkinRound), nowMs: NOW }),
      COLUMN({ round: R2([playing()]), data: CARD_DATA(R2([])), nowMs: NOW }),
    ];
    let scanned = 0;
    for (const props of cases) {
      const body = asideInner(column(props));
      for (const m of body.matchAll(/class="([^"]*)"/g)) {
        expect(m[1], m[1]).not.toMatch(/(^|\s)(?:[\w-]+:)*-?order-/);
        scanned += 1;
      }
    }
    expect(scanned, "anti-vacuity: class strings scanned").toBeGreaterThan(30);
  });

  it("the column hands the queue its round, its rows, its slugs and the panel's select", () => {
    const onSelect = vi.fn();
    const data = CARD_DATA(R2([playing({ fixtureId: "h1" })]));
    const ui = renderIsland(RoundColumn, COLUMN({ round: R2([playing({ fixtureId: "h1" })]), data, on: { select: onSelect, extendBoard: () => {} }, nowMs: NOW }));
    const queueEl = ui.tree().find((n) => typeof n.type === "function" && propsOf(n).held !== undefined && propsOf(n).onSelect !== undefined)!;
    expect(queueEl, "the queue is mounted by the column").toBeDefined();
    const p = propsOf(queueEl);
    expect(p.held).toBe(data.held);
    expect(p.flagged).toBe(data.flagged);
    expect(p.ownFlagged).toBe(1);
    expect(p.slugs).toBe(SLUGS);
    expect((p.round as ArbiterRound).roundNo).toBe(2);
    (p.onSelect as (id: string) => void)("h1");
    expect(onSelect).toHaveBeenCalledWith("h1");
  });
});

describe("the playing column under another locale: every word comes from that dictionary", () => {
  const fill = (s: string, vars: Record<string, string | number>) => Object.entries(vars).reduce((acc, [k, v]) => acc.replaceAll(`{${k}}`, String(v)), s);
  const under = (dict: Dict, locale: Locale, node: ReactNode) => renderToStaticMarkup(<DictProvider dict={dict} locale={locale}>{node}</DictProvider>);

  it.each([["es", esUi], ["fr", frUi], ["nl", nlUi]] as [Locale, Dict][])("%s: status, finished clause and the next round's warning", (locale, dict) => {
    const d = dict as unknown as Record<string, string>;
    const props = COLUMN({
      round: R2([playing(), playing(), over()]),
      nowMs: NOW,
      data: DATA({ views: [NEXT({ earlierInPlay: [{ roundNo: 2, games: 3 }] })] }),
    });
    const h = under(dict, locale, <RoundColumn {...props} />);
    const expected: Record<string, string> = {
      playing: fill(d["arbiter.column.playing.other"]!, { count: 2, total: 3 }),
      finished: fill(d["arbiter.column.finished.one"]!, { count: 1 }),
      earlier: fill(d["runsheet.round.confirmEarlierInPlay.other"]!, { round: 2, count: 3 }),
      cta: d["runsheet.round.openCta"]!,
    };
    for (const [what, text] of Object.entries(expected)) expect(h, `${locale} ${what}`).toContain(esc(text));
    expect(d["arbiter.column.playing.other"], `${locale} is translated`).not.toBe(en["arbiter.column.playing.other"]);
    expect(h, `${locale}: English leaked`).not.toContain(esc(pl("arbiter.column.playing", 3, { count: 2, total: 3 })));
    expect(Object.keys(expected).length, "anti-vacuity: words checked").toBe(4);
  });
});

describe("the playing column: layout rules", () => {
  it("no dash or arrow in the markup, every control is 44px, and no scroller is left unreachable", () => {
    const h = playingColumn([playing(), over()], {
      roundExtend: BAR,
      data: DATA({ views: [NEXT({ earlierInPlay: [{ roundNo: 1, games: 2 }, { roundNo: 2, games: 1 }] })] }),
    });
    for (const code of [0x2013, 0x2014, 0x2192, 0x2190, 0x2197]) expect(h, `U+${code.toString(16)}`).not.toContain(String.fromCharCode(code));
    const controls = [...h.matchAll(/<(?:button|a)\b[^>]*>/g)].map((m) => m[0]);
    expect(controls.length, "anti-vacuity: the next-round press is the one control").toBe(1);
    for (const c of controls) expect(classOf(c).split(/\s+/), c).toContain("min-h-11");
    for (const tag of h.match(SCROLLERS) ?? []) expect(tag, tag).toContain('tabindex="0"');
  });

  it("the status block is a min-w-0 box that wraps (a long heading cannot push the column wider)", () => {
    const h = playingColumn([playing()]);
    expect(classOf(tagOf(h, "arbiter-column-status")!).split(/\s+/)).toContain("min-w-0");
    expect(classOf(tagOf(h, "arbiter-round-column")!).split(/\s+/)).toContain("min-w-0");
  });
});

describe("the queue under another locale, through the column that mounts it", () => {
  const fill = (s: string, vars: Record<string, string | number>) => Object.entries(vars).reduce((acc, [k, v]) => acc.replaceAll(`{${k}}`, String(v)), s);
  const under = (dict: Dict, locale: Locale, node: ReactNode) => renderToStaticMarkup(<DictProvider dict={dict} locale={locale}>{node}</DictProvider>);
  const heldRow = (fixtureId: string, boardNo: number | null): RoundColumnData["held"][number] => ({
    fixtureId,
    fixtureNo: 1,
    homeName: "Ada L.",
    awayName: "Bo M.",
    scheduledAt: null,
    reason: "aborted",
    lastError: null,
    whiteSide: "home",
    revokedSeat: null,
    roundNo: 2,
    boardNo,
    stageName: "Swiss",
    canResync: false,
    seated: false,
    noResultOffer: { kind: "void" },
  });
  const flaggedBoard = (fixtureId: string, state: ArbiterBoard["state"]): RoundColumnData["flagged"][number] => ({
    ...board({ fixtureId, boardNo: 7, state, flags: [{ id: `${fixtureId}-a`, kind: "out_of_band_play", at: iso(NOW), plies: null }, { id: `${fixtureId}-b`, kind: "out_of_band_play", at: iso(NOW), plies: null }] }),
    roundNo: 2,
    stageName: "Swiss",
  });

  it.each([["es", esUi], ["fr", frUi], ["nl", nlUi]] as [Locale, Dict][])("%s: the title, both Review words, Mark as reviewed, the flag count and the ownFlagged line", (locale, dict) => {
    const d = dict as unknown as Record<string, string>;
    const round = R2([playing({ fixtureId: "h1" })]);
    const props = COLUMN({
      round,
      nowMs: NOW,
      data: DATA({
        held: [heldRow("h1", 4), heldRow("h2", null)],
        flagged: [flaggedBoard("g1", { kind: "cancelled" })],
        ownFlagged: 2,
      }),
    });
    const h = under(dict, locale, <RoundColumn {...props} />);
    const expected: Record<string, string> = {
      title: fill(d["arbiter.column.queue.other"]!, { count: 3 }),
      review: fill(d["arbiter.column.review"]!, { board: 4 }),
      reviewThis: d["arbiter.column.reviewThis"]!,
      markReviewed: d["externalPlay.queue.markReviewed"]!,
      flags: fill(d["arbiter.flagCount.other"]!, { count: 2 }),
      ownFlagged: fill(d["externalPlay.queue.ownFlagged.other"]!, { count: 2 }),
    };
    for (const [what, text] of Object.entries(expected)) expect(h, `${locale} ${what}`).toContain(esc(text));
    // Premises: these differ from the English, so containing them proves the locale was used; and none of the English leaked.
    for (const key of ["arbiter.column.queue.other", "arbiter.column.review", "arbiter.column.reviewThis"]) expect(d[key], `${locale} ${key} is translated`).not.toBe(en[key]);
    for (const text of [pl("arbiter.column.queue", 3), t("arbiter.column.review", { board: 4 }), en["arbiter.column.reviewThis"]!]) {
      expect(h, `${locale}: English leaked`).not.toContain(esc(text));
    }
    expect(Object.keys(expected).length, "anti-vacuity: words checked").toBe(6);
  });
});
