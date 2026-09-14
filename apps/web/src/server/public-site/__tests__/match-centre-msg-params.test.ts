// M1 k1 — the CLASS behind "Starts {time}".
//
// The live rain-delay test found an upcoming match's court card reading the
// LITERAL text "Starts {time}": `buildMatchCentre` emitted
// `matchCentre.status.startsAt` with `params: { when }` while all four
// dictionaries wrote the placeholder `{time}`, so `t()` left the brace in
// place and printed it to the spectator (`lib/i18n-runtime.ts:24` —
// `interpolate` substitutes only the keys the caller supplied and returns
// `{k}` verbatim for every other one).
//
// Why no existing gate saw it. `match-centre-dictionary.test.ts` already
// asserts (a) every derived key EXISTS in all four locales and (b) every
// locale's template names the same `{param}` set AS ENGLISH. Both were green:
// en/es/fr/nl all said `{time}`, consistently. Nothing anywhere compared a
// dictionary template against the params the BUILDER actually passes it —
// which is the only comparison that can see this defect, and is what this
// file adds.
//
// Derivation, never a typed list (same ruling as the dictionary gate): the
// keys and params come from real `buildMatchCentre` output over a matrix of
// statuses, sports and outcomes, deep-walked for every `Msg` in the document;
// the templates come from the four real `public.json` dictionaries, merged
// over English exactly the way `getDictionary` merges them at runtime.
//
// The two directions, both asserted per locale:
//   A. UNRENDERED PLACEHOLDER — `t(dict, key, params)` still contains a
//      `{brace}`. This is literally what the spectator saw.
//   B. UNUSED PARAM — the builder passes a param the template never names, so
//      a fact the builder took the trouble to compute is silently dropped.
//
// Mutants killed — see `m1-report.md` for the raw runs.
import { describe, expect, it } from "vitest";
import type { EventEnvelope } from "@seazn/engine/core";
import { makeEnvelope } from "@seazn/engine/testkit";
import { cricket } from "@seazn/engine/sports/cricket";
import { football, FootballCfg } from "@seazn/engine/sports/football";
import { tennis } from "@seazn/engine/sports/tennis";
import { RESULT_KINDS, buildMatchCentre, type MatchCentreInput } from "../match-centre";
import type { PublicFixture } from "../data";
import type { PublicPerson } from "../public-lineups";
import type { MatchCentreDocT, MsgT, SideT } from "../match-centre-schema";
import { LOCALES, type Dict } from "@/lib/i18n-constants";
import { lookup, t } from "@/lib/i18n-runtime";
import enPublic from "@/dictionaries/en/public.json";
import esPublic from "@/dictionaries/es/public.json";
import frPublic from "@/dictionaries/fr/public.json";
import nlPublic from "@/dictionaries/nl/public.json";
import { AWAY, HOME, SUPER_OVER_SCRIPT, TIE_NO_SUPER_OVER, scriptLedger, type Script, type ScriptLedger } from "./cricket-ledger";

// --------------------------------------------------------------- dictionaries

// `getDictionary` (lib/i18n.ts:85) serves `{ ...en, ...other }` — a locale
// that is missing a key renders the English one — so a gate that read the
// bare locale file would judge a template this surface never shows.
const RAW: Record<string, Record<string, unknown>> = { en: enPublic, es: esPublic, fr: frPublic, nl: nlPublic };
const DICTS: Record<string, Dict> = Object.fromEntries(
  LOCALES.map((l) => [l, { ...enPublic, ...(RAW[l] ?? {}) } as Dict]),
);

/** The SAME pattern `interpolate` substitutes on (`lib/i18n-runtime.ts:24`).
 *  Anything still matching it after `t()` has run is a brace the reader sees. */
const PLACEHOLDER = /\{(\w+)\}/g;

const placeholdersOf = (template: string): string[] =>
  [...new Set([...template.matchAll(PLACEHOLDER)].map((m) => m[1]!))].sort();

