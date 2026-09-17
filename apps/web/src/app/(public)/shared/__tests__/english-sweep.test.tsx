// Spectator W2, Task 16 — zero English on every /shared page, in es, fr and nl.
//
// Each page's default export (and its `generateMetadata`) is rendered with its
// data doors stubbed, in all four locales, and every piece of text a visitor
// can read — text nodes and the visible attributes — must be accounted for by
// that locale's dictionary or be data. The method, and why it is not a list of
// old English strings, is in `_english-sweep.ts`.
//
// DATA IS MARKED. Every free-text string a scene seeds (org, competition,
// division, entrant, person, venue names, post titles and bodies) contains
// `zq` and starts with a digit, so the sweep can tell a name from a word:
// `zq` is in no dictionary, and a name's initials (a monogram, a crest) are
// digits, which are data too.
//
// THE BOUNDARY. Doors that are SQL are stubbed at the module boundary, the
// same doors each page's own tests stub. Where a door hands the page words it
// already resolved (the hub document, the player's stat labels), the scene
// builds them with the SAME exported builders production uses, in the scene's
// locale — the hub through the real `loadCompetitionHub` over stubbed rows —
// so a builder that resolves English is inside the sweep, not behind a stub.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LOCALES, type Locale } from "@/lib/i18n-constants";
import {
  classify,
  dictionaryHits,
  explained,
  extractSegments,
  formatFinding,
  metadataSegments,
  servedMetadata,
  type Finding,
  type Segment,
} from "./_english-sweep";
import { ENGLISH_SWEEP_ALLOWLIST } from "./_english-sweep-allowlist";

/** The allowlist phrases that hold on a page rendering `files`. */
const allowFor = (files: readonly string[]): string[] =>
  ENGLISH_SWEEP_ALLOWLIST.filter((a) => a.onlyOn === undefined || a.onlyOn.some((f) => files.includes(f))).map((a) => a.text);
const NON_EN = LOCALES.filter((l): l is Exclude<Locale, "en"> => l !== "en");

// ------------------------------------------------------------------ stubs

const state = vi.hoisted(() => ({ locale: "en" as string, tab: null as string | null, search: "" }));
const stub = vi.hoisted(() => ({
  getPublicOrg: vi.fn(),
  getPublicCompetition: vi.fn(),
  getPublicDivision: vi.fn(),
  getPublicFixture: vi.fn(),
  getPublicPlayer: vi.fn(),
  readEntrantMemberRefs: vi.fn(),
  readLeaderRows: vi.fn(),
  publicRegistrationInfo: vi.fn(),
  activePublicSuspensionEntries: vi.fn(),
  resolveSponsors: vi.fn(),
  publicPosts: vi.fn(),
  publicPost: vi.fn(),
  resolvePostSides: vi.fn(),
  relatedCompetition: vi.fn(),
  publicSuspensions: vi.fn(),
  embedDivisionData: vi.fn(),
}));
/** Every element a share image handed to satori, in draw order. */
const images = vi.hoisted(() => ({ drawn: [] as unknown[] }));

vi.mock("next/font/google", () => ({
  Barlow_Condensed: () => ({ variable: "--ps-font-display", className: "" }),
  // The root layout's, imported for the metadata every page inherits.
  Geist: () => ({ variable: "--font-geist-sans", className: "" }),
  Geist_Mono: () => ({ variable: "--font-geist-mono", className: "" }),
}));
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  notFound: () => {
    throw new Error("SWEEP_NOT_FOUND");
  },
  permanentRedirect: (to: string) => {
    throw new Error(`SWEEP_REDIRECT:${to}`);
  },
  // The match centre's `?tab=`, read on the client.
  useSearchParams: () => new URLSearchParams(state.search),
  usePathname: () => "/shared/9zqorg",
  // The player card's 404 links to the org home by the route's own param.
  useParams: () => ({ orgSlug: "9zqorg", competitionSlug: "9zqcup", personId: "9zqperson" }),
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
}));
// `unstable_cache` has no incremental cache outside a Next request.
vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...a: unknown[]) => unknown) => fn,
  revalidateTag: () => {},
}));
vi.mock("@/server/public-site/data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/public-site/data")>()),
  getPublicOrg: stub.getPublicOrg,
  getPublicCompetition: stub.getPublicCompetition,
  getPublicDivision: stub.getPublicDivision,
  getPublicFixture: stub.getPublicFixture,
  getPublicPlayer: stub.getPublicPlayer,
  readEntrantMemberRefs: stub.readEntrantMemberRefs,
}));
vi.mock("@/server/public-site/public-leaders", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/public-site/public-leaders")>()),
  readLeaderRows: stub.readLeaderRows,
}));
vi.mock("@/server/usecases/registrations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/usecases/registrations")>()),
  publicRegistrationInfo: stub.publicRegistrationInfo,
}));
vi.mock("@/server/usecases/discipline", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/usecases/discipline")>()),
  activePublicSuspensionEntries: stub.activePublicSuspensionEntries,
  publicSuspensions: stub.publicSuspensions,
}));
vi.mock("@/server/usecases/sponsors", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/usecases/sponsors")>()),
  resolveSponsors: stub.resolveSponsors,
}));
vi.mock("@/lib/entitlements", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/entitlements")>()),
  hasFeature: async () => true,
}));
vi.mock("@/server/logger", () => ({
  log: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {}, fatal: () => {}, trace: () => {} },
}));
// The hub's poll transport; nothing polls under a static render.
vi.mock("@/components/public-site/competition-hub-data", () => ({ fetchCompetitionHub: async () => null }));
// Which tab the hub opens on: the URL's `?tab=`, read on the client.
vi.mock("@/components/public-site/use-tab-param", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/public-site/use-tab-param")>()),
  useTabParam: () => state.tab,
  useDivisionParam: () => null,
}));
vi.mock("@/server/slug-resolve", () => ({ sharedRenameTarget: async () => null }));
vi.mock("@/server/usecases/org-posts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/usecases/org-posts")>()),
  publicPosts: stub.publicPosts,
  publicPost: stub.publicPost,
}));
vi.mock("@/server/news/public-view", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/news/public-view")>()),
  resolvePostSides: stub.resolvePostSides,
  relatedCompetition: stub.relatedCompetition,
}));
vi.mock("@/server/help-content", () => ({ renderHelpMarkdown: async (md: string) => `<p>${md}</p>` }));
vi.mock("@/lib/posthog-server", () => ({ captureServer: async () => {} }));
vi.mock("@/lib/prose", () => ({ renderProse: async (html: string) => `<p>${html}</p>` }));
// The embed widgets' loader: the same division document the page stubs hand
// the division page.
vi.mock("@/server/embed-data", () => ({ embedDivisionData: stub.embedDivisionData }));
// A share image is satori pixels, which no sweep can read — but the ELEMENT
// handed to satori is markup. Captured here and rendered like a page, so every
// word the image would draw is classified. The body is never painted.
vi.mock("next/og", () => ({
  ImageResponse: class {
    body = null;
    status = 200;
    headers = new Headers({ "content-type": "image/png" });
    constructor(element: unknown) {
      images.drawn.push(element);
    }
  },
}));
// The match poster's one query outside `getPublicFixture`: the fixture's stage
// name, the upcoming poster's hero. Any OTHER statement fails exactly as the
// real client does with no database configured.
vi.mock("@/lib/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db")>()),
  sql: (strings: TemplateStringsArray) => {
    if (strings.join("?").includes("from stages where id")) return Promise.resolve([{ name: "9zqstage 8zqname" }]);
    throw new Error("SWEEP_UNEXPECTED_SQL: DATABASE_URL is not set");
  },
}));

import { metadata as rootMetadata } from "@/app/layout";
import OrgLayout from "../[orgSlug]/layout";
import * as OrgHome from "../[orgSlug]/page";
import * as NewsFeed from "../[orgSlug]/news/page";
import * as NewsPost from "../[orgSlug]/news/[postSlug]/page";
import * as Poster from "../[orgSlug]/[competitionSlug]/poster/page";
import * as Competition from "../[orgSlug]/[competitionSlug]/page";
import * as Division from "../[orgSlug]/[competitionSlug]/[divisionSlug]/page";
import * as Fixture from "../[orgSlug]/[competitionSlug]/[divisionSlug]/fixtures/[fixtureId]/page";
import * as Player from "../[orgSlug]/[competitionSlug]/players/[personId]/page";
import PlayerCardLayout from "../[orgSlug]/[competitionSlug]/players/[personId]/layout";
import PlayerNotFound from "../[orgSlug]/[competitionSlug]/players/[personId]/not-found";
import KioskOrgLayout from "../(kiosk)/[orgSlug]/layout";
import * as PresentCompetition from "../(kiosk)/[orgSlug]/[competitionSlug]/present/page";
import * as PresentDivision from "../(kiosk)/[orgSlug]/[competitionSlug]/[divisionSlug]/present/page";
import FixtureCard from "../[orgSlug]/[competitionSlug]/[divisionSlug]/fixtures/[fixtureId]/opengraph-image";
import { GET as fixturePoster } from "../[orgSlug]/[competitionSlug]/[divisionSlug]/fixtures/[fixtureId]/poster.png/route";
import EmbedLayout from "@/app/embed/layout";
import EmbedWidget from "@/app/embed/divisions/[id]/[widget]/page";
import { Slideshow } from "@/components/v2/slideshow";
import { buildMatchCentre } from "@/server/public-site/match-centre";
import type { MatchCentreDocT, SideT } from "@/server/public-site/match-centre-schema";
import type { PublicPerson } from "@/server/public-site/public-lineups";
import { composePlayerMatchLines, type PlayerMatchSeed } from "@/server/public-site/public-player-matches";
import { groupCareerStatsBySport, labelPlayerStats } from "@/server/player-stats";
import { scriptLedger, HOME, AWAY, type Script } from "@/server/public-site/__tests__/cricket-ledger";
import { makeEnvelope } from "@seazn/engine/testkit";
import { cricket } from "@seazn/engine/sports/cricket";
import { FootballCfg } from "@seazn/engine/sports/football";
import { getDictionary } from "@/lib/i18n";
import { msgFor } from "@/lib/messages-i18n";
import { toLocale } from "@/lib/i18n-constants";
import { resolveLatestModule } from "@/server/engine-db";
import type {
  PublicDivision,
  PublicEntrant,
  PublicFixture,
  PublicStage,
  PublicStandings,
} from "@/server/public-site/data";

