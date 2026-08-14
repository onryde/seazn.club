// What the auto pass now TELLS the organiser, pinned row for row.
//
// Before the solver wave this pass reported only what the placer could not fit —
// `no_slot`, `start_window`, a pinned collision — plus the typed-rule referee.
// It now also carries the FULL verifier's rows, because `buildSchedule` and
// `reflowExisting` each run `validateAssignments` over the board they produce.
// Rest and overlap rows the auto pass has never emitted can therefore appear.
//
// The widening is WANTED: a board that breaches a rule should say so on the
// surface the organiser builds it from. But it has a sharp edge that is worth a
// test of its own. REFLOW is the DEFAULT mode, and when the repair solver cannot
// improve on the incumbent it hands the organiser's ORIGINAL board back and
// verifies THAT — so a board they have been living with quite happily can
// suddenly come back carrying rows they have never been shown.
//
// This file pins the exact set on exactly that shape, so a later change to the
// verifier cannot quietly alter what organisers see. It asserts identity and
// blocking-ness, not merely a count: "two conflicts" would survive the two rows
// changing into completely different rules.
//
// The board is built so the outcome needs no search and cannot flake: both
// offending cards are PINNED, so the repair solver may not move either, the
// proposal comes back untouched, and `settle` verifies the whole thing.
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures } from "../stages";
import { applySchedule, autoSchedule, putScheduleSettings } from "../schedule";
import { patchFixture } from "../fixtures";

const HAS_DB = !!process.env.DATABASE_URL;
const T0 = "2026-08-01T09:00:00.000Z";
const MIN = 60_000;
const at = (minutes: number) =>
  new Date(Date.parse(T0) + minutes * MIN).toISOString();

const DIVISION_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

/** 4 entrants -> 6 league fixtures, 2 courts, 30-minute matches, 30 minutes'
 *  rest owed between an entrant's matches (so a pair needs 60 minutes apart). */
