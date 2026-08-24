// Formatter unit tests (C3, 2026-08-13 design amendment). Pure module, no
// React needed — `msg` is the real i18n runtime over the real dictionaries,
// so a broken interpolation or a stale key is caught here, not just in a
// mounted-component test.
import { describe, expect, it } from "vitest";
import { t } from "@/lib/i18n-runtime";
import type { Dict } from "@/lib/i18n-constants";
import type { ConflictDetail, ConflictDetailKind } from "@seazn/engine/scheduling";
import en from "@/dictionaries/en/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import {
  formatConflictDetail,
  fromBoardConflictDetail,
  formatBoardConflictDetail,
  type ConflictDetailCtx,
} from "../conflict-detail-format";
import type { BoardConflictDetail } from "../types";

const enDict = en as unknown as Dict;
const frDict = fr as unknown as Dict;
const msgEn = (key: string, vars?: Record<string, string | number>) => t(enDict, key, vars);
const msgFr = (key: string, vars?: Record<string, string | number>) => t(frDict, key, vars);

const baseCtx: ConflictDetailCtx = {
  msg: msgEn,
  entrantNames: { e1: "Alpha", e2: "Bravo" },
  fixtureTitles: { f1: "Alpha vs Bravo", f2: "Charlie vs Delta" },
};

describe("formatConflictDetail — localized output", () => {
  it("resolves an entrant id through entrantNames (the reported symptom's exact kind)", () => {
    const d: ConflictDetail = { kind: "entrant_below_rest", entrantIds: ["e1"] };
    expect(formatConflictDetail(d, baseCtx)).toBe("Alpha does not get enough rest");
  });

  it("resolves both an entrant and the other fixture", () => {
    const d: ConflictDetail = { kind: "entrant_overlap", entrantIds: ["e2"], otherFixtureId: "f2" };
    expect(formatConflictDetail(d, baseCtx)).toBe("Bravo is also playing in Charlie vs Delta at the same time");
  });

  it("interpolates scalar fields (no name resolution involved)", () => {
    const d: ConflictDetail = { kind: "round_order_day", roundNo: 2, day: "2026-08-14", otherRoundNo: 1, otherDay: "2026-08-15" };
    expect(formatConflictDetail(d, baseCtx)).toBe("Round 2 is on 2026-08-14, before round 1 on 2026-08-15");
  });

  it("a kind with no fields at all renders the static sentence", () => {
    expect(formatConflictDetail({ kind: "no_slot_lattice" }, baseCtx)).toBe(
      "No legal slot anywhere in the schedule",
    );
  });

  it("localizes into fr — not the same string as en", () => {
    const d: ConflictDetail = { kind: "entrant_below_rest", entrantIds: ["e1"] };
    const frText = formatConflictDetail(d, { ...baseCtx, msg: msgFr });
    expect(frText).toBe("Alpha n'a pas assez de repos");
    expect(frText).not.toBe(formatConflictDetail(d, baseCtx));
  });
});

describe("formatConflictDetail — instruction_time splits on ruleType", () => {
  it("not_before", () => {
    const d: ConflictDetail = { kind: "instruction_time", ruleType: "not_before", time: "08:00", requiredTime: "09:00" };
    expect(formatConflictDetail(d, baseCtx)).toBe(
      "Starts at 08:00 — your instruction asks for nothing before 09:00",
    );
  });

  it("not_after", () => {
    const d: ConflictDetail = { kind: "instruction_time", ruleType: "not_after", time: "22:00", requiredTime: "21:00" };
    expect(formatConflictDetail(d, baseCtx)).toBe(
      "Starts at 22:00 — your instruction asks for nothing after 21:00",
    );
  });
});