// --------------------------------------------------------------- the data

const ISO = "2026-09-05T13:00:00.000Z";
const ORG_SLUG = "9zqorg";
const COMP_SLUG = "9zqcup";

const org = () => ({
  id: "00000000-0000-4000-8000-0000000000aa",
  name: "9zqriver 8zqside",
  slug: ORG_SLUG,
  branded: false,
  branding: {},
  logo: null,
  about: "9zqabout 8zqtext",
  default_locale: state.locale,
  card_payments: false,
});

const competitionRow = (id: string, status: string, inPlay: number, startsOn: string | null, endsOn: string | null) => ({
  id,
  org_id: org().id,
  name: `9zqcomp ${id}zq`,
  slug: `9zq${id}`,
  description: "9zqdescription",
  starts_on: startsOn,
  ends_on: endsOn,
  branding: {},
  status,
  visibility: "public" as const,
  in_play: inPlay,
});

const post = (id: string, kind: string, title: string, over: Record<string, unknown> = {}) => ({
  id: `00000000-0000-4000-8000-00000000000${id}`,
  orgId: org().id,
  competitionId: null,
  divisionId: null,
  kind,
  status: "published",
  slug: `9zqpost-${id}`,
  title,
  bodyMd: "9zqbody 8zqtext",
  heroImagePath: null,
  autoSource: null,
  publishedAt: ISO,
  createdAt: ISO,
  updatedAt: ISO,
  ...over,
});

const POSTS = [
  post("1", "result", "9zqblue 3–1 8zqred"),
  post("2", "round_recap", "9zqround 8zqrecap"),
  post("3", "announcement", "9zqbig 8zqnews"),
  post("4", "news", "9zqsmall 8zqnews"),
  post("5", "weekly_digest", "9zqweekly 8zqdigest"),
];

// ------------------------------------------------ the hub: rows, not a doc
//
// The competition page renders the hub DOCUMENT, and most of its words are
// resolved while that document is built (round names, table columns, result
// sentences, leader labels, the status ladder's copy). So the scene stubs the
// ROWS the builder reads and runs the real `loadCompetitionHub` in the scene's
// locale: a football division with a league then an 8-team knockout (third
// place and final), and a second with two groups. Some matches decided, one
// live, the rest scheduled; squads with a suspended player; leaders; an open
// registration; sponsors of every tier.

const COMP_ID = "00000000-0000-4000-8000-0000000000c1";
const hubCompetition = () => ({
  id: COMP_ID,
  org_id: org().id,
  name: "9zqautumn 8zqcup",
  slug: COMP_SLUG,
  description: "9zqabout 8zqthe 7zqcup",
  starts_on: "2026-09-01",
  ends_on: "2026-09-20",
  branding: {},
  status: "active",
  visibility: "public" as const,
});

const FOOTBALL = resolveLatestModule("football").version;
const VOLLEYBALL = resolveLatestModule("volleyball").version;
const division = (id: string, slug: string, over: Partial<PublicDivision> = {}): PublicDivision => ({
  id,
  competition_id: COMP_ID,
  name: `9zqdivision ${slug}`,
  slug,
  description: "9zqdivision 8zqprose",
  sport_key: "football",
  variant_key: "11-a-side",
  status: "active",
  module_version: FOOTBALL,
  tiebreakers: null,
  // The catalog's REAL name (`scripts/sync-sports.ts` SPORT_NAMES), deliberately
  // NOT data-marked: `sports.name` is English system copy, so a page printing it
  // must be visible here. It carried `9zqsport` until T16b fix round 4, which
  // hid the division page's English sport name from every run.
  sport_name: "Football",
  entrant_count: 8,
  youth: false,
  player_name_display: null,
  config: { halfMinutes: 45, halves: 2 },
  ...over,
});
const DIV_A = division("d-a", "9zqa");
const DIV_B = division("d-b", "9zqb", { entrant_count: 4 });

const stage = (id: string, divisionId: string, seq: number, kind: PublicStage["kind"], name: string): PublicStage => ({
  id,
  division_id: divisionId,
  seq,
  kind,
  name,
  status: "active",
});

const entrants = (divisionId: string, prefix: string, n: number): PublicEntrant[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `${prefix}${i + 1}`,
    division_id: divisionId,
    kind: "team",
    display_name: `${i + 1}zq${prefix} 9zqteam`,
    seed: i + 1,
    status: "confirmed",
    members:
      i < 2
        ? [
            { name: `${i + 1}zqplayer 9zqone`, photo: null, person_id: `p-${prefix}${i}-1`, squad_number: 9, position: "9zqforward" },
            { name: `${i + 1}zqplayer 8zqtwo`, photo: null, person_id: null, squad_number: null, position: null },
          ]
        : [],
    team_display: null,
    badge_url: null,
  }));

const fixture = (over: Partial<PublicFixture> & { id: string; division_id: string; stage_id: string }): PublicFixture => ({
  pool_id: null,
  round_no: 1,
  seq_in_round: 1,
  home_entrant_id: null,
  away_entrant_id: null,
  home_slot_label: null,
  away_slot_label: null,
  scheduled_at: null,
  venue: null,
  court_label: null,
  venue_name: "9zqpark",
  court_name: "9zqpitch",
  status: "scheduled",
  outcome: null,
  summary: null,
  last_seq: null,
  ...over,
});

const decided = (home: string, away: string, h: number, a: number) => ({
  status: "decided",
  home_entrant_id: home,
  away_entrant_id: away,
  outcome: h === a ? { kind: "draw" } : { kind: "win", winner: h > a ? home : away, loser: h > a ? away : home },
  summary: { perSide: [{ entrantId: home, line: String(h) }, { entrantId: away, line: String(a) }] },
});

type HubMode = "live" | "upcoming" | "finished";

