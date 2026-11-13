// Quick match plan 2, Task 5 (spec docs/superpowers/specs/2026-11-03-quick-match-design.md §5 step 3, §7.5, C15, C18,
// C19; pre-flight A6, A14, B5, C10, D10, D12, D13, D16, Q3): the guest's home at `/q/<token>`.
//
// The real producers on both ends, no fixture on either (AGENTS.md class 1): every quick match is made by
// `createQuickMatch`, every result by the real write path (`scoreEvent`, `playToDecided`), and the page under test is the
// REAL async server component, called as Next calls it (`params` a Promise). Its server components are expanded the way
// the server renders them (`expand` below); a client component is a boundary whose props are SERIALISED into the flight
// payload, so `flightOf` serialises exactly those, plus every host element's attributes.
//
// Expected values come from the rulebook, the spec and the dictionaries (the copy's source), or from the rows the real
// producer wrote: a round robin of n is n(n-1)/2 matches, a knockout of n is n - 1 (§7.3), the 7 days are C1's, and a
// match number is D12's "1-based index among non-bye fixtures in play order", applied to the plan-1 read's own list.
//
// Sports: badminton (the spec's own example; sets) for the flow, football for the draw (B5d: a level league match scores
// points and reads "drew"). The page reads no sport-specific branch beyond the score line, which `scoreLineOf` owns.
//
// Real Postgres required; the DB cases skip without DATABASE_URL. The empty case and the module guards run without one.
import { randomBytes as kekBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { cloneElement, Fragment, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LEVEL_RANK } from "@seazn/engine/competition";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sql } from "@/lib/db";
import { t as tRuntime, plural as pluralRuntime } from "@/lib/i18n-runtime";
import { levelWords } from "@/lib/score/levels";
import type { CreateQuickMatch } from "@/server/api-v1/schemas";
import { systemAuth, type CreatedQuickMatch } from "@/server/usecases/quick-match-create";
import { createQuickMatchAnyFormat } from "@/server/usecases/__tests__/_quick-match-knockout";
import { hardDeleteQuickMatchCompetition } from "@/server/usecases/quick-match-delete";
import { skipQuickMatchFixture } from "@/server/usecases/quick-match-skip";
import {
  readQuickMatchHome,
  resolveQuickMatchToken,
  type QuickMatchFixture,
  type QuickMatchHome,
} from "@/server/usecases/quick-match-home";
import { listQuickMatchSports } from "@/server/usecases/quick-match-sports";
import { hashVisitorKey, mintHomeToken, mintVisitorKey } from "@/server/usecases/quick-match-tokens";
import { scoreEvent } from "@/server/usecases/scoring";
import { playToDecided } from "@/server/usecases/__tests__/_quick-match-probe";
import * as homeModule from "@/components/quick-match/home";
import * as standingsModule from "@/components/quick-match/standings";
import * as drawModule from "@/components/quick-match/draw";
import * as listModule from "@/components/quick-match/match-list";
import * as saveFormModule from "@/components/quick-match/save-form";
import { homeFlash, QuickMatchHomeShapeError, QuickMatchHomeView, type AddMatchView, type QuickMatchCopy } from "@/components/quick-match/home";
import type { RowMenuRequest } from "@/components/quick-match/match-list";
import { QuickMatchRowMenu } from "@/components/quick-match/row-menu";
import { QuickMatchShare } from "@/components/quick-match/share";
import { DictProvider } from "@/components/i18n/dict-provider";
import en from "@/dictionaries/en/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import enPublic from "@/dictionaries/en/public.json";
import { builtinModules } from "@seazn/engine/sports";
import type { StandingsRow } from "@seazn/engine/competition";
import type { Dict } from "@/lib/i18n-constants";
import { withTenant } from "@/lib/db";
import { QUICK_MATCH_ERRORS, QUICK_MATCH_SYSTEM_ORG_ID } from "@/lib/quick-match-constants";
import { stageTableRulesDocs } from "@/server/engine-db/table-rules";
import { StandingsTable } from "@/components/public-site/standings-table";
import type { FullTableData } from "@/components/quick-match/standings";
import { QuickMatchDeletionLine } from "@/components/quick-match/deletion-line";
import QuickMatchHomePage, { generateMetadata } from "../page";
import { quickMatchFullTable } from "../full-table";

/** A throwaway key of this file's own: every create seals a home token, and CI's unit job has no DEVICE_LINK_KEK. */
vi.stubEnv("DEVICE_LINK_KEK", kekBytes(32).toString("hex"));

// The viewer's locale (D10): the page asks `resolveLocale()` with no org default. Hoisted so a case can switch it.
const locale = vi.hoisted(() => ({ value: "en" as "en" | "fr" }));
vi.mock("@/lib/resolve-locale", () => ({ resolveLocale: vi.fn(async () => locale.value) }));
// The create's one analytics event reaches a mock, never PostHog.
vi.mock("@/lib/posthog-server", async (orig) => ({
  ...(await orig<typeof import("@/lib/posthog-server")>()),
  captureServer: vi.fn(),
}));

const HAS_DB = !!process.env.DATABASE_URL;
/** C1 / §7.2: an unsaved quick match is kept this many days after its last activity. The spec's number, typed. */
const SPEC_EXPIRY_DAYS = 7;
const SIDES = ["Ravi & Sam", "Priya & Tom", "Lee & Ana", "Jo & Max"];

const en_ = (key: keyof typeof en, vars?: Record<string, string | number>) => tRuntime(en, key, vars);
const fr_ = (key: keyof typeof fr, vars?: Record<string, string | number>) => tRuntime(fr, key, vars);
const pub_ = (key: keyof typeof enPublic) => tRuntime(enPublic, key);
const enPlayed = (played: number, count: number) =>
  pluralRuntime(en, "quickMatch.home.played", count, "en", { played, days: SPEC_EXPIRY_DAYS });

// ── the server-render expansion and the flight payload ──────────────────────────────────────────────────────────────

/** Every component the four quick-match modules export is a SERVER component: the server calls it and only its output
 *  reaches the browser. Anything else with a function type is a client boundary (its props are serialised). */
const SERVER_MODULES = { homeModule, standingsModule, drawModule, listModule, saveFormModule };
const SERVER = new Set<unknown>(
  Object.values(SERVER_MODULES).flatMap((m) => Object.values(m).filter((v) => typeof v === "function")),
);
const SERVER_FILES = ["home.tsx", "standings.tsx", "draw.tsx", "match-list.tsx", "save-form.tsx"].map((f) =>
  path.resolve(import.meta.dirname, "../../../../components/quick-match", f),
);

/** The tree as the server renders it: every server component called (awaited when async), host elements and client
 *  boundaries kept, their children expanded. */
async function expand(node: ReactNode): Promise<ReactNode> {
  if (Array.isArray(node)) return Promise.all(node.map((n) => expand(n as ReactNode)));
  if (!isValidElement(node)) return node;
  const el = node as ReactElement<Record<string, unknown>>;
  if (typeof el.type === "function" && SERVER.has(el.type)) {
    return expand(await (el.type as (p: unknown) => ReactNode | Promise<ReactNode>)(el.props));
  }
  if (el.props.children === undefined) return el;
  const children = await expand(el.props.children as ReactNode);
  return cloneElement(el, undefined, ...(Array.isArray(children) ? children : [children]));
}

/** Bytes as the flight would carry a typed array: base64, never the raw object. */
const bytesReplacer = (_k: string, v: unknown) =>
  v && typeof v === "object" && ArrayBuffer.isView(v) ? Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("base64") : v;

/** What a server render ships besides the HTML: every host element's attributes, every client boundary's props
 *  (serialised whole), and every text node, over the EXPANDED tree. */
function flightOf(tree: ReactNode): string {
  const out: string[] = [];
  const visit = (n: unknown) => {
    if (Array.isArray(n)) return n.forEach(visit);
    if (typeof n === "string" || typeof n === "number") return void out.push(String(n));
    if (!isValidElement(n)) return;
    const { children, ...rest } = n.props as Record<string, unknown>;
    out.push(JSON.stringify(rest, bytesReplacer));
    visit(children);
  };
  visit(tree);
  return out.join("\n");
}

function all(node: unknown, pred: (el: ReactElement<Record<string, unknown>>) => boolean, out: ReactElement<Record<string, unknown>>[] = []) {
  if (Array.isArray(node)) {
    for (const n of node) all(n, pred, out);
  } else if (isValidElement(node)) {
    const el = node as ReactElement<Record<string, unknown>>;
    if (pred(el)) out.push(el);
    all(el.props.children, pred, out);
  }
  return out;
}
const byTestId = (tree: ReactNode, id: string) => all(tree, (el) => el.props["data-testid"] === id);
const oneByTestId = (tree: ReactNode, id: string) => {
  const hits = byTestId(tree, id);
  expect(hits, `exactly one [data-testid=${id}]`).toHaveLength(1);
  return hits[0]!;
};
function textOf(node: unknown): string {
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (isValidElement(node)) return textOf((node.props as { children?: unknown }).children);
  return "";
}
/** The "Not saved — deleted on {date}" island (a client boundary: the guest's own zone, review I1): its element in the
 *  expanded tree, and the line its server render ships (the never-late fallback day). Null when the tree has none. */
function deletionLineOf(tree: ReactNode): { el: ReactElement<Record<string, unknown>>; served: string } | null {
  const hits = all(tree, (el) => el.type === QuickMatchDeletionLine);
  expect(hits.length, "at most one deletion line").toBeLessThanOrEqual(1);
  if (hits.length === 0) return null;
  const served = renderToStaticMarkup(hits[0]!).replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'").replace(/&amp;/g, "&");
  return { el: hits[0]!, served: served.replace(/\s+/g, " ").trim() };
}
/** Whitespace folded, so a sentence split over elements reads as one. */
const words = (node: unknown) => textOf(node).replace(/\s+/g, " ").trim();
/** What a screen reader hears: the words with every `aria-hidden` subtree left out (a chevron, the printed letters). */
function heardOf(node: unknown): string {
  if (Array.isArray(node)) return node.map(heardOf).join("");
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (isValidElement(node)) {
    const props = node.props as { children?: unknown; "aria-hidden"?: unknown };
    return props["aria-hidden"] === "true" ? "" : heardOf(props.children);
  }
  return "";
}
const heard = (node: unknown) => heardOf(node).replace(/\s+/g, " ").trim();
const classOf = (el: ReactElement<Record<string, unknown>>) => String(el.props.className ?? "");
/** The table's header cells, each read on its own (the place column's name is screen-reader text). */
const headCells = (tree: ReactNode) => all(oneByTestId(tree, "qm-standings-head"), (el) => el.type === "th").map(words);
const srOnly = (el: ReactElement<Record<string, unknown>>) => classOf(el).split(/\s+/).includes("sr-only");
/** The numeric header cells (each names its column in a `title`): what it prints, what a screen reader reads, its title. */
const numericHeads = (tree: ReactNode) =>
  all(oneByTestId(tree, "qm-standings-head"), (el) => el.type === "th" && el.props.title !== undefined).map((th) => ({
    shown: words(all(th, (el) => el.props["aria-hidden"] === "true")),
    heard: words(all(th, srOnly)),
    title: th.props.title,
  }));
/** The public table's own header, typed from its English dictionary as the mockup prints it: abbreviation and words. */
const head = (shown: string, heard: string) => ({ shown, heard, title: heard });
/** Each table row as printed: its place, its name, its numeric cells. */
const tableRowsOf = (tree: ReactNode) =>
  byTestId(tree, "qm-standings-row").map((r) => [
    words(all(all(r, (el) => el.type === "td")[0], (el) => el.props["aria-hidden"] === "true")[0] ?? all(r, (el) => el.type === "td")[0]),
    words(all(r, (el) => el.type === "th")[0]),
    ...byTestId(r, "qm-cell").map(words),
  ]);
/** The landmarks: the banner (the header) sits outside the one `main`, so a screen reader can jump between them. */
function expectBannerOutsideMain(tree: ReactNode) {
  const mains = all(tree, (el) => el.type === "main");
  expect(mains, "one main landmark").toHaveLength(1);
  expect(all(mains[0], (el) => el.type === "header"), "the header is not inside main").toHaveLength(0);
  expect(all(tree, (el) => el.type === "header"), "one banner").toHaveLength(1);
}

async function renderPage(token: string): Promise<{ tree: ReactNode; html: string; flight: string }> {
  const raw = await QuickMatchHomePage({ params: Promise.resolve({ token }) });
  const tree = await expand(raw as ReactNode);
  return { tree, html: renderToStaticMarkup(<>{tree}</>), flight: flightOf(tree) };
}

// ── the quick matches ──────────────────────────────────────────────────────────────────────────────────────────────

let BADMINTON_V: string;
/** Football's offer, read from the real catalog: a team sport whose league match can end level (B5d). */
let FOOTBALL: { variant: string; kind: CreateQuickMatch["kind"] };
/** Chess's offer (the catalog's `boardgame`), read from the real catalog: FIDE's half-point table (win 1, draw ½). */
let CHESS: { variant: string; kind: CreateQuickMatch["kind"] };

beforeAll(async () => {
  if (!HAS_DB) return;
  const [row] = await sql<{ key: string }[]>`
    select key from sport_variants where sport_key = 'badminton' and is_system and org_id is null order by key limit 1`;
  if (!row) throw new Error("no system badminton variant: run `npm run sync:sports` against this database");
  BADMINTON_V = row.key;
  const football = (await listQuickMatchSports()).find((s) => s.sport_key === "football");
  if (!football) throw new Error("football is not offered on this database: run `npm run sync:sports`");
  FOOTBALL = { variant: football.variants[0]!.variant_key, kind: football.kinds[0]! };
  const chess = (await listQuickMatchSports()).find((s) => s.sport_key === "boardgame");
  if (!chess) throw new Error("chess is not offered on this database: run `npm run sync:sports`");
  CHESS = { variant: chess.variants[0]!.variant_key, kind: chess.kinds[0]! };
});

