// The D2 capacity card's WIRING into SettingsPanel (P10 §4/Task 6 rewrite).
//
// Before this task, the report was computed synchronously inside a useMemo
// (capacityInputForFixtures + assessCapacity), so renderToStaticMarkup —
// which runs useState initialisers and useMemo on first render but NEVER
// fires an effect (component-ui-i18n memory) — could observe the rendered
// verdict directly. That is no longer true: the report now arrives only
// through useCapacityReport's effect + debounced fetch, which
// renderToStaticMarkup never runs at all. So this file now tests two
// things separately:
//   1. capacityRequestFromDraft — the pure mapping from the panel's own
//      live draft state to the wire body the hook sends. Same coverage
//      intent as the old verdict-based tests (window bounds, the
//      never-throw unbounded-start case, the empty-courts org-wide
//      fallback, non-movable exclusion), just asserted against the
//      REQUEST shape rather than a computed CapacityReport — verdict
//      arithmetic itself is covered by capacity-endpoint.test.ts
//      (server-side) and use-capacity-report.test.ts (the hook).
//   2. A regression guard: SettingsPanel renders NO capacity card
//      synchronously, for any input. That is the "no client-side fallback
//      computation" acceptance criterion made falsifiable — if a future
//      change reintroduces a synchronous (useMemo-shaped) computation in
//      the component body, this test starts failing because
//      data-capacity-verdict would appear in a renderToStaticMarkup pass
//      the way it used to.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Dict } from "@/lib/i18n-constants";
import { DictProvider } from "@/components/i18n/dict-provider";
import en from "@/dictionaries/en/ui.json";
import { SettingsPanel, capacityRequestFromDraft, sanitizeNonNegativeInt } from "../settings-panel";
import type { BoardConfig } from "../types";
import type { Venue } from "@/components/v2/shared/court-multi-picker";

function render(ui: React.ReactElement): string {
  return renderToStaticMarkup(
    <DictProvider dict={en as unknown as Dict} locale="en">
      {ui}
    </DictProvider>,
  );
}

function baseConfig(overrides: Partial<BoardConfig> = {}): BoardConfig {
  return {
    matchMinutes: 60,
    gapMinutes: 0,
    courts: ["Court 1"],
    perEntrantMinRest: 0,
    blackouts: [],
    sessionWindows: [],
    ...overrides,
  };
}

const baseDraft = (over: Partial<Parameters<typeof capacityRequestFromDraft>[1]> = {}) => ({
  startAt: "",
  endAt: "",
  matchMinutes: 60,
  gapMinutes: 0,
  rest: 0,
  courts: ["Court 1"],
  ...over,
});

const MOVABLE = (id: string, home: string | null, away: string | null) => ({
  status: "scheduled",
  home_entrant_id: home,
  away_entrant_id: away,
  pool_id: null,
  id,
});

// Two real org courts under one venue — enough to prove the fallback reads
// the ACTUAL org court list (via `flattenCourts`), not just its length.
function orgVenues(): Venue[] {
  return [
    {
      id: "venue-1",
      name: "Riverside Centre",
      address: null,
      sort: 0,
      archived_at: null,
      created_at: "2026-01-01T00:00:00.000Z",
      courts: [
        {
          id: "court-1",
          venue_id: "venue-1",
          name: "Court 1",
          sort: 0,
          tags: [],
          archived_at: null,
          created_at: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "court-2",
          venue_id: "venue-1",
          name: "Court 2",
          sort: 1,
          tags: [],
          archived_at: null,
          created_at: "2026-01-01T00:00:00.000Z",
        },
      ],
    },
  ];
}