// ------------------------------------------------- the uniform-param shape
//
// Direction B below would otherwise red on a DELIBERATE builder contract: some
// key families are handed a FIXED param shape, with the members a branch has
// no value for filled in as `""` (`dismissalMsg`'s own doc block — "Every
// branch supplies ALL of `bowler`/`fielder`/`assist` (empty string when
// absent)" — and `ballLines`' `batter: ""`). That is defensive, not sloppy:
// `t()` prints an unsupplied `{brace}` verbatim, so a translator who adds
// `{fielder}` to `dismissal.bowled` would otherwise ship the k1 defect again.
//
// An `""` param is therefore exempt with no entry here: an empty string can
// carry nothing a template could have rendered. A NON-EMPTY param the
// templates ignore is a fact the builder computed and every locale drops —
// the shape `matchCentre.chase.need` had before M1 (it passed the balls
// remaining to a template that says only "{side} need {runs} to win", while
// its own translated sibling `matchCentre.chase.needFrom` names `{balls}` in
// all four locales). Those are defects, so each survivor needs a written
// reason here, and `no dead allowance entries` below fails if one stops being
// hit — the list cannot quietly outlive what it excuses.
const UNNAMED_PARAM_ALLOWANCE: { key: RegExp; param: string; why: string }[] = [
  {
    key: /^matchCentre\.dismissal\.runout$/,
    param: "assist",
    why: "`dismissalMsg` COMPOSES the assist into `{fielder}` ('Jones/Smith', the way a scorebook prints it) — the template does render it, under the other name",
  },
  {
    key: /^matchCentre\.result\.(super_over|boundary_count)$/,
    param: "margin",
    why: "`resultMsg` passes one shape to the whole result family; a method-only sentence ('won on the super over') has no room for a margin, and regulation/dls/innings do render `{margin}`",
  },
  {
    key: /^matchCentre\.ballLine\.wicket$/,
    param: "runs",
    why: "`ballLines` pins `runs` to 0 on a wicket ball and the wicket line prints the word, not the number; every other ballLine template renders `{runs}`",
  },
];

const isUniformShapeFiller = (key: string, param: string, value: string | number): boolean =>
  value === "" || UNNAMED_PARAM_ALLOWANCE.some((a) => a.param === param && a.key.test(key));

// --------------------------------------------------------------- fixtures

const F = (over: Partial<PublicFixture>): PublicFixture => ({
  id: "fx1",
  division_id: "d1",
  stage_id: "s1",
  pool_id: null,
  round_no: 1,
  seq_in_round: 1,
  home_entrant_id: "home",
  away_entrant_id: "away",
  home_slot_label: null,
  away_slot_label: null,
  scheduled_at: "2026-09-25T09:00:00.000Z",
  venue: null,
  court_label: null,
  venue_name: "Central Park",
  court_name: "Court 1",
  status: "scheduled",
  outcome: null,
  summary: null,
  last_seq: null,
  ...over,
});

const HOME_SIDE: SideT = { entrantId: "home", name: "Home Blazers", short: "HOM", colour: null, badgeUrl: null };
const AWAY_SIDE: SideT = { entrantId: "away", name: "Southend Queens", short: "SEQ", colour: null, badgeUrl: null };
const SIDES: [SideT, SideT] = [HOME_SIDE, AWAY_SIDE];

function lineupsFrom(homeIds: readonly string[], awayIds: readonly string[]): Record<string, PublicPerson[]> {
  const person = (id: string): PublicPerson => ({
    personId: id,
    name: `Player ${id.toUpperCase()}`,
    masked: false,
    slot: "starting",
  });
  return { home: homeIds.map(person), away: awayIds.map(person) };
}

function input(over: Partial<MatchCentreInput> = {}): MatchCentreInput {
  return {
    fixture: F({}),
    sportKey: "cricket",
    cfg: cricket.configSchema.parse({}),
    events: [],
    lineups: lineupsFrom(HOME, AWAY),
    sides: SIDES,
    venueTz: "Europe/London",
    locale: "en",
    now: new Date("2026-09-25T10:00:00.000Z"),
    hrefs: { division: "/d/1", competition: "/c/1", calendar: null },
    stage: { name: "Group A", roundLabel: "Round 1" },
    moduleVersion: null,
    formatLabel: "8-over match",
    ...over,
  };
}

function decidedFixture(ledger: ScriptLedger, extra: Partial<PublicFixture> = {}): PublicFixture {
  return F({
    status: "decided",
    outcome: ledger.state.outcome as PublicFixture["outcome"],
    summary: cricket.summary(ledger.state),
    ...extra,
  });
}

// ----------------------------------------------------------------- scripts

/** One innings that is dismissed EVERY way the engine's `Delivery` union can
 *  express, so the `matchCentre.dismissal.*` family arrives through the real
 *  fold rather than by hand-building a dismissal detail per kind. The last
 *  batter is left unbeaten, which is the family's `not_out` member. */