describe("formatConflictDetail — court_double_booking's optional otherFixtureId", () => {
  // P9 review wave 3, finding #3: `court` is a real courts.id uuid since the
  // P9 cutover, never a name — the server resolves `courtName` beside it
  // (schemas.ts's court_name, via courtNamesById -> buildCourtDirectory) and
  // that is what these messages must interpolate, never `court` itself.
  const COURT_UUID = "7c9c3ad1-4f2e-4b1a-9e77-1a2b3c4d5e6f";

  it("names the other fixture through the resolved courtName, never the raw court id", () => {
    const d: ConflictDetail = {
      kind: "court_double_booking",
      court: COURT_UUID,
      courtName: "Court 1 (Riverside Centre)",
      otherFixtureId: "f2",
    };
    const text = formatConflictDetail(d, baseCtx);
    expect(text).toBe("Court Court 1 (Riverside Centre) is already taken by Charlie vs Delta");
    expect(text).not.toContain(COURT_UUID);
  });

  it("falls back to the generic sentence when otherFixtureId is absent (calendar.ts:1384's reportability guard) — still through courtName", () => {
    const d: ConflictDetail = { kind: "court_double_booking", court: COURT_UUID, courtName: "Court 1 (Riverside Centre)" };
    const text = formatConflictDetail(d, baseCtx);
    expect(text).toBe("Court Court 1 (Riverside Centre) is already taken by another match");
    expect(text).not.toContain(COURT_UUID);
  });

  it("a courtName miss degrades to the shared unknown-court string — never the raw uuid", () => {
    const d: ConflictDetail = { kind: "court_double_booking", court: COURT_UUID, otherFixtureId: "f2" };
    const text = formatConflictDetail(d, baseCtx);
    expect(text).toBe("Court Unknown court is already taken by Charlie vs Delta");
    expect(text).not.toContain(COURT_UUID);
  });
});

describe("formatConflictDetail — locked_slot_clash and court_tag_mismatch resolve courtName too (P9 review wave 3, finding #3)", () => {
  const COURT_UUID = "9a1b2c3d-4e5f-4061-8a1b-2c3d4e5f6071";

  it("locked_slot_clash names the resolved court, never the raw id", () => {
    const d: ConflictDetail = { kind: "locked_slot_clash", court: COURT_UUID, courtName: "Court 2" };
    const text = formatConflictDetail(d, baseCtx);
    expect(text).toBe("The pinned time clashes on court Court 2");
    expect(text).not.toContain(COURT_UUID);
  });

  it("locked_slot_clash degrades to the unknown-court string on a courtName miss", () => {
    const d: ConflictDetail = { kind: "locked_slot_clash", court: COURT_UUID };
    const text = formatConflictDetail(d, baseCtx);
    expect(text).toBe("The pinned time clashes on court Unknown court");
    expect(text).not.toContain(COURT_UUID);
  });

  it("court_tag_mismatch names the resolved court, never the raw id (previously untested entirely)", () => {
    const d: ConflictDetail = { kind: "court_tag_mismatch", court: COURT_UUID, courtName: "Show Court" };
    const text = formatConflictDetail(d, baseCtx);
    expect(text).toBe("Court Show Court does not carry a required tag");
    expect(text).not.toContain(COURT_UUID);
  });

  it("court_tag_mismatch degrades to the unknown-court string on a courtName miss", () => {
    const d: ConflictDetail = { kind: "court_tag_mismatch", court: COURT_UUID };
    const text = formatConflictDetail(d, baseCtx);
    expect(text).toBe("Court Unknown court does not carry a required tag");
    expect(text).not.toContain(COURT_UUID);
  });

  it("two courts sharing a bare name in different venues stay distinguishable through courtName — never collapse to identical text", () => {
    // The server resolves courtName venue-qualified (courtNamesById ->
    // buildCourtDirectory) whenever a bare name collides across venues —
    // this proves the CLIENT plumbing preserves whatever distinguishing text
    // the server sent, rather than re-deriving or losing it.
    const a: ConflictDetail = {
      kind: "court_double_booking",
      court: "11111111-1111-4111-8111-111111111111",
      courtName: "Court 1 (Riverside Centre)",
      otherFixtureId: "f1",
    };
    const b: ConflictDetail = {
      kind: "court_double_booking",
      court: "22222222-2222-4222-8222-222222222222",
      courtName: "Court 1 (Downtown Hall)",
      otherFixtureId: "f1",
    };
    const textA = formatConflictDetail(a, baseCtx);
    const textB = formatConflictDetail(b, baseCtx);
    expect(textA).toContain("Court 1 (Riverside Centre)");
    expect(textB).toContain("Court 1 (Downtown Hall)");
    expect(textA).not.toBe(textB);
    const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-/;
    expect(textA).not.toMatch(UUID_RE);
    expect(textB).not.toMatch(UUID_RE);
  });
});