describe("capacityRequestFromDraft", () => {
  it("builds an undefined window when neither startAt nor endAt is set", () => {
    const req = capacityRequestFromDraft([], baseDraft(), baseConfig(), "UTC", []);
    expect(req.config.window).toBeUndefined();
  });

  it("builds an unbounded-start window (-Infinity) when only endAt is set — must not throw", () => {
    // The shipped crash this guarded against: a division with an END date
    // and no START date used to reach dayKeyInTz(-Infinity, tz) further
    // down the OLD pipeline. capacityRequestFromDraft itself must still
    // build a window object here (useCapacityReport's own guard is what
    // now skips the request for it) — asserting that construction alone
    // never throws is the regression pin.
    const call = () =>
      capacityRequestFromDraft(
        [],
        baseDraft({ endAt: "2026-08-13", startAt: "" }),
        baseConfig(),
        "UTC",
        [],
      );
    expect(call).not.toThrow();
    expect(call().config.window).toEqual({ from: -Infinity, to: expect.any(Number) });
  });

  it("builds a fully bounded window from startAt + endAt — DAY-granular, not the exact startAt instant", () => {
    // `from` is midnight of the day startAt falls on (matches capacityDays'
    // own day-bucket approach downstream), not 09:00 itself — a time-of-day
    // on the start field narrows nothing about which CALENDAR DAYS are in
    // scope.
    const req = capacityRequestFromDraft(
      [],
      baseDraft({ startAt: "2026-08-01T09:00", endAt: "2026-08-01" }),
      baseConfig(),
      "UTC",
      [],
    );
    expect(req.config.window).toEqual({
      from: Date.parse("2026-08-01T00:00:00.000Z"),
      to: Date.parse("2026-08-02T00:00:00.000Z"),
    });
  });

  it("maps only MOVABLE (scheduled) fixtures, excluding a decided one", () => {
    const req = capacityRequestFromDraft(
      [MOVABLE("f1", "A", "B"), { status: "decided", home_entrant_id: "A", away_entrant_id: "B", pool_id: null, id: "f2" }],
      baseDraft(),
      baseConfig(),
      "UTC",
      [],
    );
    expect(req.fixtures).toEqual([{ home: "A", away: "B", poolId: undefined, id: "f1" }]);
  });

  // Review 5 of #857, Minor 3. A start taken back reads `scheduled` but holds a
  // result: the board flags it `held`, every builder leaves it in place, and the
  // server's capacity guards no longer count it as demand. Neither does the card.
  it("does not count a held card (a start taken back) as demand, though it reads scheduled", () => {
    const req = capacityRequestFromDraft(
      [MOVABLE("f1", "A", "B"), { ...MOVABLE("f2", "C", "D"), held: true }, { ...MOVABLE("f3", "E", "F"), held: false }],
      baseDraft(),
      baseConfig(),
      "UTC",
      [],
    );
    expect(req.fixtures.map((f) => f.id)).toEqual(["f1", "f3"]);
  });

  it("falls back to every org court (via venues) when the draft's own court selection is empty — mirrors resolveCandidateCourts' server-side UNCONSTRAINED fallback", () => {
    const req = capacityRequestFromDraft([], baseDraft({ courts: [] }), baseConfig({ courts: [] }), "UTC", orgVenues());
    expect(req.config.courts).toEqual(["court-1", "court-2"]);
  });

  it("uses the draft's live courts, matchMinutes, gapMinutes and rest — not config's last-saved values", () => {
    const req = capacityRequestFromDraft(
      [],
      baseDraft({ courts: ["court-live"], matchMinutes: 45, gapMinutes: 5, rest: 20 }),
      baseConfig({ courts: ["court-saved"], matchMinutes: 60, gapMinutes: 0, perEntrantMinRest: 0 }),
      "UTC",
      [],
    );
    expect(req.config.courts).toEqual(["court-live"]);
    expect(req.config.matchMinutes).toBe(45);
    expect(req.config.gapMinutes).toBe(5);
    expect(req.config.perEntrantMinRest).toBe(20);
  });

  it("converts sessionWindows/blackouts off config (last-saved, not draft) from ISO strings to epoch-ms pairs", () => {
    const req = capacityRequestFromDraft(
      [],
      baseDraft(),
      baseConfig({
        sessionWindows: [{ from: "2026-08-01T09:00:00.000Z", to: "2026-08-01T10:00:00.000Z" }],
        blackouts: [{ from: "2026-08-01T12:00:00.000Z", to: "2026-08-01T13:00:00.000Z" }],
      }),
      "UTC",
      [],
    );
    expect(req.config.sessionWindows).toEqual([
      { from: Date.parse("2026-08-01T09:00:00.000Z"), to: Date.parse("2026-08-01T10:00:00.000Z") },
    ]);
    expect(req.config.blackouts).toEqual([
      { from: Date.parse("2026-08-01T12:00:00.000Z"), to: Date.parse("2026-08-01T13:00:00.000Z") },
    ]);
  });

  it("carries config.constraints through untouched when present, omits the key entirely when absent", () => {
    const withConstraints = capacityRequestFromDraft(
      [],
      baseDraft(),
      baseConfig({ constraints: { restMin: 30 } }),
      "UTC",
      [],
    );
    expect(withConstraints.config.constraints).toEqual({ restMin: 30 });
    const without = capacityRequestFromDraft([], baseDraft(), baseConfig(), "UTC", []);
    expect("constraints" in without.config).toBe(false);
  });
});