const EVERY_DISMISSAL_SCRIPT: Script = {
  cfg: { ballsPerInnings: 72, ballsPerOver: 6, playersPerSide: 11, minOversForResult: 1 },
  home: ["h1", "h2", "h3", "h4", "h5", "h6", "h7", "h8", "h9", "h10", "h11"],
  away: AWAY,
  tossWonBy: "away",
  elected: "bowl",
  innings: [
    {
      batting: "home",
      bowlers: ["a1", "a2", "a3", "a4"],
      deliveries: [
        { bat: 1 },
        { out: "bowled" },
        { out: "caught", fielder: "a5" },
        { out: "lbw" },
        { out: "runout", fielder: "a5", assist: "a6" },
        { out: "stumped", fielder: "a7" },
        { out: "hitwicket" },
        { out: "obstructed" },
        { out: "timedout" },
        { out: "hitballtwice" },
        { retire: true, reason: "out" },
      ],
      leaveOpen: true,
    },
  ],
};

/** A chase in progress: the "need N from M" sentence, a run rate line, a live
 *  block and an unbroken partnership — the in-play Msgs no closed innings has. */
const CHASE_SCRIPT: Script = {
  cfg: { ballsPerInnings: 12, ballsPerOver: 6, playersPerSide: 8, minOversForResult: 1 },
  home: HOME,
  away: AWAY,
  tossWonBy: "home",
  elected: "bat",
  innings: [
    {
      batting: "home",
      bowlers: ["a7", "a6"],
      deliveries: [{ bat: 6 }, { bat: 6 }, { bat: 6 }, { bat: 6 }, { bat: 6 }, { bat: 6 }, { bat: 6 }, { bat: 6 }, { bat: 0 }, { bat: 0 }, { bat: 0 }, { bat: 0 }],
    },
    {
      batting: "away",
      bowlers: ["h7"],
      deliveries: [{ bat: 1 }, { extra: "wide", runs: 1 }, { extra: "noball", runs: 1, bat: 2 }, { extra: "bye", runs: 2 }, { extra: "legbye", runs: 1 }, { extra: "penalty", runs: 5 }, { bat: 0 }],
      leaveOpen: true,
    },
  ],
};

const DECIDED_SCRIPT: Script = {
  cfg: { ballsPerInnings: 6, ballsPerOver: 6, playersPerSide: 8, minOversForResult: 1 },
  home: HOME,
  away: AWAY,
  tossWonBy: "home",
  elected: "bat",
  innings: [
    { batting: "home", bowlers: ["a7"], deliveries: [{ bat: 4 }, { bat: 4 }, { bat: 4 }, { bat: 4 }, { bat: 4 }, { bat: 4 }] },
    {
      batting: "away",
      bowlers: ["h1"],
      deliveries: [{ bat: 0 }, { out: "caught", fielder: "h2", bat: 0 }, { bat: 0 }, { bat: 0 }, { bat: 0 }, { bat: 0 }],
    },
  ],
};

// ------------------------------------------------------------- the documents

/**
 * Every document this gate walks, labelled so a failure names the case.
 *
 * Breadth is the point: a status the matrix does not reach is a status whose
 * Msgs nothing here compares. The floors asserted at the bottom of this file
 * are what stop the matrix quietly shrinking to nothing.
 */