describe("formatConflictDetail — person_below_rest is the ONE multi-person join", () => {
  it("joins every personId, not just the first", () => {
    const d: ConflictDetail = { kind: "person_below_rest", personIds: ["p1", "p2"] };
    const text = formatConflictDetail(d, { ...baseCtx, personNames: { p1: "Sam", p2: "Jo" } });
    expect(text).toBe("Sam, Jo do not get enough rest");
  });

  it("every OTHER kind carrying personIds/entrantIds reads only the first (matches the legacy prose's own indexing)", () => {
    // person_overlap's legacy prose reads `personIds![0]` — a caller that
    // passed a second id must not see it leak into the sentence.
    const d: ConflictDetail = { kind: "person_overlap", personIds: ["p1", "p2"], otherFixtureId: "f1" };
    const text = formatConflictDetail(d, { ...baseCtx, personNames: { p1: "Sam", p2: "Jo" } });
    expect(text).toContain("Sam");
    expect(text).not.toContain("Jo");
  });
});

describe("formatConflictDetail — id fallback (never a full UUID)", () => {
  const UUID = "6be47174-7f41-4030-9c1a-1e2f3a4b5c6d";

  it("a synthetic `name:` person id renders the name it carries, not a further-shortened form", () => {
    // personKeyResolver (schedule-ai.ts:202) mints `name:${normalizedName}`
    // for two person rows sharing a display name in a joint AI pack.
    const d: ConflictDetail = { kind: "person_overlap", personIds: ["name:alice smith"], otherFixtureId: "f1" };
    const text = formatConflictDetail(d, baseCtx); // no personNames map in scope
    expect(text).toContain("alice smith");
    expect(text).not.toContain("name:");
  });

  it("a genuine opaque person id (no personNames entry, no `name:` prefix) is shortened — never the full UUID", () => {
    const d: ConflictDetail = { kind: "person_overlap", personIds: [UUID], otherFixtureId: "f1" };
    const text = formatConflictDetail(d, baseCtx);
    expect(text).toContain(UUID.slice(0, 8));
    expect(text).not.toContain(UUID);
  });

  it("a personNames HIT wins over both the `name:` prefix and shortening", () => {
    const d: ConflictDetail = { kind: "person_overlap", personIds: ["name:alice smith"], otherFixtureId: "f1" };
    const text = formatConflictDetail(d, { ...baseCtx, personNames: { "name:alice smith": "Alice Smith (#42)" } });
    expect(text).toContain("Alice Smith (#42)");
  });

  it("an entrant id missing from entrantNames is shortened — never the full UUID", () => {
    const d: ConflictDetail = { kind: "entrant_below_rest", entrantIds: [UUID] };
    const text = formatConflictDetail(d, baseCtx);
    expect(text).toContain(UUID.slice(0, 8));
    expect(text).not.toContain(UUID);
  });

  it("a fixture id missing from fixtureTitles is shortened — never the full UUID", () => {
    const d: ConflictDetail = { kind: "order_before_feeder", otherFixtureId: UUID };
    const text = formatConflictDetail(d, baseCtx);
    expect(text).toContain(UUID.slice(0, 8));
    expect(text).not.toContain(UUID);
  });
});

