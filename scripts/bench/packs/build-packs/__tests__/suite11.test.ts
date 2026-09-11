// B06b — the suite 11 builder's gate.
//
// Modelled on `_tiny.test.ts`: a generator, a committed output, and a test
// that fails when the two disagree. The strongest case here is the stage-0
// one — it folds all 205 streams through the real engine and compares each
// against the pack's own expected outcome, which is what caught both encoding
// bugs this pack shipped with in draft (an unsigilled payload ref, and a
// walkover method the product cannot express).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PackSchema } from "../../../lib/pack-schema.ts";
import { validatePack } from "../../../lib/validate-pack.ts";
import { buildSuite11, entrantRef, personRef } from "../suite11.ts";

const committed = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../suite11.json", import.meta.url)), "utf8"),
) as ReturnType<typeof buildSuite11>;

type Stream = NonNullable<ReturnType<typeof buildSuite11>["streams"]>[number];
type Event = Stream["events"][number];

const scorePayload = (e: Event): { by?: string; points?: number; person?: string } =>
  (e.payload ?? {}) as { by?: string; points?: number; person?: string };

const streamsOf = (divisionRef: string): Stream[] =>
  (committed.streams ?? []).filter((s) => s.divisionRef === divisionRef);

const scoresOf = (s: Stream): Event[] => s.events.filter((e) => e.type === "generic.score");

describe("suite11 builder", () => {
  it("reproduces the committed pack exactly", () => {
    expect(buildSuite11()).toEqual(committed);
  });

  it("is deterministic across two calls", () => {
    expect(buildSuite11()).toEqual(buildSuite11());
  });

  it("the committed pack is PackSchema-valid", () => {
    const parsed = PackSchema.safeParse(committed);
    if (!parsed.success) throw new Error(JSON.stringify(parsed.error.issues.slice(0, 5), null, 2));
    expect(parsed.success).toBe(true);
  });
});

