import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RunSheet, type RunSheetFilter } from "@/components/v2/desk/run-sheet";
import { buildRunSheet, type RunSheetFixture } from "@/lib/run-sheet-groups";

// The fixture stream panel (imported through the run sheet) reads the checkout-return URL and strips it (G5).
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(""),
}));

// Competition desk W3, controller ruling C-1 — pre-existing from W2 (this
// file's own git history has zero commits in `origin/main..HEAD` before
// this fix; W3 did not introduce the defect, only the fix touches it).
//
// `overflow: hidden` on an ancestor makes THAT ancestor the containing block
// a `position: sticky` descendant sticks to, not the viewport — and neither
// the `run-sheet` div nor a bracket `<section>` ever scrolls internally (the
// PAGE does), so a sticky header inside either one sat at a fixed 56px
// offset from its OWN box, permanently, overlapping whatever row occupied
// that band, rather than tracking real page scroll. Measured in a real
// browser (controller): a bracket round header sat 56px into its section
// AT `scrollY = 0` — already wrong at rest, not "about to stick".
//
// This file is the vitest half of the fix (`environment: "node"`, no DOM,
// so it cannot see actual scroll/sticky behaviour — that is
// run-sheet.spec.ts's job): it pins the STRUCTURAL cause going away
// (`overflow-hidden` absent from both ancestors) and its replacement
// (`rounded-t-2xl` on the bracket section's own FIRST round header only —
// the one child that actually needed the clipping `overflow-hidden` used
// to provide, since its `bg-slate-50` would otherwise square off past the
// section's own rounded top corner; every other round header sits well
// inside the section's flat area and never needed it).
const TZ = "UTC";
const NOW_MS = Date.UTC(2026, 8, 5, 12, 0, 0);

function fx(no: number, o: Partial<RunSheetFixture> = {}): RunSheetFixture {
  return {
    id: `f${no}`,
    stage_id: "s1",
    fixture_no: no,
    round_no: 1,
    seq_in_round: no,
    scheduled_at: "2026-09-05T14:00:00.000Z",
    status: "scheduled",
    court_name: null,
    court_id: null,
    venue_name: null,
    officials: [],
    outcome: null,
    home_entrant_id: "e1",
    away_entrant_id: "e2",
    home_slot_label: null,
    away_slot_label: null,
    lane: null,
    is_final: false,
    third_place: false,
    conditional: false,
    ext_key: null,
    ...o,
  };
}

const KNOCKOUT = [{ id: "s1", seq: 1, kind: "knockout", name: "Cup" }];

// Two rounds, deliberately — round 1 (the section's FIRST rendered child)
// must get the rounding; round 2 (mid-section) must NOT, so this test can
// tell "every header rounded" (a guard nothing kills) apart from "only the
// first one is".
const FIXTURES: RunSheetFixture[] = [
  fx(1),
  fx(2, { round_no: 2, scheduled_at: "2026-09-06T14:00:00.000Z" }),
];

function sheetHtml(filter: RunSheetFilter = "all"): string {
  return renderToStaticMarkup(
    <RunSheet
      blocks={buildRunSheet({ fixtures: FIXTURES, stages: KNOCKOUT, tz: TZ, nowMs: NOW_MS })}
      stages={KNOCKOUT}
      tz={TZ}
      orgTz={TZ}
      nowMs={NOW_MS}
      matchMinutes={60}
      entrantNames={{ e1: "Alpha", e2: "Bravo" }}
      canEdit
      hrefFor={(f) => `/f/${f.fixture_no}`}
      filter={filter}
      onFilter={() => {}}
      stageId={null}
      onStageFilter={() => {}}
    />,
  );
}

describe("run sheet — sticky group headers escape the overflow-hidden that broke them (controller ruling C-1)", () => {
  it("the run-sheet card itself carries no overflow-hidden", () => {
    const html = sheetHtml();
    expect(html).toContain('data-testid="run-sheet"');
    const tag = /<div data-testid="run-sheet"[^>]*>/.exec(html);
    expect(tag, "run-sheet div not found").not.toBeNull();
    expect(tag![0]).not.toContain("overflow-hidden");
  });

  it("the bracket section itself carries no overflow-hidden", () => {
    const html = sheetHtml();
    const tag = /<section data-run-sheet-block="bracket"[^>]*>/.exec(html);
    expect(tag, "bracket section not found").not.toBeNull();
    expect(tag![0]).not.toContain("overflow-hidden");
  });

  it("only the bracket section's FIRST round header is rounded — not every header", () => {
    const html = sheetHtml();
    const headers = [...html.matchAll(/<header style="[^"]*" class="([^"]*)"/g)].map((m) => m[1]!);
    expect(headers.length, "expected two round headers, one per round").toBe(2);
    expect(headers[0], "first round header must carry rounded-t-2xl").toContain("rounded-t-2xl");
    expect(headers[1], "second round header must NOT carry rounded-t-2xl — it is not at the section's own top corner").not.toContain(
      "rounded-t-2xl",
    );
  });

  it("both headers keep their sticky positioning — the fix removes overflow-hidden, never the sticky itself", () => {
    const html = sheetHtml();
    const headers = [...html.matchAll(/<header style="([^"]*)" class="([^"]*)"/g)];
    expect(headers.length, "expected two round headers").toBe(2);
    for (const m of headers) {
      // W4 moved the OFFSET from a `top-14`/`top-[86px]` class pair to one
      // `calc()` in the style attribute (finding m2 — the 86 assumed a day
      // header height that wraps at 320). `sticky` and `z-10` stay classes,
      // and both still have to survive: this test exists for the
      // overflow-hidden fix, which is about positioning, not offset.
      expect(m[2], "sticky z-10 must survive on every round header").toMatch(/\bsticky\b.*\bz-10\b/);
      expect(m[1], "the offset moved to an inline calc, and must still be there").toContain("--desk-day-h");
    }
  });
});