function divisionADetail(mode: HubMode) {
  const league = stage("a-lg", "d-a", 1, "league", "9zqleague");
  const cup = stage("a-ko", "d-a", 2, "knockout", "9zqcup 8zqstage");
  const teams = entrants("d-a", "a", 8);
  const at = (day: number, hour = 14) => `2026-09-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00:00.000Z`;
  const lg = (id: string, round: number, extra: Partial<PublicFixture>) =>
    fixture({ id, division_id: "d-a", stage_id: "a-lg", round_no: round, ...extra });
  const ko = (id: string, round: number, seq: number, extra: Partial<PublicFixture> = {}) =>
    fixture({ id, division_id: "d-a", stage_id: "a-ko", round_no: round, seq_in_round: seq, ...extra });
  const done = mode === "finished";
  const fixtures: PublicFixture[] = [
    lg("a-lg-1", 1, { scheduled_at: at(2), ...decided("a1", "a2", 2, 1) }),
    lg("a-lg-2", 1, { scheduled_at: at(2), seq_in_round: 2, ...decided("a3", "a4", 1, 1) }),
    lg("a-lg-3", 2, {
      scheduled_at: at(5, 11),
      home_entrant_id: "a1",
      away_entrant_id: "a3",
      ...(mode === "live"
        ? { status: "in_play", summary: { perSide: [{ entrantId: "a1", line: "1" }], detail: { phase: "H2" } } }
        : decided("a1", "a3", 3, 0)),
    }),
    lg("a-lg-4", 2, done ? { scheduled_at: at(5, 16), ...decided("a2", "a4", 0, 2) } : { scheduled_at: at(12), home_entrant_id: "a2", away_entrant_id: "a4" }),
    lg("a-lg-5", 3, { status: "cancelled", scheduled_at: at(6), home_entrant_id: "a5", away_entrant_id: "a6" }),
    ko("a-q1", 1, 1, { scheduled_at: at(3), ...decided("a1", "a8", 4, 0) }),
    ko("a-q2", 1, 2, { scheduled_at: at(3), ...decided("a4", "a5", 1, 2) }),
    ko("a-q3", 1, 3, { scheduled_at: at(3), ...decided("a3", "a6", 2, 2), outcome: { kind: "win", winner: "a3", loser: "a6", method: "penalties" } }),
    ko("a-q4", 1, 4, { scheduled_at: at(3), status: "forfeited", home_entrant_id: "a2", away_entrant_id: "a7", outcome: { kind: "forfeit", winner: "a2", loser: "a7" } }),
    ko("a-s1", 2, 1, done ? { scheduled_at: at(4), ...decided("a1", "a5", 2, 0) } : { scheduled_at: at(19), home_entrant_id: "a1", away_entrant_id: "a5" }),
    ko("a-s2", 2, 2, done ? { scheduled_at: at(4), ...decided("a3", "a2", 1, 0) } : { scheduled_at: at(19, 16), home_entrant_id: "a3", away_entrant_id: "a2" }),
    ko("a-3p", 3, 2, {
      third_place: true,
      scheduled_at: done ? at(5, 9) : null,
      ...(done
        ? decided("a5", "a2", 1, 0)
        : {
            home_slot_label: { key: "slot.loser_match", params: { round: 2, seq: 1 } },
            away_slot_label: { key: "slot.loser_match", params: { round: 2, seq: 2 } },
          }),
    } as Partial<PublicFixture>),
    ko("a-f", 3, 1, {
      is_final: true,
      scheduled_at: done ? at(5, 10) : at(20),
      ...(done
        ? decided("a1", "a3", 2, 1)
        : {
            home_slot_label: { key: "slot.winner_match", params: { round: 2, seq: 1 } },
            away_slot_label: { key: "slot.winner_match", params: { round: 2, seq: 2 } },
          }),
    } as Partial<PublicFixture>),
  ];
  const standings: PublicStandings[] = [
    {
      stage_id: "a-lg",
      pool_id: null,
      updated_at: at(4),
      rows: teams.slice(0, 4).map((t, i) => ({
        entrantId: t.id,
        played: 2,
        won: 2 - Math.min(i, 2),
        drawn: i === 3 ? 1 : 0,
        lost: Math.min(i, 2),
        points: 6 - 3 * Math.min(i, 2),
        metrics: { gf: 5 - i, ga: 1 + i, gd: 4 - 2 * i },
        rank: i + 1,
        ...(i === 1 ? { tieBreak: { key: "diff", with: [teams[2]!.id] } } : {}),
      })),
    },
  ];
  return {
    org: org(),
    competition: hubCompetition(),
    division: { ...DIV_A, status: done ? "completed" : "active" },
    stages: [league, cup],
    pools: [],
    fixtures,
    standings,
    entrants: teams,
    tz: "Europe/London",
  };
}

function divisionBDetail(mode: HubMode) {
  const groups = stage("b-gr", "d-b", 1, "group", "9zqgroups");
  const teams = entrants("d-b", "b", 4);
  const pools = [
    { id: "b-p1", stage_id: "b-gr", key: "A", name: "9zqpool 8zqnorth" },
    { id: "b-p2", stage_id: "b-gr", key: "B", name: "9zqpool 8zqsouth" },
  ];
  const fixtures: PublicFixture[] = [
    fixture({ id: "b-1", division_id: "d-b", stage_id: "b-gr", pool_id: "b-p1", scheduled_at: "2026-09-02T10:00:00.000Z", ...decided("b1", "b2", 0, 0) }),
    fixture({
      id: "b-2",
      division_id: "d-b",
      stage_id: "b-gr",
      pool_id: "b-p2",
      scheduled_at: mode === "finished" ? "2026-09-02T12:00:00.000Z" : "2026-09-06T09:30:00.000Z",
      ...(mode === "finished" ? decided("b3", "b4", 1, 3) : { home_entrant_id: "b3", away_entrant_id: "b4" }),
    }),
    // A match with no time yet: "time to be confirmed" copy.
    fixture({ id: "b-3", division_id: "d-b", stage_id: "b-gr", pool_id: "b-p1", round_no: 2, home_entrant_id: "b2", away_entrant_id: "b1", venue_name: null, court_name: null }),
  ];
  const row = (id: string, rank: number, points: number) => ({
    entrantId: id,
    played: 1,
    won: points === 3 ? 1 : 0,
    drawn: points === 1 ? 1 : 0,
    lost: points === 0 ? 1 : 0,
    points,
    metrics: { gf: 1, ga: 1, gd: 0 },
    rank,
  });
  return {
    org: org(),
    competition: hubCompetition(),
    division: DIV_B,
    stages: [groups],
    pools,
    fixtures,
    standings: [
      { stage_id: "b-gr", pool_id: "b-p1", updated_at: "2026-09-02T12:00:00.000Z", rows: [row("b1", 1, 1), row("b2", 2, 1)] },
      { stage_id: "b-gr", pool_id: "b-p2", updated_at: "2026-09-02T12:00:00.000Z", rows: [row("b4", 1, 3), row("b3", 2, 0)] },
    ],
    entrants: teams,
    tz: "America/Los_Angeles",
  };
}

function seedHub(mode: HubMode) {
  stub.getPublicCompetition.mockResolvedValue({
    org: org(),
    competition: hubCompetition(),
    divisions: [DIV_A, DIV_B],
    liveNow: [],
  });
  stub.getPublicDivision.mockImplementation(async (_o: string, _c: string, slug: string) =>
    slug === DIV_A.slug ? divisionADetail(mode) : slug === DIV_B.slug ? divisionBDetail(mode) : null,
  );
  stub.readEntrantMemberRefs.mockResolvedValue({
    a1: [
      { personId: "p-a0-1", fullName: "1zqplayer 9zqone", consent: null, squadNumber: 9, positionKey: null },
      { personId: "p-a0-2", fullName: "1zqplayer 8zqtwo", consent: null, squadNumber: null, positionKey: null },
    ],
  });
  stub.activePublicSuspensionEntries.mockResolvedValue([
    { divisionId: "d-a", personId: "p-a0-1", entrantId: "a1", name: "1zqplayer 9zqone", remaining: 2 },
  ]);
  stub.readLeaderRows.mockResolvedValue(
    [1, 2, 3, 4, 5, 6].map((i) => ({
      divisionId: "d-a",
      personId: `p-lead-${i}`,
      name: `${i}zqscorer 9zqname`,
      masked: i === 6,
      publicProfile: i !== 5,
      entrantName: `${i}zqa 9zqteam`,
      badgeUrl: null,
      stats: { goals: 10 - i, assists: i, yellow_cards: i % 2, red_cards: i === 3 ? 1 : 0 },
    })),
  );
  stub.publicRegistrationInfo.mockResolvedValue({
    competition: { id: COMP_ID, name: "9zqautumn 8zqcup", slug: COMP_SLUG, starts_on: null, ends_on: null },
    org: { name: org().name, slug: ORG_SLUG, logo_url: null },
    divisions: [{ open: mode !== "finished" }],
  });
  stub.resolveSponsors.mockResolvedValue([
    { id: "s1", name: "9zqtitle 8zqbank", url: "https://example.test/t", logo: null, tier: "title" },
    { id: "s2", name: "9zqgold 8zqmotors", url: null, logo: null, tier: "gold" },
    { id: "s3", name: "9zqsilver 8zqphysio", url: null, logo: null, tier: "silver" },
    { id: "s4", name: "9zqpartner 8zqcafe", url: "https://example.test/p", logo: null, tier: "partner" },
  ]);
}

/** Every tab of the hub, as the page renders it for `?tab=`. */
const HUB_TABS = ["overview", "matches", "table", "knockout", "stats", "teams", "info"] as const;

async function renderHub(mode: HubMode, tabs: readonly string[]): Promise<Segment[]> {
  seedHub(mode);
  const p = params({ orgSlug: ORG_SLUG, competitionSlug: COMP_SLUG });
  const out: Segment[] = [...(await served(Competition, p))];
  for (const tab of tabs) {
    state.tab = tab;
    try {
      const markup = renderToStaticMarkup((await Competition.default(p)) as ReactElement);
      // The tab really rendered: a hub that fell back to Overview would sweep
      // one panel seven times and call it seven.
      expect(markup, `the ${tab} panel rendered (${mode})`).toContain(`data-testid="mh-tab-panel-${tab}"`);
      out.push(...extractSegments(markup));
    } finally {
      state.tab = null;
    }
  }
  return out;
}

// ------------------------------------ the match centre: a real ledger, built

// The fixture page renders the match-centre DOCUMENT `getPublicFixture` hands
// it, and that document's words are resolved while it is built. So the scene
// folds a real ledger through the real `buildMatchCentre`, in the scene's
// locale, exactly as `loadMatchCentre` does with the rows it reads.
const FIXTURE_ID = "00000000-0000-4000-8000-0000000000f1";
const CRICKET = resolveLatestModule("cricket").version;
const SIDES: [SideT, SideT] = [
  { entrantId: "home", name: "1zqhome 9zqside", short: "1ZQ", colour: null, badgeUrl: null },
  { entrantId: "away", name: "2zqaway 9zqside", short: "2ZQ", colour: null, badgeUrl: null },
];
const person = (id: string, slot: "starting" | "bench" = "starting"): PublicPerson => ({
  personId: id,
  name: `1zq${id} 9zqplayer`,
  masked: false,
  slot,
});