describe("suite11 — stage 0, the whole pack folded offline", () => {
  const result = validatePack(committed, { expectedSuite: "suite11" });

  it("folds every stream to its own expected outcome", () => {
    const errors = result.findings.filter((f) => f.severity === "error");
    // Name them: a bare `toHaveLength(0)` on a red run says nothing about
    // which of 205 streams disagreed.
    expect(errors.map((f) => `${f.code} @ ${f.where}`)).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("carries only the four by-design warnings", () => {
    // Leaderboards, champions, finalRanks and careers are NOT derived offline
    // — `_PACK-PLAYBOOK.md` says so, and a runner must gate on `ok` rather
    // than on "any finding". If this list ever shrinks to empty, something
    // started deriving them and the gate above became weaker than it reads.
    expect(result.findings.map((f) => f.code).sort()).toEqual([
      "careers.not_derived",
      "champions.not_derived",
      "finalRanks.not_derived",
      "leaderboards.not_derived",
    ]);
  });

  it("is 100% real provenance, with nothing reconstructed", () => {
    expect(result.provenance.overall).toEqual({ real: 205, reconstructed: 0, synthetic: 0, total: 205 });
  });
});

describe("suite11 — Div A encoding (sets)", () => {
  it("encodes one generic.score per set and settles from the tally", () => {
    const final = streamsOf("d-worlds").find((s) => s.fixtureExtKey === "se-r6-i0");
    if (final === undefined) throw new Error("no Div A final stream");
    expect(final.provenance).toBe("real");
    const scores = scoresOf(final);
    // Littler 7-3 van Gerwen: ten sets, one event each.
    expect(scores).toHaveLength(10);
    expect(scores.filter((e) => scorePayload(e).by === `@${entrantRef("a", "Luke Littler")}`)).toHaveLength(7);
    const settle = final.events.filter((e) => e.type === "generic.result");
    expect(settle).toHaveLength(1);
    // EMPTY. `applyResult` (generic.ts:110-114) settles from the running
    // tally when no scores are given. Carrying p1Score/p2Score would hand the
    // engine the answer and make expected.matches compare the pack to itself.
    expect(settle[0].payload ?? {}).toEqual({});
  });

  it("emits sets in real play order, not as a block of wins", () => {
    const final = streamsOf("d-worlds").find((s) => s.fixtureExtKey === "se-r6-i0");
    if (final === undefined) throw new Error("no Div A final stream");
    const littler = `@${entrantRef("a", "Luke Littler")}`;
    const order = scoresOf(final).map((e) => (scorePayload(e).by === littler ? "L" : "V"));
    // The real final: Littler took the first four sets, van Gerwen the fifth.
    // A builder that collapsed the order would still fold to 7-3, which is
    // exactly why no downstream check could see it.
    expect(order.slice(0, 5).join("")).toBe("LLLLV");
    expect(order.filter((x) => x === "L")).toHaveLength(7);
  });

  it("sigils every payload ref and leaves structural refs bare", () => {
    for (const s of committed.streams ?? []) {
      expect(s.home.startsWith("@"), `${s.fixtureExtKey} home`).toBe(false);
      expect(s.away.startsWith("@"), `${s.fixtureExtKey} away`).toBe(false);
      for (const e of scoresOf(s)) {
        const p = scorePayload(e);
        // A BARE payload ref parses cleanly — PackSchema treats an unsigilled
        // string as a literal — and then folds against an entrant the engine
        // has never heard of. This is the cheap guard for that.
        expect(p.by?.startsWith("@"), `${s.fixtureExtKey} by`).toBe(true);
        expect(p.person?.startsWith("@"), `${s.fixtureExtKey} person`).toBe(true);
        expect(p.points).toBe(1);
      }
    }
  });

  it("the walkover is one administrative set, recorded as an adaptation", () => {
    const wo = streamsOf("d-worlds").find((s) => s.fixtureExtKey === "se-r0-i19");
    if (wo === undefined) throw new Error("no walkover stream");
    expect(scoresOf(wo)).toHaveLength(1);
    expect(scorePayload(scoresOf(wo)[0]).by).toBe(`@${entrantRef("a", "Ian White")}`);
    const expected = (committed.expected.matches ?? []).find((m) => m.fixtureExtKey === "se-r0-i19");
    // "regulation", not "walkover": stage 0 refuses the latter because the
    // product cannot express it. The adaptation carries the reason.
    expect(expected?.outcome).toMatchObject({ kind: "win", method: "regulation" });
    expect((committed.meta.adaptations ?? []).some((a) => /Ian White/.test(a.what))).toBe(true);
  });
});

describe("suite11 — Div B encoding (legs)", () => {
  it("encodes one generic.score per LEG", () => {
    const final = streamsOf("d-womens").find((s) => s.fixtureExtKey === "se-r6-i0");
    if (final === undefined) throw new Error("no Div B final stream");
    const scores = scoresOf(final);
    // Sherrock 5-4 Greaves: nine legs.
    expect(scores).toHaveLength(9);
    expect(scores.filter((e) => scorePayload(e).by === `@${entrantRef("b", "Fallon Sherrock")}`)).toHaveLength(5);
  });

  it("the 17 byes carry no stream at all", () => {
    // A bye is a round-0 fixture the PRODUCT creates with an award and
    // auto-decides (bracket.ts:184-186, which omits the away side entirely
    // rather than nulling it). There is no event to fold.
    expect(streamsOf("d-womens")).toHaveLength(110);
    const slotOrder = committed.divisions[1].stages[0].config?.slotOrder as (number | null)[];
    expect(slotOrder.filter((s) => s === null)).toHaveLength(17);
  });
});

describe("suite11 — the draw", () => {
  const draws = [
    { division: "d-worlds", index: 0, entrants: 96, byes: 32 },
    { division: "d-womens", index: 1, entrants: 111, byes: 17 },
  ];

  for (const d of draws) {
    it(`${d.division} pins a legal 128-slot slotOrder`, () => {
      const slotOrder = committed.divisions[d.index].stages[0].config?.slotOrder as (number | null)[];
      expect(slotOrder).toHaveLength(128);
      const real = slotOrder.filter((s): s is number => s !== null);
      // bracket.ts:137-141 refuses anything but each seed 1..n exactly once.
      expect(real).toHaveLength(d.entrants);
      expect(new Set(real).size).toBe(d.entrants);
      expect(Math.min(...real)).toBe(1);
      expect(Math.max(...real)).toBe(d.entrants);
      expect(slotOrder.filter((s) => s === null)).toHaveLength(d.byes);
      // bracket.ts:147-150 refuses a pairing of two byes.
      for (let i = 0; i < slotOrder.length; i += 2) {
        expect(slotOrder[i] === null && slotOrder[i + 1] === null, `pair ${i / 2}`).toBe(false);
      }
    });
  }

  it("uses slotOrder and never byes, in both divisions", () => {
    // `byeEntrants` would hand the pairings to the product (bracket.ts:120-122
    // reorders and falls back to seedPositions), pairing players who never met
    // while the pack still asserted the real results. The two cannot be
    // combined anyway (bracket.ts:130).
    for (const division of committed.divisions) {
      expect(division.stages[0].config?.byes).toBeUndefined();
      expect(division.stages[0].config?.slotOrder).toBeDefined();
    }
  });

  it("every entrant carries a distinct seed, so the draw is ours not the product's", () => {
    for (const [divisionRef, count] of [["d-worlds", 96], ["d-womens", 111]] as const) {
      const seeds = committed.entrants.filter((e) => e.divisionRef === divisionRef).map((e) => e.seed);
      expect(seeds).toHaveLength(count);
      expect(seeds.every((s) => typeof s === "number")).toBe(true);
      expect(new Set(seeds).size).toBe(count);
    }
    // The real PDC seedings survive inside the renumbering.
    const humphries = committed.entrants.find((e) => e.ref === entrantRef("a", "Luke Humphries"));
    expect(humphries?.seed).toBe(1);
  });

  it("emits streams in DEPENDENCY order, never the datasets' own order", () => {
    // Div A's dataset is CHRONOLOGICAL and the real tournament played a
    // second-round match on opening night, so the dataset's order interleaves
    // rounds. Folded in that order concurrently, every later round is refused
    // `WRONG_PHASE — fixture has an unassigned entrant`.
    for (const divisionRef of ["d-worlds", "d-womens"]) {
      const rounds = streamsOf(divisionRef).map((s) => Number(/^se-r(\d+)/.exec(s.fixtureExtKey)![1]));
      expect([...rounds].sort((a, b) => a - b), divisionRef).toEqual(rounds);
    }
    // The positive pair: the interleaving really is present in the source, or
    // the monotonic assertion above passes for the wrong reason.
    // `expected.matches` is still built by walking the dataset, so it is that
    // chronological order — and the real tournament played a second-round
    // match on opening night, so it is NOT round-monotonic.
    const asAuthored = (committed.expected.matches ?? [])
      .filter((m) => m.divisionRef === "d-worlds")
      .map((m) => Number(/^se-r(\d+)/.exec(m.fixtureExtKey)![1]));
    expect([...asAuthored].sort((a, b) => a - b)).not.toEqual(asAuthored);
    // Specifically: a round-1 fixture appears before the last round-0 one.
    expect(asAuthored.indexOf(1)).toBeLessThan(asAuthored.lastIndexOf(0));
  });

  it("mints no fixture keys of its own — every key is the product's se-r{r}-i{i}", () => {
    const keys = (committed.streams ?? []).map((s) => `${s.divisionRef}/${s.fixtureExtKey}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const s of committed.streams ?? []) {
      expect(s.fixtureExtKey, `${s.divisionRef}`).toMatch(/^se-r[0-6]-i\d+$/);
    }
    // 128 slots ⇒ round r holds 2^(6-r) fixtures. Both finals are se-r6-i0.
    expect((committed.streams ?? []).filter((s) => s.fixtureExtKey === "se-r6-i0")).toHaveLength(2);
  });
});

describe("suite11 — people", () => {
  it("one person, two entrants, two divisions", () => {
    const sherrock = personRef("Fallon Sherrock");
    const hers = committed.entrants.filter((e) => (e.roster ?? []).some((r) => r.person === sherrock));
    expect(hers.map((e) => e.divisionRef).sort()).toEqual(["d-womens", "d-worlds"]);
    expect((committed.persons ?? []).filter((p) => p.ref === sherrock)).toHaveLength(1);
  });

  it("every entrant's roster names a declared person", () => {
    const known = new Set((committed.persons ?? []).map((p) => p.ref));
    for (const e of committed.entrants) {
      expect(e.roster ?? [], `${e.ref} roster`).toHaveLength(1);
      expect(known.has((e.roster ?? [])[0].person), `${e.ref}`).toBe(true);
    }
    // 96 + 111 entrants over 205 persons: exactly the two shared players.
    expect(committed.entrants).toHaveLength(207);
    expect(committed.persons ?? []).toHaveLength(205);
  });

  it("mints three claim invites on unroutable addresses", () => {
    expect(committed.claimInvites ?? []).toHaveLength(3);
    for (const inv of committed.claimInvites ?? []) {
      // RFC 2606 reserves `.invalid`, so nothing the bench sends can reach a
      // real inbox.
      expect(inv.email.endsWith("@bench.invalid")).toBe(true);
    }
  });
});

describe("suite11 — the constraint scenario", () => {
  it("Div A is ONE court with two sessions a day", () => {
    const ally = (committed.venues ?? []).find((v) => v.ref === "v-ally-pally");
    if (ally === undefined) throw new Error("no Ally Pally venue");
    expect(ally.courts).toHaveLength(1);
    const byWeekday = new Map<number, number>();
    for (const h of ally.courts[0].hours ?? []) byWeekday.set(h.weekday, (byWeekday.get(h.weekday) ?? 0) + 1);
    expect([...byWeekday.keys()].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    for (const [weekday, count] of byWeekday) expect(count, `weekday ${weekday}`).toBe(2);
    // NOT sessionWindows: that field is venue-wide with no court key
    // (api-v1/schemas.ts:1633-1636) and cannot say "this court, twice a day".
    expect((committed.divisions[0].scheduleConfig ?? {}).sessionWindows).toBeUndefined();
  });

  it("the Christmas break is closed-date exceptions", () => {
    const stage = (committed.venues ?? [])[0].courts[0];
    const closed = (stage.exceptions ?? []).filter((e) => e.closed).map((e) => e.date).sort();
    expect(closed).toEqual(["2024-12-24", "2024-12-25", "2024-12-26", "2024-12-31"]);
    for (const e of stage.exceptions ?? []) {
      // PackCourtException's refine: a closed exception must OMIT both bounds.
      expect(e.openMin).toBeUndefined();
      expect(e.closeMin).toBeUndefined();
    }
  });

  it("Div B is the real 16 boards", () => {
    const robin = (committed.venues ?? []).find((v) => v.ref === "v-robin-park");
    expect(robin?.courts).toHaveLength(16);
    expect((committed.divisions[1].scheduleConfig?.courts as string[])).toHaveLength(16);
    // One playing day — a Saturday, derived from the event date.
    for (const c of robin?.courts ?? []) expect((c.hours ?? []).map((h) => h.weekday)).toEqual([6]);
  });

  it("caps fixtures per entrant per day at what the history actually did", () => {
    const hard = (committed.divisions[0].scheduleConfig?.constraints as { hard: { type: string; count: number }[] }).hard;
    const cap = hard.find((h) => h.type === "max_fixtures_per_day");
    // Two, not one: the 2025 draw really does put a player through two matches
    // in an evening (Thibault Tricole, opening night), so a hand-typed 1 would
    // refuse the real timetable.
    expect(cap?.count).toBe(2);
  });
});

describe("suite11 — the historical timetable", () => {
  const rowsOf = (divisionRef: string) =>
    (committed.historicalAssignment ?? []).filter((h) => h.divisionRef === divisionRef);

  it("covers every played match in both divisions", () => {
    expect(rowsOf("d-worlds")).toHaveLength(95);
    expect(rowsOf("d-womens")).toHaveLength(110);
  });

  it("never double-books the Ally Pally stage", () => {
    // Two fixtures sharing a start on one court would make the certificate
    // report the REAL timetable as infeasible — a false red that reads
    // exactly like a product bug.
    const seen = new Set<string>();
    for (const h of rowsOf("d-worlds")) {
      const key = `${h.venue}/${h.court}@${h.startsAt}`;
      expect(seen.has(key), `double-booked ${key}`).toBe(false);
      seen.add(key);
    }
  });

  it("carries Div B's one real board overlap verbatim", () => {
    // Three DartConnect feeds agree on both boards, so it is a fact about the
    // event. A certificate that reports this history as clean is broken —
    // which makes suite 11 the first genuine exercise of that check, since
    // `certify` has returned SKIPPED_NO_HISTORY on every run to date.
    const byCourt = new Map<string, { startsAt: string; endsAt?: string }[]>();
    for (const h of rowsOf("d-womens")) {
      byCourt.set(h.court as string, [...(byCourt.get(h.court as string) ?? []), h]);
    }
    const overlaps: string[] = [];
    for (const [court, rows] of byCourt) {
      rows.sort((a, b) => (a.startsAt < b.startsAt ? -1 : 1));
      for (let i = 1; i < rows.length; i++) {
        if (rows[i - 1].endsAt !== undefined && rows[i].startsAt < (rows[i - 1].endsAt as string)) overlaps.push(court);
      }
    }
    expect(overlaps).toEqual(["Board 2"]);
  });

  it("declares BOTH rows of the real overlap, and nothing else", () => {
    // Derived by sweeping every board, not hand-listed — and it must be both
    // rows, because the certificate's exemption is per-row and requires every
    // fixture of a finding to be declared.
    const declared = (committed.historicalAssignment ?? []).filter((h) => h.knownConflict !== undefined);
    expect(declared.map((h) => h.fixtureExtKey).sort()).toEqual(["se-r2-i1", "se-r3-i1"]);
    for (const row of declared) {
      expect(row.divisionRef).toBe("d-womens");
      expect(row.knownConflict).toMatch(/three independent DartConnect feeds agree/);
    }
    // Div A's timetable is derived rather than published, so nothing there may
    // claim a source conflict — a derived row that breaches the encoding is
    // OUR arithmetic, which is exactly what the red branch is for.
    expect((committed.historicalAssignment ?? []).filter((h) => h.divisionRef === "d-worlds" && h.knownConflict)).toEqual([]);
  });

  it("puts the final in its published 19:30 slot", () => {
    const final = rowsOf("d-worlds").find((h) => h.fixtureExtKey === "se-r6-i0");
    expect(final?.startsAt).toBe("2025-01-03T19:30:00.000Z");
  });
});

describe("suite11 — expected", () => {
  it("names both champions", () => {
    expect(committed.expected.champions).toEqual([
      { divisionRef: "d-worlds", stageRef: "s-worlds-main", entrant: entrantRef("a", "Luke Littler") },
      { divisionRef: "d-womens", stageRef: "s-womens-main", entrant: entrantRef("b", "Fallon Sherrock") },
    ]);
  });

  it("derives the leaderboards from the streams rather than typing them in", () => {
    for (const board of committed.expected.leaderboards ?? []) {
      const tally = new Map<string, number>();
      for (const s of streamsOf(board.divisionRef)) {
        for (const e of scoresOf(s)) {
          const ref = (scorePayload(e).person as string).slice(1);
          tally.set(ref, (tally.get(ref) ?? 0) + 1);
        }
      }
      for (const entry of board.entries) expect(entry.count, entry.name).toBe(tally.get(entry.person));
      // Descending, and with DISTINCT counts at the top — a comparator that
      // returned a constant would otherwise pass on a flat board.
      const counts = board.entries.map((e) => e.count);
      expect([...counts].sort((a, b) => b - a)).toEqual(counts);
      expect(new Set(counts).size).toBeGreaterThan(1);
    }
  });

  it("carries the cross-division careers, summed over both divisions", () => {
    const careers = committed.expected.careers ?? [];
    expect(careers.map((c) => c.name).sort()).toEqual(["Fallon Sherrock", "Noa-Lynn van Leuven"]);
    for (const c of careers) {
      // A career rollup has no divisionRef by design, so the count must be
      // strictly greater than either division alone — which is the whole
      // point of the oracle and the thing a single-division bug would break.
      const perDivision = ["d-worlds", "d-womens"].map((d) =>
        streamsOf(d)
          .flatMap(scoresOf)
          .filter((e) => (scorePayload(e).person as string).slice(1) === c.person).length,
      );
      expect(c.count).toBe(perDivision[0] + perDivision[1]);
      expect(perDivision.every((n) => n > 0), `${c.name} should play both divisions`).toBe(true);
      expect(c.count).toBeGreaterThan(Math.max(...perDivision));
    }
  });

  it("cuts finalRanks at the runner-up and invents nothing below", () => {
    for (const row of committed.expected.finalRanks ?? []) {
      // A knockout honestly ranks champion and runner-up: both losing
      // semi-finalists are equal third and the real tournament orders them no
      // further.
      expect(row.order).toHaveLength(2);
    }
  });

  it("reports suspensions and specials as NO SUBJECT, never faked", () => {
    expect(committed.expected.suspensions ?? []).toEqual([]);
    expect(committed.expected.specials ?? []).toEqual([]);
    expect(committed.expected.tables ?? []).toEqual([]);
    // And says so, so a reader does not mistake an empty array for an omission.
    const why = (committed.meta.adaptations ?? []).map((a) => a.what).join(" | ");
    expect(why).toMatch(/No suspensions and no specials/);
  });

  it("has an expected outcome for every stream and no orphans", () => {
    const streamKeys = new Set((committed.streams ?? []).map((s) => `${s.divisionRef}/${s.fixtureExtKey}`));
    const expectedKeys = new Set((committed.expected.matches ?? []).map((m) => `${m.divisionRef}/${m.fixtureExtKey}`));
    expect([...expectedKeys].filter((k) => !streamKeys.has(k))).toEqual([]);
    expect([...streamKeys].filter((k) => !expectedKeys.has(k))).toEqual([]);
    expect(expectedKeys.size).toBe(205);
  });
});

describe("suite11 — meta", () => {
  it("is not synthetic and cites real sources", () => {
    expect(committed.meta.synthetic).toBe(false);
    expect((committed.meta.sources ?? []).length).toBeGreaterThan(5);
    for (const s of committed.meta.sources ?? []) expect(s.url).toMatch(/^https?:\/\//);
  });

  it("writes down every reshaping of reality", () => {
    const adaptations = committed.meta.adaptations ?? [];
    expect(adaptations.length).toBeGreaterThanOrEqual(13);
    for (const a of adaptations) {
      // §7A: an adaptation with no `why` is a note, not a record.
      expect(a.why.length, a.what).toBeGreaterThan(40);
    }
    const what = adaptations.map((a) => a.what).join(" | ");
    for (const topic of [/distinct seed/, /reconstructed from the results/, /leg order/, /byes are derived/, /start times/, /countryCode/, /three-dart average/, /finalRanks/, /officials/]) {
      expect(what, `missing adaptation: ${topic}`).toMatch(topic);
    }
  });
});
