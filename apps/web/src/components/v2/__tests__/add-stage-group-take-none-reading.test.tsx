// The none-line of the group-aware Add stage form ("no count is offered") asks the separation oracle the CAN reading (add-stage-group-take.tsx), the
// reading the form's own counts are built from - not the save door's ALWAYS reading, which the real oracle never answers yes to for any shape
// of the builder's space (group-take-refusal-always.test.ts: 0 of 1704). So with the real oracle the two readings cannot be told apart here; the
// oracle is the one seam, stood in (as in group-take-refusal-always.test.ts, but for EVERY take: the none-line's own take is the builder's
// minimum count, which is a single rule, and the real oracle answers no to it under both readings) so the readings DIFFER: "can" yes, "always" no.
// Mutating the none-line's "can" to the default reading makes it print the generic none text instead of the refusal that names the cause.
import { describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { textOf } from "@/components/__tests__/_hook-harness";
import { t } from "@/lib/i18n-runtime";
import enUi from "@/dictionaries/en/ui.json";
import enErrors from "@/dictionaries/en/errors.json";

const oracle = vi.hoisted(() => ({ always: false, can: true }));
vi.mock("@/lib/cross-pool-draw-risk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/cross-pool-draw-risk")>();
  return {
    ...actual,
    crossPoolShapeAlwaysRefuses: () => oracle.always,
    crossPoolShapeCanRefuse: () => oracle.can,
  };
});
import { GroupTakeField } from "@/components/v2/add-stage-group-take";

const en = (key: string, vars?: Record<string, string | number>) => t(enUi as never, key, vars);
const none = en("schedule.groupTake.none");
const shown = (): string =>
  textOf(GroupTakeField({ msg: en as never, locale: "en", source: { pools: 4, entrants: null }, destKind: "knockout", counts: [], value: null, onChange: () => {} }) as ReactElement);
// The refusal's own words (en errors.json): the longest literal run between its slots - stable text that says WHY, which the generic none
// line never does. Either save copy may show (it names counts that work, or says none do).
const literal = (key: string): string => (enErrors as Record<string, string>)[key]!.split(/\{\w+\}/).reduce((a, b) => (b.length > a.length ? b : a), "");
const WHY = literal("seeding.SEEDING_POOL_SEPARATION_IMPOSSIBLE.save");
const WHY_NONE = literal("seeding.SEEDING_POOL_SEPARATION_IMPOSSIBLE.saveNone");

describe("the none-line reads the oracle's CAN answer, not the save door's ALWAYS answer", () => {
  it("premise: the two cut texts are real and differ from the generic line (a zero-length prefix would match anything)", () => {
    expect(WHY.length).toBeGreaterThan(20);
    expect(WHY_NONE.length).toBeGreaterThan(20);
    expect(none).not.toContain(WHY);
    expect(none.length).toBeGreaterThan(0);
  });

  it("an oracle that says 'can' but not 'always': the line names the separation refusal, not the generic none text", () => {
    oracle.can = true;
    oracle.always = false;
    const text = shown();
    expect(text, "not the generic line").not.toBe(none);
    expect(text.includes(WHY) || text.includes(WHY_NONE), `the separation refusal, got: ${text}`).toBe(true);
    expect(text, "no unfilled slot").not.toMatch(/\{\w+\}/);
  });

  it("the positive pair: an oracle that says neither leaves the generic none line", () => {
    oracle.can = false;
    oracle.always = false;
    expect(shown()).toBe(none);
  });
});