/** Home 24 off 6 with a catch in reply: decided by runs, a scorecard with a
 *  dismissal, a bowler with a wicket, a toss. */
const DECIDED_CRICKET: Script = {
  cfg: { ballsPerInnings: 6, ballsPerOver: 6, playersPerSide: 8, minOversForResult: 1 },
  home: HOME,
  away: AWAY,
  tossWonBy: "home",
  elected: "bat",
  innings: [
    { batting: "home", bowlers: ["a7"], deliveries: [{ bat: 4 }, { bat: 6 }, { bat: 1 }, { bat: 4 }, { bat: 0 }, { bat: 4 }] },
    {
      batting: "away",
      bowlers: ["h1"],
      deliveries: [{ bat: 1 }, { out: "caught", fielder: "h2", bat: 0 }, { bat: 2 }, { bat: 0 }, { bat: 4 }, { bat: 0 }],
    },
  ],
};

type FixtureCase = { name: string; build: () => { division: PublicDivision; fixture: PublicFixture; doc: MatchCentreDocT } };

const fixtureInput = (fixtureRow: PublicFixture, div: PublicDivision) => ({
  fixture: fixtureRow,
  lineups: { home: HOME.map((id) => person(id)), away: AWAY.map((id) => person(id)) },
  sides: SIDES,
  venueTz: "Europe/London",
  locale: state.locale,
  now: new Date(ISO),
  hrefs: {
    division: `/shared/${ORG_SLUG}/${COMP_SLUG}/${div.slug}`,
    competition: `/shared/${ORG_SLUG}/${COMP_SLUG}`,
    calendar: `/shared/${ORG_SLUG}/${COMP_SLUG}/${div.slug}/calendar.ics`,
  },
  stage: { name: "9zqstage", roundLabel: null },
  moduleVersion: div.module_version,
  formatLabel: "9zqformat",
});

const FIXTURE_CASES: FixtureCase[] = [
  {
    name: "cricket, decided",
    build: () => {
      const ledger = scriptLedger(DECIDED_CRICKET);
      const div = division("d-c", "9zqc", { sport_key: "cricket", sport_name: "Cricket", variant_key: "t20", module_version: CRICKET });
      const fixtureRow = fixture({
        id: FIXTURE_ID,
        division_id: div.id,
        stage_id: "c-st",
        home_entrant_id: "home",
        away_entrant_id: "away",
        scheduled_at: ISO,
        status: "decided",
        outcome: ledger.state.outcome as PublicFixture["outcome"],
        summary: cricket.summary(ledger.state) as PublicFixture["summary"],
      });
      const doc = buildMatchCentre({ ...fixtureInput(fixtureRow, div), sportKey: "cricket", cfg: ledger.cfg, events: ledger.events });
      return { division: div, fixture: fixtureRow, doc };
    },
  },
  {
    name: "football, in play (goals, a card, a substitution, half-time)",
    build: () => {
      const div = division("d-f", "9zqf");
      const fixtureRow = fixture({
        id: FIXTURE_ID,
        division_id: div.id,
        stage_id: "f-st",
        home_entrant_id: "home",
        away_entrant_id: "away",
        scheduled_at: ISO,
        status: "in_play",
        stream_url: "https://example.test/stream",
      });
      const input = fixtureInput(fixtureRow, div);
      const doc = buildMatchCentre({
        ...input,
        lineups: { home: ["h1", "h2", "h3"].map((id) => person(id)), away: [...["a1", "a2", "a3"].map((id) => person(id)), person("a9", "bench")] },
        sportKey: "football",
        cfg: FootballCfg.parse({}),
        events: [
          makeEnvelope(0, { type: "core.start", payload: {} }),
          makeEnvelope(1, { type: "football.goal", payload: { by: "home", scorer: "h1", assist: "h2", minute: 12 } }),
          makeEnvelope(2, { type: "football.card", payload: { by: "away", person: "a2", color: "yellow", minute: 30 } }),
          makeEnvelope(3, { type: "football.period", payload: { phase: "HT" } }),
          makeEnvelope(4, { type: "football.sub", payload: { by: "away", off: "a3", on: "a9", minute: 50 } }),
          makeEnvelope(5, { type: "football.goal", payload: { by: "away", scorer: "a1", penalty: true, minute: 61 } }),
        ],
      });
      return { division: div, fixture: fixtureRow, doc };
    },
  },
];

async function renderFixtures(): Promise<Segment[]> {
  const out: Segment[] = [];
  for (const c of FIXTURE_CASES) {
    const { division: div, fixture: fixtureRow, doc } = c.build();
    stub.getPublicFixture.mockResolvedValue({
      org: org(),
      competition: hubCompetition(),
      division: div,
      fixture: fixtureRow,
      entrantNames: { home: SIDES[0].name, away: SIDES[1].name },
      realtime: false,
      matchCentre: doc,
      venueTz: "Europe/London",
      stageName: "9zqstage",
    });
    const p = params({ orgSlug: ORG_SLUG, competitionSlug: COMP_SLUG, divisionSlug: div.slug, fixtureId: FIXTURE_ID });
    out.push(...(await served(Fixture, p)));
    expect(doc.tabs.length, `${c.name}: the document has tabs`).toBeGreaterThan(1);
    for (const tab of doc.tabs) {
      state.search = `tab=${tab}`;
      try {
        const markup = renderToStaticMarkup((await Fixture.default(p)) as ReactElement);
        expect(markup, `${c.name}: the ${tab} panel rendered`).toContain(`data-testid="mc-tab-panel-${tab}"`);
        out.push(...extractSegments(markup));
      } finally {
        state.search = "";
      }
    }
  }
  return out;
}

// ------------------------------- the match poster: both shapes, three states

// The fixture's share card (OG) and its downloadable poster are ONE model in
// two shapes (`server/og/match-poster-data.ts`). Each state the model has a
// layout for is drawn in both: a result (the cricket match, with its two
// performers), a live match (the football one) and one not yet started. The
// element handed to satori is rendered to markup, so a literal in the layout
// and a word in the model are read alike.
const UPCOMING_FOOTBALL: FixtureCase = {
  name: "football, not started",
  build: () => {
    const div = division("d-f", "9zqf");
    const fixtureRow = fixture({
      id: FIXTURE_ID,
      division_id: div.id,
      stage_id: "f-st",
      home_entrant_id: "home",
      away_entrant_id: "away",
      scheduled_at: "2026-09-06T13:00:00.000Z",
      status: "scheduled",
    });
    const doc = buildMatchCentre({ ...fixtureInput(fixtureRow, div), sportKey: "football", cfg: FootballCfg.parse({}), events: [] });
    return { division: div, fixture: fixtureRow, doc };
  },
};

async function renderPosters(): Promise<Segment[]> {
  const out: Segment[] = [];
  for (const c of [...FIXTURE_CASES, UPCOMING_FOOTBALL]) {
    const { division: div, fixture: fixtureRow, doc } = c.build();
    stub.getPublicFixture.mockResolvedValue({
      org: org(),
      competition: hubCompetition(),
      division: div,
      fixture: fixtureRow,
      entrantNames: { home: SIDES[0].name, away: SIDES[1].name },
      realtime: false,
      matchCentre: doc,
      venueTz: "Europe/London",
      stageName: "9zqstage",
    });
    const p = params({ orgSlug: ORG_SLUG, competitionSlug: COMP_SLUG, divisionSlug: div.slug, fixtureId: FIXTURE_ID });
    images.drawn.length = 0;
    await FixtureCard(p);
    const poster = await fixturePoster(new Request("https://example.test/poster.png"), p);
    expect(poster.status, `${c.name}: the poster route answered`).toBe(200);
    expect(images.drawn, `${c.name}: the card and the poster each drew`).toHaveLength(2);
    for (const element of images.drawn) out.push(...extractSegments(renderToStaticMarkup(element as ReactElement)));
  }
  return out;
}

// ------------------------------------- the embed widgets, inside their chrome

// A club's iframe: /embed/divisions/<id>/{standings|schedule|bracket}, each in
// the embed layout. The bracket widget is drawn twice — over a division with a
// knockout, and over one without, which is the only place its empty line shows.
// Metadata is not read: the embed document's <title> is never shown (the
// widget lives inside another site's page, `robots: noindex`).
async function renderEmbeds(): Promise<Segment[]> {
  seedHub("live");
  const cases: [string, ReturnType<typeof divisionADetail> | ReturnType<typeof divisionBDetail>][] = [
    ["standings", divisionADetail("live")],
    ["standings", divisionBDetail("live")],
    ["schedule", divisionADetail("live")],
    ["bracket", divisionADetail("live")],
    ["bracket", divisionBDetail("live")],
  ];
  const out: Segment[] = [];
  let emptyBracket = 0;
  for (const [widget, detail] of cases) {
    stub.embedDivisionData.mockResolvedValue({ ok: true, data: detail });
    const page = await EmbedWidget(params({ id: detail.division.id, widget }));
    const markup = renderToStaticMarkup(EmbedLayout({ children: page }) as ReactElement);
    if (widget === "bracket" && !detail.stages.some((s) => s.kind === "knockout")) {
      emptyBracket += 1;
      expect(markup, "the empty bracket says so").toMatch(/<p class="p-2 text-sm text-zinc-500">[^<]+<\/p>/);
    }
    expect(markup, `${widget}: the attribution renders with the widget`).toMatch(/utm_source=embed[^>]*>[^<]+ →<\/a>/);
    out.push(...extractSegments(markup));
  }
  expect(emptyBracket, "premise: one bracket widget has no bracket stage to draw").toBe(1);
  return out;
}