afterAll(async () => {
  vi.unstubAllEnvs();
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

/** Four badminton pairs, a single round robin, each call its own quick match (pre-flight A16). */
const league = (over: Partial<CreateQuickMatch> = {}): CreateQuickMatch => ({
  name: `QM home ${randomUUID().slice(0, 8)}`,
  sport_key: "badminton",
  variant_key: BADMINTON_V,
  kind: "pair",
  format: "league",
  sides: SIDES,
  plays: 1,
  email: null,
  locale: "en",
  ...over,
});
const create = (input: CreateQuickMatch) => {
  // An email's link mail needs the origin (plan 3's create); held in a variable so the call fits either signature.
  const ctx = { visitorHash: hashVisitorKey(mintVisitorKey()), baseUrl: "https://seazn.example" };
  return createQuickMatchAnyFormat(input, ctx);
};
async function homeOf(out: CreatedQuickMatch): Promise<QuickMatchHome> {
  const row = await resolveQuickMatchToken(out.token);
  const home = row ? await readQuickMatchHome(row) : null;
  if (!home) throw new Error(`precondition: quick match ${out.id} reads`);
  return home;
}
/** D12's match number, from the plan-1 read's own order: the 1-based index among non-bye fixtures. */
const matchNumbers = (h: QuickMatchHome) => new Map(h.fixtures.filter((f) => !f.isBye).map((f, i) => [f.id, i + 1]));

/** The view's copy, built as the page builds it, from the dictionaries. */
const enCopy = (): QuickMatchCopy => ({
  locale: "en",
  t: (k, v) => tRuntime(en, k, v),
  plural: (k, n, v) => pluralRuntime(en, k, n, "en", v),
  levels: levelWords(enPublic),
  pub: (k, v) => tRuntime(enPublic, k, v),
});
/** The slots T6, T7 and T8 (and plan 4 T4) fill: here, stand-ins that say where they were put. */
const stubSlots = () => ({
  score: vi.fn((f: { id: string; live: boolean }, place: "hero" | "row") => (
    <span data-testid="slot-score" data-fixture-id={f.id} data-live={String(f.live)} data-place={place} />
  )),
  // Plan 4 Task 4: one row's ⋯ menu, handed what the row offers.
  rowMenu: vi.fn((r: RowMenuRequest) => (
    <span data-testid="slot-row-menu" data-fixture-id={r.fixtureId} data-items={r.items.map((i) => i.kind).join(",")} />
  )),
  share: <span data-testid="slot-share" />,
  // Task 8: handed what "Add a match" offers (every side, and the two its selects open at).
  addMatch: vi.fn((v: AddMatchView) => (
    <span data-testid="slot-add-match" data-home={v.home} data-away={v.away} data-sides={v.sides.map((s) => s.id).join(",")} />
  )),
});
async function renderView(home: QuickMatchHome, slots = stubSlots(), fullTable: FullTableData | null = null) {
  const tree = await expand(<QuickMatchHomeView home={home} copy={enCopy()} slots={slots} fullTable={fullTable} />);
  return { tree, slots };
}

// ── the modules ───────────────────────────────────────────────────────────────────────────────────────────────────────

describe("the home's modules", () => {
  it("are server components (no `use client`), so `expand` renders them as the server does; the export set is not empty", () => {
    let checked = 0;
    for (const file of SERVER_FILES) {
      const text = fs.readFileSync(file, "utf8");
      expect(text.trimStart().startsWith('"use client"'), file).toBe(false);
      checked++;
    }
    expect(checked).toBe(5);
    expect(SERVER.size).toBeGreaterThanOrEqual(5);
  });
});

// ── the empty case first ──────────────────────────────────────────────────────────────────────────────────────────────

describe("the empty case: a quick match with no match left", () => {
  // A state no producer makes (plan 1's read answers it too): two sides and no fixture. The table is as the producer
  // stores an unplayed one (review m2): every row `level`, positional ranks, the tie unbroken and split by seed.
  const empty: QuickMatchHome = {
    row: {
      id: "qm-1", competitionId: "c-1", name: "Empty", format: "league", email: null, locale: "en",
      lastActivityAt: new Date(), expiresAt: new Date(), savedByUserId: null, tokenEnc: new Uint8Array(),
    },
    divisionId: "d-1",
    stageId: "s-1",
    sport: { key: "badminton", labelKey: "sport.badminton" },
    kind: "pair",
    kindChosen: true,
    sides: [{ entrantId: "e-1", name: "One" }, { entrantId: "e-2", name: "Two" }],
    fixtures: [],
    next: null,
    played: 0,
    notPlayed: 0,
    total: 0,
    standings: {
      stage_id: "s-1", pool_id: null, computed_through_seq: 0, updated_at: null,
      rows: ["e-1", "e-2"].map((entrantId, i, ids) => ({
        entrantId, played: 0, won: 0, drawn: 0, lost: 0, points: 0, metrics: {}, rank: i + 1, level: true, tieUnbroken: true,
        tieBreak: { key: "seed", note: "h2h_incomplete", with: ids.filter((x) => x !== entrantId) },
      })),
    },
    pointsUnit: "whole",
    tableRules: null,
    metricSpecs: [],
    finished: false,
  };

  it("shows no hero, no winner card and no match row; the table lists both sides with no leader", async () => {
    const { tree, slots } = await renderView(empty);
    expect(byTestId(tree, "qm-hero")).toHaveLength(0);
    expect(byTestId(tree, "qm-winner")).toHaveLength(0);
    expect(byTestId(tree, "qm-match")).toHaveLength(0);
    expect(slots.score).not.toHaveBeenCalled();
    const rows = byTestId(tree, "qm-standings-row");
    expect(rows.map(words)).toEqual([expect.stringContaining("One"), expect.stringContaining("Two")]);
    expect(rows.filter((r) => r.props["data-leader"] === "true"), "a level table has no leader").toHaveLength(0);
    // The engine's level place (`LEVEL_RANK`), never the stored positional 1 and 2; a screen reader hears the words.
    expect(tableRowsOf(tree).map((r) => r[0])).toEqual([LEVEL_RANK, LEVEL_RANK]);
    for (const r of rows) expect(words(all(r, srOnly))).toBe(pub_("table.level"));
    expect(words(oneByTestId(tree, "qm-played"))).toBe(enPlayed(0, 0));
  });

  it("a SAVED match (no expiry) says how many are played and never 'kept N days'; the unsaved one still does (A-I3)", async () => {
    // The spec's copy: a saved quick match is kept until its owner deletes it (plan 3 Task 2), so no countdown is true of it.
    const saved = (played: number, total: number): QuickMatchHome => ({
      ...empty,
      row: { ...empty.row, expiresAt: null, savedByUserId: "u-1" },
      played,
      total,
    });
    const cases: [number, number, string][] = [
      [1, 3, "1 of 3 matches played"],
      [1, 1, "1 of 1 match played"],
      [0, 0, "0 of 0 matches played"],
    ];
    for (const [played, total, line] of cases) {
      const { tree } = await renderView(saved(played, total));
      expect(words(oneByTestId(tree, "qm-played")), `${played}/${total}`).toBe(line);
    }
    expect(cases).toHaveLength(3);
    // The positive pair: the same counts, unsaved, carry the spec's 7 days.
    const { tree } = await renderView({ ...empty, played: 1, total: 3 });
    expect(words(oneByTestId(tree, "qm-played"))).toBe(enPlayed(1, 3));
    expect(enPlayed(1, 3)).toContain(`${SPEC_EXPIRY_DAYS} days`);
  });

  it("under Save, an unsaved match names the DAY it is deleted, in the viewer's language; a saved one, and one with no expiry, name none (owner 2026-11-12)", async () => {
    // 10:00 UTC, 19 November 2026. The owner's words, the date as the page's public dates read: day-month in English.
    const at = new Date("2026-11-19T10:00:00.000Z");
    const saveSlot = () => ({ ...stubSlots(), save: <form data-testid="slot-save" /> });
    const view = (row: Partial<QuickMatchHome["row"]>, viewerId: string | null, copy = enCopy()) =>
      expand(<QuickMatchHomeView home={{ ...empty, row: { ...empty.row, ...row } }} copy={copy} slots={saveSlot()} viewerId={viewerId} />);
    const frCopy: QuickMatchCopy = { ...enCopy(), locale: "fr", t: (k, v) => tRuntime(fr, k, v) };

    const unsaved = await view({ expiresAt: at, savedByUserId: null }, null);
    // Review I1: the day is the guest's own (a client island names it in the browser's zone, `deletion-line.test.tsx`). The
    // server ships the island the row's instant, the page's language and the raw line; its own HTML names the never-late
    // day, the UTC day of expires_at − 14h: 10:00Z on the 19th − 14h = 20:00Z on the 18th.
    const line = deletionLineOf(unsaved);
    expect(line, "an unsaved match with an expiry shows the line").not.toBeNull();
    expect(line!.el.props).toEqual({ expiresAt: "2026-11-19T10:00:00.000Z", lang: "en", line: en["quickMatch.home.notSaved"] });
    expect(line!.served).toBe("Not saved — deleted on 18 November 2026");
    // Under Save: in the actions row, after the Save form in document order.
    const order = all(
      oneByTestId(unsaved, "qm-actions"),
      (el) => el.props["data-testid"] === "slot-save" || el.type === QuickMatchDeletionLine,
    );
    expect(order.map((el) => (el.type === QuickMatchDeletionLine ? "deletion-line" : el.props["data-testid"]))).toEqual([
      "slot-save",
      "deletion-line",
    ]);
    const frLine = deletionLineOf(await view({ expiresAt: at, savedByUserId: null }, null, frCopy));
    expect(frLine!.el.props).toEqual({ expiresAt: "2026-11-19T10:00:00.000Z", lang: "fr", line: fr["quickMatch.home.notSaved"] });
    expect(frLine!.served).toBe("Non enregistré — sera supprimé le 18 novembre 2026");

    // No line: the saver looking (Saved), anyone else looking at a saved match (no Save at all), and a match nobody holds
    // that has no expiry (its saver's account was deleted: `saved_by_user_id` is ON DELETE SET NULL and `expires_at` stays
    // null, so Save is offered again but nothing will delete it).
    const none: [string, Awaited<ReturnType<typeof view>>, boolean][] = [
      ["the saver", await view({ expiresAt: null, savedByUserId: "u-1" }, "u-1"), false],
      ["someone else, a saved match", await view({ expiresAt: null, savedByUserId: "u-1" }, null), false],
      ["nobody holds it, no expiry", await view({ expiresAt: null, savedByUserId: null }, null), true],
    ];
    for (const [who, tree, offersSave] of none) {
      expect(deletionLineOf(tree), who).toBeNull();
      expect(byTestId(tree, "slot-save"), `${who}: Save offered`).toHaveLength(offersSave ? 1 : 0);
    }
    expect(none).toHaveLength(3);
  });

  it("a settled match's score reads winner first from the engine's per-side lines; the headline only when they name no pair (h2)", async () => {
    const side = (n: number) => ({ entrantId: `e-${n}`, name: `Side ${n}` });
    // A goal sport (no set table): the away side won 0-1, so winner first is "1–0" and the stored order is wrong.
    const settled = (summary: unknown, winnerEntrantId: string): QuickMatchFixture => ({
      id: "f-1", roundNo: 1, fixtureNo: 1, seqInRound: 1, home: side(1), away: side(2), homeSlotLabel: null, awaySlotLabel: null,
      status: "decided", summary, isBye: false, isFinal: false, winnerEntrantId, phase: "settled", resultMovedOn: false,
    });
    const football = (f: QuickMatchFixture): QuickMatchHome => ({
      ...empty, sport: { ...empty.sport, key: "football", labelKey: "sport.football" }, fixtures: [f], played: 1, total: 1,
    });
    const scoreOf = async (f: QuickMatchFixture) => words(oneByTestId((await renderView(football(f))).tree, "qm-match-score"));
    const perSide = [{ entrantId: "e-1", line: "0" }, { entrantId: "e-2", line: "1" }];
    let checked = 0;
    expect(await scoreOf(settled({ headline: "0–1", perSide }, "e-2"))).toBe("1–0");
    checked++;
    expect(await scoreOf(settled({ headline: "1–0", perSide: perSide.map((p) => ({ ...p, line: p.line === "0" ? "1" : "0" })) }, "e-1"))).toBe("1–0");
    checked++;
    // perSide naming only one side, or another match's sides: the published headline, as it stands.
    for (const partial of [[perSide[0]], [{ entrantId: "e-8", line: "1" }, { entrantId: "e-9", line: "0" }], []]) {
      expect(await scoreOf(settled({ headline: "0–1", perSide: partial }, "e-2")), JSON.stringify(partial)).toBe("0–1");
      checked++;
    }
    expect(checked).toBe(5);
  });

  it("each row's ⋯ menu offers what its phase allows (owner 2026-11-13): Score and Not played to play, Edit result when settled, Put back when Not played; Score itself only on the hero and a playable row", async () => {
    const side = (n: number) => ({ entrantId: `e-${n}`, name: `Side ${n}` });
    const fx = (id: string, n: number, over: Partial<QuickMatchFixture>): QuickMatchFixture => ({
      id, roundNo: 1, fixtureNo: n, seqInRound: n, home: side(1), away: side(2), homeSlotLabel: null, awaySlotLabel: null,
      status: "decided", summary: null, isBye: false, isFinal: false, winnerEntrantId: "e-1", phase: "settled", resultMovedOn: false,
      ...over,
    });
    const fixtures = [
      fx("f-open", 1, {}),
      fx("f-moved", 2, { resultMovedOn: true }),
      fx("f-off", 3, { status: "abandoned", winnerEntrantId: null }),
      fx("f-ready", 4, { status: "scheduled", winnerEntrantId: null, phase: "ready" }),
      fx("f-live", 5, { status: "in_play", winnerEntrantId: null, phase: "live" }),
      fx("f-skipped", 6, { status: "cancelled", winnerEntrantId: null, phase: "notPlayed" }),
    ];
    // 3 settled + 1 Not played of 6: open.
    const { slots } = await renderView({ ...empty, fixtures, next: fixtures[4]!, played: 3, notPlayed: 1, total: 6 });
    const menus = slots.rowMenu.mock.calls.map(([r]) => `${r.fixtureId}:${r.items.map((i) => i.kind).join("+")}`).sort();
    expect(menus).toEqual(["f-live:score+skip", "f-off:edit", "f-open:edit", "f-ready:score+skip", "f-skipped:putBack"]);
    // Each request names its match as the row does (the ⋯'s accessible name) and carries D12's number.
    for (const [r] of slots.rowMenu.mock.calls) {
      expect([r.home, r.away], r.fixtureId).toEqual(["Side 1", "Side 2"]);
      expect(r.n, r.fixtureId).toBe(fixtures.findIndex((f) => f.id === r.fixtureId) + 1);
    }
    // Score is the hero's and the playable rows' (never a settled row's: "Edit result" is in the menu now).
    const asked = slots.score.mock.calls.map(([f, place]) => `${f.id}:${place}`).sort();
    expect(asked).toEqual(["f-live:hero", "f-live:row", "f-ready:row"]);
    // The empty case: nothing to offer, nothing asked.
    const none = await renderView({ ...empty, fixtures: [fixtures[1]!], next: null, played: 1, total: 1, finished: true });
    expect(none.slots.rowMenu).not.toHaveBeenCalled();
    expect(byTestId(none.tree, "slot-row-menu")).toHaveLength(0);
    // A knockout (P12, legacy rows: a bracket needs a winner): its playable rows draw no menu; a settled one keeps Edit result.
    const ko = await renderView({
      ...empty, row: { ...empty.row, format: "knockout" }, standings: null,
      fixtures: [fixtures[0]!, fixtures[3]!, fixtures[4]!], next: fixtures[4]!, played: 1, total: 3,
    });
    expect(ko.slots.rowMenu.mock.calls.map(([r]) => `${r.fixtureId}:${r.items.map((i) => i.kind).join("+")}`)).toEqual(["f-open:edit"]);
    expect(ko.slots.score.mock.calls.map(([f, place]) => `${f.id}:${place}`).sort()).toEqual(["f-live:hero", "f-live:row", "f-ready:row"]);
  });

  // Task 8 (C5): "Add a match" is the decider a level top asks for, so it opens at the stored table's top two, in the
  // table's own order (the producer ranks it), never the typed order; before there is a table, at the first two typed.
  it("'Add a match' opens at the table's top two in the table's order, else the first two sides typed; one side gets none", async () => {
    const row0 = empty.standings!.rows[0] as object;
    const ranked = (ids: string[]) => ids.map((entrantId, i) => ({ ...row0, entrantId, rank: i + 1 }));
    const typed = [{ entrantId: "e-2", name: "Two" }, { entrantId: "e-3", name: "Three" }, { entrantId: "e-1", name: "One" }];
    const cases: [string, QuickMatchHome, { home: string; away: string }][] = [
      // The table's top two differ from the first two typed: the witness that the table, not the typing, decides.
      ["a table", { ...empty, sides: typed, standings: { ...empty.standings!, rows: ranked(["e-1", "e-3", "e-2"]) } }, { home: "e-1", away: "e-3" }],
      ["no table yet", { ...empty, sides: typed, standings: null }, { home: "e-2", away: "e-3" }],
    ];
    let checked = 0;
    for (const [name, home, pick] of cases) {
      const { tree, slots } = await renderView(home);
      expect(slots.addMatch, name).toHaveBeenCalledTimes(1);
      expect(slots.addMatch.mock.calls[0]![0], name).toEqual({
        sides: [{ id: "e-2", name: "Two" }, { id: "e-3", name: "Three" }, { id: "e-1", name: "One" }],
        ...pick,
      });
      expect(byTestId(tree, "slot-add-match"), name).toHaveLength(1);
      checked++;
    }
    expect(checked).toBe(2);
    // A lone side has no match to add (a state no create makes; the guard still holds): the slot is never asked.
    const lone: QuickMatchHome = { ...empty, sides: [empty.sides[0]!], standings: { ...empty.standings!, rows: ranked(["e-1"]) } };
    const { tree, slots } = await renderView(lone);
    expect(slots.addMatch).not.toHaveBeenCalled();
    expect(byTestId(tree, "slot-add-match")).toHaveLength(0);
  });

  // Assumptions are guards: two states plan 1's read never produces are named refusals, never a blank or a code.
  it("the Full table fold (owner 2026-11-12): none without the page's data or when it adds no column; offered closed when it does; a row it lacks is refused", async () => {
    // A knockout stores no table, so the page's builder has nothing to give; with nothing from the page there is no fold.
    expect(quickMatchFullTable({ standings: null, tableRules: null, metricSpecs: [] }, (k) => tRuntime(enPublic, k))).toBeNull();
    expect(byTestId((await renderView(empty)).tree, "qm-full-table")).toHaveLength(0);
    // The public table's columns over the same rows, but nothing the short table lacks: still no fold (nothing more to show).
    const same: FullTableData = {
      columns: ["played", "won", "points"].map((key) => ({ key, abbr: key, word: key })),
      cells: { "e-1": ["0", "0", "0"], "e-2": ["0", "0", "0"] },
    };
    expect(byTestId((await renderView(empty, stubSlots(), same)).tree, "qm-full-table")).toHaveLength(0);
    // One column more (L): the fold, closed on first paint, its rows the short table's in the same order.
    const more: FullTableData = {
      columns: [...same.columns, { key: "lost", abbr: "L", word: "Lost" }],
      cells: { "e-1": ["0", "0", "0", "0"], "e-2": ["1", "1", "1", "1"] },
    };
    const { tree } = await renderView(empty, stubSlots(), more);
    const fold = oneByTestId(tree, "qm-full-table");
    expect([fold.type, fold.props.open]).toEqual(["details", undefined]);
    expect(heard(oneByTestId(fold, "qm-full-table-toggle"))).toBe(en_("quickMatch.home.fullTable"));
    expect(byTestId(fold, "qm-full-table-row").map((r) => words(all(r, (el) => el.type === "th")[0]))).toEqual(["One", "Two"]);
    expect(byTestId(fold, "qm-full-table-row").map((r) => byTestId(r, "qm-full-cell").map(words))).toEqual([
      ["0", "0", "0", "0"],
      ["1", "1", "1", "1"],
    ]);
    // The guard: a row the page's table does not hold (or holds short) is refused, never a row of blanks.
    const lacking: FullTableData["cells"][] = [{ "e-1": more.cells["e-1"]! }, { "e-1": more.cells["e-1"]!, "e-2": ["1", "1", "1"] }];
    for (const cells of lacking) {
      await expect(renderView(empty, stubSlots(), { ...more, cells })).rejects.toThrow(QuickMatchHomeShapeError);
    }
  });

  it("refuses a table that names a side the quick match does not hold", async () => {
    const stray: QuickMatchHome = {
      ...empty,
      standings: { ...empty.standings!, rows: [...empty.standings!.rows, { ...(empty.standings!.rows[0] as object), entrantId: "e-9" }] },
    };
    await expect(renderView(stray)).rejects.toThrow(QuickMatchHomeShapeError);
    await expect(renderView(stray)).rejects.toThrow(/e-9/);
  });

  it("a settled match reads winner first, its games too; an abandoned one names no winner and no draw", async () => {
    const side = (n: number) => ({ entrantId: `e-${n}`, name: `Side ${n}` });
    // The summary's set table as the engine publishes it (`setBreakdown`'s declared shape): the AWAY side won both games,
    // so the right answer (winner first) differs from the stored order.
    const summary = { headline: "0–2", detail: { sets: [{ home: 15, away: 21, closed: true }, { home: 18, away: 21, closed: true }] } };
    const settled = (over: Partial<QuickMatchFixture>): QuickMatchFixture => ({
      id: "f-1", roundNo: 1, fixtureNo: 1, seqInRound: 1, home: side(1), away: side(2), homeSlotLabel: null, awaySlotLabel: null,
      status: "decided", summary, isBye: false, isFinal: false, winnerEntrantId: "e-2", phase: "settled", resultMovedOn: false,
      ...over,
    });
    const league = (f: QuickMatchFixture): QuickMatchHome => ({ ...empty, fixtures: [f], played: 1, total: 1 });
    const won = oneByTestId((await renderView(league(settled({})))).tree, "qm-match");
    expect(words(oneByTestId(won, "qm-match-sides"))).toBe(en_("quickMatch.home.result", { winner: "Side 2", loser: "Side 1" }));
    expect(words(oneByTestId(won, "qm-match-score"))).toBe("21–15 · 21–18");
    // The same match won by the home side reads in the stored order.
    const home = oneByTestId((await renderView(league(settled({ winnerEntrantId: "e-1", summary: { ...summary, detail: { sets: [{ home: 21, away: 15, closed: true }] } } })))).tree, "qm-match");
    expect(words(oneByTestId(home, "qm-match-score"))).toBe("21–15");
    // Abandoned with no winner: a settled match, but neither "beat" nor "drew".
    const off = oneByTestId((await renderView(league(settled({ status: "abandoned", winnerEntrantId: null })))).tree, "qm-match");
    expect(off.props["data-state"]).toBe("settled");
    expect(words(oneByTestId(off, "qm-match-sides"))).toBe(`Side 1 ${en_("quickMatch.home.versus")} Side 2`);
    expect(words(off)).not.toContain(en_("quickMatch.home.drawn", { a: "Side 1", b: "Side 2" }));
  });

  it("refuses a waiting seat whose label names no single feeder; the same seat naming one reads its feeder", async () => {
    const side = (n: number) => ({ entrantId: `e-${n}`, name: `Side ${n}` });
    const fixture = (over: Partial<QuickMatchFixture>): QuickMatchFixture => ({
      id: "f-1", roundNo: 1, fixtureNo: 1, seqInRound: 1, home: side(1), away: side(2), homeSlotLabel: null,
      awaySlotLabel: null, status: "scheduled", summary: null, isBye: false, isFinal: false, winnerEntrantId: null,
      phase: "ready", resultMovedOn: false, ...over,
    });
    const knockout = (label: unknown): QuickMatchHome => ({
      ...empty,
      row: { ...empty.row, format: "knockout" },
      standings: null,
      sides: [side(1), side(2), side(3)],
      fixtures: [
        fixture({}),
        fixture({ id: "f-2", roundNo: 2, fixtureNo: 2, isFinal: true, home: side(3), away: null, awaySlotLabel: label, phase: "waiting" }),
      ],
      total: 2,
    });
    // The positive pair: the label plan 1 writes resolves, and the seat names its feeder (the lone semi-final).
    const { tree } = await renderView(knockout({ key: "slot.winner_match", params: { round: 1, seq: 1 } }));
    const final = byTestId(tree, "qm-match").find((r) => r.props["data-fixture-id"] === "f-2")!;
    expect(words(final)).toContain(en_("quickMatch.home.winnerOfTheSemi"));
    let refused = 0;
    for (const label of [null, { key: "slot.winner_match", params: { round: 1, seq: 2 } }, { key: "slot.loser_match", params: { round: 1, seq: 1 } }]) {
      await expect(renderView(knockout(label)), JSON.stringify(label)).rejects.toThrow(QuickMatchHomeShapeError);
      refused++;
    }
    expect(refused).toBe(3);
  });

  // ── Not played (plan 4 Task 4) ─────────────────────────────────────────────────────────────────────────────────────
  //
  // A league's literals, counts typed by hand from the rows each case builds (never read back from `playedOf`), and the
  // expected words hand-typed in English where the line is assembled from more than one key (T1 review M1: an expected
  // value built from the same keys would mirror a wrong placeholder instead of catching it).
  describe("Not played (plan 4 Task 4)", () => {
    const side = (n: number) => ({ entrantId: `e-${n}`, name: `Side ${n}` });
    const fx = (id: string, n: number, over: Partial<QuickMatchFixture> = {}): QuickMatchFixture => ({
      id, roundNo: 1, fixtureNo: n, seqInRound: n, home: side(1), away: side(2), homeSlotLabel: null, awaySlotLabel: null,
      status: "scheduled", summary: null, isBye: false, isFinal: false, winnerEntrantId: null, phase: "ready", resultMovedOn: false,
      ...over,
    });
    const settled = (id: string, n: number) => fx(id, n, { status: "decided", winnerEntrantId: "e-1", phase: "settled" });
    const skipped = (id: string, n: number) => fx(id, n, { status: "cancelled", phase: "notPlayed" });
    const live = (id: string, n: number, headline: string) => fx(id, n, { status: "in_play", phase: "live", summary: { headline } });
    /** The table after side 1 won: a leader at rank 1 (not level), side 2 below it. */
    const leaderTable = {
      ...empty.standings!,
      rows: [
        { entrantId: "e-1", played: 2, won: 2, drawn: 0, lost: 0, points: 4, metrics: {}, rank: 1, level: false, tieUnbroken: false },
        { entrantId: "e-2", played: 2, won: 0, drawn: 0, lost: 2, points: 0, metrics: {}, rank: 2, level: false, tieUnbroken: false },
      ],
    };
    const homeWith = (fixtures: QuickMatchFixture[], counts: { played: number; notPlayed: number; finished: boolean }, over: Partial<QuickMatchHome> = {}): QuickMatchHome => ({
      ...empty,
      fixtures,
      next: fixtures.find((f) => f.phase === "live") ?? fixtures.find((f) => f.phase === "ready") ?? null,
      total: fixtures.length,
      ...counts,
      ...over,
    });
    const menuOf = (calls: [RowMenuRequest][], id: string) => calls.map(([r]) => r).find((r) => r.fixtureId === id);

    it("(b) a Not played row: its own state, the dashed mark, 'A v B' and the Not played label; Put back in its menu until the league finishes, then none", async () => {
      // Open: 1 played, 1 Not played, 1 to play, of 3.
      const open = await renderView(homeWith([settled("f-1", 1), skipped("f-2", 2), fx("f-3", 3)], { played: 1, notPlayed: 1, finished: false }));
      const row = byTestId(open.tree, "qm-match").find((r) => r.props["data-fixture-id"] === "f-2")!;
      expect(row.props["data-state"]).toBe("notPlayed");
      expect(classOf(row).split(/\s+/)).toContain("border-dashed");
      expect(words(oneByTestId(row, "qm-match-sides"))).toBe(`Side 1 ${en_("quickMatch.home.versus")} Side 2`);
      expect(words(oneByTestId(row, "qm-not-played"))).toBe("Not played");
      expect(menuOf(open.slots.rowMenu.mock.calls, "f-2")?.items).toEqual([{ kind: "putBack" }]);
      expect(byTestId(row, "slot-row-menu")).toHaveLength(1);
      expect(byTestId(row, "slot-score"), "a Not played match is never scored from the list").toHaveLength(0);
      // The positive pair of the dashed mark: a row still to play is not dashed.
      const ready = byTestId(open.tree, "qm-match").find((r) => r.props["data-fixture-id"] === "f-3")!;
      expect(classOf(ready).split(/\s+/)).not.toContain("border-dashed");
      // Finished (every match played or Not played): the label stays, Put back goes (§6), and so does its menu.
      const done = await renderView(homeWith([settled("f-1", 1), skipped("f-2", 2), skipped("f-3", 3)], { played: 1, notPlayed: 2, finished: true }, { standings: leaderTable }));
      const after = byTestId(done.tree, "qm-match").filter((r) => r.props["data-state"] === "notPlayed");
      expect(after.map((r) => r.props["data-fixture-id"])).toEqual(["f-2", "f-3"]);
      for (const r of after) {
        expect(words(oneByTestId(r, "qm-not-played"))).toBe("Not played");
        expect(byTestId(r, "slot-row-menu")).toHaveLength(0);
      }
      expect(done.slots.rowMenu.mock.calls.map(([r]) => r.fixtureId), "only the settled row keeps a menu (Edit result)").toEqual(["f-1"]);
    });

    it("(c) the played line names how many were not played and keeps the full total; saved or not; one match or many", async () => {
      const unsaved = (fixtures: QuickMatchFixture[], played: number, notPlayed: number) =>
        homeWith(fixtures, { played, notPlayed, finished: played + notPlayed === fixtures.length });
      const saved = (h: QuickMatchHome): QuickMatchHome => ({ ...h, row: { ...h.row, expiresAt: null, savedByUserId: "u-1" } });
      const three = [settled("f-1", 1), skipped("f-2", 2), fx("f-3", 3)];
      const cases: [string, QuickMatchHome, string][] = [
        ["1 of 3, 1 not played", unsaved(three, 1, 1), "1 of 3 matches played · 1 not played · deleted 7 days after the last score unless saved"],
        ["the same, saved", saved(unsaved(three, 1, 1)), "1 of 3 matches played · 1 not played"],
        ["one match, not played, saved", saved(unsaved([skipped("f-1", 1)], 0, 1)), "0 of 1 match played · 1 not played"],
        ["two not played", saved(unsaved([skipped("f-1", 1), skipped("f-2", 2)], 0, 2)), "0 of 2 matches played · 2 not played"],
      ];
      for (const [name, home, line] of cases) {
        expect(words(oneByTestId((await renderView(home)).tree, "qm-played")), name).toBe(line);
      }
      expect(cases).toHaveLength(4);
      // The positive pair: nothing Not played keeps the earlier line (no "· 0 not played").
      const none = await renderView(unsaved([settled("f-1", 1), fx("f-2", 2)], 1, 0));
      expect(words(oneByTestId(none.tree, "qm-played"))).toBe("1 of 2 matches played · deleted 7 days after the last score unless saved");
    });

    it("(d) finished by skips with matches played: the winner card says how many were played and not, no hero, the Final table with its note", async () => {
      const cases: [string, QuickMatchHome, string][] = [
        ["2 played, 1 not", homeWith([settled("f-1", 1), skipped("f-2", 2), settled("f-3", 3)], { played: 2, notPlayed: 1, finished: true }, { standings: leaderTable }), "Top of the table after 2 played matches. 1 match was not played."],
        ["1 played, 2 not", homeWith([settled("f-1", 1), skipped("f-2", 2), skipped("f-3", 3)], { played: 1, notPlayed: 2, finished: true }, { standings: leaderTable }), "Top of the table after 1 played match. 2 matches were not played."],
      ];
      for (const [name, home, note] of cases) {
        const { tree } = await renderView(home);
        const card = oneByTestId(tree, "qm-winner");
        expect(words(oneByTestId(card, "qm-winner-kicker")), name).toBe(en_("quickMatch.home.winner"));
        // `empty`'s sides: e-1 is "One", the leader of `leaderTable`.
        expect(byTestId(card, "qm-winner-name").map(words), name).toEqual(["One"]);
        expect(words(oneByTestId(card, "qm-winner-note")), name).toBe(note);
        expect(byTestId(tree, "qm-hero"), name).toHaveLength(0);
        expect(words(oneByTestId(tree, "qm-standings-title")), name).toBe("Final table");
        expect(words(oneByTestId(tree, "qm-standings-note")), name).toBe("Counts played matches only");
        expect(byTestId(tree, "qm-no-play"), name).toHaveLength(0);
      }
      expect(cases).toHaveLength(2);
      // The positive pair: finished with every match played has no note; still open, the table is "Standings".
      const allPlayed = await renderView(homeWith([settled("f-1", 1), settled("f-2", 2)], { played: 2, notPlayed: 0, finished: true }, { standings: leaderTable }));
      expect(byTestId(allPlayed.tree, "qm-winner-note")).toHaveLength(0);
      expect(words(oneByTestId(allPlayed.tree, "qm-standings-title"))).toBe("Final table");
      const open = await renderView(homeWith([settled("f-1", 1), fx("f-2", 2)], { played: 1, notPlayed: 0, finished: false }, { standings: leaderTable }));
      expect(words(oneByTestId(open.tree, "qm-standings-title"))).toBe("Standings");
      expect(byTestId(open.tree, "qm-winner")).toHaveLength(0);
    });

    it("(e) finished with nothing played: 'No matches were played' and a new quick match, no table, no winner, no hero", async () => {
      const cases: [string, QuickMatchHome, string][] = [
        ["three", homeWith([skipped("f-1", 1), skipped("f-2", 2), skipped("f-3", 3)], { played: 0, notPlayed: 3, finished: true }), "All 3 matches were marked Not played, so there is no winner."],
        ["the only one", homeWith([skipped("f-1", 1)], { played: 0, notPlayed: 1, finished: true }), "The only match was marked Not played, so there is no winner."],
      ];
      for (const [name, home, hint] of cases) {
        const { tree, slots } = await renderView(home);
        const card = oneByTestId(tree, "qm-no-play");
        expect(words(oneByTestId(card, "qm-no-play-kicker")), name).toBe("League finished");
        expect(words(oneByTestId(card, "qm-no-play-title")), name).toBe("No matches were played");
        expect(words(oneByTestId(card, "qm-no-play-hint")), name).toBe(hint);
        const start = oneByTestId(card, "qm-no-play-start");
        // The viewer's own setup page (`/<lang>/play`, the dead link's way on), in the dead link's words.
        expect([start.type, start.props.href, words(start)], name).toEqual(["a", "/en/play", "Start a new quick match"]);
        expect(byTestId(tree, "qm-standings"), name).toHaveLength(0);
        expect(byTestId(tree, "qm-winner"), name).toHaveLength(0);
        expect(byTestId(tree, "qm-hero"), name).toHaveLength(0);
        // Every match listed, Not played, with no Put back (the league is finished).
        expect(byTestId(tree, "qm-match").map((r) => r.props["data-state"]), name).toEqual(home.fixtures.map(() => "notPlayed"));
        expect(slots.rowMenu, name).not.toHaveBeenCalled();
      }
      expect(cases).toHaveLength(2);
      // The positive pair: Not played but not finished is no "no play" (the table stays).
      const open = await renderView(homeWith([skipped("f-1", 1), fx("f-2", 2)], { played: 0, notPlayed: 1, finished: false }));
      expect(byTestId(open.tree, "qm-no-play")).toHaveLength(0);
      expect(byTestId(open.tree, "qm-standings")).toHaveLength(1);
    });

    it("(f) the table's note says it counts played matches only while a match is Not played, and only then", async () => {
      const withSkip = await renderView(homeWith([skipped("f-1", 1), fx("f-2", 2)], { played: 0, notPlayed: 1, finished: false }));
      expect(words(oneByTestId(withSkip.tree, "qm-standings-note"))).toBe("Counts played matches only");
      const without = await renderView(homeWith([fx("f-1", 1), fx("f-2", 2)], { played: 0, notPlayed: 0, finished: false }));
      expect(byTestId(without.tree, "qm-standings-note")).toHaveLength(0);
    });

    it("(g)(h) the confirm sheet's words: bodyLast on the last open match, body otherwise; a live match's score as the partial line", async () => {
      const copyOf = async (home: QuickMatchHome, id: string) => {
        const { slots } = await renderView(home);
        const item = menuOf(slots.rowMenu.mock.calls, id)?.items.find((i) => i.kind === "skip");
        if (!item || item.kind !== "skip") throw new Error(`premise: ${id} offers Not played`);
        return item.copy;
      };
      const title = en_("quickMatch.skip.title", { home: "Side 1", away: "Side 2" });
      expect(title).toBe("Skip Side 1 v Side 2?");
      const cases: [string, QuickMatchHome, string, keyof typeof en][] = [
        // The only match left after one played: skipping it finishes the league.
        ["last after a played one", homeWith([settled("f-1", 1), fx("f-2", 2)], { played: 1, notPlayed: 0, finished: false }), "f-2", "quickMatch.skip.bodyLast"],
        // A Not played match counts as done, so the one beside it is the last.
        ["last after a Not played one", homeWith([skipped("f-1", 1), fx("f-2", 2)], { played: 0, notPlayed: 1, finished: false }), "f-2", "quickMatch.skip.bodyLast"],
        // A one-match league: its only match is the last (Review Focus 4: a mis-tap is warned).
        ["a one-match league", homeWith([fx("f-1", 1)], { played: 0, notPlayed: 0, finished: false }), "f-1", "quickMatch.skip.bodyLast"],
        ["two still to play", homeWith([settled("f-1", 1), fx("f-2", 2), fx("f-3", 3)], { played: 1, notPlayed: 0, finished: false }), "f-2", "quickMatch.skip.body"],
        ["one live, one ready", homeWith([live("f-1", 1, "8–5"), fx("f-2", 2)], { played: 0, notPlayed: 0, finished: false }), "f-2", "quickMatch.skip.body"],
      ];
      for (const [name, home, id, body] of cases) {
        const c = await copyOf(home, id);
        expect(c.title, name).toBe(title);
        expect(c.body, name).toBe(en[body]);
        expect(c.partial, `${name}: nothing scored`).toBeNull();
      }
      expect(cases).toHaveLength(5);
      expect(en["quickMatch.skip.bodyLast"]).not.toBe(en["quickMatch.skip.body"]);
      // (h) A live match: its score as it stands, in the partial line; the last open one gets bodyLast too.
      const c = await copyOf(homeWith([settled("f-1", 1), live("f-2", 2, "8–5")], { played: 1, notPlayed: 0, finished: false }), "f-2");
      expect(c.partial).toBe("8–5 is already scored. It will not count in the table; it stays in the match history.");
      expect(c.body).toBe(en["quickMatch.skip.bodyLast"]);
    });

    it("(i) the home's flash for the skip routes' refusals: a match with a result, a finished league, a match marked Not played", () => {
      const cases: [string, string][] = [
        [QUICK_MATCH_ERRORS.NOT_SKIPPABLE, "quickMatch.flash.notSkippable"],
        [QUICK_MATCH_ERRORS.LEAGUE_FINISHED, "quickMatch.flash.leagueFinished"],
        [QUICK_MATCH_ERRORS.NOT_PLAYED, "quickMatch.flash.notPlayed"],
      ];
      for (const [code, key] of cases) {
        expect(homeFlash(code), code).toEqual({ key, tone: "refusal" });
        expect(homeFlash(code)!.key, `${code} is not the generic line`).not.toBe("quickMatch.flash.generic");
      }
      expect(cases).toHaveLength(3);
    });

    it("(j) the list's order: still to play first, then Not played, then finished, each in play order", async () => {
      const fixtures = [settled("f-1", 1), skipped("f-2", 2), fx("f-3", 3), settled("f-4", 4), skipped("f-5", 5), live("f-6", 6, "1–0")];
      const { tree } = await renderView(homeWith(fixtures, { played: 2, notPlayed: 2, finished: false }));
      expect(byTestId(tree, "qm-match").map((r) => r.props["data-fixture-id"])).toEqual(["f-3", "f-6", "f-2", "f-5", "f-1", "f-4"]);
      expect(byTestId(tree, "qm-match").map((r) => words(oneByTestId(r, "qm-match-no"))), "D12's numbers follow the match").toEqual(["3", "6", "2", "5", "1", "4"]);
    });
  });
});

// ── the page ──────────────────────────────────────────────────────────────────────────────────────────────────────────

describe.skipIf(!HAS_DB)("the quick match home page", () => {
  it("a fresh league of 4: 0 of 6 played, match 1 up next, a table of 4, six matches to play", async () => {
    locale.value = "en";
    const input = league();
    const out = await create(input);
    const { tree, html } = await renderPage(out.token);

    // The rulebook: a single round robin of 4 is 4·3/2 = 6 matches.
    expect(words(oneByTestId(tree, "qm-played"))).toBe(enPlayed(0, 6));
    expect(words(oneByTestId(tree, "qm-eyebrow"))).toBe(
      [en_("sport.badminton"), en_("quickMatch.kind.pair"), en_("quickMatch.format.league")].join(" · "),
    );
    expect(words(oneByTestId(tree, "qm-name"))).toBe(input.name);

    // The hero names match 1's sides, as the generator stored them (round, then the division's fixture number).
    const [first] = await sql<{ home: string; away: string }[]>`
      select h.display_name as home, a.display_name as away
      from fixtures f join entrants h on h.id = f.home_entrant_id join entrants a on a.id = f.away_entrant_id
      where f.division_id = ${out.divisionId} order by f.round_no, f.fixture_no limit 1`;
    const hero = oneByTestId(tree, "qm-hero");
    expect(words(oneByTestId(hero, "qm-hero-kicker"))).toBe(en_("quickMatch.home.upNext", { n: 1, total: 6 }));
    expect(words(oneByTestId(hero, "qm-hero-home"))).toBe(first!.home);
    expect(words(oneByTestId(hero, "qm-hero-away"))).toBe(first!.away);
    expect(byTestId(tree, "qm-winner")).toHaveLength(0);

    const rows = byTestId(tree, "qm-standings-row");
    expect(rows).toHaveLength(4);
    expect(rows.filter((r) => r.props["data-leader"] === "true"), "nothing played: no leader yet").toHaveLength(0);
    // ... and no place: the stored table is LEVEL before a match counts (`isLevelTable`), so every place is the engine's
    // level dash, as the public table prints it, never the positional ranks the producer stores.
    expect(tableRowsOf(tree).map((r) => r[0])).toEqual([LEVEL_RANK, LEVEL_RANK, LEVEL_RANK, LEVEL_RANK]);
    // The mockup's columns, P then W then Pts (`resultColumns`' order), and no D before any draw; the place column is
    // named for a screen reader only, and each numeric column is named in words (review m5).
    expect(headCells(tree).slice(0, 2)).toEqual([en_("ladder.rank"), en_("quickMatch.home.sideCol")]);
    expect(numericHeads(tree)).toEqual([head("P", "Played"), head("W", "Won"), head("Pts", "Points")]);
    // The table is named by its visible heading; the banner sits outside main.
    const table = all(oneByTestId(tree, "qm-standings-short"), (el) => el.type === "table");
    expect(table.map((el) => el.props["aria-labelledby"])).toEqual([oneByTestId(tree, "qm-standings-title").props.id]);
    expect(oneByTestId(tree, "qm-standings-title").props.id).toBe("qm-standings-title");
    expectBannerOutsideMain(tree);

    const matches = byTestId(tree, "qm-match");
    expect(matches).toHaveLength(6);
    expect(matches.map((m) => m.props["data-state"])).toEqual(Array(6).fill("ready"));
    expect(matches.map((m) => words(oneByTestId(m, "qm-match-no")))).toEqual(["1", "2", "3", "4", "5", "6"]);
    expect(matches[0]!.props["data-next"], "the hero's match is marked in the list").toBe("true");
    expect(matches.slice(1).filter((m) => m.props["data-next"] === "true")).toHaveLength(0);

    // Plan 3 Task 5 (D13 lifted): an unsaved match offers Save, a plain post to the save route, to anyone.
    const save = oneByTestId(tree, "qm-save-form");
    expect([save.type, save.props.method, save.props.action]).toEqual(["form", "post", `/q/${out.token}/save/confirm`]);
    expect(words(oneByTestId(tree, "qm-save"))).toBe(en_("quickMatch.home.save"));
    expect(byTestId(tree, "qm-saved")).toHaveLength(0);
    // Owner 2026-11-12, review I1: under Save, the day this match is deleted. The island carries the row's own expiry; the
    // server's HTML names the never-late day, the UTC calendar day of expires_at − 14h, in en-GB words.
    const [expiry] = await sql<{ expires_at: Date | null }[]>`select expires_at from quick_matches where id = ${out.id}`;
    expect(expiry?.expires_at, "premise: an unsaved match has an expiry").toBeInstanceOf(Date);
    const early = new Date(expiry!.expires_at!.getTime() - 14 * 3_600_000);
    const day = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "long", year: "numeric" }).format(early);
    const line = deletionLineOf(tree);
    expect(line?.el.props.expiresAt).toBe(expiry!.expires_at!.toISOString());
    expect(line?.served).toBe(`Not saved — deleted on ${day}`);
    expect(byTestId(tree, "slot-score")).toHaveLength(0);
    expect(words(oneByTestId(tree, "qm-anyone"))).toBe(en_("quickMatch.home.anyoneCanScore"));
    expect(html).toContain(`<h2`);
    expect(words(oneByTestId(tree, "qm-standings-title"))).toBe(en_("quickMatch.home.standings"));
    expect(byTestId(tree, "qm-draw")).toHaveLength(0);
  });

  it("no index: the page's metadata says so, in the viewer's words", async () => {
    locale.value = "en";
    const meta = await generateMetadata();
    expect(meta.robots).toEqual({ index: false, follow: false });
    expect(meta.title).toBe(en_("quickMatch.home.title"));
  });

  it("an unknown, malformed, changed, expired or deleted token is the dead screen; the exact token, trimmed, is the home (Review Focus 3)", async () => {
    locale.value = "en";
    const out = await create(league({ sides: SIDES.slice(0, 2) }));
    const dead = async (token: string, why: string) => {
      const { tree, html } = await renderPage(token);
      const screen = oneByTestId(tree, "qm-dead-link");
      expect(words(oneByTestId(screen, "qm-dead-title")), why).toBe(en_("quickMatch.dead.title"));
      expect(words(oneByTestId(screen, "qm-dead-hint")), why).toBe(en_("quickMatch.dead.hint", { days: SPEC_EXPIRY_DAYS }));
      const start = oneByTestId(screen, "qm-dead-start");
      expect(start.props.href, why).toBe("/en/play");
      expect(words(start)).toBe(en_("quickMatch.dead.startNew"));
      expect(html, why).not.toContain("scan-dead-link");
      expect(byTestId(tree, "qm-home"), why).toHaveLength(0);
      expectBannerOutsideMain(tree);
    };
    const home = async (token: string, why: string) => {
      const { tree } = await renderPage(token);
      expect(byTestId(tree, "qm-dead-link"), why).toHaveLength(0);
      expect(words(oneByTestId(tree, "qm-name")), why).toBe(words(oneByTestId((await renderPage(out.token)).tree, "qm-name")));
    };
    // The positive pair first: the exact token, and the same token with stray whitespace around it.
    await home(out.token, "the exact token");
    await home(` ${out.token}\n`, "whitespace around the exact token is trimmed");

    await dead(mintHomeToken(), "a well-formed token no row holds");
    await dead("qm_short", "a malformed token");
    const upper = out.token.slice(0, 3) + out.token.slice(3).replace(/[a-z]/, (c) => c.toUpperCase());
    expect(upper, "premise: one letter changed case").not.toBe(out.token);
    await dead(upper, "a changed token (case is part of the token)");
    await dead(`${out.token}x`, "a token with a character more");

    await sql`update quick_matches set expires_at = now() - interval '1 day' where id = ${out.id}`;
    await dead(out.token, "an expired quick match");
    await sql`update quick_matches set expires_at = now() + interval '1 day' where id = ${out.id}`;
    await home(out.token, "re-armed, it is the home again");
    await hardDeleteQuickMatchCompetition(out.competitionId);
    await dead(out.token, "a deleted quick match");
  });

  it("the dead screen speaks the viewer's language and links to the viewer's setup page", async () => {
    locale.value = "fr";
    try {
      const { tree } = await renderPage(mintHomeToken());
      const screen = oneByTestId(tree, "qm-dead-link");
      expect(words(oneByTestId(screen, "qm-dead-title"))).toBe(fr_("quickMatch.dead.title"));
      expect(oneByTestId(screen, "qm-dead-start").props.href).toBe("/fr/play");
    } finally {
      locale.value = "en";
    }
  });

  it("the viewer's locale, never the creator's (D10): a French viewer of a match made in Spanish reads French", async () => {
    const { resolveLocale } = await import("@/lib/resolve-locale");
    locale.value = "fr";
    try {
      const out = await create(league({ locale: "es", sides: SIDES.slice(0, 2) }));
      vi.mocked(resolveLocale).mockClear();
      const { tree } = await renderPage(out.token);
      expect(vi.mocked(resolveLocale)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(resolveLocale).mock.calls[0]!.filter((a) => a !== undefined), "no orgDefault, no row locale").toEqual([]);
      expect(words(oneByTestId(tree, "qm-standings-title"))).toBe(fr_("quickMatch.home.standings"));
      expect(fr["quickMatch.home.standings"]).not.toBe(en["quickMatch.home.standings"]);
      expect(words(oneByTestId(tree, "qm-anyone"))).toBe(fr_("quickMatch.home.anyoneCanScore"));
    } finally {
      locale.value = "en";
    }
  });

  it("Share (Task 7): the island gets the home's own PATH and the viewer's words, in a provider of only its children's keys", async () => {
    const input = league({ sides: SIDES.slice(0, 2) });
    const out = await create(input);
    let checked = 0;
    for (const [lang, dict] of [["en", en], ["fr", fr]] as const) {
      locale.value = lang;
      try {
        const { tree, html } = await renderPage(out.token);
        const shares = all(tree, (el) => el.type === QuickMatchShare);
        expect(shares, lang).toHaveLength(1);
        // The PATH, never an absolute URL: the island puts it on the page's own origin (B7). The spec's home link, typed.
        expect(shares[0]!.props.path).toBe(`/q/${out.token}`);
        expect(shares[0]!.props.title).toBe(input.name);
        expect(shares[0]!.props.labels).toEqual({
          share: dict["quickMatch.home.share"],
          copy: dict["quickMatch.home.copy"],
          copied: dict["quickMatch.home.copied"],
          qrAlt: dict["quickMatch.home.qrAlt"],
          showQr: dict["dlink.showQr"],
          shareNative: tRuntime(dict, "quickMatch.home.shareNative", { name: input.name }),
        });
        // ShareButton and the QR read their own words (`useMsg`): a provider in the viewer's locale holds exactly the
        // `share.*` and `qr.*` keys, so they are not English on a French home, and the flight carries no whole dictionary.
        const providers = all(tree, (el) => el.type === DictProvider && all(el.props.children, (c) => c.type === QuickMatchShare).length > 0);
        expect(providers, lang).toHaveLength(1);
        const provided = providers[0]!.props as { dict: Record<string, string>; locale: string };
        expect(provided.locale).toBe(lang);
        const wanted = Object.keys(dict).filter((k) => k.startsWith("share.") || k.startsWith("qr.")).sort();
        expect(wanted, "anti-vacuity: ShareButton's two words and the QR's five").toEqual(
          expect.arrayContaining(["share.whatsapp", "share.copied", "qr.tapToEnlarge", "qr.enlarge", "qr.enlarged.close"]),
        );
        expect(Object.keys(provided.dict).sort()).toEqual(wanted);
        for (const key of wanted) expect(provided.dict[key], `${lang} ${key}`).toBe(dict[key as keyof typeof dict]);
        // The server's HTML: Copy on first paint (one tap, the ruling), the QR's toggle closed, all in the viewer's words;
        // and no absolute home link anywhere (the island puts the path on the browser's own origin).
        const tag = (id: string) => new RegExp(`<[a-z]+[^>]*data-testid="${id}"[^>]*>`).exec(html)?.[0] ?? "";
        expect(tag("qm-share-copy"), `${lang}: Copy on first paint`).not.toBe("");
        expect(html).toContain(`>${dict["quickMatch.home.copy"]}</button>`);
        expect(tag("qm-share-toggle")).toContain('aria-expanded="false"');
        expect(html).toContain(dict["dlink.showQr"]);
        expect(tag("qm-share-url")).toMatch(/class="[^"]*\bph-no-capture\b/);
        expect(html).not.toContain('data-testid="qm-share-panel"');
        expect(html).not.toMatch(/https?:\/\/[^"<\s]*\/q\//);
        checked++;
      } finally {
        locale.value = "en";
      }
    }
    expect(checked).toBe(2);
    expect(fr["share.whatsapp"], "the French pass witnesses a translation").not.toBe(en["share.whatsapp"]);
    // The dead screen offers no Share (D16: nothing to share).
    expect(all((await renderPage(mintHomeToken())).tree, (el) => el.type === QuickMatchShare)).toHaveLength(0);
    await hardDeleteQuickMatchCompetition(out.competitionId);
  });

  it("never ships the creator's email or the sealed token to the browser: not in the HTML, not in the flight (A14)", async () => {
    locale.value = "en";
    const email = `qm-${randomUUID().slice(0, 8)}@example.com`;
    const input = league({ email, sides: SIDES.slice(0, 2) });
    const out = await create(input);
    // The positive half first: the row the page reads DOES carry both, so their absence below is not vacuous.
    const row = await resolveQuickMatchToken(out.token);
    expect(row!.email).toBe(email);
    expect(row!.tokenEnc.byteLength).toBeGreaterThan(16);
    const enc = Buffer.from(row!.tokenEnc);

    const { html, flight } = await renderPage(out.token);
    expect(html).toContain(input.name);
    expect(html).toContain(SIDES[0]!.replace("&", "&amp;"));
    expect(flight).toContain(input.name);
    for (const [where, text] of [["html", html], ["flight", flight]] as const) {
      expect(text, `${where}: the email`).not.toContain(email);
      expect(text, `${where}: the email's local part`).not.toContain(email.split("@")[0]!);
      for (const form of [enc.toString("base64"), enc.toString("base64url"), enc.toString("hex"), Array.from(enc.subarray(0, 12)).join(",")]) {
        expect(text, `${where}: the sealed token`).not.toContain(form);
      }
    }
  });

  it("a knockout of 3: the draw with the bye marked, a lone 'Semi-final' with no number, the final waiting on it with no Score (C18, D12, ruling 11-08)", async () => {
    locale.value = "en";
    const out = await create(league({ format: "knockout", sides: SIDES.slice(0, 3) }));
    const h = await homeOf(out);
    const n = matchNumbers(h);
    const bye = h.fixtures.find((f) => f.isBye)!;
    const semi = h.fixtures.find((f) => !f.isBye && !f.isFinal)!;
    const final = h.fixtures.find((f) => f.isFinal)!;
    // The rulebook (§7.3): with 3 sides seed 1 sits out; the one first-round match is match 1, the final match 2.
    expect(n.get(semi.id)).toBe(1);
    expect(n.get(final.id)).toBe(2);
    expect(h.fixtures.filter((f) => f.roundNo === semi.roundNo && !f.isBye), "premise: the semi-final round has ONE match").toHaveLength(1);

    const { tree, slots } = await renderView(h);
    const draw = oneByTestId(tree, "qm-draw");
    expect(words(oneByTestId(draw, "qm-draw-title"))).toBe(en_("quickMatch.home.draw"));
    expect(byTestId(tree, "qm-standings")).toHaveLength(0);
    const cards = byTestId(draw, "qm-draw-card");
    expect(cards).toHaveLength(3);
    // The bye: marked, its holder named, and no round name (it is not a match, so it is not a second "Semi-final").
    const byeCard = cards.find((c) => c.props["data-fixture-id"] === bye.id)!;
    expect(byeCard.props["data-bye"]).toBe("true");
    expect(words(byeCard)).toContain(SIDES[0]!);
    expect(words(byeCard)).toContain(en_("bracket.slot.bye"));
    expect(byTestId(byeCard, "qm-draw-round")).toHaveLength(0);
    // Controller ruling 2026-11-08: a round with one match is not numbered. "Semi-final", never "Semi-final 1" or "2".
    const semiCard = cards.find((c) => c.props["data-fixture-id"] === semi.id)!;
    const semiName = words(oneByTestId(semiCard, "qm-draw-round"));
    expect(semiName).toBe("Semi-final");
    expect(semiName).toBe(en_("quickMatch.home.semiFinalOnly"));
    expect(semiName).not.toMatch(/\d/);
    const finalCard = cards.find((c) => c.props["data-fixture-id"] === final.id)!;
    expect(words(oneByTestId(finalCard, "qm-draw-round"))).toBe(en_("bracket.round.final"));
    expect(words(finalCard)).toContain(SIDES[0]!);   // the bye's holder is already seated in the final
    expect(words(finalCard)).toContain(en_("quickMatch.home.winnerOfTheSemi"));
    expect(words(finalCard)).not.toMatch(/\d/);
    // The waiting seat's words wrap (review m4); a named seat truncates, its positive pair.
    const finalNames = byTestId(finalCard, "qm-draw-name");
    const waiting = finalNames.find((el) => words(el) === en_("quickMatch.home.winnerOfTheSemi"))!;
    const named = finalNames.find((el) => words(el) === SIDES[0])!;
    expect(classOf(waiting).split(" ")).toContain("break-words");
    expect(classOf(waiting).split(" ")).not.toContain("truncate");
    expect(classOf(named).split(" ")).toContain("truncate");

    // The list: the bye is not a match; the final waits on "the semi-final" (the same words as the draw), with no Score.
    const rows = byTestId(tree, "qm-match");
    expect(rows.map((r) => r.props["data-fixture-id"])).toEqual([semi.id, final.id]);
    const finalRow = rows[1]!;
    expect(finalRow.props["data-state"]).toBe("waiting");
    expect(words(oneByTestId(finalRow, "qm-match-sides"))).toBe(
      `${SIDES[0]} ${en_("quickMatch.home.versus")} ${en_("quickMatch.home.winnerOfTheSemi")}`,
    );
    expect(words(finalRow)).toContain(en_("quickMatch.home.waits"));
    // The hero is the semi-final, unnumbered too; it and its row carry the Score slot, the waiting final none.
    expect(words(oneByTestId(tree, "qm-hero-kicker"))).toBe(en_("quickMatch.home.upNextRound", { round: "Semi-final" }));
    const placed = slots.score.mock.calls.map(([f, place]) => `${place}:${f.id}:${f.live}`).sort();
    expect(placed).toEqual([`hero:${semi.id}:false`, `row:${semi.id}:false`].sort());
    expect(byTestId(finalRow, "slot-score")).toHaveLength(0);
    // A knockout has no "Add a match" (C5), even when the slot is offered: the slot is never even asked.
    expect(byTestId(tree, "slot-add-match")).toHaveLength(0);
    expect(slots.addMatch).not.toHaveBeenCalled();
    expect(byTestId(tree, "slot-share")).toHaveLength(1);
    await hardDeleteQuickMatchCompetition(out.competitionId);
  });

  it("a knockout of 5: a lone 'Quarter-final', semi-finals 1 and 2, and every waiting seat in the draw's words; never a round code (D12, ruling 11-08)", async () => {
    locale.value = "en";
    const out = await create(league({ format: "knockout", sides: ["S1", "S2", "S3", "S4", "S5"] }));
    const h = await homeOf(out);
    const n = matchNumbers(h);
    expect(n.size).toBe(4);   // the rulebook: a knockout of 5 is 4 matches
    const rounds = [...new Set(h.fixtures.map((f) => f.roundNo))].sort((a, b) => a - b);
    const realIn = (r: number) => h.fixtures.filter((f) => f.roundNo === r && !f.isBye);
    // The rulebook: 5 sides in an 8-draw. Three seeds sit out, so ONE quarter-final is played; two semi-finals; the final.
    expect(rounds.map((r) => realIn(r).length)).toEqual([1, 2, 1]);
    const { tree } = await renderView(h);
    const html = renderToStaticMarkup(<>{tree}</>);
    expect(html, "no R1·2-style code reaches the guest").not.toMatch(/R\d+·\d+/);

    // Each match's card, by the ruling: the lone quarter unnumbered, the semis by their place among the round's matches.
    const nameOf = (id: string) => words(oneByTestId(byTestId(tree, "qm-draw-card").find((c) => c.props["data-fixture-id"] === id)!, "qm-draw-round"));
    const [qf] = realIn(rounds[0]!);
    const [sf1, sf2] = realIn(rounds[1]!);
    const [fin] = realIn(rounds[2]!);
    expect([nameOf(qf!.id), nameOf(sf1!.id), nameOf(sf2!.id), nameOf(fin!.id)]).toEqual(["Quarter-final", "Semi-final 1", "Semi-final 2", "Final"]);
    expect(byTestId(tree, "qm-draw-round")).toHaveLength(4);   // the three byes carry no round name

    // Every waiting seat, in the list and the draw alike: the lone quarter's winner unnumbered, a semi's by its number.
    const expectedFor = (feederId: string) =>
      feederId === qf!.id ? "Winner of the quarter-final" : feederId === sf1!.id ? "Winner of semi-final 1" : "Winner of semi-final 2";
    const feederOf = (label: unknown) => {
      const { round, seq } = (label as { params: { round: number; seq: number } }).params;
      return h.fixtures.find((f) => f.roundNo === Number(round) && f.seqInRound === Number(seq))!;
    };
    const said: string[] = [];
    for (const f of h.fixtures.filter((x) => !x.isBye)) {
      const row = byTestId(tree, "qm-match").find((r) => r.props["data-fixture-id"] === f.id)!;
      const card = byTestId(tree, "qm-draw-card").find((c) => c.props["data-fixture-id"] === f.id)!;
      for (const [side, label] of [[f.home, f.homeSlotLabel], [f.away, f.awaySlotLabel]] as const) {
        if (side !== null) continue;
        const words_ = expectedFor(feederOf(label).id);
        expect(words(row)).toContain(words_);
        expect(byTestId(card, "qm-draw-seat").map(words)).toContain(words_);
        said.push(words_);
      }
    }
    // The quarter-final's winner (one semi-final seat), and both seats of the final.
    expect(said.sort()).toEqual(["Winner of semi-final 1", "Winner of semi-final 2", "Winner of the quarter-final"]);
    await hardDeleteQuickMatchCompetition(out.competitionId);
  });

  it("a knockout of 6: quarter-finals 1 and 2, and each semi-final seat waits on 'Winner of quarter-final n', as its card is named (ruling m8)", async () => {
    locale.value = "en";
    const out = await create(league({ format: "knockout", sides: ["S1", "S2", "S3", "S4", "S5", "S6"] }));
    const h = await homeOf(out);
    const rounds = [...new Set(h.fixtures.map((f) => f.roundNo))].sort((a, b) => a - b);
    const realIn = (r: number) => h.fixtures.filter((f) => f.roundNo === r && !f.isBye);
    // The rulebook: 6 sides in an 8-draw. Two seeds sit out, so TWO quarter-finals are played; two semi-finals; the final.
    expect(rounds.map((r) => realIn(r).length)).toEqual([2, 2, 1]);
    const { tree } = await renderView(h);
    const cardOf = (id: string) => byTestId(tree, "qm-draw-card").find((c) => c.props["data-fixture-id"] === id)!;
    const [qf1, qf2] = realIn(rounds[0]!);
    expect([qf1, qf2].map((f) => words(oneByTestId(cardOf(f!.id), "qm-draw-round")))).toEqual(["Quarter-final 1", "Quarter-final 2"]);
    const expectedFor = (feederId: string) => (feederId === qf1!.id ? "Winner of quarter-final 1" : "Winner of quarter-final 2");
    const said: string[] = [];
    for (const f of realIn(rounds[1]!)) {
      const row = byTestId(tree, "qm-match").find((r) => r.props["data-fixture-id"] === f.id)!;
      for (const [side, label] of [[f.home, f.homeSlotLabel], [f.away, f.awaySlotLabel]] as const) {
        if (side !== null) continue;
        const { round, seq } = (label as { params: { round: number; seq: number } }).params;
        const feeder = h.fixtures.find((x) => x.roundNo === Number(round) && x.seqInRound === Number(seq))!;
        const text = expectedFor(feeder.id);
        expect(words(row)).toContain(text);
        expect(byTestId(cardOf(f.id), "qm-draw-name").map(words)).toContain(text);
        said.push(text);
      }
    }
    // One seat of each semi-final waits on a quarter-final (the other holds a seed with a bye).
    expect(said.sort()).toEqual(["Winner of quarter-final 1", "Winner of quarter-final 2"]);
    await hardDeleteQuickMatchCompetition(out.competitionId);
  });

  it("a decided knockout: the hero is the winner card, winners are marked in the draw, results read 'A beat B' (C15)", async () => {
    locale.value = "en";
    const out = await create(league({ format: "knockout", sides: SIDES.slice(0, 3) }));
    let h = await homeOf(out);
    const semi = h.next!;
    expect(await playToDecided(systemAuth(), semi.id)).toMatchObject({ kind: "decided" });
    h = await homeOf(out);
    const final = h.next!;
    expect(final.isFinal).toBe(true);
    expect(await playToDecided(systemAuth(), final.id)).toMatchObject({ kind: "decided" });

    const { tree, html } = await renderPage(out.token);
    h = await homeOf(out);
    expect(h.finished).toBe(true);   // precondition from the plan-1 read
    const done = h.fixtures.find((f) => f.id === final.id)!;
    const winnerName = h.sides.find((s) => s.entrantId === done.winnerEntrantId)!.name;
    expect(byTestId(tree, "qm-hero")).toHaveLength(0);
    const card = oneByTestId(tree, "qm-winner");
    expect(words(oneByTestId(card, "qm-winner-kicker"))).toBe(en_("quickMatch.home.winner"));
    expect(byTestId(card, "qm-winner-name").map(words)).toEqual([winnerName]);
    expect(words(oneByTestId(tree, "qm-played"))).toBe(enPlayed(2, 2));

    // Every match is settled and reads as a whole-sentence result, winner first.
    let checked = 0;
    for (const f of h.fixtures.filter((x) => !x.isBye)) {
      const row = byTestId(tree, "qm-match").find((r) => r.props["data-fixture-id"] === f.id)!;
      expect(row.props["data-state"]).toBe("settled");
      const [w, l] = f.home!.entrantId === f.winnerEntrantId ? [f.home!, f.away!] : [f.away!, f.home!];
      expect(words(oneByTestId(row, "qm-match-sides"))).toBe(en_("quickMatch.home.result", { winner: w.name, loser: l.name }));
      // The score line: badminton's games, each read winner first (the sentence's order), so the winner leads in more
      // of them than the loser does (the rulebook: a match is won by winning the majority of its games).
      const games = words(oneByTestId(row, "qm-match-score")).split(" · ").map((g) => g.split("–").map(Number));
      expect(games.length).toBeGreaterThanOrEqual(2);
      expect(games.every((g) => g.length === 2 && g.every(Number.isInteger)), JSON.stringify(games)).toBe(true);
      expect(games.filter(([a, b]) => a! > b!).length).toBeGreaterThan(games.filter(([a, b]) => a! < b!).length);
      // The draw marks the winner's line (in lime), and only it.
      const cardEl = byTestId(tree, "qm-draw-card").find((c) => c.props["data-fixture-id"] === f.id)!;
      const marked = byTestId(cardEl, "qm-draw-seat").filter((s) => s.props["data-winner"] === "true");
      expect(byTestId(marked[0], "qm-draw-name").map(words)).toEqual([w.name]);
      expect(classOf(marked[0]!)).toContain("text-[color:var(--mk-lime)]");
      // The score on the winner's line, as the list reads it (winner first); none on the loser's, none under the seats.
      const lineScores = byTestId(cardEl, "qm-draw-seat").map((s) => byTestId(s, "qm-draw-seat-score").map(words));
      expect(lineScores).toEqual(
        byTestId(cardEl, "qm-draw-seat").map((s) => (s === marked[0] ? [words(oneByTestId(row, "qm-match-score"))] : [])),
      );
      expect(byTestId(cardEl, "qm-draw-score")).toHaveLength(0);
      checked++;
    }
    expect(checked).toBe(2);
    expect(html).not.toContain(`data-state="ready"`);
    await hardDeleteQuickMatchCompetition(out.competitionId);
  });

  it("co-leaders with the SAME name (side names are not unique): the Level card names both, each under its own React key (final review A m-2)", async () => {
    // Server rendering never checks keys (React warns about a duplicate only when the client reconciles), so the keys are read
    // off the expanded tree. Same producer path as the level football case below, with the two sides typed alike.
    locale.value = "en";
    const out = await create(league({ sport_key: "football", variant_key: FOOTBALL.variant, kind: FOOTBALL.kind, sides: ["Sam", "Sam"] }));
    const only = (await homeOf(out)).next!;
    for (const [seq, req] of [
      { type: "core.start", payload: {} },
      { type: "football.period", payload: { phase: "HT" } },
      { type: "football.period", payload: { phase: "FT" } },
    ].entries()) {
      await scoreEvent(systemAuth(), only.id, { expected_seq: seq, ...req });
    }
    const h = await homeOf(out);
    expect(h.finished, "precondition: the one match is played").toBe(true);
    expect(h.fixtures[0]!.winnerEntrantId, "precondition: level, no winner").toBeNull();

    const { tree } = await renderPage(out.token);
    const card = oneByTestId(tree, "qm-winner");
    expect(words(oneByTestId(card, "qm-winner-kicker"))).toBe(en_("quickMatch.home.level"));
    const names = byTestId(card, "qm-winner-name");
    expect(names.map(words), "both co-leaders named, though their names are the same").toEqual(["Sam", "Sam"]);
    expect(names.every((n) => n.key !== null), "each name carries a key").toBe(true);
    expect(new Set(names.map((n) => n.key)).size, "and no two share one").toBe(names.length);
    await hardDeleteQuickMatchCompetition(out.competitionId);
  });

  it("football: a level league match reads 'drew', the table shows the draw, and a level top reads Level naming both (B5d)", async () => {
    locale.value = "en";
    const input = league({ sport_key: "football", variant_key: FOOTBALL.variant, kind: FOOTBALL.kind, sides: ["Blue team", "Red team"] });
    const out = await create(input);
    const h0 = await homeOf(out);
    const only = h0.next!;
    // Kick-off, half time, full time, no goal: a level 90 minutes (stage-defaults.test.ts's own sequence).
    for (const [seq, req] of [
      { type: "core.start", payload: {} },
      { type: "football.period", payload: { phase: "HT" } },
      { type: "football.period", payload: { phase: "FT" } },
    ].entries()) {
      await scoreEvent(systemAuth(), only.id, { expected_seq: seq, ...req });
    }
    const h = await homeOf(out);
    const settled = h.fixtures.find((f) => f.id === only.id)!;
    expect(settled.status, "precondition: a level league match is decided").toBe("decided");
    expect(settled.winnerEntrantId, "precondition: and names no winner").toBeNull();
    expect(h.finished).toBe(true);

    const { tree } = await renderPage(out.token);
    const row = oneByTestId(tree, "qm-match");
    expect(words(oneByTestId(row, "qm-match-sides"))).toBe(
      en_("quickMatch.home.drawn", { a: settled.home!.name, b: settled.away!.name }),
    );
    expect(words(row)).not.toContain(" beat ");
    // The table: D appears because a row holds a draw, each side one played, none won, one drawn, and the points the
    // stored table gave them (the producer's numbers, equal for a draw).
    const stored = (h.standings!.rows as { entrantId: string; points: number; drawn: number }[]);
    expect(stored.every((r) => r.drawn === 1)).toBe(true);
    expect(new Set(stored.map((r) => r.points)).size).toBe(1);
    expect(stored[0]!.points).toBeGreaterThan(0);
    expect(numericHeads(tree)).toEqual([head("P", "Played"), head("W", "Won"), head("D", "Drawn"), head("Pts", "Points")]);
    const tableRows = byTestId(tree, "qm-standings-row");
    expect(tableRows).toHaveLength(2);
    for (const r of tableRows) {
      expect(byTestId(r, "qm-cell").map(words)).toEqual(["1", "0", "1", String(stored[0]!.points)]);
    }
    // Co-leaders share the top place (a counted table, so no level dash).
    expect(tableRowsOf(tree).map((r) => r[0])).toEqual(["1", "1"]);
    // One kind for football (a team): the guest chose none, so the eyebrow names none (h1).
    expect(words(oneByTestId(tree, "qm-eyebrow"))).toBe("Football · League");
    // Level at the top: the card says so and names both sides, and both rows are marked as leaders.
    const card = oneByTestId(tree, "qm-winner");
    expect(words(oneByTestId(card, "qm-winner-kicker"))).toBe(en_("quickMatch.home.level"));
    expect(byTestId(card, "qm-winner-name").map(words).sort()).toEqual(["Blue team", "Red team"]);
    expect(tableRows.filter((r) => r.props["data-leader"] === "true")).toHaveLength(2);
    await hardDeleteQuickMatchCompetition(out.competitionId);
  });

  it("football: the AWAY side wins 0-1 and the result reads winner first, 'Red team beat Blue team · 1–0', never '0–1' (h2)", async () => {
    locale.value = "en";
    const out = await create(league({ sport_key: "football", variant_key: FOOTBALL.variant, kind: FOOTBALL.kind, sides: ["Blue team", "Red team"] }));
    const only = (await homeOf(out)).next!;
    // Kick-off, one goal by the AWAY side, half time, full time.
    for (const [seq, req] of [
      { type: "core.start", payload: {} },
      { type: "football.goal", payload: { by: only.away!.entrantId } },
      { type: "football.period", payload: { phase: "HT" } },
      { type: "football.period", payload: { phase: "FT" } },
    ].entries()) {
      await scoreEvent(systemAuth(), only.id, { expected_seq: seq, ...req });
    }
    const h = await homeOf(out);
    const done = h.fixtures.find((f) => f.id === only.id)!;
    expect(done.winnerEntrantId, "precondition: the away side won").toBe(only.away!.entrantId);

    const { tree } = await renderPage(out.token);
    const row = oneByTestId(tree, "qm-match");
    expect(words(oneByTestId(row, "qm-match-sides"))).toBe(en_("quickMatch.home.result", { winner: only.away!.name, loser: only.home!.name }));
    // The rulebook: the winner scored one goal, the loser none; read in the sentence's order.
    expect(words(oneByTestId(row, "qm-match-score"))).toBe("1–0");
    // The table, by the league convention (3 points for a win, 0 for a loss): no D column, no draw yet.
    expect(numericHeads(tree)).toEqual([head("P", "Played"), head("W", "Won"), head("Pts", "Points")]);
    expect(tableRowsOf(tree)).toEqual([
      ["1", only.away!.name, "1", "1", "3"],
      ["2", only.home!.name, "1", "0", "0"],
    ]);
    await hardDeleteQuickMatchCompetition(out.competitionId);
  });

  it("chess: the table prints FIDE's points (win 1, draw ½) in halves, the D column, the places, and an eyebrow with no kind (I1, h1)", async () => {
    locale.value = "en";
    const out = await create(league({ sport_key: "boardgame", variant_key: CHESS.variant, kind: CHESS.kind, sides: ["Ann", "Bo", "Cy"] }));
    const h0 = await homeOf(out);
    const idOf = new Map(h0.sides.map((s) => [s.name, s.entrantId]));
    // The results, by pairing: Ann beats Bo; Ann and Cy draw by agreement; Bo and Cy draw by agreement.
    let played = 0;
    for (const f of h0.fixtures.filter((x) => !x.isBye)) {
      const pair = [f.home!.name, f.away!.name].sort().join("-");
      const payload = pair === "Ann-Bo" ? { winner: idOf.get("Ann"), method: "resign" } : { winner: null, method: "agreement" };
      await scoreEvent(systemAuth(), f.id, { expected_seq: 0, type: "core.start", payload: {} });
      await scoreEvent(systemAuth(), f.id, { expected_seq: 1, type: "boardgame.result", payload });
      played++;
    }
    expect(played).toBe(3);   // the rulebook: a single round robin of 3 is 3·2/2 = 3 games

    const { tree } = await renderPage(out.token);
    expect(words(oneByTestId(tree, "qm-eyebrow"))).toBe("Chess · League");
    expect(numericHeads(tree)).toEqual([head("P", "Played"), head("W", "Won"), head("D", "Drawn"), head("Pts", "Points")]);
    // FIDE, by hand: Ann 1 + ½ = 1½; Cy ½ + ½ = 1; Bo 0 + ½ = ½. Each played 2.
    expect(tableRowsOf(tree)).toEqual([
      ["1", "Ann", "2", "1", "1", "1½"],
      ["2", "Cy", "2", "0", "2", "1"],
      ["3", "Bo", "2", "0", "1", "½"],
    ]);
    const card = oneByTestId(tree, "qm-winner");
    expect(byTestId(card, "qm-winner-name").map(words)).toEqual(["Ann"]);
    await hardDeleteQuickMatchCompetition(out.competitionId);
  });

  it("a league won outright names one winner and marks one leader; the void of its deciding event takes the hero back to Live (Q3)", async () => {
    locale.value = "en";
    const out = await create(league({ sides: SIDES.slice(0, 2) }));
    const h0 = await homeOf(out);
    const only = h0.next!;
    const r = await playToDecided(systemAuth(), only.id);
    if (r.kind !== "decided") throw new Error(`precondition: ${JSON.stringify(r)}`);

    let page = await renderPage(out.token);
    const decided = (await homeOf(out)).fixtures.find((f) => f.id === only.id)!;
    const winner = decided.home!.entrantId === decided.winnerEntrantId ? decided.home! : decided.away!;
    const card = oneByTestId(page.tree, "qm-winner");
    expect(words(oneByTestId(card, "qm-winner-kicker"))).toBe(en_("quickMatch.home.winner"));
    expect(byTestId(card, "qm-winner-name").map(words)).toEqual([winner.name]);
    const leaders = byTestId(page.tree, "qm-standings-row").filter((row) => row.props["data-leader"] === "true");
    expect(leaders.map(words)).toEqual([expect.stringContaining(winner.name)]);
    // The positive pair of the fresh table's level dashes: once a match counts, the winner stands first.
    expect(words(all(leaders[0], (el) => el.type === "td")[0])).toBe("1");
    expect(byTestId(page.tree, "qm-hero")).toHaveLength(0);

    // The void use case: core.void of the deciding event, expected_seq = the tip.
    await scoreEvent(systemAuth(), only.id, { expected_seq: r.lastSeq, type: "core.void", payload: { event_id: r.lastEventId } });
    page = await renderPage(out.token);
    expect(byTestId(page.tree, "qm-winner"), "no winner card once the result is undone").toHaveLength(0);
    const hero = oneByTestId(page.tree, "qm-hero");
    expect(words(oneByTestId(hero, "qm-hero-kicker"))).toBe(en_("quickMatch.home.liveMatch", { n: 1, total: 1 }));
    expect(words(oneByTestId(hero, "qm-hero-kicker"))).toContain(en_("quickMatch.home.live"));
    expect(oneByTestId(page.tree, "qm-match").props["data-state"]).toBe("live");
    expect(words(oneByTestId(page.tree, "qm-played"))).toBe(enPlayed(0, 1));
    await hardDeleteQuickMatchCompetition(out.competitionId);
  });

  it("Full table (owner 2026-11-12): after one decided badminton match, the public table's own columns in its order, under a closed fold; the short table keeps P, W, Pts", async () => {
    locale.value = "en";
    const out = await create(league({ sides: SIDES.slice(0, 3) }));
    const only = (await homeOf(out)).next!;
    const r = await playToDecided(systemAuth(), only.id);
    if (r.kind !== "decided") throw new Error(`precondition: ${JSON.stringify(r)}`);
    const h = await homeOf(out);
    const decided = h.fixtures.find((f) => f.id === only.id)!;
    const winner = decided.winnerEntrantId!;
    const loser = decided.home!.entrantId === winner ? decided.away!.entrantId : decided.home!.entrantId;
    const idle = h.sides.map((s) => s.entrantId).find((id) => id !== winner && id !== loser)!;

    const { tree, html } = await renderPage(out.token);
    // The short table is the mockup's, unchanged; the fold sits under it, closed on first paint, and its name is the toggle.
    expect(numericHeads(tree)).toEqual([head("P", "Played"), head("W", "Won"), head("Pts", "Points")]);
    const fold = oneByTestId(tree, "qm-full-table");
    expect([fold.type, fold.props.open]).toEqual(["details", undefined]);
    expect(heard(oneByTestId(fold, "qm-full-table-toggle"))).toBe(en_("quickMatch.home.fullTable"));

    // THE ORACLE: the public table itself (`StandingsTable`, the division page's) over the same stored rows, with the stage's
    // rules from the one loader and the sport's metrics from the engine's registry. Its header words, in its order, are the
    // full table's — never a list typed here.
    const rules = (await withTenant(QUICK_MATCH_SYSTEM_ORG_ID, (tx) => stageTableRulesDocs(tx, [out.stageId])))[out.stageId];
    if (!rules) throw new Error("precondition: the loader has the stage's table rules");
    const metrics = builtinModules.find((m) => m.key === "badminton")!.metrics;
    const publicHtml = renderToStaticMarkup(
      <StandingsTable
        rows={h.standings!.rows as StandingsRow[]}
        metricSpecs={metrics}
        cascade={rules.tiebreakers}
        entrantNames={Object.fromEntries(h.sides.map((s) => [s.entrantId, s.name]))}
        dict={enPublic as unknown as Dict}
        rules={rules}
      />,
    );
    const unescape = (x: string) => x.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    const publicTitles = [...publicHtml.matchAll(/<th[^>]*\stitle="([^"]*)"/g)].map((m) => unescape(m[1]!));
    const heads = all(oneByTestId(fold, "qm-full-table-head"), (el) => el.type === "th" && el.props.title !== undefined);
    expect(publicTitles.length, "the public table shows more than P, W and Pts").toBeGreaterThan(3);
    expect(heads.map((th) => th.props.title)).toEqual(publicTitles);
    // Each header prints the letters and is heard as the word, as the short table's are.
    for (const th of heads) expect(words(all(th, srOnly))).toBe(th.props.title);

    // The rulebook's cells for the one decided match: each side that played it played 1; the winner won it, the loser lost
    // it; the third side played nothing. Rows in the short table's order, by name.
    const keys = heads.map((th) => String(th.key));
    const at = (key: string) => {
      const i = keys.indexOf(key);
      expect(i, `the full table has a ${key} column`).toBeGreaterThanOrEqual(0);
      return i;
    };
    const nameOf = (id: string) => h.sides.find((s) => s.entrantId === id)!.name;
    const rowCells = (id: string) => {
      const row = byTestId(fold, "qm-full-table-row").find((tr) => words(all(tr, (el) => el.type === "th")[0]) === nameOf(id));
      if (!row) throw new Error(`no full-table row for ${nameOf(id)}`);
      return byTestId(row, "qm-full-cell").map(words);
    };
    expect([at("played"), at("won"), at("lost")].map((i) => rowCells(winner)[i])).toEqual(["1", "1", "0"]);
    expect([at("played"), at("won"), at("lost")].map((i) => rowCells(loser)[i])).toEqual(["1", "0", "1"]);
    expect(rowCells(idle)[at("played")]).toBe("0");
    expect(byTestId(fold, "qm-full-table-row").map((tr) => words(all(tr, (el) => el.type === "th")[0]))).toEqual(
      byTestId(tree, "qm-standings-row").map((tr) => words(all(tr, (el) => el.type === "th")[0])),
    );

    // The full table scrolls sideways in its own region, never the page: focusable, a role and a name (axe's rule).
    const region = oneByTestId(fold, "qm-full-table-region");
    expect([region.props.role, region.props.tabIndex, region.props["aria-label"]]).toEqual([
      "region",
      0,
      tRuntime(enPublic, "table.regionCaptioned", { caption: en_("quickMatch.home.fullTable") }),
    ]);
    // `relative` contains the header's absolutely placed screen-reader words, or they widen the page at 320 (browser-measured).
    expect(classOf(region).split(/\s+/)).toEqual(expect.arrayContaining(["relative", "overflow-x-auto", "min-w-0"]));
    // Open, the short table steps aside: its wrapper hides when the section holds an open fold (one table at a time).
    expect(classOf(oneByTestId(tree, "qm-standings-short")).split(/\s+/)).toContain("group-has-[>details[open]]/standings:hidden");
    expect(classOf(oneByTestId(tree, "qm-standings")).split(/\s+/)).toContain("group/standings");
    expect(html).toContain('data-testid="qm-full-table"');
    await hardDeleteQuickMatchCompetition(out.competitionId);
  });

  it("a live match shows its score in the hero and the list; a league offers Share and Add a match in their slots", async () => {
    locale.value = "en";
    const out = await create(league({ sides: SIDES.slice(0, 2) }));
    const only = (await homeOf(out)).next!;
    // core.start and one rally (the engine's own first play event), then the hero reads the match as live.
    const { firstRallyFor } = await import("@/server/usecases/__tests__/_quick-match-probe");
    for (const req of await firstRallyFor(only.id)) await scoreEvent(systemAuth(), only.id, req);
    const h = await homeOf(out);
    expect(h.fixtures.filter((f) => f.phase === "live").map((f) => f.id), "precondition: in play").toEqual([only.id]);
    const { tree, slots } = await renderView(h);
    const hero = oneByTestId(tree, "qm-hero");
    expect(words(oneByTestId(hero, "qm-hero-kicker"))).toBe(en_("quickMatch.home.liveMatch", { n: 1, total: 1 }));
    // The live score after one rally: the rulebook's one point to one side, nothing else scored yet.
    expect(["1–0", "0–1"]).toContain(words(oneByTestId(hero, "qm-hero-score")));
    const row = oneByTestId(tree, "qm-match");
    expect(row.props["data-state"]).toBe("live");
    expect(words(oneByTestId(row, "qm-live"))).toBe(en_("quickMatch.home.live"));
    expect(words(oneByTestId(row, "qm-match-score"))).toBe(words(oneByTestId(hero, "qm-hero-score")));
    expect(slots.score.mock.calls.map(([f, place]) => `${place}:${f.live}`).sort()).toEqual(["hero:true", "row:true"]);
    expect(byTestId(tree, "slot-share")).toHaveLength(1);
    expect(byTestId(tree, "slot-add-match"), "a league takes a decider (C5)").toHaveLength(1);
    // Handed both sides as typed, opening at the stored table's top two (the producer's own order).
    expect(slots.addMatch).toHaveBeenCalledTimes(1);
    const top = (h.standings!.rows as { entrantId: string }[]).map((r) => r.entrantId);
    expect(slots.addMatch.mock.calls[0]![0]).toEqual({
      sides: h.sides.map((s) => ({ id: s.entrantId, name: s.name })),
      home: top[0],
      away: top[1],
    });
    await hardDeleteQuickMatchCompetition(out.competitionId);
  });

  // Plan 4 Task 4 (a), (b) on the REAL page: the row menus as the server renders them (each is a client island, rendered to
  // its server HTML here), their posts the home's own paths. Badminton, the spec's example: the menu reads no sport (the
  // sport sweep of skip and Put back is T3's, quick-match-skip.test.ts).
  it("the row menus on the real page (plan 4 Task 4): a ready row's ⋯ posts Score and Not played and holds its sheet; a settled row's Edit result; a Not played row's Put back, gone once the league finishes", async () => {
    locale.value = "en";
    const out = await create(league({ sides: ["Ines", "Ravi", "Mika"] }));
    const h0 = await homeOf(out);
    const [m1, m2, m3] = h0.fixtures.filter((f) => !f.isBye);
    expect(h0.total, "premise: a round robin of 3 is 3·2/2 = 3 matches").toBe(3);
    const played = await playToDecided(systemAuth(), m1!.id);
    if (played.kind !== "decided") throw new Error(`precondition: ${JSON.stringify(played)}`);
    /** A row's server HTML: the row and its menu island (a client boundary, rendered as the server sends it). */
    const rowHtml = (tree: ReactNode, id: string) => {
      const hits = byTestId(tree, "qm-match").filter((r) => r.props["data-fixture-id"] === id);
      expect(hits, `one row for ${id}`).toHaveLength(1);
      return renderToStaticMarkup(hits[0]!);
    };
    const count = (html: string, needle: string) => html.split(needle).length - 1;
    const name = (f: QuickMatchFixture) => `More actions for ${f.home!.name} v ${f.away!.name}`;

    let page = await renderPage(out.token);
    // (a) A ready row: its ⋯ named for its match; Score and Not played posting the home's own paths; the sheet's form posts
    // the same skip; no Put back, no Edit result.
    const ready = rowHtml(page.tree, m2!.id);
    expect(ready).toContain(`aria-label="${name(m2!)}"`);
    expect(ready).toContain('data-testid="qm-row-menu"');
    expect(ready).toContain('data-testid="qm-skip"');
    expect(count(ready, `action="/q/${out.token}/skip/${m2!.id}"`), "the menu's Not played and the sheet's confirm").toBe(2);
    expect(count(ready, `action="/q/${out.token}/score/${m2!.id}"`), "the row's Score and the menu's Score").toBe(2);
    expect(ready).toContain('data-testid="qm-skip-sheet"');
    expect(ready).not.toContain('data-testid="qm-put-back"');
    expect(ready).not.toContain('data-testid="qm-edit-result"');
    // Every form carries the replay block (its action holds the home token, O3).
    expect(count(ready, "<form"), "the row's Score, the menu's two, the sheet's").toBe(4);
    for (const form of ready.match(/<form[^>]*>/g) ?? []) {
      expect(form).toMatch(/\sclass="ph-no-capture[\s"]/);
      expect(form, "a real post: it works without the script").toContain(' method="post"');
    }
    // A settled row: Edit result in its menu (the same Score route the pad reopens), no Score button, no Not played.
    const done = rowHtml(page.tree, m1!.id);
    expect(done).toContain('data-testid="qm-edit-result"');
    expect(count(done, `action="/q/${out.token}/score/${m1!.id}"`)).toBe(1);
    expect(done).not.toContain('data-testid="qm-score"');
    expect(done).not.toContain("/skip/");
    // The sheet's body for match 2: two matches still to play, so it can be put back.
    expect(ready).toContain(en["quickMatch.skip.body"].replace(/'/g, "&#x27;"));

    // (b) Match 2 marked Not played, through the home's own writer (`skipQuickMatchFixture`, plan 4 T3), as its sheet posts.
    const qm = await resolveQuickMatchToken(out.token);
    if (!qm) throw new Error("precondition: the quick match's token resolves");
    const markNotPlayed = async (fixtureId: string) => {
      expect(await skipQuickMatchFixture(qm, fixtureId), `premise: fixture ${fixtureId} was open and is now Not played`).toEqual({
        changed: true,
      });
    };
    await markNotPlayed(m2!.id);
    page = await renderPage(out.token);
    expect(words(oneByTestId(page.tree, "qm-played"))).toBe("1 of 3 matches played · 1 not played · deleted 7 days after the last score unless saved");
    expect(byTestId(page.tree, "qm-match").map((r) => r.props["data-fixture-id"]), "to play, Not played, finished").toEqual([m3!.id, m2!.id, m1!.id]);
    const skipped = rowHtml(page.tree, m2!.id);
    expect(skipped).toContain('data-state="notPlayed"');
    expect(skipped).toContain(">Not played<");
    expect(skipped).toContain('data-testid="qm-put-back"');
    expect(skipped).toContain(`action="/q/${out.token}/put-back/${m2!.id}"`);
    expect(skipped).not.toContain('data-testid="qm-skip"');
    expect(skipped).not.toContain('data-testid="qm-score"');
    // The one match left: its sheet now warns that skipping it finishes the league (D6).
    expect(rowHtml(page.tree, m3!.id)).toContain(en["quickMatch.skip.bodyLast"].replace(/'/g, "&#x27;"));
    expect(words(oneByTestId(page.tree, "qm-standings-note"))).toBe("Counts played matches only");

    // Match 3 too: the league is finished on its one played match. Put back is gone; the winner card says what was played.
    await markNotPlayed(m3!.id);
    page = await renderPage(out.token);
    for (const id of [m2!.id, m3!.id]) {
      const html = rowHtml(page.tree, id);
      expect(html, id).toContain(">Not played<");
      expect(html, id).not.toContain('data-testid="qm-row-menu"');
      expect(html, id).not.toContain("/put-back/");
    }
    expect(rowHtml(page.tree, m1!.id), "Edit result stays: it reopens the league").toContain('data-testid="qm-edit-result"');
    expect(byTestId(page.tree, "qm-hero")).toHaveLength(0);
    expect(words(oneByTestId(page.tree, "qm-winner-note"))).toBe("Top of the table after 1 played match. 2 matches were not played.");
    expect(words(oneByTestId(page.tree, "qm-standings-title"))).toBe("Final table");
    // The winner is the side the played match's result names (the stored outcome, not computed here).
    const decided = (await homeOf(out)).fixtures.find((f) => f.id === m1!.id)!;
    const winner = decided.home!.entrantId === decided.winnerEntrantId ? decided.home! : decided.away!;
    expect(byTestId(oneByTestId(page.tree, "qm-winner"), "qm-winner-name").map(words)).toEqual([winner.name]);
    // Every row menu the page drew is the island, never a stand-in (anti-vacuity: one, Edit result's).
    expect(all(page.tree, (el) => el.type === QuickMatchRowMenu)).toHaveLength(1);
    await hardDeleteQuickMatchCompetition(out.competitionId);
  });
});
