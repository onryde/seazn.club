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
import { FIXTURE_STATUSES } from "@/lib/fixture-status";
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
const memberRefsMock = vi.hoisted(() => vi.fn());

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
  readEntrantMemberRefs: memberRefsMock,
}));
// The discipline read is SQL — a real database's job
// (`competition-hub-db.test.ts`, and `discipline.test.ts` for read-only-ness).
// Here it is the seam whose OUTPUT the builder maps onto squads and division
// boxes.
const suspensionEntriesMock = vi.hoisted(() => vi.fn());
vi.mock("@/server/usecases/discipline", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/usecases/discipline")>()),
  activePublicSuspensionEntries: suspensionEntriesMock,
}));
// Observed, not silenced for its own sake: a read the hub swallows must still
// leave a warning behind, or a broken discipline query reads as "no bans".
const logMock = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  fatal: vi.fn(),
  trace: vi.fn(),
}));
vi.mock("@/server/logger", () => ({ log: logMock }));

import { msgFor } from "@/lib/messages-i18n";
import { decidedOutcomeText } from "@/lib/scoring-vocab";
import { roundRoleFor, roundRoleLabel } from "@/lib/round-role-label";
import { t } from "@/lib/i18n-runtime";
import { resolveSlotLabel } from "@/lib/slot-label";
import enPublic from "@/dictionaries/en/public.json";
import esPublic from "@/dictionaries/es/public.json";
import frPublic from "@/dictionaries/fr/public.json";
import nlPublic from "@/dictionaries/nl/public.json";
import { resolveLatestModule } from "@/server/engine-db";
import { twoSidedBracket } from "@seazn/engine/scheduling/bracket-layout";
import { registry, type AnySportModule } from "@seazn/engine/sport";
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

/** The en captions of pools A and B under `stage`: `table.poolLabel` over the
 *  pool KEY, read from the dictionary file — never the stored "Pool " + key. */
const enCaptions = (stage: string, keys: string[] = ["A", "B"]) =>
  keys.map((k) => `${stage} — ${enPublic["table.poolLabel"].replace("{key}", k)}`);

// ---------------------------------------------------------------------------
// Liveness — one authority, proven over the whole vocabulary
// ---------------------------------------------------------------------------

// The v1 wire vocabulary for a fixture's status (`Fixture.status`,
// `server/api-v1/schemas.ts`). W2a: that enum is `z.enum(FIXTURE_STATUSES)`, so
// this list IS the wire vocabulary; the guard below reads the source text to
// prove schemas.ts still uses it (the matches-hub.test.ts guard's twin).
const STATUSES = FIXTURE_STATUSES;