// ------------------------------------------ the player page: its baked words

// `getPublicPlayer` bakes the stat labels, the career line and each match line
// in the org's locale from rows it reads. The stub hands the page those fields
// built by the SAME exported labellers, in the scene's locale.
const PERSON_ID = "00000000-0000-4000-8000-0000000000e1";

async function playerData() {
  const locale = toLocale(state.locale);
  const statMsg = (k: Parameters<typeof msgFor>[1]) => msgFor(locale, k);
  const plural = (key: string, n: number) =>
    msgFor(locale, `${key}.${new Intl.PluralRules(locale).select(n)}` as Parameters<typeof msgFor>[1], { count: n });
  const snapshots = [
    { division_id: "d-a", division_name: DIV_A.name, division_slug: DIV_A.slug, sport_key: "football", variant_key: "11-a-side", module_version: FOOTBALL, stats: { goals: 3, assists: 2, yellow_cards: 1, red_cards: 0 } },
    { division_id: "d-b", division_name: DIV_B.name, division_slug: DIV_B.slug, sport_key: "football", variant_key: "7-a-side", module_version: FOOTBALL, stats: { goals: 1, assists: 0, yellow_cards: 0, red_cards: 1 } },
  ];
  const seed = (id: string, over: Partial<PlayerMatchSeed>): PlayerMatchSeed => ({
    fixtureId: `00000000-0000-4000-8000-00000000${id}`,
    href: `/shared/${ORG_SLUG}/${COMP_SLUG}/${DIV_A.slug}/fixtures/${id}`,
    divisionName: DIV_A.name,
    divisionSlug: DIV_A.slug,
    scheduledAt: ISO,
    tz: "Europe/London",
    opponentName: "3zqopponent 9zqside",
    result: "won",
    sportKey: "football",
    status: "decided",
    lastSeq: 9,
    snapshotAt: null,
    slot: "starting",
    scoreLine: "3–1",
    ...over,
  });
  const seeds = [
    seed("0001", { status: "in_play", result: "live", scoreLine: "1–1", scheduledAt: "2026-09-05T11:30:00.000Z" }),
    seed("0002", {}),
    seed("0003", { result: "drawn", scoreLine: "2–2", scheduledAt: "2026-08-29T13:00:00.000Z" }),
    seed("0004", { result: "lost", sportKey: "cricket", scoreLine: null, scheduledAt: "2026-08-22T13:00:00.000Z" }),
    seed("0005", { result: "lost", scoreLine: "0–2", scheduledAt: null }),
  ];
  const matches = await composePlayerMatchLines(seeds, [PERSON_ID], await getDictionary(locale, "public"), async () => ({
    [PERSON_ID]: { batting: { runs: 23, balls: 17 }, bowling: { wickets: 2, runs: 18 } },
  }));
  return {
    org: org(),
    competition: hubCompetition(),
    player: { id: PERSON_ID, org_id: org().id, name: "4zqpat 9zqlee", photo: null },
    memberships: [
      { division_name: DIV_A.name, division_slug: DIV_A.slug, entrant_name: "1zqa 9zqteam", squad_number: 9, position: "9zqforward" },
      { division_name: DIV_B.name, division_slug: DIV_B.slug, entrant_name: "1zqb 9zqteam", squad_number: null, position: null },
    ],
    stats: snapshots.map((s) => ({
      division_name: s.division_name,
      division_slug: s.division_slug,
      sport_key: s.sport_key,
      metrics: labelPlayerStats(s.sport_key, s.module_version, s.stats, statMsg),
    })),
    career: groupCareerStatsBySport(snapshots, new Map([["d-a", 4], ["d-b", 2]]), statMsg).map((c) => ({
      ...c,
      meta: [plural("career.divisions", c.divisions), plural("career.variants", c.variants), plural("career.matches", c.matches)].join(" · "),
    })),
    careerLabel: statMsg("player.career.title"),
    matches,
    generatedAt: ISO,
  };
}

async function renderPlayer(): Promise<Segment[]> {
  const data = await playerData();
  expect(data.stats.every((s) => s.metrics.length > 0), "the stat labeller labelled every division").toBe(true);
  expect(data.career.length, "the career rollup aggregated").toBe(1);
  expect(data.matches.length, "every seeded match became a line").toBe(5);
  stub.getPublicPlayer.mockResolvedValue(data);
  const p = params({ orgSlug: ORG_SLUG, competitionSlug: COMP_SLUG, personId: PERSON_ID });
  return [...(await html(await Player.default(p))), ...(await served(Player, p))];
}

// ------------------------------------------ the division page, every panel

// The division page renders its three panels at once (the tab bar only hides
// two), so one render reads Schedule, Standings and Entrants together. Four
// states between them draw every conditional word it has: a league table with
// a tie-break note, a live match in the results grid and a knockout; the same
// division finished, crowned; two pools; and a division with nothing yet.
async function renderDivisions(): Promise<Segment[]> {
  seedHub("live");
  stub.publicSuspensions.mockResolvedValue([
    { name: "1zqplayer 9zqone", remaining: 2 },
    { name: "2zqplayer 9zqtwo", remaining: 1 },
  ]);
  const cases: [string, ReturnType<typeof divisionADetail> | ReturnType<typeof divisionBDetail>][] = [
    ["a league with a tie-break, a live match and a knockout", divisionADetail("live")],
    ["finished, with a champion", divisionADetail("finished")],
    ["two pools and a match with no time", divisionBDetail("live")],
    // A second SPORT for the empty state. Football's catalog name is also the
    // French word ("Football"), so a football page alone cannot see the sport
    // name leak in fr; volleyball's ("Volleyball") is no locale's word.
    [
      "nothing yet, in another sport: no fixtures, no standings, no entrants",
      {
        ...divisionBDetail("upcoming"),
        division: { ...DIV_B, sport_key: "volleyball", sport_name: "Volleyball", variant_key: "indoor", module_version: VOLLEYBALL, config: {} },
        fixtures: [],
        standings: [],
        entrants: [],
      },
    ],
  ];
  const out: Segment[] = [];
  for (const [name, detail] of cases) {
    stub.getPublicDivision.mockResolvedValue(detail);
    const p = params({ orgSlug: ORG_SLUG, competitionSlug: COMP_SLUG, divisionSlug: detail.division.slug });
    const markup = renderToStaticMarkup((await Division.default(p)) as ReactElement);
    for (const panel of ["schedule", "standings", "entrants"]) {
      expect(markup, `${name}: the ${panel} panel rendered`).toContain(`id="panel-${panel}"`);
    }
    out.push(...extractSegments(markup), ...(await served(Division, p)));
  }
  return out;
}

// ---------------------------------------------- the kiosk boards, every slide

// A board shows one slide at a time, so a static render draws only the first.
// Each slide the page built is rendered on its own, inside the kiosk layout,
// with every other prop exactly as the page set it.
async function renderBoards(): Promise<Segment[]> {
  seedHub("live");
  stub.getPublicOrg.mockResolvedValue({ org: org(), competitions: [] });
  const competitionBoard = params({ orgSlug: ORG_SLUG, competitionSlug: COMP_SLUG });
  const divisionBoard = params({ orgSlug: ORG_SLUG, competitionSlug: COMP_SLUG, divisionSlug: DIV_A.slug });
  const boards = [
    (await PresentCompetition.default(competitionBoard)) as ReactElement<Parameters<typeof Slideshow>[0]>,
    (await PresentDivision.default(divisionBoard)) as ReactElement<Parameters<typeof Slideshow>[0]>,
  ];
  // A board's tab title and description, as a browser or a cast list shows them.
  const out: Segment[] = [
    ...(await served(PresentCompetition, competitionBoard)),
    ...(await served(PresentDivision, divisionBoard)),
  ];
  for (const board of boards) {
    expect(board.type, "the page returns the board").toBe(Slideshow);
    const kinds = new Set(board.props.slides.map((slide) => slide.kind));
    expect(kinds.size, `the board has more than one kind of slide (${[...kinds].join(", ")})`).toBeGreaterThan(1);
    for (const slide of board.props.slides) {
      const one = createElement(Slideshow, { ...board.props, slides: [slide] });
      out.push(...(await html(await KioskOrgLayout({ children: one, ...params({ orgSlug: ORG_SLUG }) }))));
    }
  }
  return out;
}

// ------------------------------------------------------------- the scenes