describe("SettingsPanel — no client-side fallback computation", () => {
  it("renders NO capacity card synchronously, even for inputs that would have been 'impossible' under the old local computation — the report can only ever arrive via useCapacityReport's effect+fetch, which renderToStaticMarkup never runs", () => {
    const html = render(
      <SettingsPanel
        divisionId="div-1"
        config={baseConfig({
          startAt: "2026-08-01T09:00:00.000Z",
          endAt: "2026-08-01T23:59:00.000Z",
          sessionWindows: [{ from: "2026-08-01T09:00:00.000Z", to: "2026-08-01T10:00:00.000Z" }],
        })}
        canEdit
        constraintsAllowed
        orgTz="UTC"
        defaultOpen
        onSaved={() => {}}
        onError={() => {}}
        fixtures={[
          MOVABLE("f1", "A", "B"),
          MOVABLE("f2", "A", "C"),
          MOVABLE("f3", "A", "D"),
          MOVABLE("f4", "B", "C"),
          MOVABLE("f5", "B", "D"),
          MOVABLE("f6", "C", "D"),
        ]}
        viewerPlan="community"
      />,
    );
    expect(html).not.toContain("data-capacity-verdict");
  });
});

// Review finding 4: `gapMinutes`/`rest` used a bare `Number(e.target.value)`,
// unlike matchMinutes' own `|| 30` guard. Typing `-` yields NaN (serialises
// to `null` on the wire); `1.5` yields a non-integer. Both are rejected by
// CapacityPrecheckInput's `z.number().int().min(0)` (capacity-guard.ts) ->
// 400 -> one retry -> `failed: true`, so the card sticks on "check failed"
// until the organiser edits something else. `sanitizeNonNegativeInt` is the
// fix, applied at the SAME point matchMinutes' guard already lives (the
// onChange handler), so the state itself — not just one call site — is
// always a valid non-negative integer.
describe("sanitizeNonNegativeInt (review finding 4)", () => {
  it("rounds a fractional value to the nearest integer", () => {
    expect(sanitizeNonNegativeInt("1.5")).toBe(2);
    expect(sanitizeNonNegativeInt("1.4")).toBe(1);
  });

  it("floors an invalid or non-numeric value to 0, never NaN", () => {
    expect(sanitizeNonNegativeInt("-")).toBe(0);
    expect(sanitizeNonNegativeInt("abc")).toBe(0);
    expect(Number.isNaN(sanitizeNonNegativeInt("-"))).toBe(false);
  });

  it("clamps a negative value to 0 rather than sending it over the wire", () => {
    expect(sanitizeNonNegativeInt("-5")).toBe(0);
  });

  it("passes a valid non-negative integer through unchanged", () => {
    expect(sanitizeNonNegativeInt("10")).toBe(10);
    expect(sanitizeNonNegativeInt("0")).toBe(0);
  });

  it("treats an emptied field as 0, matching both fields' own min={0}", () => {
    expect(sanitizeNonNegativeInt("")).toBe(0);
  });
});