describe("hubLiveness — the ONE liveness derivation", () => {
  it("the STATUSES list still matches the enum in server/api-v1/schemas.ts (FIXTURE_STATUSES)", () => {
    const src = readFileSync(new URL("../../api-v1/schemas.ts", import.meta.url), "utf8");
    expect(src.split("\n").filter((l) => /status: z\.enum\(FIXTURE_STATUSES\)/.test(l))).toHaveLength(1);
    expect(src.split("\n").filter((l) => /status: z\.enum\(\[.*"forfeited".*\]\)/.test(l))).toEqual([]);
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
      // W2a: held — played level, listed under Completed, its own status line on the `other` header.
      needs_decision: { bucket: "completed", status: "other", live: false },
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
// list unattended. `table.pool` / `table.poolLabel` (`lib/pool-label.ts`, the
// hub's pool caption) and `table.tieBreak` (standings-view.ts:174) are the
// literals with no exported source to scan — all are call sites this file
// already imports/exercises elsewhere.
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
      "table.poolLabel",
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

  it("W2a: a held fixture's status line is the held one — D-H3's 'Level — winner to be decided' (never the 'Not played' fallback)", () => {
    // Expected copy is the spec's own (§5.5 public surfaces), read from the en dictionary.
    const header = hubHeader(F({ id: "f1", status: "needs_decision" }), SIDES(), "football", "T");
    expect(header.status).toBe("other");
    expect(header.statusLine).toEqual({ key: "matchCentre.status.needs_decision" });
    const en = JSON.parse(
      readFileSync(new URL("../../../dictionaries/en/public.json", import.meta.url), "utf8"),
    ) as Record<string, string>;
    expect(en[header.statusLine!.key]).toBe("Level — winner to be decided");
    expect(en["matchCentre.status.other"]).not.toBe("Level — winner to be decided"); // the two answers differ
  });

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
  // V414 — no qualification cut on this hand-built stage.
  qualify_count: null,
  qualify_per_group: false,
  next_stage_name: null,
  swiss_rounds: null,
  points_rule: null,
  has_rank_overrides: false,
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
  suspensionEntriesMock.mockResolvedValue([]);
  memberRefsMock.mockResolvedValue({});
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

  it("Round 2b: a BYE side is flagged from the STORED slot label (never the name), and the builder's own output draws it as the empty box on the real card while a pending side keeps '?'", async () => {
    const ko: PublicStage = { ...STAGE, id: "ko", kind: "knockout", name: "Knockout" };
    // How the tree writes a bye (`usecases/stages.ts`, `byeSlotLabel`): the
    // fixture carries the award, the phantom side has no entrant and the slot
    // label `{ key: "bracket.slot.bye" }`, and the status is `forfeited`.
    const bye = F({
      id: "ko-bye",
      stage_id: "ko",
      home_entrant_id: "e1",
      away_entrant_id: null,
      away_slot_label: { key: "bracket.slot.bye", params: {} },
      status: "forfeited",
      outcome: { kind: "award", winner: "e1" },
    });
    // A slot still waiting on a result: no entrant, a feeder label.
    const pending = F({
      id: "ko-pending",
      stage_id: "ko",
      round_no: 2,
      home_entrant_id: null,
      home_slot_label: { key: "slot.winner_match", params: { round: 1, seq: 1 } },
      away_entrant_id: "e2",
    });
    // A bye label left on a side that HAS an entrant: the entrant, not a bye.
    const filled = F({
      id: "ko-filled",
      stage_id: "ko",
      round_no: 2,
      seq_in_round: 2,
      home_entrant_id: "e1",
      home_slot_label: { key: "bracket.slot.bye", params: {} },
      away_entrant_id: "e2",
    });
    getPublicDivisionMock.mockResolvedValue(
      divisionDetail({ stages: [ko], fixtures: [bye, pending, filled], standings: [] }),
    );
    const doc = (await loadCompetitionHub("riverside", "autumn-cup", NOW))!;
    const byId = (id: string) => doc.matches.find((x) => x.fixtureId === id)!;
    // The premise that makes a producer field necessary: both empty sides
    // reach the document as `entrantId: ""`, indistinguishable by that field.
    expect(byId("ko-bye").header.sides[1].entrantId).toBe("");
    expect(byId("ko-pending").header.sides[0].entrantId).toBe("");
    expect(byId("ko-bye").byeSides).toEqual([false, true]);
    expect(byId("ko-pending").byeSides).toEqual([false, false]);
    expect(byId("ko-filled").byeSides).toEqual([false, false]);
    const parsed = CompetitionHubDoc.safeParse(doc);
    expect(parsed.error?.issues ?? []).toEqual([]);

    // The seam, producer to consumer: the builder's own matches through the real card.
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { createElement } = await import("react");
    const { MatchCard } = await import("@/components/public-site/matches-hub/match-card");
    const en = (await import("@/dictionaries/en/public.json")).default;
    const card = (id: string) =>
      renderToStaticMarkup(
        createElement(MatchCard, {
          match: byId(id),
          dict: en as unknown as Parameters<typeof MatchCard>[0]["dict"],
          locale: "en",
          now: 0,
        }),
      );
    expect(card("ko-bye")).toMatch(/<span aria-hidden="true" data-crest="empty" class="[^"]*"><\/span>/);
    expect(card("ko-bye")).not.toContain('data-crest="pending"');
    expect(card("ko-pending")).toMatch(/<span aria-hidden="true" data-crest="pending" class="[^"]*">\?<\/span>/);
    expect(card("ko-pending")).not.toContain('data-crest="empty"');
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

  describe("stageFormatLines (design 2026-09-17 §D3/T7) — only the stages whose rules differ", () => {
    // The prod shape (2026-09-24): a badminton `short` division whose Swiss
    // stage plays Best-of-1 to 15 (cap 21). The division's config is the
    // module's own parse of the variant, never typed here.
    const badminton = resolveLatestModule("badminton");
    const SHORT = badminton.configSchema.parse(badminton.variants.short) as Record<string, unknown>;
    const SWISS_RULES = { bestOf: 1, setTo: 15, cap: 21, finalSetTo: 15, winBy: 2 };
    const BADMINTON_DIV: PublicDivision = {
      ...DIV,
      sport_key: "badminton",
      variant_key: "short",
      sport_name: "Badminton",
      module_version: badminton.version,
      config: SHORT,
    };
    const swiss: PublicStage = { ...STAGE, id: "sw", seq: 1, kind: "swiss", name: "Swiss", rules: SWISS_RULES };
    const league: PublicStage = { ...STAGE, id: "lg", seq: 2, kind: "league", name: "League" };
    // An override that RESTATES the division's own best-of: stored rules, no
    // difference — an identical line per stage is noise (brief decision).
    const finals: PublicStage = {
      ...STAGE,
      id: "fn",
      seq: 3,
      kind: "knockout",
      name: "Finals",
      rules: { bestOf: SHORT.bestOf },
    };

    const load = async (stages: PublicStage[]) => {
      getPublicCompetitionMock.mockResolvedValue({ org: ORG, competition: COMP, divisions: [BADMINTON_DIV], liveNow: [] });
      getPublicDivisionMock.mockResolvedValue(
        divisionDetail({ division: BADMINTON_DIV, stages, fixtures: [], standings: [], entrants: [] }),
      );
      return (await loadCompetitionHub("riverside", "autumn-cup", NOW))!;
    };

    it("names ONLY the overriding stage, with its effective rules — 15 points, not the division's 11", async () => {
      expect(SHORT.setTo, "the right answer must differ from the division's").not.toBe(SWISS_RULES.setTo);
      const doc = await load([swiss, league, finals]);
      expect(doc.divisions[0]!.stageFormatLines).toEqual([
        {
          stageName: "Swiss",
          line: [
            { key: "format.rules.oneGamePointsCap", params: { points: SWISS_RULES.setTo, cap: SWISS_RULES.cap } },
          ],
        },
      ]);
      // The division's own sentence is unchanged — it is the default.
      expect(doc.divisions[0]!.formatLine).toEqual(describeFormat("badminton", badminton, SHORT));
      expect(CompetitionHubDoc.safeParse(doc).success).toBe(true);
    });

    it("in STAGE order, not the order the reader handed them over", async () => {
      const leagueBo5: PublicStage = { ...league, rules: { bestOf: 5 } };
      const doc = await load([leagueBo5, swiss]);
      expect(doc.divisions[0]!.stageFormatLines?.map((l) => l.stageName)).toEqual(["Swiss", "League"]);
    });

    it("a stage whose rule keys differ gets a line even where the words are vague (winBy alone) — never the preset (review round 2)", async () => {
      const winByOnly: PublicStage = { ...league, rules: { winBy: (SHORT.winBy as number) - 1 } };
      const doc = await load([winByOnly]);
      expect(doc.divisions[0]!.stageFormatLines).toEqual([
        {
          stageName: "League",
          line: [
            {
              key: "format.rules.bestOfPointsCap",
              params: { n: SHORT.bestOf, points: SHORT.setTo, cap: SHORT.cap },
            },
          ],
        },
      ]);
      // A line is at least one clause: the schema refuses an empty one.
      const empty = structuredClone(doc);
      empty.divisions[0]!.stageFormatLines![0]!.line = [];
      expect(CompetitionHubDoc.safeParse(empty).success).toBe(false);
      expect(CompetitionHubDoc.safeParse(doc).success).toBe(true);
    });

    it("a division with no overriding stage carries NO field at all — not an empty list", async () => {
      const doc = await load([league, finals]);
      expect(doc.divisions[0]).not.toHaveProperty("stageFormatLines");
      // The football division the rest of this file uses has no stage rules.
      getPublicCompetitionMock.mockResolvedValue({ org: ORG, competition: COMP, divisions: [DIV], liveNow: [] });
      getPublicDivisionMock.mockResolvedValue(divisionDetail());
      const plain = (await loadCompetitionHub("riverside", "autumn-cup", NOW))!;
      expect(plain.divisions[0]).not.toHaveProperty("stageFormatLines");
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

  it("pool A reads above pool B — never in pool-id order (lib/pool-order.ts)", async () => {
    // Ids chosen to sort OPPOSITE to the names, and the snapshots handed over
    // in id order: an id sort, what this builder used to do, reads B first.
    const POOL_A = "ffffffff-0000-4000-8000-00000000000a";
    const POOL_B = "00000000-0000-4000-8000-00000000000b";
    const snap = (pool_id: string, entrantId: string): PublicStandings => ({
      ...SNAPSHOT,
      pool_id,
      rows: [{ entrantId, played: 1, won: 1, drawn: 0, lost: 0, points: 3, metrics: { gf: 1, ga: 0 }, rank: 1 }],
    });
    getPublicDivisionMock.mockResolvedValue(
      divisionDetail({
        stages: [{ ...STAGE, kind: "group", name: "Groups" }],
        pools: [
          { id: POOL_B, stage_id: "st1", key: "B", name: "Pool B" },
          { id: POOL_A, stage_id: "st1", key: "A", name: "Pool A" },
        ],
        standings: [snap(POOL_B, "e2"), snap(POOL_A, "e1")],
      }),
    );
    const doc = (await loadCompetitionHub("riverside", "autumn-cup", NOW))!;
    expect(doc.tables.map((v) => v.caption)).toEqual(enCaptions("Groups"));
    expect(doc.tables.map((v) => v.id)).toEqual([`open-st1-${POOL_A}`, `open-st1-${POOL_B}`]);
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

  // Retitled: it said "ordered by pool id", and its ids ("pA" < "pB") sort the
  // same way as its names, so it could not tell the two orders apart. The
  // test above it gives the ids the OPPOSITE order.
  it("pool tables are captioned with their pool's en label from its key, pool A first", async () => {
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
    expect(doc.tables.map((t) => t.caption)).toEqual(enCaptions("League"));
    expect(doc.tables.map((t) => t.id)).toEqual(["open-st1-pA", "open-st1-pB"]);
  });

  // Pool label i18n (2026-10-06). `pools.name` is only ever written as the
  // English "Pool " + key (`usecases/stages.ts`), so a caption read off it put
  // English in front of every es/fr/nl spectator. The pools below carry
  // exactly that stored name; the caption must be the org-locale dictionary's
  // `table.poolLabel` over the pool's KEY. Expected text is read out of the
  // dictionary FILES, never through the code under test.
  it("each pool's caption is the ORG's locale's pool label over its key — never the stored English name, in every locale", async () => {
    const files: Record<(typeof LOCALES)[number], Record<string, string>> = {
      en: enPublic,
      es: esPublic,
      fr: frPublic,
      nl: nlPublic,
    };
    const label = (locale: (typeof LOCALES)[number], key: string) => files[locale]["table.poolLabel"].replace("{key}", key);
    // Premise: the right answer differs from the stored name in a non-English
    // locale, or this test could not see the defect it exists for.
    expect(label("es", "A")).not.toBe("Pool A");
    const pools = [
      { id: "pB", stage_id: "st1", key: "B", name: "Pool B" },
      { id: "pA", stage_id: "st1", key: "A", name: "Pool A" },
    ];
    const standings: PublicStandings[] = [
      { ...SNAPSHOT, pool_id: "pB" },
      { ...SNAPSHOT, pool_id: "pA" },
    ];
    let checked = 0;
    for (const locale of LOCALES) {
      getPublicCompetitionMock.mockResolvedValue({
        org: { ...ORG, default_locale: locale },
        competition: COMP,
        divisions: [DIV],
        liveNow: [],
      });
      getPublicDivisionMock.mockResolvedValue(
        divisionDetail({ stages: [{ ...STAGE, kind: "group", name: "Groups" }], pools, standings }),
      );
      const doc = (await loadCompetitionHub("riverside", "autumn-cup", NOW))!;
      expect(doc.tables.map((t) => t.caption), locale).toEqual([
        `Groups — ${label(locale, "A")}`,
        `Groups — ${label(locale, "B")}`,
      ]);
      checked += doc.tables.length;
    }
    // Anti-vacuity: two pool captions per locale, four locales.
    expect(checked).toBe(LOCALES.length * pools.length);
  });

  it("a snapshot whose pool the read does not list keeps the bare pool word, in the org's locale", async () => {
    getPublicCompetitionMock.mockResolvedValue({
      org: { ...ORG, default_locale: "es" },
      competition: COMP,
      divisions: [DIV],
      liveNow: [],
    });
    getPublicDivisionMock.mockResolvedValue(
      divisionDetail({
        stages: [{ ...STAGE, kind: "group", name: "Groups" }],
        pools: [],
        standings: [{ ...SNAPSHOT, pool_id: "p-unlisted" }],
      }),
    );
    const doc = (await loadCompetitionHub("riverside", "autumn-cup", NOW))!;
    expect(doc.tables.map((t) => t.caption)).toEqual([`Groups — ${esPublic["table.pool"]}`]);
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

  // The Teams tab renders a SQUAD DISCLOSURE per card — a member count, a
  // chevron and "No squad listed yet" — and a singles entrant is none of
  // those things. `entrant_kind` already reached this builder (it decides
  // `Side.isPerson`) and stopped there, so the card had no way to tell one
  // person from a club. The whole table, not one sample: a kind that arrives
  // as anything else falls through to `team`, which is the shape every card
  // had before this field existed.
  it("each card carries its entrant's KIND — individual and pair are not teams, and an unknown kind falls through to team", async () => {
    getPublicDivisionMock.mockResolvedValue(
      divisionDetail({
        entrants: [
          ENTRANTS[0]!,
          { ...ENTRANTS[1]!, kind: "individual" },
          { ...ENTRANTS[2]!, kind: "pair" },
        ],
      }),
    );
    const doc = (await loadCompetitionHub("riverside", "autumn-cup", NOW))!;
    expect(doc.teams.map((t) => [t.entrantId, t.kind])).toEqual([
      ["e1", "team"],
      ["e2", "individual"],
      ["e3", "pair"],
    ]);
    // …and the document the route serves still validates, which is what says
    // the value is inside the schema's own enum rather than merely a string.
    expect(CompetitionHubDoc.safeParse(doc).error?.issues ?? []).toEqual([]);

    getPublicDivisionMock.mockResolvedValue(
      divisionDetail({ entrants: [{ ...ENTRANTS[0]!, kind: "club" }] }),
    );
    const odd = (await loadCompetitionHub("riverside", "autumn-cup", NOW))!;
    expect(odd.teams.map((t) => t.kind)).toEqual(["team"]);
    expect(CompetitionHubDoc.safeParse(odd).error?.issues ?? []).toEqual([]);
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
// Division-page parity (owner ruling 2026-09-16) — squads, suspensions,
// division prose and the per-team calendar, before any redirect
// ---------------------------------------------------------------------------

describe("loadCompetitionHub — squads, suspensions, division prose, team calendars", () => {
  type Member = PublicEntrant["members"][number];
  const member = (over: Partial<Member> & { name: string }): Member => ({
    photo: null,
    person_id: null,
    squad_number: null,
    position: null,
    ...over,
  });
  const withMembers = (byEntrant: Record<string, Member[]>): PublicEntrant[] =>
    ENTRANTS.map((e) => ({ ...e, members: byEntrant[e.id] ?? [] }));
  /** The INTERNAL row behind each squad line, positionally aligned with it. */
  const ref = (
    personId: string,
    fullName: string,
    squadNumber: number | null = null,
    over: { consent?: { public_name?: boolean } | null; positionKey?: string | null } = {},
  ) => ({ personId, fullName, consent: null, squadNumber, positionKey: null, ...over });
  /** One active ban as the hub's single discipline read returns it. */
  const ban = (personId: string, entrantId: string | null, name: string, remaining: number, divisionId = "div-1") => ({
    divisionId,
    personId,
    entrantId,
    name,
    remaining,
  });
  const load = async () => {
    const doc = (await loadCompetitionHub("riverside", "autumn-cup", NOW))!;
    expect(CompetitionHubDoc.safeParse(doc).error?.issues ?? []).toEqual([]);
    return doc;
  };
  const marks = (doc: Awaited<ReturnType<typeof load>>) =>
    doc.teams.map((t) => t.members!.map((m) => m.suspendedRemaining));

  it("EMPTY FIRST: no squads and no bans → `members: []` and `suspensions: []` (never undefined, which reads as a document built before squads existed), and no internal member read", async () => {
    const doc = await load();
    expect(doc.teams.map((t) => t.members)).toEqual([[], [], []]);
    expect(doc.divisions.map((d) => d.suspensions)).toEqual([[]]);
    expect(memberRefsMock).not.toHaveBeenCalled();
  });

  it("members come from the masked entrant read, in the READ's order, with the raw squad number and position", async () => {
    // Deliberately neither alphabetical nor by number: the order is the
    // division page's (`public_entrants_v` sorts), and the builder must not
    // re-sort what it was handed.
    getPublicDivisionMock.mockResolvedValue(
      divisionDetail({
        entrants: withMembers({
          e1: [
            member({ name: "Zed Adams", person_id: "pz", squad_number: 9, position: "FW" }),
            member({ name: "Dev P.", squad_number: 3 }),
            member({ name: "Arun Kumar", person_id: "pa" }),
          ],
        }),
      }),
    );
    const doc = await load();
    expect(doc.teams[0]!.members).toEqual([
      {
        personId: "pz",
        name: "Zed Adams",
        squadNumber: 9,
        position: "FW",
        playerHref: "/shared/riverside/autumn-cup/players/pz",
        suspendedRemaining: null,
      },
      // No public id (no consent, or no player-profile entitlement): no link,
      // and no id either — the view withheld it, so the document does.
      { personId: null, name: "Dev P.", squadNumber: 3, position: null, playerHref: null, suspendedRemaining: null },
      {
        personId: "pa",
        name: "Arun Kumar",
        squadNumber: null,
        position: null,
        playerHref: "/shared/riverside/autumn-cup/players/pa",
        suspendedRemaining: null,
      },
    ]);
    // A squad and NO ban: the internal person read has nothing to mark, so it
    // does not run (the EMPTY test cannot say this — it has no squad at all).
    expect(memberRefsMock).not.toHaveBeenCalled();
  });

  it("a masked name never links: the DIVISION's name policy withholds the link and the id even where the view published one — the whole policy table", async () => {
    // `public_entrants_v` publishes `person_id` on consent + entitlement and
    // knows nothing of youth, so a consented minor arrives WITH an id and a
    // masked name. The division page links on the id alone; the hub does not.
    const cases: [youth: boolean, display: string | null, links: boolean][] = [
      [false, null, true],
      [true, null, false],
      [true, "full", true],
      [false, "first_initial", false],
    ];
    for (const [youth, display, links] of cases) {
      const division: PublicDivision = { ...DIV, youth, player_name_display: display };
      getPublicCompetitionMock.mockResolvedValue({ org: ORG, competition: COMP, divisions: [division], liveNow: [] });
      getPublicDivisionMock.mockResolvedValue(
        divisionDetail({ division, entrants: withMembers({ e1: [member({ name: "Sam C.", person_id: "ps" })] }) }),
      );
      const [m] = (await load()).teams[0]!.members!;
      expect({ youth, display, playerHref: m!.playerHref, personId: m!.personId }).toEqual({
        youth,
        display,
        playerHref: links ? "/shared/riverside/autumn-cup/players/ps" : null,
        personId: links ? "ps" : null,
      });
    }
  });

  it("the Suspended mark is by PERSON, never by name: two 'Sam Carter' on one team and a third on another — only the banned one is marked", async () => {
    getPublicDivisionMock.mockResolvedValue(
      divisionDetail({
        entrants: withMembers({
          e1: [
            member({ name: "Sam Carter", squad_number: 4 }),
            member({ name: "Sam Carter", squad_number: 5 }),
          ],
          e2: [member({ name: "Sam Carter" })],
        }),
      }),
    );
    memberRefsMock.mockResolvedValue({
      e1: [ref("p-twin", "Sam Carter", 4), ref("p-banned", "Sam Carter", 5)],
      e2: [ref("p-other", "Sam Carter")],
    });
    suspensionEntriesMock.mockResolvedValue([
      { divisionId: "div-1", personId: "p-banned", entrantId: "e1", name: "Sam Carter", remaining: 2 },
    ]);
    const doc = await load();
    // The banned person is the SECOND row — a name match would mark the first
    // (or all three).
    expect(marks(doc)).toEqual([[null, 2], [null], []]);
    // One internal read, for exactly the entrants that list a squad.
    expect(memberRefsMock).toHaveBeenCalledTimes(1);
    expect(memberRefsMock).toHaveBeenCalledWith(["e1", "e2"]);
  });

  it("a ban holds across the DIVISION (the team-sheet gate is division-scoped): a ban with no entrant marks the person, and two bans mark the longer", async () => {
    getPublicDivisionMock.mockResolvedValue(
      divisionDetail({
        entrants: withMembers({
          e1: [member({ name: "Sam Carter" })],
          e2: [member({ name: "Joe Bloggs" })],
        }),
      }),
    );
    memberRefsMock.mockResolvedValue({ e1: [ref("p1", "Sam Carter")], e2: [ref("p2", "Joe Bloggs")] });
    suspensionEntriesMock.mockResolvedValue([
      { divisionId: "div-1", personId: "p1", entrantId: null, name: "Sam Carter", remaining: 1 },
      // The longer ban FIRST, so "the last one read wins" cannot pass for
      // "the longest wins".
      { divisionId: "div-1", personId: "p2", entrantId: "e2", name: "Joe Bloggs", remaining: 3 },
      { divisionId: "div-1", personId: "p2", entrantId: "e2", name: "Joe Bloggs", remaining: 1 },
    ]);
    expect(marks(await load())).toEqual([[1], [3], []]);
  });

  it("marks NOBODY where the internal rows cannot be trusted to line up: a count that disagrees with the squad, or two rows the view's own sort cannot tell apart", async () => {
    getPublicDivisionMock.mockResolvedValue(
      divisionDetail({
        entrants: withMembers({
          // Same full name, same (absent) number: `public_entrants_v` orders
          // by `squad_number nulls last, full_name`, so their relative order
          // is Postgres's choice, not a promise — either row could be the ban.
          e1: [member({ name: "Sam Carter" }), member({ name: "Sam Carter" })],
          // One member listed, two internal rows: a person joined between the
          // cached read and this one.
          e2: [member({ name: "Joe Bloggs" })],
          e3: [member({ name: "Kim Lee", squad_number: 1 }), member({ name: "Sam Carter" })],
        }),
      }),
    );
    memberRefsMock.mockResolvedValue({
      e1: [ref("p-a", "Sam Carter"), ref("p-b", "Sam Carter")],
      e2: [ref("p-j", "Joe Bloggs"), ref("p-new", "Ann New")],
      e3: [ref("p-k", "Kim Lee", 1), ref("p-a", "Sam Carter")],
    });
    suspensionEntriesMock.mockResolvedValue([
      { divisionId: "div-1", personId: "p-a", entrantId: "e1", name: "Sam Carter", remaining: 2 },
      { divisionId: "div-1", personId: "p-j", entrantId: "e2", name: "Joe Bloggs", remaining: 1 },
    ]);
    const doc = await load();
    // e3 is the positive pair: the same banned person, unambiguous there, IS
    // marked — so the refusals above are the guards, not a dead mapping.
    expect(marks(doc)).toEqual([[null, null], [null], [null, 2]]);
    // The bans themselves still list.
    expect(doc.divisions[0]!.suspensions!.map((s) => s.name)).toEqual(["Joe Bloggs", "Sam Carter"]);
  });

  // The squad lines come from `getPublicDivision`'s cache (30s); the internal
  // rows are read fresh, and a roster write does not revalidate that cache. A
  // same-count edit between the two reads shifts who sits at index i while
  // the count still agrees — so EVERY row must agree with its line before any
  // is marked. Each case below carries a positive pair on e3, so the refusal
  // is the guard, not a dead mapping.
  it("a same-count RENUMBER marks nobody on that team: Carter went from 4 to 9, so the fresh rows sit one place off the cached lines (a youth division, where the NAME cannot tell them apart)", async () => {
    const youth: PublicDivision = { ...DIV, youth: true };
    getPublicCompetitionMock.mockResolvedValue({ org: ORG, competition: COMP, divisions: [youth], liveNow: [] });
    getPublicDivisionMock.mockResolvedValue(
      divisionDetail({
        division: youth,
        entrants: withMembers({
          // Cached: Carter #4, Cole #7 — both "Sam C." in a youth division.
          e1: [member({ name: "Sam C.", squad_number: 4 }), member({ name: "Sam C.", squad_number: 7 })],
          e3: [member({ name: "Kim L.", squad_number: 1 })],
        }),
      }),
    );
    memberRefsMock.mockResolvedValue({
      // Fresh: Cole #7, Carter #9.
      e1: [ref("p-cole", "Sam Cole", 7), ref("p-carter", "Sam Carter", 9)],
      e3: [ref("p-kim", "Kim Lee", 1)],
    });
    suspensionEntriesMock.mockResolvedValue([ban("p-carter", "e1", "Sam C.", 2), ban("p-kim", "e3", "Kim L.", 1)]);
    // Zipped as-is, Carter's ban would land on line 2 — Cole, shirt 7.
    expect(marks(await load())).toEqual([[null, null], [], [1]]);
  });

  it("a same-count SWAP marks nobody on that team: Ann and Bob traded shirts, so the numbers still read 1, 2 down the list but row 2 is Ann while line 2 reads Bob", async () => {
    getPublicDivisionMock.mockResolvedValue(
      divisionDetail({
        entrants: withMembers({
          e1: [member({ name: "Ann Lee", squad_number: 1 }), member({ name: "Bob Ray", squad_number: 2 })],
          e3: [member({ name: "Kim Lee", squad_number: 1 })],
        }),
      }),
    );
    memberRefsMock.mockResolvedValue({
      e1: [ref("p-bob", "Bob Ray", 1), ref("p-ann", "Ann Lee", 2)],
      e3: [ref("p-kim", "Kim Lee", 1)],
    });
    suspensionEntriesMock.mockResolvedValue([ban("p-ann", "e1", "Ann Lee", 2), ban("p-kim", "e3", "Kim Lee", 1)]);
    expect(marks(await load())).toEqual([[null, null], [], [1]]);
  });

  it("a same-count REPLACEMENT marks nobody on that team: a different Sam Carter took the same shirt, and the cached line's published id is still the old one's", async () => {
    getPublicDivisionMock.mockResolvedValue(
      divisionDetail({
        entrants: withMembers({
          e1: [member({ name: "Sam Carter", person_id: "p-old", squad_number: 5 })],
          e3: [member({ name: "Kim Lee", person_id: "p-kim", squad_number: 1 })],
        }),
      }),
    );
    memberRefsMock.mockResolvedValue({
      e1: [ref("p-new", "Sam Carter", 5, { consent: { public_name: true } })],
      e3: [ref("p-kim", "Kim Lee", 1, { consent: { public_name: true } })],
    });
    suspensionEntriesMock.mockResolvedValue([ban("p-new", "e1", "Sam Carter", 3), ban("p-kim", "e3", "Kim Lee", 1)]);
    const doc = await load();
    expect(marks(doc)).toEqual([[null], [], [1]]);
    // Nor does the new person's ban borrow the old person's player page.
    const listed = doc.divisions[0]!.suspensions!;
    expect(listed.find((s) => s.name === "Sam Carter")!.personId).toBeNull();
    expect(listed.find((s) => s.name === "Kim Lee")!.personId).toBe("p-kim");
  });

  it("a same-count POSITION edit marks nobody on that team: the card no longer describes the roster", async () => {
    getPublicDivisionMock.mockResolvedValue(
      divisionDetail({
        entrants: withMembers({
          e1: [member({ name: "Ann Lee", squad_number: 1, position: "GK" })],
          e3: [member({ name: "Kim Lee", squad_number: 1, position: "FW" })],
        }),
      }),
    );
    memberRefsMock.mockResolvedValue({
      e1: [ref("p-ann", "Ann Lee", 1, { positionKey: "DF" })],
      e3: [ref("p-kim", "Kim Lee", 1, { positionKey: "FW" })],
    });
    suspensionEntriesMock.mockResolvedValue([ban("p-ann", "e1", "Ann Lee", 2), ban("p-kim", "e3", "Kim Lee", 1)]);
    expect(marks(await load())).toEqual([[null], [], [1]]);
  });

  it("ALL OR NOTHING: one renumbered player voids the whole card — Ann's own row still matches her line, and she is not marked either", async () => {
    getPublicDivisionMock.mockResolvedValue(
      divisionDetail({
        entrants: withMembers({
          e1: [
            member({ name: "Ann Lee", squad_number: 1 }),
            member({ name: "Bob Ray", squad_number: 2 }),
            member({ name: "Cat Moss", squad_number: 3 }),
          ],
          e3: [member({ name: "Kim Lee", squad_number: 1 })],
        }),
      }),
    );
    memberRefsMock.mockResolvedValue({
      // Bob went from 2 to 4: rows 2 and 3 have moved, row 1 has not.
      e1: [ref("p-ann", "Ann Lee", 1), ref("p-cat", "Cat Moss", 3), ref("p-bob", "Bob Ray", 4)],
      e3: [ref("p-kim", "Kim Lee", 1)],
    });
    suspensionEntriesMock.mockResolvedValue([ban("p-ann", "e1", "Ann Lee", 2), ban("p-kim", "e3", "Kim Lee", 1)]);
    expect(marks(await load())).toEqual([[null, null, null], [], [1]]);
  });

  it("each division lists its bans: the team's MASKED name, a public id only where the squad row has one, sorted by name", async () => {
    getPublicDivisionMock.mockResolvedValue(
      divisionDetail({
        entrants: withMembers({
          e1: [member({ name: "Zara Young", person_id: "pz" })],
          e2: [member({ name: "Adam Old" })],
        }),
      }),
    );
    memberRefsMock.mockResolvedValue({ e1: [ref("pz", "Zara Young")], e2: [ref("pa", "Adam Old")] });
    suspensionEntriesMock.mockResolvedValue([
      { divisionId: "div-1", personId: "pz", entrantId: "e1", name: "Zara Young", remaining: 1 },
      { divisionId: "div-1", personId: "pa", entrantId: "e2", name: "Adam Old", remaining: 2 },
      // Off every roster, on an entrant a spectator cannot see (withdrawn):
      // the ban lists, but neither the internal person nor entrant id does.
      { divisionId: "div-1", personId: "p-gone", entrantId: "e-withdrawn", name: "Gone Person", remaining: 1 },
    ]);
    const doc = await load();
    expect(doc.divisions[0]!.suspensions).toEqual([
      { personId: null, name: "Adam Old", entrantId: "e2", entrantName: "Red Rockets", remaining: 2 },
      { personId: null, name: "Gone Person", entrantId: null, entrantName: null, remaining: 1 },
      { personId: "pz", name: "Zara Young", entrantId: "e1", entrantName: "Blue Blazers", remaining: 1 },
    ]);
    expect(JSON.stringify(doc)).not.toContain("p-gone");
    expect(JSON.stringify(doc)).not.toContain('"pa"');
    // The quiet twin of the two failure tests below: reads that succeed log nothing.
    expect(logMock.warn).not.toHaveBeenCalled();
  });

  it("ONE discipline read for the whole competition: every division's id in one call, and each ban lists under its OWN division only", async () => {
    const reserves: PublicDivision = { ...DIV, id: "div-2", slug: "reserves", name: "Reserves", youth: true };
    getPublicCompetitionMock.mockResolvedValue({ org: ORG, competition: COMP, divisions: [DIV, reserves], liveNow: [] });
    getPublicDivisionMock.mockImplementation(async (_o: string, _c: string, slug: string) =>
      divisionDetail(slug === "reserves" ? { division: reserves } : {}),
    );
    suspensionEntriesMock.mockResolvedValue([ban("p1", null, "Sam C.", 2, "div-2"), ban("p2", null, "Joe Bloggs", 1)]);
    const doc = await load();
    expect(suspensionEntriesMock).toHaveBeenCalledTimes(1);
    expect(suspensionEntriesMock).toHaveBeenCalledWith(["div-1", "div-2"]);
    expect(doc.divisions.map((d) => [d.slug, d.suspensions!.map((s) => s.name)])).toEqual([
      ["open", ["Joe Bloggs"]],
      ["reserves", ["Sam C."]],
    ]);
  });

  it("a discipline read that FAILS hides the list and the marks — the hub still builds", async () => {
    getPublicDivisionMock.mockResolvedValue(
      divisionDetail({ entrants: withMembers({ e1: [member({ name: "Sam Carter" })] }) }),
    );
    memberRefsMock.mockResolvedValue({ e1: [ref("p1", "Sam Carter")] });
    suspensionEntriesMock.mockRejectedValue(new Error("connection reset"));
    const doc = await load();
    expect(doc.divisions[0]!.suspensions).toEqual([]);
    expect(marks(doc)).toEqual([[null], [], []]);
    expect(doc.matches.length).toBeGreaterThan(0);
    // Swallowed, never silent.
    expect(logMock.warn).toHaveBeenCalledTimes(1);
    expect(logMock.warn).toHaveBeenCalledWith(
      { competitionId: COMP.id, err: "connection reset" },
      "competition-hub: the suspension read failed; bans and Suspended marks are absent",
    );
  });

  it("an internal member read that FAILS drops the marks but keeps the bans listed", async () => {
    getPublicDivisionMock.mockResolvedValue(
      divisionDetail({ entrants: withMembers({ e1: [member({ name: "Sam Carter" })] }) }),
    );
    memberRefsMock.mockRejectedValue(new Error("connection reset"));
    suspensionEntriesMock.mockResolvedValue([{ divisionId: "div-1", personId: "p1", entrantId: "e1", name: "Sam Carter", remaining: 2 }]);
    const doc = await load();
    expect(marks(doc)).toEqual([[null], [], []]);
    expect(doc.divisions[0]!.suspensions).toEqual([
      { personId: null, name: "Sam Carter", entrantId: "e1", entrantName: "Blue Blazers", remaining: 2 },
    ]);
    expect(logMock.warn).toHaveBeenCalledTimes(1);
    expect(logMock.warn).toHaveBeenCalledWith(
      { divisionId: "div-1", err: "connection reset" },
      "competition-hub: the squad member read failed; Suspended marks are absent",
    );
  });

  it("division prose is sanitised HTML when there is some, and null when there is none (blank counts as none)", async () => {
    const second: PublicDivision = {
      ...DIV,
      id: "div-2",
      slug: "reserves",
      name: "Reserves",
      description: "Open to **every** club. <script>alert(1)</script>",
    };
    const third: PublicDivision = { ...DIV, id: "div-3", slug: "vets", name: "Vets", description: "   " };
    getPublicCompetitionMock.mockResolvedValue({
      org: ORG,
      competition: COMP,
      divisions: [DIV, second, third],
      liveNow: [],
    });
    getPublicDivisionMock.mockImplementation(async (_o: string, _c: string, slug: string) =>
      divisionDetail(slug === "reserves" ? { division: second } : slug === "vets" ? { division: third } : {}),
    );
    const doc = await load();
    expect(doc.divisions.map((d) => [d.slug, d.description])).toEqual([
      ["open", null],
      // The inline <script> element is dropped (its text survives as text) —
      // the pipeline's own output, captured, not a hand-typed guess.
      ["reserves", "<p>Open to <strong>every</strong> club. alert(1)</p>"],
      ["vets", null],
    ]);
    expect(suspensionEntriesMock).toHaveBeenCalledTimes(1);
  });

  it("each team's calendar is its division's .ics route with that entrant's filter", async () => {
    const doc = await load();
    expect(doc.teams.map((t) => t.calendarHref)).toEqual([
      "/shared/riverside/autumn-cup/open/calendar.ics?entrant=e1",
      "/shared/riverside/autumn-cup/open/calendar.ics?entrant=e2",
      "/shared/riverside/autumn-cup/open/calendar.ics?entrant=e3",
    ]);
    // The card's own link is untouched (the redirect decision owns it).
    expect(doc.teams[0]!.href).toBe("/shared/riverside/autumn-cup/open?tab=entrants");
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

// ---------------------------------------------------------------------------
// Fix round N1 — a slot waiting on a match names that match's ROUND
// ---------------------------------------------------------------------------

describe("loadCompetitionHub — N1: a slot waiting on a match names that match's ROUND, never the board's R·code", () => {
  const cup: PublicStage = { ...STAGE, id: "ko", seq: 2, kind: "knockout", name: "Cup" };
  const league: PublicStage = { ...STAGE, id: "lg", seq: 1, kind: "league", name: "League" };
  const en = enPublic as unknown as Parameters<typeof t>[0];
  const fr = frPublic as unknown as Parameters<typeof t>[0];
  type Doc = NonNullable<Awaited<ReturnType<typeof loadCompetitionHub>>>;
  type Label = { key: string; params: { round: number; seq: number } };
  const R_CODE = /R\d+·\d+/;

  /** A whole single-elimination draw of `size`: round one seeded, every later
   *  slot waiting on the round before it. Round r's fixture j is fed on side s
   *  by round r-1's fixture 2j-1+s, as its winner — `generateSingleElim`'s
   *  wiring, stored the way `stages.ts` `matchSlotLabel` stores it: the
   *  FEEDER's `{round, seq}`, as numbers. */
  const draw = (size: number, stage_id = "ko"): PublicFixture[] => {
    const rounds = Math.log2(size);
    const out: PublicFixture[] = [];
    for (let r = 1; r <= rounds; r++) {
      for (let j = 1; j <= size / 2 ** r; j++) {
        const fed = (s: 0 | 1): Label => ({ key: "slot.winner_match", params: { round: r - 1, seq: 2 * j - 1 + s } });
        out.push(
          F({
            id: `${stage_id}-r${r}-${j}`,
            stage_id,
            round_no: r,
            seq_in_round: j,
            is_final: r === rounds,
            ...(r === 1
              ? {}
              : { home_entrant_id: null, away_entrant_id: null, home_slot_label: fed(0), away_slot_label: fed(1) }),
          }),
        );
      }
    }
    return out;
  };

  const load = async (fixtures: PublicFixture[], stages: PublicStage[] = [cup], org: PublicOrg = ORG) => {
    getPublicCompetitionMock.mockResolvedValue({ org, competition: COMP, divisions: [DIV], liveNow: [] });
    getPublicDivisionMock.mockResolvedValue(divisionDetail({ stages, fixtures, standings: [] }));
    const doc = (await loadCompetitionHub("riverside", "autumn-cup", NOW))!;
    expect(CompetitionHubDoc.safeParse(doc).error?.issues ?? []).toEqual([]);
    return doc;
  };
  const nameOf = (doc: Doc, fixtureId: string, side: 0 | 1) =>
    doc.matches.find((m) => m.fixtureId === fixtureId)!.header.sides[side].name;
  /** The rail chip's own text for the round holding `fixtureId`, read out of
   *  the document's knockout view — the string the Knockout rail renders. */
  const railLabel = (doc: Doc, fixtureId: string) =>
    doc.knockouts.flatMap((v) => v.rounds).find((r) => r.fixtureIds.includes(fixtureId))!.label;
  const codes = (doc: Doc) =>
    doc.matches.flatMap((m) => m.header.sides.map((s) => s.name)).filter((name) => R_CODE.test(name));

  it.each([
    [8, "no round of sixteen"],
    [16, "a round of sixteen first"],
  ])("a %i-draw (%s): the semi-final side waiting on quarter-final 2 reads 'Winner of Quarter-finals, match 2'", async (size) => {
    const doc = await load(draw(size));
    const semiRound = Math.log2(size) - 1;
    const semi = `ko-r${semiRound}-1`;
    const feeder = `ko-r${semiRound - 1}-2`;
    // The premise: on the rail, the feeder's round IS the quarter-finals —
    // at a different `round_no` in each draw.
    expect(railLabel(doc, feeder)).toBe(msgFor("en", "bracket.round.quarter"));
    expect(nameOf(doc, semi, 1)).toBe(t(en, "knockout.feederWinner", { round: railLabel(doc, feeder), seq: 2 }));
    expect(nameOf(doc, semi, 1)).toBe("Winner of Quarter-finals, match\u00a02");
    expect(nameOf(doc, semi, 0)).toBe("Winner of Quarter-finals, match\u00a01");
    expect(codes(doc)).toEqual([]);
  });

  it("a 32-draw: round two's sides name round one by the rail's 'Round of 32'", async () => {
    const doc = await load(draw(32));
    expect(railLabel(doc, "ko-r1-1")).toBe(msgFor("en", "bracket.round.roundOf", { n: 32 }));
    expect(nameOf(doc, "ko-r2-1", 0)).toBe(
      t(en, "knockout.feederWinner", { round: railLabel(doc, "ko-r1-1"), seq: 1 }),
    );
    expect(nameOf(doc, "ko-r2-8", 1)).toBe("Winner of Round of 32, match\u00a016");
    expect(codes(doc)).toEqual([]);
  });

  it("double elimination: a losers' slot names the winners' round it drops from — 'Loser of Semi-finals, match 2'", async () => {
    const de: PublicStage = { ...STAGE, id: "de", seq: 1, kind: "double_elim", name: "Double" };
    const at = (
      id: string,
      round_no: number,
      seq_in_round: number,
      lane: "WB" | "LB" | "GF",
      over: Partial<PublicFixture> = {},
    ) => F({ id, stage_id: "de", round_no, seq_in_round, lane, ...over });
    const winner = (round: number, seq: number): Label => ({ key: "slot.winner_match", params: { round, seq } });
    const loser = (round: number, seq: number): Label => ({ key: "slot.loser_match", params: { round, seq } });
    const waiting = (home: Label, away: Label): Partial<PublicFixture> => ({
      home_entrant_id: null,
      away_entrant_id: null,
      home_slot_label: home,
      away_slot_label: away,
    });
    // Hand-numbered DENSE here (WB 1-2, LB 3-4, GF 5) — NOT `bracketToGen`'s
    // real numbering, which offsets the losers' lane by k and the grand final
    // by 2k (for k = 2: WB 1-2, LB 5-6, GF 9, reset 10; the reset case below
    // uses exactly that). The feeder lookup is a Map keyed on `(round, seq)`
    // within the stage, so only uniqueness matters, and `round_no` never
    // repeats across lanes in either numbering.
    const doc = await load(
      [
        at("wb-1", 1, 1, "WB"),
        at("wb-2", 1, 2, "WB"),
        at("wb-f", 2, 1, "WB", waiting(winner(1, 1), winner(1, 2))),
        at("lb-1", 3, 1, "LB", waiting(loser(1, 2), loser(1, 1))),
        at("lb-f", 4, 1, "LB", waiting(loser(2, 1), winner(3, 1))),
        at("gf", 5, 1, "GF", waiting(winner(2, 1), winner(4, 1))),
      ],
      [de],
    );
    expect(railLabel(doc, "wb-2")).toBe(msgFor("en", "bracket.round.semi"));
    expect(nameOf(doc, "lb-1", 0)).toBe(t(en, "knockout.feederLoser", { round: railLabel(doc, "wb-2"), seq: 2 }));
    expect(nameOf(doc, "lb-1", 0)).toBe("Loser of Semi-finals, match\u00a02");
    // Each lane's feeds name the FEEDER's lane round: the winners' final a
    // loser drops from, the losers' round a winner climbs out of, and so on up.
    // Each of those rounds holds ONE match, so the sentence drops its number
    // (N1 fix round 1, M2).
    expect(nameOf(doc, "lb-f", 0)).toBe(t(en, "knockout.feederLoserOnly", { round: railLabel(doc, "wb-f") }));
    expect(nameOf(doc, "lb-f", 1)).toBe(t(en, "knockout.feederWinnerOnly", { round: railLabel(doc, "lb-1") }));
    expect(nameOf(doc, "gf", 1)).toBe(t(en, "knockout.feederWinnerOnly", { round: railLabel(doc, "lb-f") }));
    expect(codes(doc)).toEqual([]);
  });

  it("a feeder round of ONE match drops the number — the reset reads 'Winner of Grand final' — while a round of two keeps ', match N' (M2)", async () => {
    // A 4-entrant double elimination with a reset, numbered exactly as
    // `bracketToGen` numbers it for k = 2 winners' rounds: WB 1-2, the losers'
    // lane offset by k (5-6), the grand final offset by 2k (9) and its
    // conditional reset after it (10). Wired as `generateDoubleElim` wires it:
    // LB 1 takes both WB round-one losers, LB 2 the LB 1 winner and the winners'
    // final loser, the grand final both lane champions, the reset both of its
    // players.
    const de: PublicStage = { ...STAGE, id: "de", seq: 1, kind: "double_elim", name: "Double" };
    const at = (
      id: string,
      round_no: number,
      seq_in_round: number,
      lane: "WB" | "LB" | "GF",
      over: Partial<PublicFixture> = {},
    ) => F({ id, stage_id: "de", round_no, seq_in_round, lane, ...over });
    const winner = (round: number, seq: number): Label => ({ key: "slot.winner_match", params: { round, seq } });
    const loser = (round: number, seq: number): Label => ({ key: "slot.loser_match", params: { round, seq } });
    const waiting = (home: Label, away: Label): Partial<PublicFixture> => ({
      home_entrant_id: null,
      away_entrant_id: null,
      home_slot_label: home,
      away_slot_label: away,
    });
    const doc = await load(
      [
        at("wb-1", 1, 1, "WB"),
        at("wb-2", 1, 2, "WB"),
        at("wb-f", 2, 1, "WB", waiting(winner(1, 1), winner(1, 2))),
        at("lb-1", 5, 1, "LB", waiting(loser(1, 1), loser(1, 2))),
        at("lb-f", 6, 1, "LB", waiting(winner(5, 1), loser(2, 1))),
        at("gf", 9, 1, "GF", { ...waiting(winner(2, 1), winner(6, 1)), is_final: true }),
        at("reset", 10, 1, "GF", { ...waiting(winner(9, 1), loser(9, 1)), is_final: true, conditional: true }),
      ],
      [de],
    );
    // The premise, off the rail: the round that feeds the reset is the grand
    // final, alone in its round; the round that feeds LB 1 holds two matches.
    expect(railLabel(doc, "gf")).toBe(msgFor("en", "bracket.round.grandFinal"));
    expect(doc.knockouts.flatMap((v) => v.rounds).find((r) => r.fixtureIds.includes("gf"))!.fixtureIds).toEqual(["gf"]);
    expect(doc.knockouts.flatMap((v) => v.rounds).find((r) => r.fixtureIds.includes("wb-1"))!.fixtureIds).toHaveLength(2);

    // One match in the feeder's round: no number.
    expect(nameOf(doc, "reset", 0)).toBe(t(en, "knockout.feederWinnerOnly", { round: railLabel(doc, "gf") }));
    expect(nameOf(doc, "reset", 1)).toBe(t(en, "knockout.feederLoserOnly", { round: railLabel(doc, "gf") }));
    expect(nameOf(doc, "reset", 0)).toBe("Winner of Grand final");
    expect(nameOf(doc, "reset", 1)).toBe("Loser of Grand final");
    expect(nameOf(doc, "gf", 0)).toBe(t(en, "knockout.feederWinnerOnly", { round: railLabel(doc, "wb-f") }));
    expect(nameOf(doc, "lb-f", 1)).toBe(t(en, "knockout.feederLoserOnly", { round: railLabel(doc, "wb-f") }));
    // Two matches in the feeder's round: the number stays.
    expect(nameOf(doc, "lb-1", 0)).toBe(t(en, "knockout.feederLoser", { round: railLabel(doc, "wb-1"), seq: 1 }));
    expect(nameOf(doc, "lb-1", 1)).toBe("Loser of Semi-finals, match\u00a02");
    expect(nameOf(doc, "wb-f", 1)).toBe(t(en, "knockout.feederWinner", { round: railLabel(doc, "wb-2"), seq: 2 }));
    expect(codes(doc)).toEqual([]);
  });

  it("a label whose round is not in the stage keeps today's text, never a sentence with a hole in it", async () => {
    const lostRound: Label = { key: "slot.winner_match", params: { round: 7, seq: 1 } };
    const lostSeq: Label = { key: "slot.loser_match", params: { round: 1, seq: 9 } };
    const fixtures = draw(4).map((f) =>
      f.id === "ko-r2-1" ? { ...f, home_slot_label: lostRound, away_slot_label: lostSeq } : f,
    );
    const doc = await load(fixtures);
    const today = (label: Label) => resolveSlotLabel(label, (k, v) => msgFor("en", k, v), "schedule.tbd");
    expect(nameOf(doc, "ko-r2-1", 0)).toBe(today(lostRound));
    expect(nameOf(doc, "ko-r2-1", 0)).toBe("Winner of R7·1");
    expect(nameOf(doc, "ko-r2-1", 1)).toBe(today(lostSeq));
  });

  it.each(["league first", "league last"])(
    "the feeder is found in the side's OWN stage (%s): a league's round 1 match 2 never names a knockout slot",
    async (order) => {
      const leagueRound = [
        F({ id: "lg-1", stage_id: "lg", round_no: 1, seq_in_round: 1 }),
        F({ id: "lg-2", stage_id: "lg", round_no: 1, seq_in_round: 2 }),
      ];
      const cupDraw = draw(4);
      const doc = await load(
        order === "league first" ? [...leagueRound, ...cupDraw] : [...cupDraw, ...leagueRound],
        [league, cup],
      );
      expect(railLabel(doc, "ko-r1-2")).toBe(msgFor("en", "bracket.round.semi"));
      expect(nameOf(doc, "ko-r2-1", 1)).toBe("Winner of Semi-finals, match\u00a02");
      expect(nameOf(doc, "ko-r2-1", 1)).not.toBe(
        t(en, "knockout.feederWinner", { round: msgFor("en", "bracket.round.plain", { n: 1 }), seq: 2 }),
      );
    },
  );

  it("the org's locale names the round: a French hub puts the French rail label in the French sentence", async () => {
    const doc = await load(draw(8), [cup], { ...ORG, default_locale: "fr" });
    expect(doc.locale).toBe("fr");
    expect(railLabel(doc, "ko-r1-2")).toBe(msgFor("fr", "bracket.round.quarter"));
    expect(nameOf(doc, "ko-r2-1", 1)).toBe(t(fr, "knockout.feederWinner", { round: railLabel(doc, "ko-r1-2"), seq: 2 }));
    expect(nameOf(doc, "ko-r2-1", 1)).not.toBe(
      t(en, "knockout.feederWinner", { round: railLabel(doc, "ko-r1-2"), seq: 2 }),
    );
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

  it("W2a: a chess tie-break's recorded score reaches the hub's result line (spec §5.5)", async () => {
    const tiebreak = F({
      id: "fx-tiebreak",
      status: "decided",
      round_no: 1,
      home_entrant_id: "e1",
      away_entrant_id: "e2",
      scheduled_at: "2026-09-03T14:00:00.000Z",
      outcome: { kind: "win", winner: "e2", loser: "e1", method: "tiebreak_rapid" },
      summary: {
        perSide: [
          { entrantId: "e1", line: "½" },
          { entrantId: "e2", line: "½" },
        ],
        detail: { tiebreak: { rung: "rapid", score: "1½–½" } },
      },
    });
    getPublicDivisionMock.mockResolvedValue(divisionDetail({ fixtures: [tiebreak], standings: [] }));
    const doc = (await loadCompetitionHub("riverside", "autumn-cup", NOW))!;
    const match = doc.matches.find((m) => m.fixtureId === "fx-tiebreak")!;
    expect(match.resultLine).toBe("Red Rockets won on rapid tie-break (1½–½)");
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

    // THE RESET NOBODY OWES (Task 2 fix round 1, ruling 2). The winners'
    // champion took the first grand final, so the title is settled — and the
    // reset row reads `scheduled` for ever, because nothing in production voids
    // it. Left on the rail it is the one "unfinished" round of a finished
    // bracket, a Grand final (reset) chip nobody will ever play. It leaves the
    // ROUNDS only; its match stays in the document, where a fixture in no round
    // is valid.
    it("an UNOWED reset still `scheduled` leaves the rail — the rounds end at the first grand final, and its match stays in the document", async () => {
      const doc = await load({
        stages: [de],
        fixtures: bracket(WINNERS_SIDE_WON, { status: "scheduled" }),
        standings: [],
      });
      const view = doc.knockouts[0]!;
      expect(view.championFixtureId).toBe("gf");
      expect(view.rounds.map((r) => r.key)).toEqual(["WB-1", "WB-2", "LB-1", "LB-2", "GF-3"]);
      expect(doc.matches.map((m) => m.fixtureId)).toContain("gf-reset");
    });

    it("an OWED reset stays on the rail — no champion yet, and it is the round still to play", async () => {
      const view = await deView(LOSERS_SIDE_WON, { status: "scheduled" });
      expect(view.championFixtureId).toBeNull();
      expect(view.rounds.map((r) => r.key)).toEqual(["WB-1", "WB-2", "LB-1", "LB-2", "GF-3", "GF-4"]);
    });

    it("a reset that CROWNED stays on the rail — it is the round the title was won in", async () => {
      const view = await deView(LOSERS_SIDE_WON, { status: "decided", outcome: win("e1", "e2") });
      expect(view.championFixtureId).toBe("gf-reset");
      expect(view.rounds.at(-1)!.key).toBe("GF-4");
    });

    it("only an UNSETTLED reset leaves: a settled one with no winner stays beside a first-grand-final crown", async () => {
      // The one shape that separates "not settled" from "not the champion":
      // settled, so it stays, yet it crowned nobody.
      const view = await deView(WINNERS_SIDE_WON, { status: "decided", outcome: { kind: "no_result" } });
      expect(view.championFixtureId).toBe("gf");
      expect(view.rounds.at(-1)!.key).toBe("GF-4");
    });

    it("an unowed reset that has STARTED stays on the rail while it is live — the tab's live rung must be able to open on it", async () => {
      // Task 2 fix round 2. Nobody owed it, but somebody is playing it: a
      // round dropped while `in_play` is a live match the spectator cannot
      // reach from the rail, and the tab opens on a live round first.
      const doc = await load({
        stages: [de],
        fixtures: bracket(WINNERS_SIDE_WON, { status: "in_play" }),
        standings: [],
      });
      const view = doc.knockouts[0]!;
      expect(view.championFixtureId).toBe("gf"); // the premise: still crowned off the first grand final
      expect(doc.matches.find((m) => m.fixtureId === "gf-reset")?.bucket).toBe("live");
      expect(view.rounds.map((r) => r.key)).toEqual(["WB-1", "WB-2", "LB-1", "LB-2", "GF-3", "GF-4"]);
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

    it("the forfeited final's hub match is what the Knockout banner reads a walkover off — completed, with a winner, and the forfeited status line", async () => {
      // The producer half of the banner's walkover sentence (Task 2 fix round
      // 1, ruling 7): `knockout-tab.tsx` keys on this exact status line, so it
      // is witnessed here on the REAL builder rather than only on a fixture.
      const doc = await load({
        stages: [cup],
        fixtures: eight({ status: "forfeited", outcome: forfeit("e2", "e1") }),
        standings: [],
      });
      const final = doc.matches.find((m) => m.fixtureId === doc.knockouts[0]!.championFixtureId)!;
      expect(final.fixtureId).toBe("ko-f");
      expect(final.bucket).toBe("completed");
      expect(final.winnerIndex).toBe(1);
      expect(final.header.statusLine?.key).toBe("matchCentre.status.forfeited");
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

// ---------------------------------------------------------------------------
// Standings qualification status (spec 2026-09-22, plan Task 6) — through the
// hub's REAL call site (AGENTS.md #1, the inert seam), never `buildTableView`
// or `buildQualificationView` directly: the stage's V414 meta, the division's
// fixtures and entrant statuses, the PINNED module's bounds and forfeit-score
// declaration, the cascade and the org's locale all have to reach the builder
// from `loadCompetitionHub` for these tables to carry a status.
//
// Mutants killed (Task 6): the call site deleted (`qualification` omitted) →
// both cut tests; `awardAddsToLedger` hard-wired false, or read off the
// LATEST module instead of the division's pinned one → the pinned-version
// what-if; `poolId` null, or one pool's id given to the other → the
// two-pool group (fix round 1).
// ---------------------------------------------------------------------------
describe("loadCompetitionHub — standings qualification status (spec 2026-09-22)", () => {
  const E4: PublicEntrant = { ...ENTRANTS[2]!, id: "e4", display_name: "Gold Gulls", seed: 4 };
  const CUT_STAGE: PublicStage = { ...STAGE, qualify_count: 2, next_stage_name: "Finals" };
  // A football version the registry still serves to a division pinned to it,
  // from before the sport declared a forfeit score: its config parses WITHOUT
  // `awardScore`. Registered once in the shared registry the hub resolves
  // through; it is not the latest, so nothing else in this file reaches it.
  const OLD_FOOTBALL = "0.0.1";
  const latestFootball = resolveLatestModule("football");
  try {
    registry.get("football", OLD_FOOTBALL);
  } catch {
    registry.register({
      ...latestFootball,
      version: OLD_FOOTBALL,
      configSchema: latestFootball.configSchema.transform((cfg: Record<string, unknown>) =>
        Object.fromEntries(Object.entries(cfg).filter(([key]) => key !== "awardScore")),
      ),
    } as unknown as AnySportModule);
  }

  /** A football league of four (the builder suite's `open4`): r1 e1>e4,
   *  e3>e2; r2 e1>e3, and e4 FORFEITS to e2 (a walkover); r3 e1–e2 and e3–e4
   *  to play. Points e1 6, e2 3, e3 3, e4 0; cut 2. The walkover's 3–0 is
   *  inside e4's 6–8 and e2's 7–2. `moduleVersion` is the division's pin. */
  function scene(moduleVersion: string = latestFootball.version) {
    const g = (gf: number, ga: number): Record<string, number> => ({ gf, ga, gd: gf - ga });
    const r = (entrantId: string, rank: number, won: number, goals: [number, number]) => ({
      entrantId,
      played: 2,
      won,
      drawn: 0,
      lost: 2 - won,
      points: 3 * won,
      metrics: g(...goals),
      rank,
    });
    const win = (id: string, round: number, winner: string, loser: string) =>
      F({ id, status: "decided", round_no: round, home_entrant_id: winner, away_entrant_id: loser, outcome: { kind: "win", winner, loser } });
    const fixtures = [
      win("q1", 1, "e1", "e4"),
      win("q2", 1, "e3", "e2"),
      win("q3", 2, "e1", "e3"),
      F({ id: "q4", status: "forfeited", round_no: 2, home_entrant_id: "e2", away_entrant_id: "e4", outcome: { kind: "award", winner: "e2" } }),
      F({ id: "q5", status: "scheduled", round_no: 3, home_entrant_id: "e1", away_entrant_id: "e2" }),
      F({ id: "q6", status: "scheduled", round_no: 3, home_entrant_id: "e3", away_entrant_id: "e4" }),
    ];
    const standings: PublicStandings[] = [
      {
        stage_id: "st1",
        pool_id: null,
        updated_at: "2026-09-04T16:00:00.000Z",
        rows: [r("e1", 1, 2, [2, 0]), r("e2", 2, 1, [7, 2]), r("e3", 3, 1, [1, 1]), r("e4", 4, 0, [6, 8])],
      },
    ];
    // `divisions` on the shell drives the loop and `division` on the detail is
    // what the reader returned; the hub reads the SHELL's row for the module.
    const division: PublicDivision = { ...DIV, module_version: moduleVersion, tiebreakers: ["points", "diff", "for"] };
    getPublicCompetitionMock.mockResolvedValue({ org: ORG, competition: COMP, divisions: [division], liveNow: [] });
    getPublicDivisionMock.mockResolvedValue(
      divisionDetail({ division, stages: [CUT_STAGE], fixtures, standings, entrants: [...ENTRANTS, E4] }),
    );
  }

  it("empty case first: a stage with no cut publishes qualification null and a null qual on every row", async () => {
    // The default division detail (STAGE: V414 gave no cut).
    const doc = (await loadCompetitionHub("riverside", "autumn-cup", NOW))!;
    expect(doc.tables).toHaveLength(1);
    expect(doc.tables[0]!.qualification).toBeNull();
    expect(doc.tables[0]!.rows.map((r) => r.qual)).toEqual([null, null]);
    // …and the same league WITH a cut does carry one (its positive pair).
    scene();
    const cut = (await loadCompetitionHub("riverside", "autumn-cup", NOW))!;
    expect(cut.tables[0]!.qualification).not.toBeNull();
  });

  it("a cut table carries the cut line, the legend and each entrant's status, in the org's locale", async () => {
    scene();
    const doc = (await loadCompetitionHub("riverside", "autumn-cup", NOW))!;
    expect(CompetitionHubDoc.safeParse(doc).error?.issues ?? []).toEqual([]);
    const table = doc.tables[0]!;
    expect(table.qualification).toEqual({
      cutIndex: 2,
      label: "Top 2 go through to Finals · 1 round left",
      legend: { through: "Through", open: "Still open", out: "Out", hint: "Tap a rank for details." },
    });
    const byId = Object.fromEntries(table.rows.map((r) => [r.entrantId, r.qual]));
    expect(byId.e1).toMatchObject({
      status: "win_k",
      label: "Win and in",
      ariaLabel: "Rank 1, Win and in, show details",
      headline: "Win your next match and you're through to Finals.",
    });
    expect(byId.e4).toMatchObject({
      status: "needs_help",
      label: "Needs help",
      ifYouLose: "If you lose your next match, you're out.",
    });
    // Every row of this table has a status — none is keyed to the wrong row.
    expect(table.rows.map((r) => [r.entrantId, r.qual?.status])).toEqual([
      ["e1", "win_k"],
      ["e2", "needs_help"],
      ["e3", "needs_help"],
      ["e4", "needs_help"],
    ]);
  });

  it("the average match reads the division's PINNED module version, not the latest: football's forfeit score counts only where the pin declares one", async () => {
    // Premise: the two versions differ exactly in the forfeit score.
    expect(latestFootball.configSchema.parse(DIV.config)).toMatchObject({ awardScore: { goals: 3 } });
    expect(registry.get("football", OLD_FOOTBALL).configSchema.parse(DIV.config)).not.toHaveProperty("awardScore");
    // e4 is −2 over 14 goals and its rival e2 is +5, so a win by 8 draws it
    // level on goal difference. The latest football writes its forfeit score
    // into the ledger, so those 14 goals are TWO matches' — an average of 7,
    // no single match holds a win by 8: the rule and today's values.
    scene();
    const latest = (await loadCompetitionHub("riverside", "autumn-cup", NOW))!.tables[0]!;
    const e4 = latest.rows.find((r) => r.entrantId === "e4")!.qual!;
    expect(e4.whatIf).toBe(
      "If you finish level on points with Red Rockets, goal difference decides. Now: you -2, Red Rockets +5.",
    );
    expect(e4.whatIfAssumption).toBeNull();
    // Its pair: the SAME division pinned to the old version — same sport key,
    // same config. That walkover scored nothing, the 14 goals are one match's,
    // and the target stands.
    scene(OLD_FOOTBALL);
    const pinned = (await loadCompetitionHub("riverside", "autumn-cup", NOW))!.tables[0]!;
    const p4 = pinned.rows.find((r) => r.entrantId === "e4")!.qual!;
    expect(p4.whatIf).toBe(
      "If you finish level on points with Red Rockets, goal difference decides: win your next match by 8 or more to finish ahead.",
    );
    expect(p4.whatIfAssumption).toBe(
      "Assumes Red Rockets's figures stay the same and your next match is an average one.",
    );
  });

  it("a group stage with a per-group cut: each pool's table carries ITS OWN pool's statuses and cut line", async () => {
    // Two pools of three, one through from each (`qualify_per_group`).
    //  Pool A: r1 e1>e2; r2 e1–e3, r3 e2–e3 to play. Still open for all three
    //   (e3 has two left and can reach any total), and a loss puts only e2 out.
    //  Pool B: r1 e4>e5, r2 e4>e6; r3 e5–e6 to play. e4 is out of reach.
    // The two pools differ in every line a swap would move: the rounds left
    // on the cut line, and the statuses. `poolId` wrong either way (null, or
    // the other pool's) reads another pool's fixtures, and the table goes
    // blank — never the right pool's line.
    const E5: PublicEntrant = { ...ENTRANTS[2]!, id: "e5", display_name: "Silver Swans", seed: 5 };
    const E6: PublicEntrant = { ...ENTRANTS[2]!, id: "e6", display_name: "Bronze Bears", seed: 6 };
    const GROUP: PublicStage = { ...STAGE, kind: "group", qualify_count: 1, qualify_per_group: true, next_stage_name: "Finals" };
    const pools = [
      { id: "pA", stage_id: "st1", key: "A", name: "Pool A" },
      { id: "pB", stage_id: "st1", key: "B", name: "Pool B" },
    ];
    const played = (id: string, pool: string, round: number, winner: string, loser: string) =>
      F({ id, pool_id: pool, status: "decided", round_no: round, home_entrant_id: winner, away_entrant_id: loser, outcome: { kind: "win", winner, loser } });
    const toPlay = (id: string, pool: string, round: number, home: string, away: string) =>
      F({ id, pool_id: pool, status: "scheduled", round_no: round, home_entrant_id: home, away_entrant_id: away });
    const fixtures = [
      played("a1", "pA", 1, "e1", "e2"),
      toPlay("a2", "pA", 2, "e1", "e3"),
      toPlay("a3", "pA", 3, "e2", "e3"),
      played("b1", "pB", 1, "e4", "e5"),
      played("b2", "pB", 2, "e4", "e6"),
      toPlay("b3", "pB", 3, "e5", "e6"),
    ];
    const r = (entrantId: string, rank: number, won: number, playedCount: number) => ({
      entrantId,
      played: playedCount,
      won,
      drawn: 0,
      lost: playedCount - won,
      points: 3 * won,
      metrics: { gf: won, ga: playedCount - won, gd: 2 * won - playedCount },
      rank,
    });
    const snap = (pool: string, rows: ReturnType<typeof r>[]): PublicStandings => ({
      stage_id: "st1",
      pool_id: pool,
      updated_at: "2026-09-04T16:00:00.000Z",
      rows,
    });
    // Pool B's snapshot first: the hub orders tables by pool id, not by input.
    const standings = [
      snap("pB", [r("e4", 1, 2, 2), r("e5", 2, 0, 1), r("e6", 3, 0, 1)]),
      snap("pA", [r("e1", 1, 1, 1), r("e2", 2, 0, 1), r("e3", 3, 0, 0)]),
    ];
    getPublicDivisionMock.mockResolvedValue(
      divisionDetail({ stages: [GROUP], pools, fixtures, standings, entrants: [...ENTRANTS, E4, E5, E6] }),
    );
    const doc = (await loadCompetitionHub("riverside", "autumn-cup", NOW))!;
    expect(CompetitionHubDoc.safeParse(doc).error?.issues ?? []).toEqual([]);
    expect(doc.tables.map((t) => t.id)).toEqual(["open-st1-pA", "open-st1-pB"]);
    const [a, b] = doc.tables as [(typeof doc.tables)[0], (typeof doc.tables)[0]];

    expect(a.qualification).toMatchObject({ cutIndex: 1, label: "First place goes through to Finals · 2 rounds left" });
    expect(a.rows.map((x) => [x.entrantId, x.qual?.label ?? null, x.qual?.ifYouLose ?? null])).toEqual([
      ["e1", "Needs help", "If you lose your next match, you'll need other results to go your way."],
      ["e2", "Needs help", "If you lose your next match, you're out."],
      ["e3", "Needs help", "If you lose your next match, you'll need other results to go your way."],
    ]);

    expect(b.qualification).toMatchObject({ cutIndex: 1, label: "First place goes through to Finals · 1 round left" });
    expect(b.rows.map((x) => [x.entrantId, x.qual?.label ?? null, x.qual?.ifYouLose ?? null])).toEqual([
      ["e4", "Through", null],
      ["e5", "Out", null],
      ["e6", "Out", null],
    ]);
  });
});

describe("getPublicCompetitionHub — the ISR cache's key and tags", () => {
  it("keys on the competition id and tags the org, the competition and its division", async () => {
    const doc = await getPublicCompetitionHub("riverside", "autumn-cup");
    expect(doc).not.toBeNull();
    expect(cacheCalls).toHaveLength(1);
    // v2 since the Knockout tab (plan R4): the page renders this cached
    // document WITHOUT re-parsing it, so a v1 entry — which has no
    // `knockouts` — must never be served to a renderer that reads one. v4
    // since standings qualification status (a v3 table has no
    // `qualification` and its rows no `qual`). v5 since per-stage format
    // lines (a v4 division has no `stageFormatLines`, and the page would show
    // no stage format for up to a revalidate window after a deploy).
    expect(cacheCalls[0]!.keyParts).toEqual(["pub-hub-v5", "comp-1"]);
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