describe("formatConflictDetail — exhaustive sweep", () => {
  // One representative populated `ConflictDetail` per kind — every field the
  // design doc's table lists for it. Proves the switch handles every member
  // of `ConflictDetailKind` without throwing, and that a lookup miss never
  // renders "undefined" or "[object Object]" into user-facing text — the
  // TS `never` check proves EXHAUSTIVE at compile time; this proves each
  // arm actually PRODUCES a sane string at runtime.
  const ALL: ConflictDetail[] = [
    { kind: "person_double_booking", personIds: ["p1"], otherFixtureId: "f1" },
    { kind: "locked_slot_clash", court: "Court 1" },
    { kind: "no_slot_start_window" },
    { kind: "no_slot_person_bound", personIds: ["p1"], otherFixtureId: "f1" },
    { kind: "no_slot_horizon" },
    { kind: "instruction_feeder_gap", minutes: 5, requiredMinutes: 10 },
    { kind: "instruction_day_cap", count: 3, day: "2026-08-14", requiredCount: 2 },
    { kind: "instruction_weekday", weekday: "FRI", day: "2026-08-14", requiredWeekday: "SAT" },
    { kind: "instruction_date", day: "2026-08-14", requiredDate: "2026-08-15" },
    { kind: "instruction_time", ruleType: "not_before", time: "08:00", requiredTime: "09:00" },
    { kind: "instruction_time", ruleType: "not_after", time: "22:00", requiredTime: "21:00" },
    { kind: "outside_competition_window" },
    { kind: "outside_start_window" },
    { kind: "court_double_booking", court: "Court 1", otherFixtureId: "f1" },
    { kind: "court_double_booking", court: "Court 1" },
    { kind: "court_tag_mismatch", court: "Court 1" },
    { kind: "outside_court_hours", court: "Court 1" },
    { kind: "inside_blackout" },
    { kind: "outside_session_windows" },
    { kind: "entrant_overlap", entrantIds: ["e1"], otherFixtureId: "f1" },
    { kind: "entrant_below_rest", entrantIds: ["e1"] },
    { kind: "person_overlap", personIds: ["p1"], otherFixtureId: "f1" },
    { kind: "person_below_rest", personIds: ["p1", "p2"] },
    { kind: "order_before_feeder", otherFixtureId: "f1" },
    { kind: "order_inside_feeder_rest", otherFixtureId: "f1", requiredMinutes: 30 },
    { kind: "round_order_day", roundNo: 1, day: "2026-08-14", otherRoundNo: 2, otherDay: "2026-08-15" },
    { kind: "round_order_same_day", roundNo: 1, otherRoundNo: 2, day: "2026-08-14" },
    { kind: "no_slot_lattice" },
    { kind: "no_slot_budget" },
  ];

  // 29 populated details above (instruction_time and court_double_booking
  // each appear twice, deliberately — see the design doc's key table) cover
  // all 27 `ConflictDetailKind` members — closed via ALL_KINDS_WITNESS below,
  // not a hand-maintained count that can quietly fall behind the union again
  // (this comment previously said "25" after two more kinds, court_tag_mismatch
  // and outside_court_hours, had already been added to the engine's union).
  it("covers every ConflictDetailKind at least once", () => {
    const seen = new Set(ALL.map((d) => d.kind));
    // `Record<ConflictDetailKind, true>` witness — the SAME exhaustiveness
    // idiom `conflict-detail-legacy.test.ts`'s own `CASES` table uses (and the
    // engine's `FIELD_ORDER_WITNESS` / schemas.ts's `CONFLICT_DETAIL_KIND_WITNESS`):
    // a kind added to (or renamed in) the engine's union and forgotten here is a
    // TYPE ERROR on this object literal — a missing property — not a silently
    // stale hand-typed array a human forgot to extend. This is what makes the
    // assertion below genuinely closed: a 28th kind fails to compile, it does
    // not just fail to be checked.
    const ALL_KINDS_WITNESS: Record<ConflictDetailKind, true> = {
      person_double_booking: true,
      locked_slot_clash: true,
      no_slot_start_window: true,
      no_slot_person_bound: true,
      no_slot_horizon: true,
      instruction_feeder_gap: true,
      instruction_day_cap: true,
      instruction_weekday: true,
      instruction_date: true,
      instruction_time: true,
      outside_competition_window: true,
      outside_start_window: true,
      court_double_booking: true,
      court_tag_mismatch: true,
      outside_court_hours: true,
      inside_blackout: true,
      outside_session_windows: true,
      entrant_overlap: true,
      entrant_below_rest: true,
      person_overlap: true,
      person_below_rest: true,
      order_before_feeder: true,
      order_inside_feeder_rest: true,
      round_order_day: true,
      round_order_same_day: true,
      no_slot_lattice: true,
      no_slot_budget: true,
    };
    const kinds = Object.keys(ALL_KINDS_WITNESS) as ConflictDetailKind[];
    for (const k of kinds) expect(seen.has(k), `${k} missing from the sweep fixture`).toBe(true);
  });

  it("every kind formats to a non-empty string with no leaked placeholder or lookup miss", () => {
    for (const d of ALL) {
      const text = formatConflictDetail(d, baseCtx);
      expect(text.length, `${d.kind} produced an empty string`).toBeGreaterThan(0);
      expect(text, `${d.kind} leaked "undefined"`).not.toMatch(/undefined/);
      expect(text, `${d.kind} leaked "[object Object]"`).not.toContain("[object Object]");
      // Every key actually resolved — a miss falls through i18n-runtime's
      // dev warning path and returns the KEY ITSELF, which always starts
      // with this literal prefix.
      expect(text, `${d.kind} rendered its own dict key (a missing translation)`).not.toMatch(
        /^board\.conflict\.detail\./,
      );
      // No unresolved `{placeholder}` token left in the output.
      expect(text, `${d.kind} left a {placeholder} unfilled`).not.toMatch(/\{[a-zA-Z]+\}/);
    }
  });
});

