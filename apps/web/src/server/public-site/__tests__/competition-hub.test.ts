// Spectator surface W2, Task 4 — the competition hub document.
//
// NO DATABASE. Every dependency that would need one is doubled at its module
// boundary (`./data`'s two readers, `./public-leaders`'s row reader,
// `@/lib/entitlements`'s resolver, the registration panel), so the whole
// document assembly — including both arms of the `stats.player` gate and the
// empty-leaderboard state — is proven on every run rather than only in the
// `smoke-db` job. The DB half, which proves the SQL those doubles stand in
// for, is `competition-hub-db.test.ts` beside this file.
//
// The three liveness authorities (`HubMatch.bucket`, `header.live`,
// `header.status`) are the point of the first block: Task 1's review recorded
// a document with `bucket: "completed"` beside `live: true` as reachable, and
// `hubLiveness` is what makes it unreachable. That claim is not asserted, it
// is ENUMERATED — over the whole wire status vocabulary, read out of
// `schemas.ts` so a status added to the wire reds this file.
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

// `unstable_cache` is a Next server-runtime API with no incrementalCache
// outside a real request — passthrough under vitest, the same double
// `consent.test.ts` and `public-leaders.test.ts` already use.
vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
  revalidateTag: vi.fn(),
}));

const hasFeatureMock = vi.hoisted(() => vi.fn());
const readLeaderRowsMock = vi.hoisted(() => vi.fn());
const registrationMock = vi.hoisted(() => vi.fn());
const getPublicCompetitionMock = vi.hoisted(() => vi.fn());
const getPublicDivisionMock = vi.hoisted(() => vi.fn());

// SPREAD the original in every case rather than replacing the module: each of
// these files exports more than the one symbol under test, and other modules
// in this import graph pull those other exports (`data.ts` alone imports
// `requireFeature`'s neighbours through `usecases/player-stats`). A bare
// factory would break their links at import time, not at call time.
vi.mock("@/lib/entitlements", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/entitlements")>()),
  hasFeature: hasFeatureMock,
}));
vi.mock("@/server/usecases/registrations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/usecases/registrations")>()),
  publicRegistrationInfo: registrationMock,
}));
vi.mock("../public-leaders", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../public-leaders")>()),
  readLeaderRows: readLeaderRowsMock,
}));
vi.mock("../data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../data")>()),
  getPublicCompetition: getPublicCompetitionMock,
  getPublicDivision: getPublicDivisionMock,
}));

import { msgFor } from "@/lib/messages-i18n";
import { decidedOutcomeText } from "@/lib/scoring-vocab";
import { roundRoleFor, roundRoleLabel } from "@/lib/round-role-label";
import { resolveLatestModule } from "@/server/engine-db";
import type {
  PublicCompetition,
  PublicDivision,
  PublicEntrant,
  PublicFixture,
  PublicOrg,
  PublicStage,
  PublicStandings,
} from "../data";
import { MatchCentreHeader, type SideT } from "../match-centre-schema";
import { CompetitionHubDoc } from "../competition-hub-schema";
import { describeFormat } from "../describe-format";
import {
  hubHeader,
  hubLiveness,
  hubSides,
  loadCompetitionHub,
  STATUS_LINE_KEYS,
} from "../competition-hub";

const LOCALES = ["en", "es", "fr", "nl"] as const;

// ---------------------------------------------------------------------------
// Liveness — one authority, proven over the whole vocabulary
// ---------------------------------------------------------------------------

// The v1 wire vocabulary for a fixture's status (`Fixture.status`,
// `server/api-v1/schemas.ts`). Inline `z.enum`, not a named export, so it is
// read out of the source text below — the same drift guard
// `lib/__tests__/matches-hub.test.ts` uses, for the same reason.
const STATUSES = [
  "scheduled",
  "in_play",
  "decided",
  "finalized",
  "abandoned",
  "forfeited",
  "cancelled",
] as const;

describe("hubLiveness — the ONE liveness derivation", () => {
  it("the hand-written STATUSES list still matches the enum in server/api-v1/schemas.ts", () => {
    const src = readFileSync(new URL("../../api-v1/schemas.ts", import.meta.url), "utf8");
    const line = src.split("\n").find((l) => /status: z\.enum\(\[.*"forfeited".*\]\)/.test(l));
    expect(line, 'no `status: z.enum([… "forfeited" …])` line found in schemas.ts').toBeDefined();
    const declared = [...line!.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!);
    expect(declared.sort()).toEqual([...STATUSES].sort());
  });

  it("maps every declared wire status to its bucket, header state and live flag", () => {
    expect(Object.fromEntries(STATUSES.map((s) => [s, hubLiveness(s)]))).toEqual({
      scheduled: { bucket: "upcoming", status: "scheduled", live: false },
      in_play: { bucket: "live", status: "in_play", live: true },
      decided: { bucket: "completed", status: "decided", live: false },
      finalized: { bucket: "completed", status: "decided", live: false },
      abandoned: { bucket: "completed", status: "other", live: false },
      forfeited: { bucket: "completed", status: "other", live: false },
      cancelled: { bucket: "completed", status: "other", live: false },
    });
  });

  it("THE INVARIANT: live ⟺ bucket==='live' ⟺ status==='in_play', for every string", () => {
    // The three authorities Task 1's review named. A document carrying
    // `bucket: "completed"` beside `live: true` is unreachable because `live`
    // is READ OFF the bucket; the second equivalence is the one that could
    // drift (two independent ladders), so it is enumerated rather than
    // assumed — over the declared vocabulary AND over strings the wire does
    // not declare, since an unknown status must still be self-consistent.
    const probes = [...STATUSES, "postponed", "walkover", "", "IN_PLAY", "in_play "];
    for (const s of probes) {
      const { bucket, status, live } = hubLiveness(s);
      expect(live, `live vs bucket for ${JSON.stringify(s)}`).toBe(bucket === "live");
      expect(live, `live vs status for ${JSON.stringify(s)}`).toBe(status === "in_play");
    }
  });

  it("an unknown status is LISTED (upcoming) and has no result to show (other)", () => {
    expect(hubLiveness("postponed")).toEqual({
      bucket: "upcoming",
      status: "other",
      live: false,
    });
  });
});

