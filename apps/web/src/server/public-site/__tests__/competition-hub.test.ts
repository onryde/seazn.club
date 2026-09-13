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
// `consent.test.ts` and `public-leaders.test.ts` already use, except that this
// one RECORDS its key parts and options. Without that recording the ISR half of
// the hub's invalidation story has no witness at all: deleting a tag from
// `getPublicCompetitionHub` changes no test outcome, and a cache whose tags
// nothing checks is a cache that silently stops invalidating.
const cacheCalls = vi.hoisted(() => [] as { keyParts: unknown; options: unknown }[]);
vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown, keyParts?: unknown, options?: unknown) => {
    cacheCalls.push({ keyParts, options });
    return fn;
  },
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
import { twoSidedBracket } from "@seazn/engine/scheduling/bracket-layout";
import {
  competitionTag,
  divisionTag,
  orgTag,
  REVALIDATE_FAST,
  type PublicCompetition,
  type PublicDivision,
  type PublicEntrant,
  type PublicFixture,
  type PublicOrg,
  type PublicStage,
  type PublicStandings,
} from "../data";
import { MatchCentreHeader, type SideT } from "../match-centre-schema";
import { CompetitionHubDoc } from "../competition-hub-schema";
import { divisionChampion } from "../champion";
import { describeFormat } from "../describe-format";
import { STRUCTURAL_KEYS, TIE_BREAK_MSG_KEYS } from "../standings-view";
import {
  getPublicCompetitionHub,
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
// Final-review fix F2 — every `table.*`/`format.*` key the SERVER actually
// emits must exist in all four locales, or `GET .../hub` publishes the dotted
// key itself (`t()`'s documented miss behaviour). The list here is DERIVED,
// never hand-typed: `STRUCTURAL_KEYS`/`TIE_BREAK_MSG_KEYS` are the same
// exported sources `standings-view.ts` builds `table.col.*`/`table.tieBreak.*`
// from, and `FORMAT_KEYS` is scanned out of `describe-format.ts`'s own source
// text (the same drift-guard convention `STATUS_LINE_KEYS`'s
// `schemas.ts` scan above uses) so a new `format.*` sentence lands in this
// list unattended. `table.pool` (competition-hub.ts:583) and `table.tieBreak`
// (standings-view.ts:174) are the two literals with no exported source to
// scan — both are call sites this file already imports/exercises elsewhere.
describe("table.* / format.* dictionary coverage (final-review fix F2)", () => {
  const formatSrc = readFileSync(new URL("../describe-format.ts", import.meta.url), "utf8");
  const FORMAT_KEYS = [...new Set([...formatSrc.matchAll(/key:\s*"(format\.[a-zA-Z0-9_.]+)"/g)].map((m) => m[1]!))];

  // The COMPONENT's own keys, which no builder emits and no exported constant
  // names. Found by driving the rendered page in a browser at 320: the table
  // header read "TABLE.TEAM" and the disclosure button read "table.more",
  // because F2 added only the keys the SERVER resolves. Scanned rather than
  // typed, on the same principle as FORMAT_KEYS above — a sixth key added to
  // the component lands in this list unattended.
  const viewSrc = readFileSync(
    new URL("../../../components/public-site/standings-table-view.tsx", import.meta.url),
    "utf8",
  );
  const COMPONENT_KEYS = [
    ...new Set([...viewSrc.matchAll(/"(table\.[a-zA-Z0-9_.]+)"/g)].map((m) => m[1]!)),
  ];

  it("describe-format.ts really does declare the three keys this test expects (a scan is not a read)", () => {
    expect(FORMAT_KEYS.sort()).toEqual(["format.cricket.overs", "format.minutes", "format.sets.bestOf"]);
  });

  it("standings-table-view.tsx really does ask for these six keys (a scan is not a read)", () => {
    expect(COMPONENT_KEYS.sort()).toEqual([
      "table.col.rank",
      "table.empty",
      "table.fewer",
      "table.fullDivision",
      "table.more",
      "table.team",
    ]);
  });

  it.each(LOCALES)("every table.col.* / table.pool / table.tieBreak* / format.* key exists in %s", (locale) => {
    const dict = JSON.parse(
      readFileSync(new URL(`../../../dictionaries/${locale}/public.json`, import.meta.url), "utf8"),
    ) as Record<string, unknown>;
    const required = [
      ...[...STRUCTURAL_KEYS].map((k) => `table.col.${k}`),
      "table.pool",
      "table.tieBreak",
      ...Object.values(TIE_BREAK_MSG_KEYS),
      ...FORMAT_KEYS,
      ...COMPONENT_KEYS,
    ];
    for (const key of required) {
      expect(Object.hasOwn(dict, key), `missing ${key} in ${locale}`).toBe(true);
    }
  });

  it("es/fr/nl are real translations, not an English copy-paste, for the structural column titles", () => {
    // Per-key equality is too strict: "Points" is genuinely spelled the same
    // in French (a real cognate, not a missed translation). What this test
    // catches is the whole BLOCK reading as an untranslated copy of en — so
    // it asserts at least one of the five differs, not all five.
    const en = JSON.parse(
      readFileSync(new URL("../../../dictionaries/en/public.json", import.meta.url), "utf8"),
    ) as Record<string, string>;
    for (const locale of ["es", "fr", "nl"] as const) {
      const dict = JSON.parse(
        readFileSync(new URL(`../../../dictionaries/${locale}/public.json`, import.meta.url), "utf8"),
      ) as Record<string, string>;
      const untranslated = [...STRUCTURAL_KEYS].filter((k) => dict[`table.col.${k}`] === en[`table.col.${k}`]);
      expect(
        untranslated.length,
        `${locale}'s table.col.* reads like an English copy: ${untranslated.join(", ")}`,
      ).toBeLessThan(STRUCTURAL_KEYS.size);
    }
  });

  it("format.football.minutes was never added — the minutes sentence is sport-neutral", () => {
    for (const locale of LOCALES) {
      const dict = JSON.parse(
        readFileSync(new URL(`../../../dictionaries/${locale}/public.json`, import.meta.url), "utf8"),
      ) as Record<string, unknown>;
      expect(Object.hasOwn(dict, "format.football.minutes")).toBe(false);
    }
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
  cacheCalls.splice(0);
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
    expect(
      [doc.matches, doc.tables, doc.knockouts, doc.leaders, doc.teams, doc.divisions].map((x) => x.length),
    ).toEqual([0, 0, 0, 0, 0, 0]);
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

  // Final-review fix F1 — `competition-hub.ts:591` is a deliberate BLIND
  // passthrough of `snap.updated_at` (the fix belongs at the source,
  // `data.ts`'s `getPublicDivision`, never here — see that file's own
  // `normalizeStandings`). The double above (SNAPSHOT) carries the STRING
  // `getPublicDivision` gives once it normalises, which is why every other
  // test in this describe block is a faithful happy-path. This one instead
  // feeds `loadCompetitionHub` the shape `getPublicDivision` would produce
  // WITHOUT that fix — a real `Date`, exactly what postgres.js hands back for
  // a timestamptz column absent the OID-1082-only override in `db.ts` — to
  // pin that this layer has no rescue for it: the document comes out invalid,
  // at exactly the field the review measured. Not reachable by reverting
  // `data.ts`'s fix (this test's double is independent of it); see
  // `data-standings-timestamp.test.ts` for the test that mutation covers
  // that revert.
  it("a Date on the standings snapshot (data.ts's contract broken) fails CompetitionHubDoc, at tables.0.updatedAt", async () => {
    getPublicDivisionMock.mockResolvedValue(
      divisionDetail({
        standings: [{ ...SNAPSHOT, updated_at: new Date("2026-09-04T16:00:00.000Z") as unknown as string }],
      }),
    );
    const doc = (await loadCompetitionHub("riverside", "autumn-cup", NOW))!;
    const parsed = CompetitionHubDoc.safeParse(doc);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.some((i) => i.path.join(".") === "tables.0.updatedAt")).toBe(true);
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
    // SPORT-NEUTRAL key (owner ruling 2026-09-09): football, hockey and ice
    // hockey all say the same thing about how long a match runs.
    expect(doc.divisions[0]!.formatLine).toEqual({
      key: "format.minutes",
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

// ---------------------------------------------------------------------------
// Fix round 1 — the shapes the whole suite never varied
// ---------------------------------------------------------------------------
//
// Every fixture above lives in a division with exactly ONE stage, and three
// defects hid behind that: a knockout final named against the league's round
// count, an unwitnessed stage ORDER, and an unwitnessed `finalized` status.

describe("loadCompetitionHub — round names are ranked WITHIN a stage", () => {
  const league: PublicStage = { ...STAGE, id: "lg", seq: 1, kind: "league", name: "League" };
  const ko: PublicStage = { ...STAGE, id: "ko", seq: 2, kind: "knockout", name: "Knockout" };
  // The league runs MORE rounds than the bracket — the ordinary
  // group-then-knockout shape, and the one that makes the bug visible. An
  // equal-length pair cannot witness it.
  const twoStage = [
    F({ id: "lg-1", stage_id: "lg", round_no: 1 }),
    F({ id: "lg-2", stage_id: "lg", round_no: 2 }),
    F({ id: "lg-3", stage_id: "lg", round_no: 3 }),
    F({ id: "ko-1", stage_id: "ko", round_no: 1 }),
    F({ id: "ko-2", stage_id: "ko", round_no: 2, is_final: true }),
  ];

  const labels = async () => {
    getPublicDivisionMock.mockResolvedValue(
      divisionDetail({ stages: [league, ko], fixtures: twoStage, standings: [] }),
    );
    const doc = (await loadCompetitionHub("riverside", "autumn-cup", NOW))!;
    return Object.fromEntries(doc.matches.map((m) => [m.fixtureId, m.roundLabel]));
  };

  it("the knockout FINAL is the Final, not the semi its league neighbour's round count implies", async () => {
    // `laneRoundRank` filters by LANE only, and `lane` is null for a league AND
    // for a single-elimination bracket — so ranking against the whole division
    // puts rounds 1-3 (league) and 1-2 (knockout) in ONE sorted list and makes
    // `lastRoundInLane` 3. The final then sits one round from the end and reads
    // "Semi-finals". `is_final` does not rescue it: `round-role.ts` never reads
    // `isFinal`, the role is `lastRoundInLane - roundInLane`.
    const label = await labels();
    expect(label["ko-2"]).toBe(msgFor("en", "bracket.round.final"));
    expect(label["ko-2"]).not.toBe(msgFor("en", "bracket.round.semi"));
  });

  it("and the knockout SEMI is the semi, not a quarter", async () => {
    const label = await labels();
    expect(label["ko-1"]).toBe(msgFor("en", "bracket.round.semi"));
    expect(label["ko-1"]).not.toBe(msgFor("en", "bracket.round.quarter"));
  });

  it("the league stage beside it still counts its own rounds from one", async () => {
    const label = await labels();
    expect([label["lg-1"], label["lg-2"], label["lg-3"]]).toEqual([
      msgFor("en", "bracket.round.plain", { n: 1 }),
      msgFor("en", "bracket.round.plain", { n: 2 }),
      msgFor("en", "bracket.round.plain", { n: 3 }),
    ]);
  });
});

describe("loadCompetitionHub — the order tables are published in", () => {
  const tableFor = async (stages: PublicStage[]) => {
    getPublicDivisionMock.mockResolvedValue(
      divisionDetail({
        stages,
        fixtures: [],
        standings: stages.map((s) => ({ ...SNAPSHOT, stage_id: s.id })),
      }),
    );
    const doc = (await loadCompetitionHub("riverside", "autumn-cup", NOW))!;
    return doc.tables.map((t) => t.caption);
  };

  it("a stage still RUNNING reads above one already complete", async () => {
    // Input order is the WRONG order on purpose: an ordering test whose input
    // already matches the expected output asserts nothing at all.
    const done: PublicStage = { ...STAGE, id: "s1", seq: 1, name: "Group", status: "complete" };
    const running: PublicStage = { ...STAGE, id: "s2", seq: 2, name: "Playoff", status: "active" };
    expect(await tableFor([done, running])).toEqual(["Playoff", "Group"]);
  });

  it("two stages in the same state order by SEQ", async () => {
    // The OTHER arm of the comparator, perturbed the same way: input reversed.
    const second: PublicStage = { ...STAGE, id: "s2", seq: 2, name: "Second", status: "active" };
    const first: PublicStage = { ...STAGE, id: "s1", seq: 1, name: "First", status: "active" };
    expect(await tableFor([second, first])).toEqual(["First", "Second"]);
  });

  it("two COMPLETE stages also order by seq — completeness ties, seq breaks it", async () => {
    const second: PublicStage = { ...STAGE, id: "s2", seq: 2, name: "Second", status: "complete" };
    const first: PublicStage = { ...STAGE, id: "s1", seq: 1, name: "First", status: "complete" };
    expect(await tableFor([second, first])).toEqual(["First", "Second"]);
  });
});

describe("loadCompetitionHub — a FINALIZED fixture is a decided one", () => {
  const finalized = F({
    id: "fx-finalized",
    status: "finalized",
    round_no: 1,
    home_entrant_id: "e1",
    away_entrant_id: "e2",
    scheduled_at: "2026-09-03T14:00:00.000Z",
    outcome: { kind: "win", winner: "e2", loser: "e1" },
    summary: {
      perSide: [
        { entrantId: "e1", line: "0" },
        { entrantId: "e2", line: "3" },
      ],
    },
  });

  it("keeps its result sentence, its winner and its bucket — `finalized` is not a synonym nobody sends", async () => {
    // A locked ledger is still a played match. Keying the result line on the
    // raw string "decided" silently strips the sentence off every finalized
    // fixture, which a spectator meets as a scoreline with no verdict.
    getPublicDivisionMock.mockResolvedValue(
      divisionDetail({ fixtures: [finalized], standings: [] }),
    );
    const doc = (await loadCompetitionHub("riverside", "autumn-cup", NOW))!;
    const match = doc.matches.find((m) => m.fixtureId === "fx-finalized")!;
    expect(match.bucket).toBe("completed");
    expect(match.header.status).toBe("decided");
    expect(match.winnerIndex).toBe(1);
    expect(match.resultLine).toBe(
      decidedOutcomeText(
        finalized.outcome,
        { e1: "Blue Blazers", e2: "Red Rockets", e3: "Green Giants" },
        (k, v) => msgFor("en", k, v),
        null,
        "football",
      ),
    );
    expect(match.resultLine).toContain("Red Rockets");
  });
});

// ---------------------------------------------------------------------------
// Knockouts — the hub's Knockout tab document (plan 2026-09-13, R3)
// ---------------------------------------------------------------------------
//
// ONE view per bracket stage that has fixtures. Every fixture list below is
// fed in SCRAMBLED order (last round first, seq reversed, lanes back to
// front): an ordering rule that merely preserved its input would pass an
// already-sorted input and assert nothing.
//
// Mutation sweep (2026-09-13) — one mutant at a time, restored from the commit,
// every run at its full green total; killer named:
//   drop the `knockout` push (matches-hub.ts) .. matches-hub.test.ts "exactly ONE knockout view…" (+2)
//   `> 0` → `> 1` on that push ................. matches-hub.test.ts "exactly ONE knockout view…" (+1)
//   `drawable: true` always .................... "drawable: FALSE when round 0 holds three fixtures" (+2)
//   champion without the decided check ........ "NO champion while the final is still being played"
//   third-place round placed after the final .. "rounds run in bracket order … BEFORE the final" (+1)
//   (fix round 1 moved the champion RULE into champion.ts `bracketChampion`;
//   its own sweep is in champion.test.ts. Here, the view ignoring the helper
//   is killed by 8 tests, led by "championFixtureId: the final, once it is
//   DECIDED with a winner", and routing divisionChampion around it by the
//   three "…is divisionChampion's champion" parity cases.)
//   no-is_final fallback removed .............. "with no is_final flag anywhere…"
//   laneRank returns 0 ........................ "rounds order by LANE first"
//   bracket stages not seq-sorted ............. "one view per bracket stage WITH fixtures…"
//   empty-stage `return null` removed ......... "one view per bracket stage WITH fixtures…"
//   tab count passes `knockouts: 0` ........... 17 tests, led by "a league-then-knockout division…"

describe("loadCompetitionHub — knockouts, one view per bracket stage", () => {
  const league: PublicStage = { ...STAGE, id: "lg", seq: 1, kind: "league", name: "League" };
  const cup: PublicStage = { ...STAGE, id: "ko", seq: 2, kind: "knockout", name: "Cup" };
  const ko = (id: string, round_no: number, seq_in_round: number, over: Partial<PublicFixture> = {}) =>
    F({ id, stage_id: "ko", round_no, seq_in_round, ...over });
  const win = (winner: string, loser: string) => ({ kind: "win", winner, loser });

  /** An 8-draw with a bronze match: four quarter-finals, two semis, then the
   *  final and the third-place match sharing the LAST round — which is where
   *  the engine puts them (`generateSingleElim` gives the bronze
   *  `round: se.rounds - 1`). */
  const eight = (
    final: Partial<PublicFixture> = {},
    bronze: Partial<PublicFixture> = {},
  ): PublicFixture[] => [
    ko("ko-3p", 3, 2, { third_place: true, ...bronze }),
    ko("ko-f", 3, 1, { is_final: true, ...final }),
    ko("ko-s2", 2, 2),
    ko("ko-s1", 2, 1),
    ko("ko-q4", 1, 4),
    ko("ko-q3", 1, 3),
    ko("ko-q2", 1, 2),
    ko("ko-q1", 1, 1),
  ];
  const leagueFixtures = [
    F({ id: "lg-1", stage_id: "lg", round_no: 1 }),
    F({ id: "lg-2", stage_id: "lg", round_no: 2 }),
  ];

  const load = async (over: Parameters<typeof divisionDetail>[0]) => {
    getPublicDivisionMock.mockResolvedValue(divisionDetail(over));
    const doc = (await loadCompetitionHub("riverside", "autumn-cup", NOW))!;
    // Every document this block builds must be one the schema accepts —
    // including the refinement that each round names only real matches.
    expect(CompetitionHubDoc.safeParse(doc).error?.issues ?? []).toEqual([]);
    return doc;
  };
  const leagueThenCup = (fixtures: PublicFixture[] = eight()) =>
    load({
      stages: [league, cup],
      fixtures: [...leagueFixtures, ...fixtures],
      standings: [{ ...SNAPSHOT, stage_id: "lg" }],
    });
  const cupView = async (fixtures?: PublicFixture[]) => {
    const doc = await leagueThenCup(fixtures);
    expect(doc.knockouts).toHaveLength(1);
    return doc.knockouts[0]!;
  };

  it("a league-then-knockout division: a table for the league, ONE view for the knockout, and the Knockout tab after Table", async () => {
    const doc = await leagueThenCup();
    expect(doc.tables.map((t) => t.caption)).toEqual(["League"]);
    expect(doc.knockouts).toHaveLength(1);
    expect(doc.knockouts[0]).toMatchObject({
      id: "open-ko",
      divisionId: "div-1",
      divisionSlug: "open",
      divisionName: "Open",
      stageId: "ko",
      stageName: "Cup",
      kind: "knockout",
    });
    expect(doc.tabs).toEqual(["overview", "matches", "table", "knockout", "teams", "info"]);
  });

  it("no bracket stage → no knockouts and no Knockout tab (the negative pair)", async () => {
    const doc = await load({});
    expect(doc.knockouts).toEqual([]);
    expect(doc.tabs).not.toContain("knockout");
  });

  it("rounds run in bracket order, each in seq order — and third place sits immediately BEFORE the final", async () => {
    const view = await cupView();
    expect(view.rounds.map((r) => r.key)).toEqual(["main-1", "main-2", "third-place", "main-3"]);
    expect(view.rounds.map((r) => r.fixtureIds)).toEqual([
      ["ko-q1", "ko-q2", "ko-q3", "ko-q4"],
      ["ko-s1", "ko-s2"],
      ["ko-3p"],
      ["ko-f"],
    ]);
    expect(view.rounds.map((r) => r.lane)).toEqual([null, null, null, null]);
  });

  it("each round's label equals the roundLabel its matches carry, and names the round (quarter, semi, third place, final)", async () => {
    const doc = await leagueThenCup();
    const carried = new Map(doc.matches.map((m) => [m.fixtureId, m.roundLabel]));
    const rounds = doc.knockouts[0]!.rounds;
    for (const round of rounds) {
      for (const id of round.fixtureIds) expect(round.label, `${round.key} ${id}`).toBe(carried.get(id));
    }
    // The values themselves as well: a label both sides share could agree with
    // itself and still be the wrong words.
    expect(rounds.map((r) => r.label)).toEqual([
      msgFor("en", "bracket.round.quarter"),
      msgFor("en", "bracket.round.semi"),
      msgFor("en", "bracket.round.thirdPlace"),
      msgFor("en", "bracket.round.final"),
    ]);
  });

  it("drawable: TRUE for a regular 8-draw — the engine's twoSidedBracket is the authority, and it agrees", async () => {
    const fixtures = eight();
    expect(twoSidedBracket(fixtures).ok).toBe(true);
    expect((await cupView(fixtures)).drawable).toBe(true);
  });

  it("drawable: FALSE when round 0 holds three fixtures — not a power-of-two field, so no tree", async () => {
    const lopsided = [
      ko("r3", 3, 1, { is_final: true }),
      ko("r2b", 2, 2),
      ko("r2a", 2, 1),
      ko("r1c", 1, 3),
      ko("r1b", 1, 2),
      ko("r1a", 1, 1),
    ];
    expect(twoSidedBracket(lopsided).ok).toBe(false);
    const view = await cupView(lopsided);
    expect(view.kind).toBe("knockout");
    expect(view.drawable).toBe(false);
    // Still a whole Rounds view — only the tree is withheld.
    expect(view.rounds.map((r) => r.fixtureIds)).toEqual([["r1a", "r1b", "r1c"], ["r2a", "r2b"], ["r3"]]);
  });

  it("drawable: FALSE for a stepladder even when its shape would draw — the Draw is single-elimination only", async () => {
    const fixtures = eight();
    expect(twoSidedBracket(fixtures).ok).toBe(true);
    const doc = await load({ stages: [{ ...cup, kind: "stepladder" }], fixtures, standings: [] });
    expect(doc.knockouts[0]!.kind).toBe("stepladder");
    expect(doc.knockouts[0]!.drawable).toBe(false);
  });

  it("championFixtureId: the final, once it is DECIDED with a winner", async () => {
    const view = await cupView(eight({ status: "decided", outcome: win("e1", "e2") }));
    expect(view.championFixtureId).toBe("ko-f");
  });

  it("a FINALIZED final crowns as well — the settled set, not the raw string 'decided'", async () => {
    const view = await cupView(eight({ status: "finalized", outcome: win("e2", "e1") }));
    expect(view.championFixtureId).toBe("ko-f");
  });

  it("NO champion while the final is still being played — even with a winner already sitting in `outcome`", async () => {
    const view = await cupView(eight({ status: "in_play", outcome: win("e1", "e2") }));
    expect(view.championFixtureId).toBeNull();
  });

  it("a decided final with NO winner crowns nobody", async () => {
    const view = await cupView(eight({ status: "decided", outcome: { kind: "no_result" } }));
    expect(view.championFixtureId).toBeNull();
  });

  it("a decided BRONZE match is not the final — the crown waits for the final itself", async () => {
    const view = await cupView(eight({ status: "scheduled" }, { status: "decided", outcome: win("e3", "e2") }));
    expect(view.championFixtureId).toBeNull();
  });

  it("with no is_final flag anywhere, the final is the last round's single NON-third-place fixture", async () => {
    const unflagged = eight(
      { is_final: false, status: "decided", outcome: win("e1", "e2") },
      { status: "decided", outcome: win("e3", "e2") },
    );
    expect((await cupView(unflagged)).championFixtureId).toBe("ko-f");
  });

  it("one view per bracket stage WITH fixtures — division order first, then stage seq; an empty bracket stage publishes none", async () => {
    const reserves: PublicDivision = { ...DIV, id: "div-2", slug: "reserves", name: "Reserves" };
    const plate: PublicStage = { ...STAGE, id: "pl", seq: 3, kind: "knockout", name: "Plate" };
    const bowl: PublicStage = { ...STAGE, id: "bw", seq: 4, kind: "knockout", name: "Bowl" };
    const shield: PublicStage = { ...STAGE, id: "sh", division_id: "div-2", seq: 1, kind: "knockout", name: "Shield" };
    getPublicCompetitionMock.mockResolvedValue({
      org: ORG,
      competition: COMP,
      divisions: [DIV, reserves],
      liveNow: [],
    });
    getPublicDivisionMock.mockImplementation(async (_o: string, _c: string, slug: string) =>
      slug === "reserves"
        ? divisionDetail({
            division: reserves,
            stages: [shield],
            fixtures: [F({ id: "sh-f", stage_id: "sh", is_final: true })],
            standings: [],
          })
        : divisionDetail({
            // Stage input order runs AGAINST seq, and `bw` has no fixtures.
            stages: [bowl, plate, cup],
            fixtures: [F({ id: "pl-f", stage_id: "pl", is_final: true }), ...eight()],
            standings: [],
          }),
    );
    const doc = (await loadCompetitionHub("riverside", "autumn-cup", NOW))!;
    expect(CompetitionHubDoc.safeParse(doc).error?.issues ?? []).toEqual([]);
    // Reserves' Shield is seq 1: a document-wide seq sort would put it FIRST.
    expect(doc.knockouts.map((v) => v.id)).toEqual(["open-ko", "open-pl", "reserves-sh"]);
  });

  // A double-elimination bracket. `bracket.ts` marks BOTH grand finals
  // `isFinal`, the second `conditional`, and seats the winners' champion at
  // HOME in the first (`homeFrom: winnerOf(wb.finalId)`): the reset is owed
  // only when the losers' champion — the AWAY side — wins it. Nothing in
  // production voids a reset nobody owes (the one writer that does is the
  // engine's test harness, `testkit/simulation.ts`), so such a reset simply
  // stays `scheduled`; the rule reads "owed" off the first grand final.
  const de: PublicStage = { ...STAGE, id: "de", seq: 1, kind: "double_elim", name: "Double" };
  const d = (
    id: string,
    lane: "WB" | "LB" | "GF",
    round_no: number,
    seq_in_round: number,
    over: Partial<PublicFixture> = {},
  ) => F({ id, stage_id: "de", lane, round_no, seq_in_round, ...over });
  const bracket = (gf: Partial<PublicFixture>, reset: Partial<PublicFixture>) => [
    d("gf-reset", "GF", 4, 1, {
      is_final: true,
      conditional: true,
      home_entrant_id: "e2",
      away_entrant_id: "e1",
      ...reset,
    }),
    d("gf", "GF", 3, 1, { is_final: true, home_entrant_id: "e1", away_entrant_id: "e2", ...gf }),
    d("lb-2", "LB", 2, 1),
    d("lb-1", "LB", 1, 1),
    d("wb-2", "WB", 2, 1),
    d("wb-1b", "WB", 1, 2),
    d("wb-1a", "WB", 1, 1),
  ];
  /** e1 is the winners' champion (home in the first grand final). */
  const WINNERS_SIDE_WON: Partial<PublicFixture> = { status: "decided", outcome: win("e1", "e2") };
  const LOSERS_SIDE_WON: Partial<PublicFixture> = { status: "decided", outcome: win("e2", "e1") };
  const deView = async (gf: Partial<PublicFixture>, reset: Partial<PublicFixture>) =>
    (await load({ stages: [de], fixtures: bracket(gf, reset), standings: [] })).knockouts[0]!;

  describe("a double-elimination grand final and its conditional reset", () => {
    it("rounds order by LANE first — winners, then losers, then the grand final", async () => {
      const view = await deView({}, {});
      expect(view.rounds.map((r) => r.key)).toEqual(["WB-1", "WB-2", "LB-1", "LB-2", "GF-3", "GF-4"]);
      expect(view.rounds.map((r) => r.lane)).toEqual(["WB", "WB", "LB", "LB", "GF", "GF"]);
      expect(view.rounds[0]!.fixtureIds).toEqual(["wb-1a", "wb-1b"]);
      expect(view.drawable).toBe(false);
    });

    it("the winners' champion took the first grand final: no reset is owed, so it crowns while the reset row still reads scheduled", async () => {
      expect((await deView(WINNERS_SIDE_WON, { status: "scheduled" })).championFixtureId).toBe("gf");
    });

    it("the losers' champion took it: the reset is OWED, and the crown waits for it", async () => {
      expect((await deView(LOSERS_SIDE_WON, { status: "scheduled" })).championFixtureId).toBeNull();
    });

    it("a decided reset crowns — the latest-round settled final", async () => {
      expect(
        (await deView(LOSERS_SIDE_WON, { status: "decided", outcome: win("e1", "e2") })).championFixtureId,
      ).toBe("gf-reset");
    });
  });

  // ONE champion authority. `divisionChampion` crowns the Table tab and the
  // division page; the knockout view names a champion fixture. Both call
  // `bracketChampion` now, so on every shape they must name the SAME entrant —
  // asserted as the pair, AND as a literal, so two sides agreeing on the wrong
  // winner cannot pass. Each shape is one the two rules used to disagree on.
  describe("the knockout view's champion is divisionChampion's champion", () => {
    const both = async (stages: PublicStage[], fixtures: PublicFixture[]) => {
      const doc = await load({ stages, fixtures, standings: [] });
      const id = doc.knockouts[0]!.championFixtureId;
      return {
        view: fixtures.find((f) => f.id === id)?.outcome?.winner ?? null,
        division: divisionChampion(stages, fixtures, []),
      };
    };
    const forfeit = (winner: string, loser: string) => ({ kind: "win", winner, loser, method: "forfeit" });

    it("a final won by FORFEIT crowns its winner — a forfeit is written with one, and the engine counts it settled", async () => {
      expect(await both([cup], eight({ status: "forfeited", outcome: forfeit("e2", "e1") }))).toEqual({
        view: "e2",
        division: "e2",
      });
    });

    it("a grand-final RESET won by forfeit crowns the reset's winner, not the first grand final's", async () => {
      expect(
        await both([de], bracket(LOSERS_SIDE_WON, { status: "forfeited", outcome: forfeit("e1", "e2") })),
      ).toEqual({ view: "e1", division: "e1" });
    });

    it("a decided final crowns while the bronze match is still to be played", async () => {
      expect(
        await both([cup], eight({ status: "decided", outcome: win("e1", "e2") }, { status: "scheduled" })),
      ).toEqual({ view: "e1", division: "e1" });
    });
  });
});

describe("getPublicCompetitionHub — the ISR cache's key and tags", () => {
  it("keys on the competition id and tags the org, the competition and its division", async () => {
    const doc = await getPublicCompetitionHub("riverside", "autumn-cup");
    expect(doc).not.toBeNull();
    expect(cacheCalls).toHaveLength(1);
    // v2 since the Knockout tab (plan R4): the page renders this cached
    // document WITHOUT re-parsing it, so a v1 entry — which has no
    // `knockouts` — must never be served to a renderer that reads one.
    expect(cacheCalls[0]!.keyParts).toEqual(["pub-hub-v2", "comp-1"]);
    // Derived from the SAME tag helpers the writers use, so the two halves of
    // the invalidation story cannot drift: `fireDivisionRevalidate` fires
    // `divisionTag` and `competitionTag`, and both are declared here.
    expect(cacheCalls[0]!.options).toEqual({
      tags: [orgTag("riverside"), competitionTag("comp-1"), divisionTag("div-1")],
      revalidate: REVALIDATE_FAST,
    });
    // Spelled out ONCE as well, so a change to a tag helper is visible here
    // rather than moving both sides of a derived assertion together.
    expect(cacheCalls[0]!.options).toMatchObject({
      tags: ["org-public:riverside", "competition:comp-1", "division:div-1"],
      revalidate: 30,
    });
  });

  it("EVERY division is tagged — a score in the second one must still invalidate the page", async () => {
    const second: PublicDivision = { ...DIV, id: "div-2", slug: "reserves", name: "Reserves" };
    getPublicCompetitionMock.mockResolvedValue({
      org: ORG,
      competition: COMP,
      divisions: [DIV, second],
      liveNow: [],
    });
    getPublicDivisionMock.mockImplementation(async (_o: string, _c: string, slug: string) =>
      divisionDetail(slug === "reserves" ? { division: second } : {}),
    );
    await getPublicCompetitionHub("riverside", "autumn-cup");
    expect(cacheCalls[0]!.options).toMatchObject({
      tags: [
        orgTag("riverside"),
        competitionTag("comp-1"),
        divisionTag("div-1"),
        divisionTag("div-2"),
      ],
    });
  });

  it("a competition the shell refuses is null, and no cache entry is created for it", async () => {
    getPublicCompetitionMock.mockResolvedValue(null);
    expect(await getPublicCompetitionHub("riverside", "private-cup")).toBeNull();
    expect(cacheCalls).toEqual([]);
  });
});