type Params<T> = { params: Promise<T> };
const params = <T,>(p: T): Params<T> => ({ params: Promise.resolve(p) });
const html = async (el: unknown) => extractSegments(renderToStaticMarkup(el as ReactElement));

/**
 * What a page module puts in the document head as SERVED: its own
 * `generateMetadata` (or static `metadata`, or neither) merged under the
 * layouts above it, so a field the page leaves out is read from the layout
 * that supplies it. Only the ROOT layout declares metadata anywhere above
 * /shared — the coverage test pins that, so a layout that starts declaring it
 * reds there instead of hiding here.
 */
async function served(mod: object, p: unknown): Promise<Segment[]> {
  const page = mod as { generateMetadata?: (p: unknown) => Promise<unknown>; metadata?: unknown };
  const own = page.generateMetadata ? await page.generateMetadata(p) : page.metadata;
  return metadataSegments(servedMetadata([rootMetadata as Record<string, unknown>], own as Record<string, unknown> | undefined));
}

interface Scene {
  name: string;
  /** The files under `app/(public)/shared` this scene renders. */
  files: string[];
  /** The positive half: at least this many segments of the EN render are
   *  dictionary values. Set a little under what the render draws today. */
  minDictValues: number;
  render: () => Promise<Segment[]>;
}

const SCENES: Scene[] = [
  {
    name: "org layout (header strip, footer)",
    files: ["[orgSlug]/layout.tsx"],
    minDictValues: 2,
    render: async () => {
      stub.getPublicOrg.mockResolvedValue({ org: org(), competitions: [] });
      return html(await OrgLayout({ children: createElement("p", null, "9zqchild"), ...params({ orgSlug: ORG_SLUG }) }));
    },
  },
  {
    name: "org home",
    files: ["[orgSlug]/page.tsx"],
    minDictValues: 6,
    render: async () => {
      stub.getPublicOrg.mockResolvedValue({
        org: org(),
        competitions: [
          competitionRow("1", "published", 1, "2026-09-01", "2026-09-13"),
          competitionRow("2", "published", 0, "2026-10-04", null),
          competitionRow("3", "completed", 0, null, null),
          competitionRow("4", "active", 3, "2026-09-01", null),
          // Marked live with nothing in play: the uncounted "On now" chip.
          competitionRow("5", "live", 0, "2026-09-02", null),
        ],
      });
      stub.publicPosts.mockResolvedValue({ posts: POSTS.slice(0, 3), hasMore: false });
      const p = params({ orgSlug: ORG_SLUG });
      return [...(await html(await OrgHome.default(p))), ...(await served(OrgHome, p))];
    },
  },
  {
    name: "news feed",
    files: ["[orgSlug]/news/page.tsx"],
    minDictValues: 6,
    render: async () => {
      stub.getPublicOrg.mockResolvedValue({ org: org(), competitions: [] });
      stub.publicPosts.mockResolvedValue({ posts: POSTS, hasMore: true });
      const p = { ...params({ orgSlug: ORG_SLUG }), searchParams: Promise.resolve({ page: "1" }) };
      return [...(await html(await NewsFeed.default(p))), ...(await served(NewsFeed, p))];
    },
  },
  {
    name: "news post (a result with a scorebug, and an announcement)",
    files: ["[orgSlug]/news/[postSlug]/page.tsx"],
    minDictValues: 4,
    render: async () => {
      stub.getPublicOrg.mockResolvedValue({ org: org(), competitions: [] });
      stub.resolvePostSides.mockResolvedValue(null);
      stub.relatedCompetition.mockResolvedValue({ name: "9zqrelated 8zqcup", slug: "9zqrelated" });
      const out: Segment[] = [];
      for (const p of [POSTS[0]!, POSTS[2]!]) {
        stub.publicPost.mockResolvedValue(p);
        const pp = params({ orgSlug: ORG_SLUG, postSlug: p.slug });
        out.push(...(await html(await NewsPost.default(pp))), ...(await served(NewsPost, pp)));
      }
      return out;
    },
  },
  {
    name: "QR poster",
    files: ["[orgSlug]/[competitionSlug]/poster/page.tsx"],
    minDictValues: 2,
    render: async () => {
      stub.getPublicCompetition.mockResolvedValue({
        org: org(),
        competition: competitionRow("1", "active", 0, "2026-09-01", "2026-09-13"),
        divisions: [],
        liveNow: [],
      });
      const p = params({ orgSlug: ORG_SLUG, competitionSlug: COMP_SLUG });
      return [...(await html(await Poster.default(p))), ...(await served(Poster, p))];
    },
  },
  {
    name: "competition hub — a live competition, every tab",
    files: ["[orgSlug]/[competitionSlug]/page.tsx"],
    minDictValues: 40,
    render: () => renderHub("live", HUB_TABS),
  },
  {
    name: "competition hub — nothing live (Overview's next matches, Matches on Upcoming)",
    files: [],
    minDictValues: 10,
    render: () => renderHub("upcoming", ["overview", "matches"]),
  },
  {
    name: "competition hub — finished (champions, Matches on Results, a decided knockout)",
    files: [],
    minDictValues: 10,
    render: () => renderHub("finished", ["overview", "matches", "knockout"]),
  },
  {
    name: "division page (schedule, standings with a results grid and a bracket, entrants; four states)",
    files: ["[orgSlug]/[competitionSlug]/[divisionSlug]/page.tsx"],
    minDictValues: 12,
    render: renderDivisions,
  },
  {
    name: "public fixture / match centre (a decided cricket match and a live football one, every tab)",
    files: ["[orgSlug]/[competitionSlug]/[divisionSlug]/fixtures/[fixtureId]/page.tsx"],
    minDictValues: 20,
    render: renderFixtures,
  },
  {
    name: "match poster (the fixture's share card and poster.png: a result, a live match, one not started)",
    files: [
      "[orgSlug]/[competitionSlug]/[divisionSlug]/fixtures/[fixtureId]/opengraph-image.tsx",
      "[orgSlug]/[competitionSlug]/[divisionSlug]/fixtures/[fixtureId]/poster.png/route.tsx",
    ],
    minDictValues: 4,
    render: renderPosters,
  },
  {
    name: "embed widgets (standings, schedule, a bracket and a division with none, in the embed chrome)",
    files: ["../../embed/layout.tsx", "../../embed/divisions/[id]/[widget]/page.tsx"],
    minDictValues: 10,
    render: renderEmbeds,
  },
  {
    name: "player page (stats, career, match lines)",
    files: ["[orgSlug]/[competitionSlug]/players/[personId]/page.tsx"],
    minDictValues: 8,
    render: renderPlayer,
  },
  {
    // A refused or absent card's own 404 (W2 eaf97b0ed). A not-found page takes
    // no props, so the card's layout resolves the org's copy and hands it down;
    // rendered here the way Next mounts it, inside that layout.
    name: "player card not-found (inside the card's layout)",
    files: ["[orgSlug]/[competitionSlug]/players/[personId]/layout.tsx", "[orgSlug]/[competitionSlug]/players/[personId]/not-found.tsx"],
    minDictValues: 3,
    render: async () => {
      stub.getPublicOrg.mockResolvedValue({ org: org(), competitions: [] });
      const tree = await PlayerCardLayout({
        children: createElement(PlayerNotFound),
        ...params({ orgSlug: ORG_SLUG, competitionSlug: COMP_SLUG, personId: PERSON_ID }),
      });
      const segments = await html(tree);
      expect(segments.length, "the 404 drew its heading, sentence and link").toBeGreaterThanOrEqual(3);
      return segments;
    },
  },
  {
    name: "kiosk boards (competition and division, every slide, in the kiosk layout)",
    files: [
      "(kiosk)/[orgSlug]/layout.tsx",
      "(kiosk)/[orgSlug]/[competitionSlug]/present/page.tsx",
      "(kiosk)/[orgSlug]/[competitionSlug]/[divisionSlug]/present/page.tsx",
    ],
    minDictValues: 10,
    render: renderBoards,
  },
];

/** Pages and layouts under /shared this sweep does not render, and why. */
const REGISTER =
  "the registration flow is written in the VISITOR's locale (`resolveLocale`, a cookie), not the org's, and is not in Task 16's page list; its copy is pinned by the register suites beside it";
const EXCLUDED: Record<string, string> = {
  "[orgSlug]/[competitionSlug]/register/page.tsx": REGISTER,
  "[orgSlug]/[competitionSlug]/register/join/page.tsx": REGISTER,
  "[orgSlug]/[competitionSlug]/register/status/page.tsx": REGISTER,
  "../r/[ref]/page.tsx":
    "registration's by-reference status page, a sibling of /shared in the public tree: written in the VISITOR's locale (`resolveLocale`) like the register flow, and not in Task 16's page list",
};

/**
 * Every OTHER Next file convention under the public tree that can put words in
 * front of a person — a 404, a share image, a route handler. None of them is
 * markup in the org's locale this sweep can read (a 404 has no org yet, a share
 * image is satori pixels, a calendar is ICS text, a poster is a PDF), so each is
 * named with WHY, and with the suites, relative to `src`, that witness its words
 * — which must exist. A new one reds the coverage test until it is swept or
 * listed here.
 */