function documents(): { label: string; doc: MatchCentreDocT }[] {
  const out: { label: string; doc: MatchCentreDocT }[] = [];
  const push = (label: string, over: Partial<MatchCentreInput>) =>
    out.push({ label, doc: buildMatchCentre(input(over)) });

  // --- scheduled, both ways a start time can be known
  push("cricket/scheduled+time", { fixture: F({ status: "scheduled" }) });
  push("cricket/scheduled+no-time", { fixture: F({ status: "scheduled", scheduled_at: null }) });

  // --- the `other` bucket: `matchCentre.status.<raw status>`
  for (const status of ["postponed", "abandoned", "walkover", "cancelled", "forfeited"]) {
    push(`cricket/${status}`, { fixture: F({ status }) });
  }

  // --- in play
  const chase = scriptLedger(CHASE_SCRIPT);
  push("cricket/in_play+chase", {
    events: chase.events,
    cfg: chase.cfg,
    fixture: F({ status: "in_play", summary: cricket.summary(chase.state) }),
  });

  const wickets = scriptLedger(EVERY_DISMISSAL_SCRIPT);
  push("cricket/in_play+every-dismissal", {
    events: wickets.events,
    cfg: wickets.cfg,
    lineups: lineupsFrom(EVERY_DISMISSAL_SCRIPT.home, AWAY),
    fixture: F({ status: "in_play", summary: cricket.summary(wickets.state) }),
  });

  // --- decided, once per outcome the engine can record. `RESULT_KINDS` is the
  //     builder's own exported vocabulary (engine WIN_METHODS + the non-win
  //     outcomes), so a new method moves this matrix with it.
  const decided = scriptLedger(DECIDED_SCRIPT);
  for (const kind of RESULT_KINDS) {
    const outcome = (["tie", "no_result", "draw"] as readonly string[]).includes(kind)
      ? { kind }
      : { kind: kind === "forfeit" ? "award" : "win", winner: "home", loser: "away", method: kind };
    push(`cricket/decided+${kind}`, {
      events: decided.events,
      cfg: decided.cfg,
      fixture: decidedFixture(decided, { outcome: outcome as PublicFixture["outcome"] }),
    });
  }

  // --- the two cricket endings with their own vocabulary
  const tie = scriptLedger(TIE_NO_SUPER_OVER);
  push("cricket/decided+tie-script", { events: tie.events, cfg: tie.cfg, fixture: decidedFixture(tie) });
  const superOver = scriptLedger(SUPER_OVER_SCRIPT);
  push("cricket/decided+super-over", { events: superOver.events, cfg: superOver.cfg, fixture: decidedFixture(superOver) });

  // --- a shootout: the margin comes off `summary.detail`, not a cricket card
  push("football/decided+shootout", {
    sportKey: "football",
    cfg: FootballCfg.parse({}),
    moduleVersion: football.version,
    lineups: lineupsFrom(["h1", "h2", "h3"], ["a1", "a2", "a3"]),
    events: [makeEnvelope(0, { type: "core.start", payload: {} })] as EventEnvelope[],
    fixture: F({
      status: "decided",
      outcome: { kind: "win", winner: "home", loser: "away", method: "shootout" } as PublicFixture["outcome"],
      summary: { detail: { shootout: { home: 3, away: 0 } } } as PublicFixture["summary"],
    }),
  });

  // --- the period sports: a timeline, a periods grid, `term.*` phase tokens
  push("football/in_play", {
    sportKey: "football",
    cfg: FootballCfg.parse({}),
    moduleVersion: football.version,
    lineups: lineupsFrom(["h1", "h2", "h3"], ["a1", "a2", "a3"]),
    events: [
      makeEnvelope(0, { type: "core.start", payload: {} }),
      makeEnvelope(1, { type: "football.goal", payload: { by: "home", scorer: "h1", minute: 12 } }),
      makeEnvelope(2, { type: "football.card", payload: { by: "away", player: "a1", card: "yellow", minute: 20 } }),
    ] as EventEnvelope[],
    fixture: F({ status: "in_play" }),
  });

  // --- a set sport: the sets grid and its own unit vocabulary
  push("tennis/in_play", {
    sportKey: "tennis",
    cfg: tennis.configSchema.parse({}),
    moduleVersion: tennis.version,
    lineups: lineupsFrom(["h1"], ["a1"]),
    events: [makeEnvelope(0, { type: "core.start", payload: {} })] as EventEnvelope[],
    fixture: F({ status: "in_play" }),
  });

  return out;
}

// ----------------------------------------------------------------- the walk

/** Is `v` a `Msg` (`match-centre-schema.ts:9`)? A string `key`, an optional
 *  `params` record, and NOTHING else — the document holds no other object
 *  with a `key` field, so this shape test cannot pick up a bystander. */
function isMsg(v: unknown): v is MsgT {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const keys = Object.keys(v);
  if (!keys.every((k) => k === "key" || k === "params")) return false;
  const o = v as { key?: unknown; params?: unknown };
  if (typeof o.key !== "string") return false;
  if (o.params === undefined) return true;
  return typeof o.params === "object" && o.params !== null && !Array.isArray(o.params);
}

interface Found {
  label: string;
  path: string;
  msg: MsgT;
}

function walk(label: string, path: string, node: unknown, out: Found[]): void {
  if (node === null || typeof node !== "object") return;
  if (isMsg(node)) {
    out.push({ label, path, msg: node });
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((v, i) => walk(label, `${path}[${i}]`, v, out));
    return;
  }
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    walk(label, `${path}.${k}`, v, out);
  }
}

const EMITTED: Found[] = (() => {
  const out: Found[] = [];
  for (const { label, doc } of documents()) walk(label, "doc", doc, out);
  return out;
})();

