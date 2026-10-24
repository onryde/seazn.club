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
import { emptyExtendTally } from "@/lib/checkin-extend";
import type { Dict, Locale } from "@/lib/i18n-constants";
import { messages } from "@/lib/messages";
import type { ArbiterRound } from "@/lib/arbiter-view";
import type { OpenRoundPairing, OpenRoundResult, OpenRoundView } from "@/lib/open-round";
import { routes } from "@/lib/routes";
import { DEADLINE_AFTER_MS } from "@/server/external-play/window";
import { owedPlayers } from "../../desk/open-round-control";
import { initialOpenRoundUi, type OpenRoundUiState } from "../../desk/open-round-state";
import type { OpenRoundHandle } from "../../desk/use-open-round";
import { OpenRoundBlockView, RoundColumn, type RoundColumnData, type RoundColumnProps } from "../round-column";

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
const column = (o: Partial<RoundColumnProps> = {}) => renderToStaticMarkup(<RoundColumn {...COLUMN(o)} />);

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

  it("a round on screen is not the before phase: no before block, no start line, no empty line", () => {
    // Tasks 6 and 7 draw the check-in and playing columns; until then this witnesses only that the BEFORE branch does not leak.
    const h = column({ round: ON_SCREEN, data: DATA({ views: [VIEW({ roundNo: 2 })] }) });
    expect(h).not.toContain('data-phase="before"');
    for (const id of ["arbiter-column-open", "arbiter-column-start-first", "arbiter-column-nothing"]) expect(h, id).not.toContain(ATTR(id));
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