interface NotRendered {
  reason: string;
  /** At least one, and each must exist. */
  provenBy: readonly string[];
}
const SHARED_SRC = "app/(public)/shared";
const NOT_FOUND_TEST = `${SHARED_SRC}/[orgSlug]/__tests__/not-found.test.tsx`;
const COMPETITION_CARD_TEST = `${SHARED_SRC}/[orgSlug]/[competitionSlug]/__tests__/opengraph-image-locale.test.tsx`;
const DIVISION_CARD_TEST = `${SHARED_SRC}/[orgSlug]/[competitionSlug]/[divisionSlug]/__tests__/opengraph-image-locale.test.tsx`;
const NEWS_CARD_TEST = `${SHARED_SRC}/[orgSlug]/news/__tests__/news-share-image-locale.test.tsx`;
const NOT_RENDERED: Record<string, NotRendered> = {
  "[orgSlug]/not-found.tsx": {
    reason:
      "the 404 fires BEFORE any org resolves (a reserved or missing slug), so there is no org locale to write in; it reads DEFAULT_LOCALE's dictionary by design and must stay static",
    provenBy: [NOT_FOUND_TEST],
  },
  "(kiosk)/[orgSlug]/not-found.tsx": {
    reason: "a re-export of `[orgSlug]/not-found.tsx` for the kiosk group, which has no parent boundary to inherit it from",
    provenBy: [NOT_FOUND_TEST],
  },
  "[orgSlug]/[competitionSlug]/opengraph-image.tsx": {
    reason: "a satori PNG, not markup: the live pill, count chips, dates and footer are drawn in the org's locale",
    provenBy: [COMPETITION_CARD_TEST, `${SHARED_SRC}/[orgSlug]/[competitionSlug]/__tests__/opengraph-image-dates.test.tsx`],
  },
  "(kiosk)/[orgSlug]/[competitionSlug]/present/opengraph-image.tsx": {
    reason: "a re-export of the competition share card for the kiosk board, which has no parent segment to inherit it from",
    provenBy: [COMPETITION_CARD_TEST],
  },
  "[orgSlug]/[competitionSlug]/[divisionSlug]/opengraph-image.tsx": {
    reason: "a satori PNG, not markup: the youth line, empty line and table are drawn in the org's locale",
    provenBy: [DIVISION_CARD_TEST],
  },
  "(kiosk)/[orgSlug]/[competitionSlug]/[divisionSlug]/present/opengraph-image.tsx": {
    reason: "a re-export of the division share card for the kiosk board, which has no parent segment to inherit it from",
    provenBy: [DIVISION_CARD_TEST],
  },
  "[orgSlug]/news/[postSlug]/opengraph-image.tsx": {
    reason: "a satori PNG, not markup: the post card's kind eyebrow and footer are drawn in the org's locale",
    provenBy: [NEWS_CARD_TEST],
  },
  "[orgSlug]/news/[postSlug]/story.png/route.tsx": {
    reason: "a route handler returning a satori PNG (the post card at story proportions), drawn in the org's locale",
    provenBy: [NEWS_CARD_TEST],
  },
  "[orgSlug]/[competitionSlug]/[divisionSlug]/calendar.ics/route.ts": {
    reason: "a route handler returning text/calendar, read in a calendar app rather than a page: event titles and the time-to-be-confirmed copy are written in the org's locale",
    provenBy: [`${SHARED_SRC}/[orgSlug]/[competitionSlug]/[divisionSlug]/calendar.ics/__tests__/route.test.ts`],
  },
  "[orgSlug]/[competitionSlug]/poster.pdf/route.ts": {
    reason: "a route handler returning application/pdf: the printed poster's copy and month names are written in the org's locale",
    provenBy: [`${SHARED_SRC}/[orgSlug]/[competitionSlug]/poster.pdf/__tests__/route.test.ts`],
  },
  "../r/[ref]/ticket.png/route.tsx": {
    reason:
      "a route handler returning a satori PNG of the by-reference registration ticket, drawn in the VISITOR's locale (`resolveLocale`) exactly as `../r/[ref]/page.tsx` is — not the org's, so outside this sweep's locale",
    provenBy: ["app/(public)/r/[ref]/__tests__/ticket-png-locale.test.tsx"],
  },
};

// ---------------------------------------------------------------- running

const renders = new Map<string, Promise<Segment[]>>();

/** One render per scene and locale, shared by every test that reads it. The
 *  locale is the org's `default_locale` the stubs read, so renders are
 *  serialised: two scenes rendering at once would read each other's locale. */
let queue: Promise<unknown> = Promise.resolve();
function renderIn(scene: Scene, locale: Locale): Promise<Segment[]> {
  const key = `${scene.name}|${locale}`;
  let hit = renders.get(key);
  if (!hit) {
    hit = queue.then(async () => {
      state.locale = locale;
      return scene.render();
    });
    queue = hit.catch(() => undefined);
    renders.set(key, hit);
  }
  return hit;
}

const findingsIn = (segments: readonly Segment[], locale: Locale, allow: readonly string[] = []): Finding[] => {
  const seen = new Set<string>();
  return segments
    .map((seg) => classify(seg, locale, allow))
    .filter((f): f is Finding => f !== null)
    .filter((f) => {
      const k = `${f.kind}|${f.where}|${f.text}`;
      return seen.has(k) ? false : (seen.add(k), true);
    });
};

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-05T12:00:00.000Z"));
});
afterAll(() => {
  vi.useRealTimers();
});

// ------------------------------------------------------------------ tests

describe("the sweep's classifier, on markup whose answer is known", () => {
  const es: Locale = "es";

  it("an English dictionary value on a Spanish page is an English literal, with its key", () => {
    const [f] = findingsIn(extractSegments(`<button>Copy link</button>`), es);
    expect(f?.kind).toBe("english");
    expect(f?.keys.join()).toContain("public:share.copy");
  });

  it("a string in no dictionary is hardcoded, in text and in a visible attribute", () => {
    const found = findingsIn(extractSegments(`<a aria-label="Totally unlisted words">Nowhere in any dictionary</a>`), es);
    expect(found.map((f) => [f.kind, f.where, f.text])).toEqual([
      ["hardcoded", "@aria-label", "Totally unlisted words"],
      ["hardcoded", "text", "Nowhere in any dictionary"],
    ]);
  });

  it("an icon or a count beside an English value does not hide it", () => {
    const found = findingsIn(extractSegments(`<a>Run your own free →</a><span>Live 3</span>`), es);
    expect(found.map((f) => [f.kind, f.text, f.keys.includes("public:layout.attribution")])).toEqual([
      ["english", "Run your own free →", true],
      ["english", "Live 3", false],
    ]);
  });

  it("data, numbers and the locale's own dates are accounted for; another locale's date is not", () => {
    const esDate = new Intl.DateTimeFormat("es", { dateStyle: "full", timeStyle: "short", timeZone: "UTC" }).format(
      new Date(ISO),
    );
    const enDate = new Intl.DateTimeFormat("en-GB", { dateStyle: "full", timeZone: "UTC" }).format(new Date(ISO));
    expect(findingsIn(extractSegments(`<p>9zqblue 8zqred</p><p>3–1</p><p>${esDate}</p>`), es)).toEqual([]);
    expect(findingsIn(extractSegments(`<p>${enDate}</p>`), es).map((f) => f.kind)).toEqual(["hardcoded"]);
  });

  it("a template is explained only when what fills its placeholders is: data yes, English no", () => {
    // `landing.divisions.other` is "{count} divisiones" in es.
    expect(explained("12 divisiones", es, [])).toBe(true);
    expect(explained("Copy link divisiones", es, [])).toBe(false);
  });

  it("a template's literal WORD is matched as a word: es \"{a} y {b}\" does not explain the \"y\" in \"by\"", () => {
    expect(explained("9zqa y 8zqb", es, [])).toBe(true);
    expect(explained("by", es, [])).toBe(false);
  });

  it("values a component glues with its own brackets and commas are explained piece by piece — every piece this locale's", () => {
    // `matchCentre.oversShort` "{overs} ov" and `runRateShort` "RR {rate}".
    expect(explained("83/6 (8.0 ov, RR 10.38)", es, [])).toBe(true);
    expect(explained("83/6 (8.0 ov, Copy link)", es, [])).toBe(false);
  });

  it("an allowlisted phrase is a whole word, and only where it is listed", () => {
    expect(explained("W", es, ["W"])).toBe(true);
    expect(findingsIn(extractSegments(`<th>W</th>`), es).map((f) => f.kind)).toEqual(["english"]);
    // A substring strip would leave "WW" with no letters at all — accounted for.
    expect(explained("WW", es, ["W"])).toBe(false);
  });

  it("a fragment of a template split around an element is explained", () => {
    // `layout.poweredBy` is split around `{brand}` by the org layout.
    const segs = extractSegments(`<p>Desarrollado con <span>9zqbrand</span> ·</p>`);
    expect(segs.map((s) => s.text)).toEqual(["Desarrollado con", "9zqbrand", "·"]);
    expect(findingsIn(segs, es)).toEqual([]);
  });

  it("a value that carries a separator is explained inside a longer run of separated pieces — each run this locale's", () => {
    // es `qrPoster.metaTitle` is "{competition} — cartel QR"; the root layout's
    // title template appends " — Seazn Club".
    expect(explained("9zqcup — cartel QR — Seazn Club", es, [])).toBe(true);
    expect(explained("9zqcup — Copy link — Seazn Club", es, [])).toBe(false);
    expect(explained("9zqcup — cartel QR — Copy link", es, [])).toBe(false);
  });

  it("served metadata inherits what the page leaves out, and titles go through the layout's template", () => {
    const root = { title: { default: "Root title", template: "%s — Brand" }, description: "Root words", openGraph: { siteName: "Brand" } };
    // A page that sets only robots serves the root's title and description.
    expect(servedMetadata([root], { robots: { index: false } })).toMatchObject({ title: "Root title", description: "Root words" });
    // A page's own fields replace the root's; its string title is templated.
    expect(servedMetadata([root], { title: "Page", description: "Page words" })).toMatchObject({
      title: "Page — Brand",
      description: "Page words",
      openGraph: { siteName: "Brand" },
    });
    expect(servedMetadata([root], { title: { absolute: "Alone" } }).title).toBe("Alone");
    // A layout's template is not applied to its own title.
    expect(servedMetadata([root], undefined).title).toBe("Root title");
    const [f] = findingsIn(metadataSegments(servedMetadata([rootMetadata as Record<string, unknown>], { robots: {} })), es).filter(
      (x) => x.where === "meta.description",
    );
    expect(f?.kind, "the real root layout's description is English on a Spanish page").toBe("hardcoded");
  });

  it("the positive half counts dictionary values and not data", () => {
    expect(dictionaryHits(extractSegments(`<p>Copy link</p><p>9zqname</p><p>12</p>`), "en")).toBe(1);
  });
});