// -------------------------------------------------------------------- tests

describe("every Msg the match centre emits renders with no leftover brace, in every locale", () => {
  it("the matrix actually produced documents with Msgs to check", () => {
    // Floors, not decoration: this file's entire verdict is "nothing in
    // EMITTED is broken", which an empty EMITTED satisfies perfectly. A
    // builder change that stopped emitting, or a walk that stopped finding,
    // would otherwise read as a clean bill of health.
    const distinctKeys = new Set(EMITTED.map((f) => f.msg.key));
    const withParams = EMITTED.filter((f) => f.msg.params && Object.keys(f.msg.params).length > 0);
    expect(EMITTED.length).toBeGreaterThanOrEqual(150);
    expect(distinctKeys.size).toBeGreaterThanOrEqual(30);
    expect(withParams.length).toBeGreaterThanOrEqual(40);
    // …and the families whose params are the risk are all represented, so a
    // matrix that lost a whole status/sport cannot pass on the others' volume.
    const prefixes = new Set([...distinctKeys].map((k) => k.split(".").slice(0, 2).join(".")));
    for (const family of [
      "matchCentre.status",
      "matchCentre.result",
      "matchCentre.dismissal",
      "matchCentre.info",
      // `matchCentre.ballLine`, NOT `matchCentre.ball` — the latter is the
      // glyph-label family, which no renderer reads (`ballLines`' own comment
      // in match-centre.ts records the collision the two once had).
      "matchCentre.ballLine",
      "matchCentre.chase",
      "timeline.football",
    ]) {
      expect([...prefixes], `family ${family} is reached by the matrix`).toContain(family);
    }
  });

  it("no dead allowance entries — every excused (key, param) pair is still emitted, and still unnamed in English", () => {
    // An allowance that nothing hits any more is an exemption with no subject:
    // it can only mask the next stray param that happens to share the name.
    const dead = UNNAMED_PARAM_ALLOWANCE.filter(
      (a) =>
        !EMITTED.some(({ msg }) => {
          if (!a.key.test(msg.key)) return false;
          const value = msg.params?.[a.param];
          if (value === undefined || value === "") return false;
          const template = lookup(DICTS.en!, msg.key);
          return typeof template === "string" && !placeholdersOf(template).includes(a.param);
        }),
    ).map((a) => `${a.key.source} / ${a.param}`);
    expect(dead).toEqual([]);
  });

  it("every emitted key exists in English — a missing key renders as the dotted key itself", () => {
    // `t()` returns the KEY on a miss, which contains no brace and would
    // therefore sail through the render check below.
    const missing = [
      ...new Set(
        EMITTED.filter((f) => typeof lookup(DICTS.en!, f.msg.key) !== "string").map(
          (f) => `${f.msg.key} (${f.label} ${f.path})`,
        ),
      ),
    ];
    expect(missing).toEqual([]);
  });

  for (const locale of LOCALES) {
    it(`${locale}: no emitted Msg renders a leftover {placeholder}`, () => {
      const dict = DICTS[locale]!;
      const unrendered = new Set<string>();
      for (const { label, path, msg } of EMITTED) {
        const rendered = t(dict, msg.key, msg.params);
        const left = [...rendered.matchAll(PLACEHOLDER)].map((m) => m[1]!);
        if (left.length > 0) {
          unrendered.add(`${msg.key} → "${rendered}" (missing params: ${left.join(",")}; ${label} ${path})`);
        }
      }
      // This is the exact string the spectator read on the court card:
      // `matchCentre.status.startsAt → "Starts {time}"`.
      expect([...unrendered].sort()).toEqual([]);
    });

    it(`${locale}: no emitted Msg carries a param NO locale's template names`, () => {
      const dict = DICTS[locale]!;
      const unused = new Set<string>();
      for (const { label, path, msg } of EMITTED) {
        const template = lookup(dict, msg.key);
        if (typeof template !== "string") continue; // reported by the existence test
        const named = new Set(placeholdersOf(template));
        const passed = Object.keys(msg.params ?? {});
        const strays = passed.filter(
          (p) => !named.has(p) && !isUniformShapeFiller(msg.key, p, msg.params![p]!),
        );
        if (strays.length > 0) {
          unused.add(`${msg.key} — template "${template}" never names ${strays.join(",")} (${label} ${path})`);
        }
      }
      expect([...unused].sort()).toEqual([]);
    });
  }
});