describe("STATUS_LINE_KEYS", () => {
  it.each(LOCALES)("every member has a matchCentre.status entry in %s", (locale) => {
    // `public.json` is FLAT DOTTED KEYS, so `toHaveProperty` would path-walk
    // on the dots and fail on a key that is present. `Object.hasOwn` is the
    // question actually being asked.
    const dict = JSON.parse(
      readFileSync(new URL(`../../../dictionaries/${locale}/public.json`, import.meta.url), "utf8"),
    ) as Record<string, unknown>;
    for (const status of STATUS_LINE_KEYS) {
      expect(
        Object.hasOwn(dict, `matchCentre.status.${status}`),
        `missing matchCentre.status.${status} in ${locale}`,
      ).toBe(true);
    }
    // The fallback an unlisted status lands on must exist too, or the guard
    // trades one dotted key on screen for another.
    expect(Object.hasOwn(dict, "matchCentre.status.other")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Fixtures for the builder blocks
// ---------------------------------------------------------------------------

const F = (over: Partial<PublicFixture> & { id: string }): PublicFixture => ({
  division_id: "d1",
  stage_id: "st1",
  pool_id: null,
  round_no: 1,
  seq_in_round: 1,
  home_entrant_id: "e1",
  away_entrant_id: "e2",
  home_slot_label: null,
  away_slot_label: null,
  scheduled_at: null,
  venue: null,
  court_label: null,
  venue_name: null,
  court_name: null,
  status: "scheduled",
  outcome: null,
  summary: null,
  last_seq: null,
  ...over,
});

const SIDES = (a = "e1", b = "e2"): [SideT, SideT] => [
  { entrantId: a, name: "Alpha", short: "ALP", colour: null, badgeUrl: null },
  { entrantId: b, name: "Beta", short: "BET", colour: null, badgeUrl: null },
];

describe("hubSides", () => {
  const ctx = {
    names: { e1: "Blue Blazers", e2: "Red Rockets" },
    kinds: { e1: "team", e2: "team" },
    badges: { e1: "https://cdn/x.png", e2: null },
    colours: { e1: "#0044cc", e2: null },
    slot: (label: { key: string; params: Record<string, unknown> } | null) =>
      label ? `SLOT:${label.key}` : "TBD",
  };

  it("carries the already-masked name, badge and colour, with a short for each side", () => {
    const [home, away] = hubSides(F({ id: "f1" }), ctx);
    expect(home).toEqual({
      entrantId: "e1",
      name: "Blue Blazers",
      short: "BLU",
      colour: "#0044cc",
      badgeUrl: "https://cdn/x.png",
    });
    expect(away).toMatchObject({ entrantId: "e2", name: "Red Rockets", colour: null });
  });

  it("resolves the two shorts TOGETHER — a shared surname still yields two labels", () => {
    // "Ann Smith"/"Anna Smith" both take "SMI" at the first rung: a side's own
    // name never carries enough information to know it must widen, so a
    // builder that resolves each side alone renders the SAME abbreviation on
    // both halves of the card. `disambiguatedShorts` compares the pair; this
    // is the case that proves it is actually wired in rather than a per-side
    // rule that happens to agree on team names.
    const people = {
      ...ctx,
      names: { e1: "Ann Smith", e2: "Anna Smith" },
      kinds: { e1: "individual", e2: "individual" },
    };
    const [home, away] = hubSides(F({ id: "f1" }), people);
    expect(home.short).not.toBe(away.short);
    expect([home.short, away.short].every((s) => s.length > 0)).toBe(true);
  });

  it("a TBD side renders its slot sentence as the name, with an empty entrantId", () => {
    const [home, away] = hubSides(
      F({
        id: "f1",
        home_entrant_id: null,
        home_slot_label: { key: "slot.winner_group", params: { g: "A" } },
        away_entrant_id: null,
        away_slot_label: null,
      }),
      ctx,
    );
    expect(home).toMatchObject({ entrantId: "", name: "SLOT:slot.winner_group" });
    expect(away).toMatchObject({ entrantId: "", name: "TBD" });
    // Never blank, never the string "undefined" — the two shapes this has
    // shipped as before.
    for (const side of [home, away]) {
      expect(side.name).not.toBe("");
      expect(side.name).not.toContain("undefined");
    }
  });

  it("an entrant the division read no longer returns renders '?', never a blank row", () => {
    const [home] = hubSides(F({ id: "f1", home_entrant_id: "gone" }), ctx);
    expect(home.name).toBe("?");
  });
});

describe("hubHeader — all eleven fields, from the summary alone", () => {
  it("round-trips MatchCentreHeader (the schema W1 declares, reused whole)", () => {
    const header = hubHeader(F({ id: "f1" }), SIDES(), "football", "2026-09-05T12:00:00.000Z");
    expect(MatchCentreHeader.safeParse(header).success).toBe(true);
    expect(Object.keys(header).sort()).toEqual(Object.keys(MatchCentreHeader.shape).sort());
  });

  it("scoreLines are matched to each side BY ENTRANT ID, not by array position", () => {
    const fixture = F({
      id: "f1",
      status: "decided",
      summary: {
        perSide: [
          { entrantId: "e2", line: "1" },
          { entrantId: "e1", line: "2" },
        ],
      },
    });
    expect(hubHeader(fixture, SIDES(), "football", "T").scoreLines).toEqual(["2", "1"]);
  });

  it("a TBD side has no score line even when the summary carries one for ''", () => {
    const sides: [SideT, SideT] = [
      { entrantId: "", name: "TBD", short: "?", colour: null, badgeUrl: null },
      SIDES()[1],
    ];
    const fixture = F({
      id: "f1",
      summary: { perSide: [{ entrantId: "", line: "9" }, { entrantId: "e2", line: "1" }] },
    });
    expect(hubHeader(fixture, sides, "football", "T").scoreLines).toEqual([null, "1"]);
  });

  it("in_play carries the engine's phase token and strength pair", () => {
    const fixture = F({
      id: "f1",
      status: "in_play",
      summary: { detail: { phase: "P2", strength: "5v4" } },
    });
    const header = hubHeader(fixture, SIDES(), "icehockey", "T");
    expect(header).toMatchObject({ live: true, status: "in_play", phase: "P2", strength: "5v4" });
  });

  it("a DECIDED match drops phase and strength even though detail still carries them", () => {
    // The engine leaves both stale in `detail` after the final whistle, so a
    // finished match would keep announcing a power play.
    const fixture = F({
      id: "f1",
      status: "decided",
      summary: { detail: { phase: "P3", strength: "5v4" } },
    });
    expect(hubHeader(fixture, SIDES(), "icehockey", "T")).toMatchObject({
      live: false,
      status: "decided",
      phase: null,
      strength: null,
    });
  });

  it("subLines carry the OPEN set's points — the first entry not closed, never the last", () => {
    const fixture = F({
      id: "f1",
      status: "in_play",
      summary: {
        detail: {
          sets: [
            { home: 21, away: 15, closed: true },
            { home: 14, away: 11, closed: false },
            // A later, not-yet-started column: reading "the last one" answers
            // 0-0 here, which is the bug W1's own note records.
            { home: 0, away: 0, closed: false },
          ],
        },
      },
    });
    expect(hubHeader(fixture, SIDES(), "badminton", "T").subLines).toEqual(["(14)", "(11)"]);
  });

  it("subLines are empty once every set is closed, and for a sport with no sets", () => {
    const closed = F({
      id: "f1",
      status: "decided",
      summary: { detail: { sets: [{ home: 21, away: 15, closed: true }] } },
    });
    expect(hubHeader(closed, SIDES(), "badminton", "T").subLines).toEqual([null, null]);
    expect(hubHeader(F({ id: "f2" }), SIDES(), "football", "T").subLines).toEqual([null, null]);
  });

  it("cricket in play: battingIndex is the side of the innings still open", () => {
    const fixture = F({
      id: "f1",
      status: "in_play",
      summary: {
        detail: {
          innings: [
            { entrantId: "e1", runs: 180, closed: true },
            { entrantId: "e2", runs: 56, closed: false },
          ],
        },
      },
    });
    expect(hubHeader(fixture, SIDES(), "cricket", "T").battingIndex).toBe(1);
  });

  it("cricket already decided: nobody is batting", () => {
    const fixture = F({
      id: "f1",
      status: "decided",
      summary: {
        detail: {
          innings: [
            { entrantId: "e1", closed: true },
            { entrantId: "e2", closed: false },
          ],
        },
      },
    });
    expect(hubHeader(fixture, SIDES(), "cricket", "T").battingIndex).toBeNull();
  });

  it("cricket between innings: every innings closed → nobody is batting", () => {
    // Reading "the last innings" without checking `closed` answers e2 here.
    const fixture = F({
      id: "f1",
      status: "in_play",
      summary: {
        detail: {
          innings: [
            { entrantId: "e1", closed: true },
            { entrantId: "e2", closed: true },
          ],
        },
      },
    });
    expect(hubHeader(fixture, SIDES(), "cricket", "T").battingIndex).toBeNull();
  });

  it("a batting entrant that is neither side → null, never row zero", () => {
    const fixture = F({
      id: "f1",
      status: "in_play",
      summary: { detail: { innings: [{ entrantId: "stale", closed: false }] } },
    });
    expect(hubHeader(fixture, SIDES(), "cricket", "T").battingIndex).toBeNull();
  });

  it.each(["abandoned", "cancelled", "forfeited"])(
    "%s gets its own statusLine key",
    (status) => {
      const header = hubHeader(F({ id: "f1", status }), SIDES(), "football", "T");
      expect(header.statusLine).toEqual({ key: `matchCentre.status.${status}` });
      expect(header.status).toBe("other");
    },
  );

  it("a status with no dictionary sentence falls back to matchCentre.status.other", () => {
    // Never a dotted key on the page: `t()` renders a missing key as itself.
    const header = hubHeader(F({ id: "f1", status: "rained_off_forever" }), SIDES(), "football", "T");
    expect(header.statusLine).toEqual({ key: "matchCentre.status.other" });
  });

  it.each(["scheduled", "in_play", "decided"])(
    "%s has no statusLine — the card carries that fact elsewhere",
    (status) => {
      expect(hubHeader(F({ id: "f1", status }), SIDES(), "football", "T").statusLine).toBeNull();
    },
  );

  it("updatedAt is the document's generatedAt, not a fresh clock read", () => {
    expect(hubHeader(F({ id: "f1" }), SIDES(), "football", "STAMP").updatedAt).toBe("STAMP");
  });
});

// ---------------------------------------------------------------------------
// loadCompetitionHub
// ---------------------------------------------------------------------------

const ORG: PublicOrg = {
  id: "org-1",
  name: "Riverside SC",
  slug: "riverside",
  branded: true,
  branding: {},
  logo: null,
  about: null,
  default_locale: "en",
  card_payments: false,
};

const COMP: PublicCompetition = {
  id: "comp-1",
  org_id: "org-1",
  name: "Autumn Cup",
  slug: "autumn-cup",
  description: null,
  starts_on: "2026-09-01",
  ends_on: "2026-09-30",
  branding: {},
  status: "live",
  visibility: "public",
};

const DIV: PublicDivision = {
  id: "div-1",
  competition_id: "comp-1",
  name: "Open",
  slug: "open",
  description: null,
  sport_key: "football",
  variant_key: "11-a-side",
  status: "active",
  module_version: resolveLatestModule("football").version,
  tiebreakers: null,
  sport_name: "Football",
  entrant_count: 3,
  youth: false,
  player_name_display: null,
  config: { halfMinutes: 45, halves: 2 },
};

const STAGE: PublicStage = {
  id: "st1",
  division_id: "div-1",
  seq: 1,
  kind: "league",
  name: "League",
  status: "active",
};

const ENTRANTS: PublicEntrant[] = [
  {
    id: "e1",
    division_id: "div-1",
    kind: "team",
    display_name: "Blue Blazers",
    seed: 1,
    status: "confirmed",
    members: [],
    team_display: { club_id: null, club_name: null, logo_path: null, colors: { home_primary: "#0044cc" } },
    badge_url: null,
  },
  {
    id: "e2",
    division_id: "div-1",
    kind: "team",
    display_name: "Red Rockets",
    seed: 2,
    status: "confirmed",
    members: [],
    team_display: null,
    badge_url: null,
  },
  {
    id: "e3",
    division_id: "div-1",
    kind: "team",
    display_name: "Green Giants",
    seed: 3,
    status: "confirmed",
    members: [],
    team_display: null,
    badge_url: null,
  },
];

const DECIDED = F({
  id: "fx-decided",
  status: "decided",
  round_no: 1,
  home_entrant_id: "e1",
  away_entrant_id: "e2",
  scheduled_at: "2026-09-04T14:00:00.000Z",
  venue_name: "Riverside Park",
  court_name: "Pitch 2",
  outcome: { kind: "win", winner: "e1", loser: "e2" },
  summary: {
    perSide: [
      { entrantId: "e1", line: "2" },
      { entrantId: "e2", line: "1" },
    ],
  },
});

const SCHEDULED = F({
  id: "fx-scheduled",
  status: "scheduled",
  round_no: 2,
  home_entrant_id: "e1",
  away_entrant_id: "e3",
  scheduled_at: "2026-09-12T18:30:00.000Z",
  venue_name: "Aylesbury Rec",
});

const LIVE = F({
  id: "fx-live",
  status: "in_play",
  round_no: 3,
  home_entrant_id: "e2",
  away_entrant_id: "e3",
  scheduled_at: "2026-09-05T11:00:00.000Z",
  summary: { perSide: [{ entrantId: "e2", line: "0" }], detail: { phase: "H2" } },
});

const SNAPSHOT: PublicStandings = {
  stage_id: "st1",
  pool_id: null,
  updated_at: "2026-09-04T16:00:00.000Z",
  rows: [
    { entrantId: "e1", played: 1, won: 1, drawn: 0, lost: 0, points: 3, metrics: { gf: 2, ga: 1 }, rank: 1 },
    { entrantId: "e2", played: 1, won: 0, drawn: 0, lost: 1, points: 0, metrics: { gf: 1, ga: 2 }, rank: 2 },
  ],
};

const NOW = new Date("2026-09-05T12:00:00.000Z");

function divisionDetail(over: Partial<{
  division: PublicDivision;
  stages: PublicStage[];
  pools: { id: string; stage_id: string; key: string; name: string }[];
  fixtures: PublicFixture[];
  standings: PublicStandings[];
  entrants: PublicEntrant[];
  tz: string;
}> = {}) {
  return {
    org: ORG,
    competition: COMP,
    division: DIV,
    stages: [STAGE],
    pools: [],
    fixtures: [DECIDED, SCHEDULED, LIVE],
    standings: [SNAPSHOT],
    entrants: ENTRANTS,
    tz: "Europe/London",
    ...over,
  };
}

const LEADER_ROW = {
  divisionId: "div-1",
  personId: "p1",
  name: "Arun Kumar",
  masked: false,
  publicProfile: true,
  entrantName: "Blue Blazers",
  badgeUrl: null,
  stats: { goals: 3, assists: 1 },
};

beforeEach(() => {
  vi.clearAllMocks();
  hasFeatureMock.mockResolvedValue(true);
  readLeaderRowsMock.mockResolvedValue([]);
  registrationMock.mockResolvedValue({
    competition: { id: COMP.id, name: COMP.name, slug: COMP.slug, starts_on: null, ends_on: null },
    org: { name: ORG.name, slug: ORG.slug, logo_url: null },
    divisions: [{ open: false }],
  });
  getPublicCompetitionMock.mockResolvedValue({
    org: ORG,
    competition: COMP,
    divisions: [DIV],
    liveNow: [],
  });
  getPublicDivisionMock.mockResolvedValue(divisionDetail());
});

describe("loadCompetitionHub — the shell", () => {
  it("a competition a spectator may not see → null (the page 404s it)", async () => {
    getPublicCompetitionMock.mockResolvedValue(null);
    expect(await loadCompetitionHub("riverside", "private-cup", NOW)).toBeNull();
    // Nothing else is asked for once the shell refuses.
    expect(getPublicDivisionMock).not.toHaveBeenCalled();
    expect(readLeaderRowsMock).not.toHaveBeenCalled();
  });

  it("EMPTY competition (no divisions) → overview + info only, and nothing else", async () => {
    getPublicCompetitionMock.mockResolvedValue({
      org: ORG,
      competition: COMP,
      divisions: [],
      liveNow: [],
    });
    const doc = (await loadCompetitionHub("riverside", "autumn-cup", NOW))!;
    expect(doc.tabs).toEqual(["overview", "info"]);
    expect([doc.matches, doc.tables, doc.leaders, doc.teams, doc.divisions].map((x) => x.length)).toEqual(
      [0, 0, 0, 0, 0],
    );
    expect(CompetitionHubDoc.safeParse(doc).success).toBe(true);
  });

  it("a division whose detail read comes back null is skipped, not fatal", async () => {
    getPublicDivisionMock.mockResolvedValue(null);
    const doc = (await loadCompetitionHub("riverside", "autumn-cup", NOW))!;
    expect(doc.matches).toEqual([]);
    expect(doc.divisions).toEqual([]);
    expect(CompetitionHubDoc.safeParse(doc).success).toBe(true);
  });

  it("a registration panel that 404s does not throw the hub down", async () => {
    registrationMock.mockRejectedValue(new Error("competition not found"));
    const doc = (await loadCompetitionHub("riverside", "autumn-cup", NOW))!;
    expect(doc.info.registrationOpen).toBe(false);
  });
});

describe("loadCompetitionHub — the document", () => {
  it("parses against CompetitionHubDoc, tabs and all", async () => {
    readLeaderRowsMock.mockResolvedValue([LEADER_ROW]);
    const doc = (await loadCompetitionHub("riverside", "autumn-cup", NOW))!;
    const parsed = CompetitionHubDoc.safeParse(doc);
    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(parsed.success).toBe(true);
    expect(doc.tabs).toEqual(["overview", "matches", "table", "stats", "teams", "info"]);
  });

  it("carries the competition's identity and the org's own locale", async () => {
    const doc = (await loadCompetitionHub("riverside", "autumn-cup", NOW))!;
    expect(doc).toMatchObject({
      competitionId: "comp-1",
      orgSlug: "riverside",
      competitionSlug: "autumn-cup",
      name: "Autumn Cup",
      orgName: "Riverside SC",
      branded: true,
      locale: "en",
      generatedAt: NOW.toISOString(),
    });
  });

  it("matches are ordered live → upcoming → completed", async () => {
    const doc = (await loadCompetitionHub("riverside", "autumn-cup", NOW))!;
    expect(doc.matches.map((m) => m.fixtureId)).toEqual([
      "fx-live",
      "fx-scheduled",
      "fx-decided",
    ]);
    expect(doc.matches.map((m) => m.bucket)).toEqual(["live", "upcoming", "completed"]);
  });

  it("the decided match carries the result sentence and a winnerIndex", async () => {
    const doc = (await loadCompetitionHub("riverside", "autumn-cup", NOW))!;
    const decided = doc.matches.find((m) => m.fixtureId === "fx-decided")!;
    expect(decided).toMatchObject({
      bucket: "completed",
      winnerIndex: 0,
      divisionSlug: "open",
      href: "/shared/riverside/autumn-cup/open/fixtures/fx-decided",
      venueName: "Riverside Park",
      courtName: "Pitch 2",
      header: { status: "decided", live: false, scoreLines: ["2", "1"] },
    });
    // ONE AUTHORITY: the expected sentence is the shared vocabulary's own
    // answer for this outcome, not a string typed here.
    expect(decided.resultLine).toBe(
      decidedOutcomeText(
        DECIDED.outcome,
        { e1: "Blue Blazers", e2: "Red Rockets", e3: "Green Giants" },
        (k, v) => msgFor("en", k, v),
        null,
        "football",
      ),
    );
    expect(decided.resultLine).toContain("Blue Blazers");
  });

  it("a match that is not decided carries no result line", async () => {
    const doc = (await loadCompetitionHub("riverside", "autumn-cup", NOW))!;
    for (const id of ["fx-live", "fx-scheduled"]) {
      expect(doc.matches.find((m) => m.fixtureId === id)!.resultLine).toBeNull();
    }
  });

  it("the scheduled match carries its instant and the DIVISION's venue zone", async () => {
    const doc = (await loadCompetitionHub("riverside", "autumn-cup", NOW))!;
    expect(doc.matches.find((m) => m.fixtureId === "fx-scheduled")).toMatchObject({
      bucket: "upcoming",
      tz: "Europe/London",
      scheduledAt: "2026-09-12T18:30:00.000Z",
      header: { status: "scheduled", statusLine: null },
    });
  });

  it("every match's header agrees with its bucket about being live", async () => {
    const doc = (await loadCompetitionHub("riverside", "autumn-cup", NOW))!;
    expect(doc.matches.length).toBeGreaterThan(0);
    for (const m of doc.matches) {
      expect(m.header.live, m.fixtureId).toBe(m.bucket === "live");
      expect(m.header.status === "in_play", m.fixtureId).toBe(m.bucket === "live");
    }
  });

  it("roundLabel is the engine's own role, resolved in the org locale", async () => {
    const doc = (await loadCompetitionHub("riverside", "autumn-cup", NOW))!;
    const scheduled = doc.matches.find((m) => m.fixtureId === "fx-scheduled")!;
    // A league stage's rounds are a dense ordinal sequence — `plain_round`,
    // ranked within the lane, which for round_no 2 of a 1/2/3 sequence is
    // "Round 2". Derived through the same two helpers the public bracket uses.
    expect(scheduled.roundLabel).toBe(
      roundRoleLabel(
        (k, v) => msgFor("en", k, v),
        roundRoleFor(
          [DECIDED, SCHEDULED, LIVE].map((f) => ({ round_no: f.round_no, lane: null })),
          { round_no: 2, lane: null, is_final: false, third_place: false, conditional: false },
          "league",
        ),
      ),
    );
    expect(scheduled.roundLabel).not.toBeNull();
    expect(scheduled.roundLabel).not.toContain("bracket.round");
  });

  it("a knockout final is named by its POSITION, not its round number", async () => {
    const ko: PublicStage = { ...STAGE, id: "ko", kind: "knockout", name: "Knockout" };
    const semi = F({ id: "ko-1", stage_id: "ko", round_no: 1, status: "decided", outcome: { winner: "e1" } });
    const final = F({ id: "ko-2", stage_id: "ko", round_no: 2, is_final: true });
    getPublicDivisionMock.mockResolvedValue(
      divisionDetail({ stages: [ko], fixtures: [semi, final], standings: [] }),
    );
    const doc = (await loadCompetitionHub("riverside", "autumn-cup", NOW))!;
    expect(doc.matches.find((m) => m.fixtureId === "ko-2")!.roundLabel).toBe(
      msgFor("en", "bracket.round.final"),
    );
    expect(doc.matches.find((m) => m.fixtureId === "ko-1")!.roundLabel).toBe(
      msgFor("en", "bracket.round.semi"),
    );
  });

  it("a TBD side renders the org-locale slot sentence as the side's name", async () => {
    const ko: PublicStage = { ...STAGE, id: "ko", kind: "knockout", name: "Knockout" };
    const tbd = F({
      id: "ko-tbd",
      stage_id: "ko",
      home_entrant_id: null,
      home_slot_label: { key: "slot.winner_group", params: { g: "A" } },
      away_entrant_id: "e2",
    });
    getPublicDivisionMock.mockResolvedValue(
      divisionDetail({ stages: [ko], fixtures: [tbd], standings: [] }),
    );
    const doc = (await loadCompetitionHub("riverside", "autumn-cup", NOW))!;
    const side = doc.matches[0]!.header.sides[0];
    expect(side.name).toBe(msgFor("en", "slot.winner_group", { g: "A" }));
    expect(side.name).not.toBe("");
    expect(side.name).not.toContain("undefined");
  });

  it("the org's locale drives every resolved string, not English", async () => {
    getPublicCompetitionMock.mockResolvedValue({
      org: { ...ORG, default_locale: "fr" },
      competition: COMP,
      divisions: [DIV],
      liveNow: [],
    });
    getPublicDivisionMock.mockResolvedValue(
      divisionDetail({ fixtures: [F({ id: "fx-x", status: "cancelled" })] }),
    );
    const doc = (await loadCompetitionHub("riverside", "autumn-cup", NOW))!;
    expect(doc.locale).toBe("fr");
    expect(doc.matches[0]!.roundLabel).toBe(
      roundRoleLabel(
        (k, v) => msgFor("fr", k, v),
        roundRoleFor(
          [{ round_no: 1, lane: null }],
          { round_no: 1, lane: null, is_final: false, third_place: false, conditional: false },
          "league",
        ),
      ),
    );
    // The French label must actually differ from the English one, or this
    // asserts nothing about the locale reaching the builder.
    expect(doc.matches[0]!.roundLabel).not.toBe(msgFor("en", "bracket.round.plain", { n: 1 }));
  });
});

describe("loadCompetitionHub — divisions, tables and teams", () => {
  it("the division block carries the format sentence describeFormat derives", async () => {
    const doc = (await loadCompetitionHub("riverside", "autumn-cup", NOW))!;
    expect(doc.divisions).toHaveLength(1);
    expect(doc.divisions[0]).toMatchObject({
      id: "div-1",
      slug: "open",
      sportKey: "football",
      sportName: "Football",
      tz: "Europe/London",
      entrantCount: 3,
      variantKey: "11-a-side",
      href: "/shared/riverside/autumn-cup/open",
    });
    expect(doc.divisions[0]!.formatLine).toEqual(
      describeFormat("football", resolveLatestModule("football"), DIV.config),
    );
    expect(doc.divisions[0]!.formatLine).toEqual({
      key: "format.football.minutes",
      params: { minutes: 90 },
    });
  });

  it("a table per non-bracket stage, with the champion and the full-division href", async () => {
    // The league is not complete and not fully played, so nobody is crowned.
    const doc = (await loadCompetitionHub("riverside", "autumn-cup", NOW))!;
    expect(doc.tables).toHaveLength(1);
    expect(doc.tables[0]).toMatchObject({
      id: "open-st1-overall",
      divisionId: "div-1",
      divisionSlug: "open",
      caption: "League",
      fullHref: "/shared/riverside/autumn-cup/open?tab=standings",
      updatedAt: "2026-09-04T16:00:00.000Z",
    });
    expect(doc.tables[0]!.rows.map((r) => r.name)).toEqual(["Blue Blazers", "Red Rockets"]);
    expect(doc.tables[0]!.rows.every((r) => r.champion === false)).toBe(true);
  });

  it("a COMPLETE league crowns rank 1 in the table it publishes", async () => {
    getPublicDivisionMock.mockResolvedValue(
      divisionDetail({ stages: [{ ...STAGE, status: "complete" }] }),
    );
    const doc = (await loadCompetitionHub("riverside", "autumn-cup", NOW))!;
    expect(doc.tables[0]!.rows.filter((r) => r.champion).map((r) => r.entrantId)).toEqual(["e1"]);
  });

  it("a bracket stage publishes no table (its ladder is the bracket, not a ledger)", async () => {
    getPublicDivisionMock.mockResolvedValue(
      divisionDetail({
        stages: [{ ...STAGE, kind: "knockout" }],
        standings: [SNAPSHOT],
      }),
    );
    const doc = (await loadCompetitionHub("riverside", "autumn-cup", NOW))!;
    expect(doc.tables).toEqual([]);
    expect(doc.tabs).not.toContain("table");
  });

  it("pool tables are captioned with their pool and ordered by pool id", async () => {
    const pools = [
      { id: "pB", stage_id: "st1", key: "B", name: "Pool B" },
      { id: "pA", stage_id: "st1", key: "A", name: "Pool A" },
    ];
    const standings: PublicStandings[] = [
      { ...SNAPSHOT, pool_id: "pB" },
      { ...SNAPSHOT, pool_id: "pA" },
    ];
    getPublicDivisionMock.mockResolvedValue(
      divisionDetail({ stages: [{ ...STAGE, kind: "group" }], pools, standings }),
    );
    const doc = (await loadCompetitionHub("riverside", "autumn-cup", NOW))!;
    expect(doc.tables.map((t) => t.caption)).toEqual(["League — Pool A", "League — Pool B"]);
    expect(doc.tables.map((t) => t.id)).toEqual(["open-st1-pA", "open-st1-pB"]);
  });

  it("one team card per entrant, with badge, colour and seed", async () => {
    const doc = (await loadCompetitionHub("riverside", "autumn-cup", NOW))!;
    expect(doc.teams.map((t) => t.name)).toEqual(["Blue Blazers", "Red Rockets", "Green Giants"]);
    expect(doc.teams[0]).toMatchObject({
      entrantId: "e1",
      divisionSlug: "open",
      colour: "#0044cc",
      seed: 1,
      href: "/shared/riverside/autumn-cup/open?tab=entrants",
    });
    expect(doc.teams[1]!.colour).toBeNull();
  });
});

describe("loadCompetitionHub — info", () => {
  it("venues are deduplicated and sorted; calendars and hrefs point at real routes", async () => {
    const doc = (await loadCompetitionHub("riverside", "autumn-cup", NOW))!;
    expect(doc.info).toEqual({
      startsOn: "2026-09-01",
      endsOn: "2026-09-30",
      venues: ["Aylesbury Rec", "Riverside Park"],
      registrationOpen: false,
      registerHref: "/shared/riverside/autumn-cup/register",
      calendars: [
        { divisionName: "Open", href: "/shared/riverside/autumn-cup/open/calendar.ics" },
      ],
      presentHref: "/shared/riverside/autumn-cup/present",
    });
  });

  it("registrationOpen follows the registration panel's own per-division answer", async () => {
    registrationMock.mockResolvedValue({
      competition: { id: COMP.id, name: COMP.name, slug: COMP.slug, starts_on: null, ends_on: null },
      org: { name: ORG.name, slug: ORG.slug, logo_url: null },
      divisions: [{ open: false }, { open: true }],
    });
    const doc = (await loadCompetitionHub("riverside", "autumn-cup", NOW))!;
    expect(doc.info.registrationOpen).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Controller rulings A and B — the stats.player gate and the empty state
// ---------------------------------------------------------------------------

describe("loadCompetitionHub — the stats.player gate", () => {
  const gate = (key: string) => (_org: string, featureKey: string) =>
    Promise.resolve(featureKey === key ? false : true);

  it("GRANTED: leader boards are built and the Stats tab appears", async () => {
    readLeaderRowsMock.mockResolvedValue([LEADER_ROW]);
    const doc = (await loadCompetitionHub("riverside", "autumn-cup", NOW))!;
    expect(doc.leaders.length).toBeGreaterThan(0);
    expect(doc.leaders[0]).toMatchObject({ divisionId: "div-1", sportKey: "football", key: "goals" });
    expect(doc.leaders[0]!.rows[0]).toMatchObject({
      value: "3",
      personHref: "/shared/riverside/autumn-cup/players/p1",
    });
    // The board's heading is the shared player-stat vocabulary's own word,
    // never a key and never the engine's raw token where copy exists.
    expect(doc.leaders[0]!.label).toBe(msgFor("en", "stat.football.goals"));
    expect(doc.tabs).toContain("stats");
  });

  it("DENIED: no boards, no Stats tab, and the snapshot is never even read", async () => {
    readLeaderRowsMock.mockResolvedValue([LEADER_ROW]);
    hasFeatureMock.mockImplementation(gate("stats.player"));
    const doc = (await loadCompetitionHub("riverside", "autumn-cup", NOW))!;
    expect(doc.leaders).toEqual([]);
    expect(doc.tabs).not.toContain("stats");
    // Not merely filtered afterwards — a denied org's consent-resolved player
    // rows are never loaded at all.
    expect(readLeaderRowsMock).not.toHaveBeenCalled();
    // The rest of the document is unaffected.
    expect(doc.matches.length).toBe(3);
    expect(CompetitionHubDoc.safeParse(doc).success).toBe(true);
  });

  it("the gate is resolved PER COMPETITION, with the key as it is written", async () => {
    await loadCompetitionHub("riverside", "autumn-cup", NOW);
    expect(hasFeatureMock).toHaveBeenCalledWith("org-1", "stats.player", "comp-1");
  });

  it("realtime is resolved the same way, per competition", async () => {
    hasFeatureMock.mockImplementation(gate("realtime"));
    const doc = (await loadCompetitionHub("riverside", "autumn-cup", NOW))!;
    expect(hasFeatureMock).toHaveBeenCalledWith("org-1", "realtime", "comp-1");
    expect(doc.realtime).toBe(false);
  });

  it("realtime GRANTED reaches the document", async () => {
    const doc = (await loadCompetitionHub("riverside", "autumn-cup", NOW))!;
    expect(doc.realtime).toBe(true);
  });

  it("the two gates are independent — denying realtime keeps the leader boards", async () => {
    readLeaderRowsMock.mockResolvedValue([LEADER_ROW]);
    hasFeatureMock.mockImplementation(gate("realtime"));
    const doc = (await loadCompetitionHub("riverside", "autumn-cup", NOW))!;
    expect(doc.realtime).toBe(false);
    expect(doc.leaders.length).toBeGreaterThan(0);
  });
});

describe("loadCompetitionHub — empty leader boards are a first-class state", () => {
  it("a division with fixtures and standings but NO snapshot rows: no boards, no Stats tab, no error", async () => {
    // The common case, not the edge case: `player_stat_snapshots` is a
    // recompute-on-read cache and a division nobody has opened stats for holds
    // zero rows.
    readLeaderRowsMock.mockResolvedValue([]);
    const doc = (await loadCompetitionHub("riverside", "autumn-cup", NOW))!;
    expect(readLeaderRowsMock).toHaveBeenCalledTimes(1);
    expect(doc.leaders).toEqual([]);
    expect(doc.tabs).toEqual(["overview", "matches", "table", "teams", "info"]);
    // Everything ELSE is still there — this is a missing tab, not a degraded
    // document.
    expect(doc.matches.length).toBe(3);
    expect(doc.tables.length).toBe(1);
    expect(doc.teams.length).toBe(3);
    expect(CompetitionHubDoc.safeParse(doc).success).toBe(true);
  });

  it("rows that are all ZERO also yield no board — an empty heading is not a board", async () => {
    readLeaderRowsMock.mockResolvedValue([{ ...LEADER_ROW, stats: { goals: 0, assists: 0 } }]);
    const doc = (await loadCompetitionHub("riverside", "autumn-cup", NOW))!;
    expect(doc.leaders).toEqual([]);
    expect(doc.tabs).not.toContain("stats");
  });

  it("the reader is asked for exactly the divisions the hub is publishing, with their consent policy", async () => {
    await loadCompetitionHub("riverside", "autumn-cup", NOW);
    const [, divisions] = readLeaderRowsMock.mock.calls[0]!;
    expect(divisions).toEqual([
      expect.objectContaining({ id: "div-1", youth: false, player_name_display: null }),
    ]);
  });

  it("a YOUTH division's own masking policy reaches the reader", async () => {
    getPublicDivisionMock.mockResolvedValue(
      divisionDetail({ division: { ...DIV, youth: true, player_name_display: "initials" } }),
    );
    getPublicCompetitionMock.mockResolvedValue({
      org: ORG,
      competition: COMP,
      divisions: [{ ...DIV, youth: true, player_name_display: "initials" }],
      liveNow: [],
    });
    await loadCompetitionHub("riverside", "autumn-cup", NOW);
    const [, divisions] = readLeaderRowsMock.mock.calls[0]!;
    expect(divisions).toEqual([
      expect.objectContaining({ youth: true, player_name_display: "initials" }),
    ]);
  });
});