describe("coverage: every file under the public tree and /embed that can put words in front of a person is swept or excused", () => {
  const SHARED = join(__dirname, "..");
  const PUBLIC = join(SHARED, "..");
  const APP = join(PUBLIC, "..");
  const SRC = join(APP, "..");
  /** Relative to /shared, so the sibling `r` tree reads `../r/…` and the embed `../../embed/…`. */
  const walk = (dir: string, match: RegExp): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) return name === "__tests__" ? [] : walk(full, match);
      return match.test(name) ? [relative(SHARED, full).split(sep).join("/")] : [];
    });
  const ROOTS = [PUBLIC, join(APP, "embed")];
  const onDiskMatching = (match: RegExp) => ROOTS.flatMap((root) => walk(root, match)).sort();
  const basename = (file: string) => file.slice(file.lastIndexOf("/") + 1);
  const swept = (match: RegExp) => SCENES.flatMap((s) => s.files).filter((f) => match.test(basename(f)));
  const PAGE_OR_LAYOUT = /^(page|layout)\.[jt]sx?$/;
  /** The other conventions Next serves to a visitor from an `app` segment. */
  const OTHER_CONVENTION =
    /^(?:(?:not-found|error|global-error|forbidden|unauthorized|loading|template|default|route)\.[jt]sx?|(?:opengraph-image|twitter-image|icon|apple-icon)(?:\.alt)?\.\w+|(?:sitemap|robots|manifest)\.\w+)$/;

  it("premise: every scene file is one of the two shapes the walks look for", () => {
    const files = SCENES.flatMap((s) => s.files);
    expect(files.filter((f) => !PAGE_OR_LAYOUT.test(basename(f)) && !OTHER_CONVENTION.test(basename(f)))).toEqual([]);
  });

  it("the pages and layouts on disk are exactly the scenes' files plus the exclusions", () => {
    const onDisk = onDiskMatching(PAGE_OR_LAYOUT);
    expect(onDisk, "premise: the walk reaches /embed").toContain("../../embed/divisions/[id]/[widget]/page.tsx");
    const accounted = [...swept(PAGE_OR_LAYOUT), ...Object.keys(EXCLUDED)].sort();
    expect(onDisk.filter((f) => !accounted.includes(f)), "on disk but neither swept nor excluded").toEqual([]);
    expect(accounted).toEqual(onDisk);
    for (const [file, reason] of Object.entries(EXCLUDED)) expect(reason.length, file).toBeGreaterThan(20);
  });

  it("every other convention file on disk — 404s, share images, route handlers — is swept, or listed with a reason and an existing witness", () => {
    const onDisk = onDiskMatching(OTHER_CONVENTION);
    expect(onDisk, "premise: the walk finds the 404, the share cards and the calendar").toEqual(
      expect.arrayContaining(["[orgSlug]/not-found.tsx", "[orgSlug]/[competitionSlug]/opengraph-image.tsx", "[orgSlug]/[competitionSlug]/[divisionSlug]/calendar.ics/route.ts"]),
    );
    const sweptHere = swept(OTHER_CONVENTION);
    expect(sweptHere.filter((f) => f in NOT_RENDERED), "swept AND listed as not rendered").toEqual([]);
    const accounted = [...sweptHere, ...Object.keys(NOT_RENDERED)].sort();
    expect(onDisk.filter((f) => !accounted.includes(f)), "on disk but neither swept nor listed").toEqual([]);
    expect(accounted).toEqual(onDisk);
    for (const [file, { reason, provenBy }] of Object.entries(NOT_RENDERED)) {
      expect(reason.length, file).toBeGreaterThan(40);
      expect(provenBy.length, `${file} names a witness`).toBeGreaterThan(0);
      for (const suite of provenBy) expect(existsSync(join(SRC, suite)), `${file}: ${suite} exists`).toBe(true);
    }
  });

  it("no layout in the public tree declares metadata, so the root is the only thing a page inherits", () => {
    // `served` merges each page's own metadata under the ROOT layout's alone.
    // (/embed's layout does declare `robots`; its documents' metadata is not
    // read — see the embed scene.)
    const DECLARES = /export\s+(?:const|let|var)\s+metadata\b|export\s+(?:async\s+)?function\s+generateMetadata\b|export\s*\{[^}]*\b(?:metadata|generateMetadata)\b/;
    const poster = readFileSync(join(SHARED, "[orgSlug]/[competitionSlug]/poster/page.tsx"), "utf8");
    expect(DECLARES.test(poster), "premise: the probe sees a page that does declare it").toBe(true);
    const layouts = walk(PUBLIC, /^layout\.[jt]sx?$/);
    expect(layouts.length, "premise: there are layouts to read").toBeGreaterThan(1);
    for (const file of layouts) expect(DECLARES.test(readFileSync(join(SHARED, file), "utf8")), file).toBe(false);
  });
});

for (const scene of SCENES) {
  describe(`/shared — ${scene.name}`, () => {
    it(`en draws at least ${scene.minDictValues} dictionary values (the render is not empty)`, async () => {
      const segs = await renderIn(scene, "en");
      expect(dictionaryHits(segs, "en")).toBeGreaterThanOrEqual(scene.minDictValues);
    });

    for (const locale of NON_EN) {
      it(`${locale}: no surviving English literal, no hardcoded string`, async () => {
        const segs = await renderIn(scene, locale);
        // Non-vacuous in THIS locale too: the page drew its own dictionary.
        expect(dictionaryHits(segs, locale), "the page drew this locale's dictionary").toBeGreaterThanOrEqual(
          scene.minDictValues,
        );
        const findings = findingsIn(segs, locale, allowFor(scene.files));
        // The list is the MESSAGE, so a red prints every finding in full.
        expect(findings.length, `${scene.name} in ${locale}:\n${findings.map(formatFinding).join("\n")}`).toBe(0);
      });
    }
  });
}

describe("the allowlist", () => {
  it("a page-scoped entry is accounted for on its page and on no other (the hub's \"W\" is still the English \"won\")", () => {
    const scoped = ENGLISH_SWEEP_ALLOWLIST.filter((a) => a.onlyOn !== undefined);
    expect(scoped.length, "premise: some entries are scoped").toBeGreaterThan(0);
    const hub = SCENES.find((scene) => scene.files.includes("[orgSlug]/[competitionSlug]/page.tsx"))!;
    for (const a of scoped) {
      for (const file of a.onlyOn!) expect(allowFor([file]), `${a.text} on ${file}`).toContain(a.text);
      expect(allowFor(hub.files), a.text).not.toContain(a.text);
    }
  });

  it("every entry has a reason, and every entry is still needed by some render", async () => {
    const used = new Set<string>();
    for (const scene of SCENES) {
      for (const locale of NON_EN) {
        for (const seg of await renderIn(scene, locale)) {
          if (explained(seg.text, locale, [])) continue;
          for (const a of allowFor(scene.files)) if (seg.text.includes(a) && explained(seg.text, locale, [a])) used.add(a);
        }
      }
    }
    for (const entry of ENGLISH_SWEEP_ALLOWLIST) {
      expect(entry.reason.length, `"${entry.text}" has a reason`).toBeGreaterThan(20);
      expect(used.has(entry.text), `"${entry.text}" is still rendered somewhere`).toBe(true);
    }
  });
});