describe("fromBoardConflictDetail / formatBoardConflictDetail — the snake_case wire adapter", () => {
  it("renames every field camelCase, formats identically to the engine shape", () => {
    const wire: BoardConflictDetail = {
      kind: "round_order_same_day",
      round_no: 3,
      other_round_no: 4,
      day: "2026-08-14",
    };
    const engineShape: ConflictDetail = { kind: "round_order_same_day", roundNo: 3, otherRoundNo: 4, day: "2026-08-14" };
    expect(fromBoardConflictDetail(wire)).toEqual(engineShape);
    expect(formatBoardConflictDetail(wire, baseCtx)).toBe(formatConflictDetail(engineShape, baseCtx));
  });

  it("resolves entrant/fixture ids exactly like the camelCase path", () => {
    const wire: BoardConflictDetail = { kind: "entrant_overlap", entrant_ids: ["e1"], other_fixture_id: "f2" };
    expect(formatBoardConflictDetail(wire, baseCtx)).toBe(
      "Alpha is also playing in Charlie vs Delta at the same time",
    );
  });

  it("an absent field on the wire stays absent after conversion (never a present `undefined`)", () => {
    const wire: BoardConflictDetail = { kind: "no_slot_lattice" };
    const converted = fromBoardConflictDetail(wire);
    expect(Object.keys(converted)).toEqual(["kind"]);
  });

  it("maps the wire's court_name to courtName (P9 review wave 3, finding #3) — the gap that let a raw uuid through", () => {
    const UUID = "5c6d7e8f-4a1b-4c2d-9e3f-1a2b3c4d5e6f";
    const wire: BoardConflictDetail = {
      kind: "court_double_booking",
      court: UUID,
      court_name: "Court 1 (Riverside Centre)",
      other_fixture_id: "f2",
    };
    expect(fromBoardConflictDetail(wire)).toEqual({
      kind: "court_double_booking",
      court: UUID,
      courtName: "Court 1 (Riverside Centre)",
      otherFixtureId: "f2",
    });
    const text = formatBoardConflictDetail(wire, baseCtx);
    expect(text).toBe("Court Court 1 (Riverside Centre) is already taken by Charlie vs Delta");
    expect(text).not.toContain(UUID);
  });
});

describe("formatBoardConflictDetail — unknown kind (review finding 5, version skew)", () => {
  it("never surfaces the raw engine kind to an organiser", () => {
    // `fromBoardConflictDetail` casts the wire's plain-`string` `kind` to
    // `ConflictDetailKind` (BoardConflictDetail.kind is deliberately untyped
    // — see types.ts's own comment) so an older client bundle or a cached
    // conflict carrying a kind this build's switch does not know about
    // reaches `formatConflictDetail`'s `default` branch at runtime, past the
    // `never` check that only proves exhaustiveness at COMPILE time over the
    // kinds this build knows. Before the fix this returned the raw token
    // ("no_slot_budget_v2") — engine vocabulary an organiser cannot act on.
    const wire: BoardConflictDetail = { kind: "no_slot_budget_v2" };
    expect(formatBoardConflictDetail(wire, baseCtx)).toBe("");
  });
});