async function seed(): Promise<{ auth: AuthCtx; stageId: string }> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Org " + suffix}, ${"org-" + suffix})
    returning id`;
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'Generic', '1.0.0', ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('generic', 'score', 'Score', ${sql.json(DIVISION_CONFIG)}, true)
    on conflict do nothing`;
  for (const feature of ["scheduling.constraints", "scheduling.board"]) {
    await sql`
      insert into org_entitlement_overrides (org_id, feature_key, bool_value)
      values (${orgId}, ${feature}, true)
      on conflict (org_id, feature_key) do update set bool_value = true`;
  }
  const auth: AuthCtx = {
    orgId,
    via: "session",
    userId: null,
    role: "owner",
    keyId: null,
  };
  const competition = await createCompetition(auth, {
    // #376: an end date is mandatory — a competition with no end can never
    // cross the pass line, so the schema requires one.
    ends_on: "2030-12-31",
    name: "Widen " + suffix,
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(auth, competition.id, {
    name: "Open",
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    eligibility: [],
  });
  await createEntrants(
    auth,
    division.id,
    Array.from({ length: 4 }, (_, i) => ({
      kind: "individual" as const,
      display_name: `E${i + 1}`,
      seed: i + 1,
      members: [],
    })),
  );
  const [stage] = await createStages(auth, division.id, {
    seq: 1,
    kind: "league",
    name: "L",
    config: {},
  });
  await putScheduleSettings(auth, division.id, {
    config: {
      startAt: T0,
      matchMinutes: 30,
      gapMinutes: 0,
      courts: ["C1", "C2"],
      perEntrantMinRest: 30,
      blackouts: [],
      sessionWindows: [],
    },
    tz: "UTC",
  });
  await generateStageFixtures(auth, stage.id);
  return { auth, stageId: stage.id };
}

describe.skipIf(!HAS_DB)(
  "reflow reports the FULL verifier's rows over the board it returns",
  () => {
    it("names exactly the rest breach on a pinned, unrepairable board", async () => {
      const { auth, stageId } = await seed();

      const rows = await sql<
        { id: string; home_entrant_id: string; away_entrant_id: string; round_no: number }[]
      >`select id, home_entrant_id, away_entrant_id, round_no
      from fixtures where stage_id = ${stageId} order by id`;
      expect(rows).toHaveLength(6);

      // Two cards that share an entrant, 30 minutes apart under a 30-minute rest
      // rule: they need 60. Rest is warn-only at the write gate, which is the only
      // reason a board can reach this state at all.
      //
      // Chosen as ROUND 1 and ROUND 2 specifically (C1, 2026-08-12 round-order
      // design fix-loop finding 1's determinism fix), the same reasoning the
      // court-clash test below uses: a round-robin entrant plays AT MOST once
      // per round, so any entrant-sharing pair is guaranteed two DIFFERENT
      // rounds, but an ARBITRARY such pair could be rounds 1-and-3 — leaving
      // the untouched round 2 with nowhere consistent to sit relative to both
      // (round order tolerates ties, not gaps). Rounds 1-and-2 leaves round 3
      // as the board's own maximum, so parking every `others` fixture
      // chronologically LAST (round-ascending among themselves) is always
      // safe regardless of what rounds 1/2 are doing. In a 4-entrant round
      // robin every entrant plays every round, so round 1's fixture
      // containing a given entrant and round 2's fixture containing that SAME
      // entrant always both exist.
      const byRound = new Map<number, (typeof rows)[number][]>();
      for (const r of rows) {
        (byRound.get(r.round_no) ?? byRound.set(r.round_no, []).get(r.round_no)!).push(r);
      }
      const round1 = byRound.get(1)!;
      const round2 = byRound.get(2)!;
      const pivotEntrant = round1[0]!.home_entrant_id;
      const first = round1.find(
        (r) => r.home_entrant_id === pivotEntrant || r.away_entrant_id === pivotEntrant,
      )!;
      const clashing = round2.find(
        (r) => r.home_entrant_id === pivotEntrant || r.away_entrant_id === pivotEntrant,
      )!;
      // The other 4 fixtures cannot just be parked "later than the pivot
      // pair": with exactly 4 entrants there are only 3 distinct perfect
      // matchings (K4), so round 1's OTHER fixture necessarily shares one
      // entrant with `clashing` (round 2's pivot fixture) AND a DIFFERENT
      // entrant with round 2's OTHER fixture — and the same cross-sharing
      // repeats between round 2 and round 3. Dumping every non-pivot fixture
      // chronologically after `clashing` (as an earlier version of this test
      // did) put round 1's other fixture AFTER a round 2 fixture, which is
      // itself a round-order violation the (now round-order-aware) write
      // gate correctly refuses to create — that was this test's failure.
      // These offsets are the minimum-margin, round_no-keyed placement that
      // keeps every OTHER entrant's pair of same-round-gap matches >= the
      // 60-minute rest floor, while leaving exactly the pivot pair (30
      // minutes apart) as the board's one deliberate breach:
      //   round 1 other: -60  (must clear BOTH round 2 fixtures by >= 60)
      //   first (pivot):   0
      //   clashing (pivot): 30
      //   round 2 other:   60  (must clear round 1's other fixture by >= 60)
      //   round 3 (both): 150  (must clear both round 2 fixtures by >= 60)
      const round1Other = round1.find((r) => r.id !== first.id)!;
      const round2Other = round2.find((r) => r.id !== clashing.id)!;
      const round3 = byRound.get(3)!;
      await applySchedule(auth, stageId, {
        assignments: [
          { fixture_id: round1Other.id, scheduled_at: at(-60), court_label: "C2" },
          { fixture_id: first.id, scheduled_at: at(0), court_label: "C1" },
          { fixture_id: clashing.id, scheduled_at: at(30), court_label: "C2" },
          { fixture_id: round2Other.id, scheduled_at: at(60), court_label: "C1" },
          { fixture_id: round3[0]!.id, scheduled_at: at(150), court_label: "C1" },
          { fixture_id: round3[1]!.id, scheduled_at: at(150), court_label: "C2" },
        ],
        source: "manual",
      });

      // Pinned, so the repair solver may not move either and the incumbent board
      // is what comes back — no search, no flake.
      for (const f of [first, clashing])
        await patchFixture(auth, f.id, { schedule_locked: true });

      const out = await autoSchedule(auth, stageId, {
        only_unlocked: true,
        mode: "reflow",
      });

      // The board is returned unchanged...
      expect(out.assignments).toHaveLength(6);
      expect(
        out.assignments.find((a) => a.fixture_id === first.id)?.scheduled_at,
      ).toBe(at(0));
      expect(
        out.assignments.find((a) => a.fixture_id === clashing.id)?.scheduled_at,
      ).toBe(at(30));

      // ...and this is the EXACT set of rows the organiser is now shown, WHOLE
      // objects rather than a count or a subset of fields. A count would survive
      // these two turning into two entirely different rules; dropping `rule` would
      // survive the token an organiser's repair prompt cites changing underneath
      // it. Both are the drift this file exists to catch.
      //
      // These are `warn.rest` rows, and the pass they came from NEVER EMITTED
      // THEM before this wave — that is the widening, stated as a value.
      const shared = [first.home_entrant_id, first.away_entrant_id].find((e) =>
        [clashing.home_entrant_id, clashing.away_entrant_id].includes(e),
      )!;
      const byId = (a: { fixture_id: string }, b: { fixture_id: string }) =>
        a.fixture_id.localeCompare(b.fixture_id);
      // `detail` is stripped before the `toEqual` (C3, 2026-08-13): it is still
      // populated — same legacy English, proven by the dedicated legacy-parity
      // suite — but this test's job is the WIRE SHAPE, not the prose.
      // Snake_case (`entrant_ids`) — `ScheduleConflict`'s house style, unlike
      // the engine's own camelCase `ConflictDetail`.
      const stripDetail = <T extends { detail?: string }>({ detail: _detail, ...rest }: T) => rest;
      const expected = [first.id, clashing.id]
        .map((id) => ({
          fixture_id: id,
          code: "warn.rest",
          rule: "H4",
          blocking: false,
          details: { kind: "entrant_below_rest" as const, entrant_ids: [shared] },
        }))
        .sort(byId);
      expect([...out.conflicts].sort(byId).map(stripDetail)).toEqual(expected);
    }, 120_000);

    /**
     * FINDING 1's OWN regression test (C1, 2026-08-12 round-order design
     * fix-loop): a board where the ONLY thing wrong is round order, pinned
     * against a card the repair solver cannot move. `rest`/`court`/etc. are
     * real `RepairFamily` members the repair solver can legitimately RELAX
     * and report honestly (see the test above, and the court-clash test
     * below, both now kept clean of incidental round noise for exactly this
     * reason) — round order is not one of them at all (the design doc's own
     * "out of scope" ruling), so it can NEVER appear in a relaxed family, and
     * a board dirty ONLY by round order forces `solveRepair`'s
     * "moved.length === 0 && relaxed.length === 0" branch: z3 finds a model
     * satisfying every family it knows about, with nothing moved, while the
     * REAL verifier still rejects the board — the `RepairVerificationError`
     * "encoding_drift" shape.
     *
     * Only ONE card is locked, not every card — `solveRepair`'s own
     * pre-existing-conflict check is scoped to the proposal (the UNLOCKED
     * fixtures) and never looks at conflicts between two LOCKED cards, so
     * "lock everything" makes the proposal empty and the check trivially
     * clean, which is the opposite of what this test needs (see the inline
     * comment at the lock site below).
     *
     * Before the fix this reached the organiser as an unhandled exception —
     * `apps/web/src/server/api-v1/http.ts`'s generic catch-all turned it into
     * an opaque `{ok:false, code:"INTERNAL"}` at HTTP 500. `reflowExisting` now
     * catches it and degrades exactly the way `buildSchedule` already degrades
     * its own solver/verifier disagreement: the untouched board comes back
     * with `engine:"greedy"`, `status:"verifier_rejected"`, and the real,
     * already-computed conflict — never a 500.
     */
    it("degrades gracefully when round order is the only thing a pinned board violates", async () => {
      const { auth, stageId } = await seed();

      const rows = await sql<{ id: string; round_no: number }[]>`
        select id, round_no from fixtures where stage_id = ${stageId} order by round_no, id`;
      expect(rows).toHaveLength(6);
      const byRound = new Map<number, (typeof rows)[number][]>();
      for (const r of rows) {
        (byRound.get(r.round_no) ?? byRound.set(r.round_no, []).get(r.round_no)!).push(r);
      }
      // One fixture per round (3 rounds), each on its own court/well-separated
      // entrant set so NEITHER rest NOR court NOR person-overlap has anything
      // to say — round order is the only rule in play, and the pair set is
      // full (C1's own ruling): round 1 vs round 3 is checked directly, not
      // only the adjacent round 1-vs-2 / 2-vs-3 pairs.
      const round1 = byRound.get(1)![0]!;
      const round2 = byRound.get(2)![0]!;
      const round3 = byRound.get(3)![0]!;
      // The OTHER 3 fixtures must also be scheduled — left unscheduled, z3's
      // repair pass legitimately places them (nothing else is movable),
      // which counts as "moved" and silently defeats the very condition
      // (`moved.length === 0`) this test exists to trigger. Mirrors each
      // pivot's own time on the other court: round 1's sibling has no
      // shared entrant with round 1's own fixture (a round is a perfect
      // matching), so tying the time is rest-safe, and K4's cross-round
      // sharing (see the rest-breach test's comment) is satisfied too since
      // every gap between differently-timed rounds here is 120 minutes,
      // double the 60-minute floor.
      const round1Other = byRound.get(1)!.find((r) => r.id !== round1.id)!;
      const round2Other = byRound.get(2)!.find((r) => r.id !== round2.id)!;
      const round3Other = byRound.get(3)!.find((r) => r.id !== round3.id)!;
      // Round order violated between EVERY pair: 3 (latest) first, 1 (earliest)
      // last, all same day, all different courts/times so nothing else fires.
      //
      // Written straight to the table, not through `applySchedule`: the
      // (now round-order-aware) write gate would refuse to CREATE this board
      // in the first place — matching the court-clash test above, which hits
      // the identical trap for the identical reason (refusing to create a
      // disordered board is not the same as never having to read one).
      for (const [f, minutes, court] of [
        [round3, 0, "C1"],
        [round2, 120, "C1"],
        [round1, 240, "C1"],
        [round3Other, 0, "C2"],
        [round2Other, 120, "C2"],
        [round1Other, 240, "C2"],
      ] as const) {
        await sql`
          update fixtures set scheduled_at = ${at(minutes)}, court_label = ${court}
          where id = ${f.id}`;
      }
      // ONLY round 1 is locked. This is deliberate, not a weaker stand-in for
      // "pin every card": `solveRepair`'s own pre-existing-conflict check
      // (`repair.ts`'s `pre = validateAssignments(proposal, ...)`) is scoped
      // to the PROPOSAL — the UNLOCKED fixtures — and never looks at
      // conflicts BETWEEN two locked cards at all. Lock all 6 (tried first)
      // and `proposal` is empty, `pre` is trivially empty, and the throw
      // this test exists to prove can never fire. Locking just round 1 keeps
      // round 2 and round 3 in the proposal, so the round-order breach
      // against the one immovable anchor — and against each other — is
      // exactly what `pre` is computed over. z3 still has no reason to MOVE
      // either (round order is invisible to it, and nothing it does track is
      // wrong at their current slots), so `moved` and `relaxed` both come
      // back empty regardless.
      await patchFixture(auth, round1.id, { schedule_locked: true });

      const out = await autoSchedule(auth, stageId, {
        only_unlocked: true,
        mode: "reflow",
      });

      // Untouched — no exception reached the caller, and nothing moved.
      expect(out.assignments).toHaveLength(6);
      expect(
        out.assignments.find((a) => a.fixture_id === round3.id)?.scheduled_at,
      ).toBe(at(0));
      expect(
        out.assignments.find((a) => a.fixture_id === round1.id)?.scheduled_at,
      ).toBe(at(240));

      // The graceful fallback, by name — mirrors `buildSchedule`'s own
      // `BuildStatus.verifier_rejected` ("the encoder and validateAssignments
      // disagreed... the greedy seed is returned and the disagreement is
      // logged"), the same status this file's other two tests never see
      // because their own violations ARE relaxable.
      expect(out.solver.engine).toBe("greedy");
      expect(out.solver.status).toBe("verifier_rejected");

      // And the real conflict rides along — both directly-adjacent pairs, at
      // minimum, each blaming the LATER round for starting first (mirrors
      // feed-order blaming the dependent side, not the feeder).
      expect(out.conflicts).toContainEqual(
        expect.objectContaining({ fixture_id: round3.id, code: "warn.order", rule: "H6", blocking: true }),
      );
      expect(out.conflicts).toContainEqual(
        expect.objectContaining({ fixture_id: round2.id, code: "warn.order", rule: "H6", blocking: true }),
      );
      expect(out.conflicts.every((c) => c.code === "warn.order")).toBe(true);
    }, 120_000);

    /**
     * THE SHARP EDGE, and the reason the widening needed a ruling at all.
     *
     * The case above is warn-level, which is uncomfortable but harmless. This one
     * is BLOCKING: a board carrying a court double-booking, handed back unchanged
     * by a reflow that cannot move either offender, now comes back red — on a
     * surface that has never shown the organiser a red row for it before.
     *
     * Boards like this exist. `court` became blocking in #399 over boards that
     * were published while it was a warning, which is the entire reason the WRITE
     * gate is a delta rather than an absolute test. So the two cards are written
     * straight to the table rather than through `applySchedule`: the apply gate
     * would refuse to CREATE this board, and refusing to create one is not the
     * same as never having to read one.
     */
    it("names exactly the blocking court clash on a board it hands back unchanged", async () => {
      const { auth, stageId } = await seed();

      const rows = await sql<
        { id: string; home_entrant_id: string; away_entrant_id: string; round_no: number }[]
      >`select id, home_entrant_id, away_entrant_id, round_no
      from fixtures where stage_id = ${stageId} order by id`;
      // The pair is CHOSEN, not taken as rows[0]/rows[1] — and, since C1
      // (2026-08-12 round-order design fix-loop finding 1's determinism fix),
      // chosen as ROUND 1 and ROUND 2 specifically, not merely "some pair that
      // shares an entrant". Two reasons, both about keeping this board's ONLY
      // violation the court clash it is about:
      //
      //   * a round-robin entrant plays AT MOST once per round, so ANY pair
      //     sharing an entrant is guaranteed to be two DIFFERENT rounds — but
      //     an arbitrary such pair could be rounds 1-and-3, and `others` would
      //     then have to include round 2's fixtures sitting BETWEEN two
      //     rounds this test pins to the SAME instant, which is
      //     unsatisfiable for `others` to place without itself becoming a
      //     round-order violation (round order tolerates ties, not gaps).
      //   * round 1 and round 2 specifically means the untouched THIRD round
      //     (round 3) is the board's own maximum, so parking it — and round
      //     2's own other fixture — chronologically LAST is always safe
      //     regardless of what round 1/2 are doing.
      //
      // In a 4-entrant round robin every entrant plays every round, so round
      // 1's fixture containing a given entrant and round 2's fixture
      // containing that SAME entrant always both exist.
      const byRound = new Map<number, (typeof rows)[number][]>();
      for (const r of rows) {
        (byRound.get(r.round_no) ?? byRound.set(r.round_no, []).get(r.round_no)!).push(r);
      }
      const round1 = byRound.get(1)!;
      const round2 = byRound.get(2)!;
      const round3 = byRound.get(3)!;
      const pivotEntrant = round1[0]!.home_entrant_id;
      const a = round1.find(
        (r) => r.home_entrant_id === pivotEntrant || r.away_entrant_id === pivotEntrant,
      )!;
      const b = round2.find(
        (r) => r.home_entrant_id === pivotEntrant || r.away_entrant_id === pivotEntrant,
      )!;
      const shared = pivotEntrant;
      const aOther = round1.find((r) => r.id !== a.id)!;
      const bOther = round2.find((r) => r.id !== b.id)!;
      // Same round_no-keyed placement as the rest-breach test above (see its
      // comment: K4's 3-matching structure forces round 1's other fixture to
      // share an entrant with BOTH round 2 fixtures, so it cannot simply be
      // parked "later than the clash"). Here the pivot pair ties at the SAME
      // instant (0 apart, not 30) since the deliberate violation is the court
      // double-booking, not rest — round order tolerates ties, so `a`/`b`
      // sitting together is not itself a violation.
      await sql`
        update fixtures set scheduled_at = ${at(-60)}, court_label = 'C2'
        where id = ${aOther.id}`;
      await sql`
        update fixtures set scheduled_at = ${at(60)}, court_label = 'C1'
        where id = ${bOther.id}`;
      await sql`
        update fixtures set scheduled_at = ${at(150)}, court_label = 'C1'
        where id = ${round3[0]!.id}`;
      await sql`
        update fixtures set scheduled_at = ${at(150)}, court_label = 'C2'
        where id = ${round3[1]!.id}`;

      // Two cards stacked on ONE court at ONE time — physically impossible, and
      // `assertNoNewBlocking` would refuse to write it, so it goes in directly.
      await sql`
      update fixtures set scheduled_at = ${at(0)}, court_label = 'C1'
      where id in ${sql([a.id, b.id])}`;
      // Pinned, so the repair solver may not resolve the clash and the incumbent
      // board is what comes back.
      for (const f of [a, b])
        await patchFixture(auth, f.id, { schedule_locked: true });

      const out = await autoSchedule(auth, stageId, {
        only_unlocked: true,
        mode: "reflow",
      });

      // Handed back unchanged...
      expect(
        out.assignments.find((x) => x.fixture_id === a.id)?.scheduled_at,
      ).toBe(at(0));
      expect(
        out.assignments.find((x) => x.fixture_id === b.id)?.scheduled_at,
      ).toBe(at(0));

      // ...and reported as BLOCKING — the exact set, all FOUR rows. Two families
      // fire, not one: the cards collide on the court AND put the same human on
      // two courts at once, and both are blocking. This is what an organiser now
      // sees in red on a board they had been living with, and it is the behaviour
      // we deliberately chose to keep rather than narrow.
      //
      // Note `warn.person_overlap` carries `blocking: true`. The code's prefix and
      // its blocking-ness genuinely disagree in `REASON_CODE`; that predates this
      // work, and pinning it here is how a later tidy-up gets noticed rather than
      // silently changing what the board shows.
      const key = (x: { fixture_id: string; code: string }) =>
        `${x.fixture_id}|${x.code}`;
      const byKey = (x: { fixture_id: string; code: string }, y: typeof x) =>
        key(x).localeCompare(key(y));
      // `detail` is stripped before the `toEqual` (C3, 2026-08-13) — see the
      // identical comment on the `entrant_below_rest` case above in this file.
      const stripDetail = <T extends { detail?: string }>({ detail: _detail, ...rest }: T) => rest;
      const expected = [
        [a.id, b.id],
        [b.id, a.id],
      ]
        .flatMap(([self, other]) => [
          {
            fixture_id: self!,
            code: "conflict.court",
            rule: "H2",
            blocking: true,
            details: { kind: "court_double_booking" as const, court: "C1", other_fixture_id: other! },
          },
          {
            fixture_id: self!,
            code: "warn.person_overlap",
            rule: "H4",
            blocking: true,
            details: { kind: "entrant_overlap" as const, entrant_ids: [shared], other_fixture_id: other! },
          },
        ])
        .sort(byKey);
      expect([...out.conflicts].sort(byKey).map(stripDetail)).toEqual(expected);
    }, 120_000);
  },
);
