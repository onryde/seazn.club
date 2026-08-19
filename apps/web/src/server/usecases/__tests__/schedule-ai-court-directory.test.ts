// P9 pass 3d — the AI pack speaks court NAMES again, ids stay internal.
//
// Two pure functions, no DB:
//   buildCourtDirectory     id -> {label, venue, tags}. The disambiguation
//                            rule this file exists to pin: a bare name shared
//                            by courts in different venues is venue-qualified,
//                            deterministically on (name, venue) text — never
//                            on uuid order.
//   resolveModelCourtLabels the model's own court_label (a label, per
//                            toModelPayload) resolved back to the real id
//                            before structuralCheck/toEngineAssignments/the
//                            diff/apply touch it.
import { describe, expect, it } from "vitest";
import { buildCourtDirectory, resolveModelCourtLabels } from "../schedule-ai";
import type { AiSchedulePlan } from "../schedule-ai-prompt";

describe("buildCourtDirectory", () => {
  it("labels a court by its bare name when no other court shares it", () => {
    const dir = buildCourtDirectory([
      { id: "c1", name: "Court 1", venue_name: "North Hall", tags: [] },
      { id: "c2", name: "Court 2", venue_name: "North Hall", tags: [] },
    ]);
    expect(dir.get("c1")?.label).toBe("Court 1");
    expect(dir.get("c2")?.label).toBe("Court 2");
  });

  it("venue-qualifies a name shared by courts in different venues", () => {
    const dir = buildCourtDirectory([
      { id: "c1", name: "Court 1", venue_name: "North Hall", tags: [] },
      { id: "c2", name: "Court 1", venue_name: "South Hall", tags: [] },
    ]);
    expect(dir.get("c1")?.label).toBe("Court 1 (North Hall)");
    expect(dir.get("c2")?.label).toBe("Court 1 (South Hall)");
    // The point of the exercise: the two labels are unambiguous.
    expect(dir.get("c1")?.label).not.toBe(dir.get("c2")?.label);
  });

  it("does not venue-qualify a name that is unique to its own venue, even when an unrelated collision exists elsewhere", () => {
    const dir = buildCourtDirectory([
      { id: "c1", name: "Court 1", venue_name: "North Hall", tags: [] },
      { id: "c2", name: "Court 1", venue_name: "South Hall", tags: [] },
      { id: "c3", name: "Show Court", venue_name: "North Hall", tags: [] },
    ]);
    expect(dir.get("c3")?.label).toBe("Show Court");
  });

  it("is deterministic on (name, venue) text, not on id order", () => {
    // "zzz-id" sorts lexicographically AFTER "aaa-id" — if the disambiguation
    // ever keyed off uuid order (the recurring defect this session traced
    // five separate bugs to), swapping row order would swap which court
    // reads as the "first" one and could flip which gets qualified how.
    const rowsForward = [
      { id: "zzz-id", name: "Court 1", venue_name: "North Hall", tags: [] },
      { id: "aaa-id", name: "Court 1", venue_name: "South Hall", tags: [] },
    ];
    const rowsReversed = [...rowsForward].reverse();
    const forward = buildCourtDirectory(rowsForward);
    const reversed = buildCourtDirectory(rowsReversed);
    expect(forward.get("zzz-id")?.label).toBe("Court 1 (North Hall)");
    expect(forward.get("aaa-id")?.label).toBe("Court 1 (South Hall)");
    expect(reversed.get("zzz-id")?.label).toBe(forward.get("zzz-id")?.label);
    expect(reversed.get("aaa-id")?.label).toBe(forward.get("aaa-id")?.label);
  });

  it("carries tags and venue through unchanged", () => {
    const dir = buildCourtDirectory([
      { id: "c1", name: "Court 1", venue_name: "North Hall", tags: ["indoor", "hardcourt"] },
    ]);
    expect(dir.get("c1")).toEqual({ label: "Court 1", venue: "North Hall", tags: ["indoor", "hardcourt"] });
  });

  it("resolves the residual same-venue-same-name collision (an archived court freeing its name to a new active one) with a stable suffix, never crashing or colliding", () => {
    const dir = buildCourtDirectory([
      { id: "11111111-1111-1111-1111-111111111111", name: "Court 1", venue_name: "North Hall", tags: [] },
      { id: "22222222-2222-2222-2222-222222222222", name: "Court 1", venue_name: "North Hall", tags: [] },
    ]);
    const l1 = dir.get("11111111-1111-1111-1111-111111111111")?.label;
    const l2 = dir.get("22222222-2222-2222-2222-222222222222")?.label;
    expect(l1).not.toBe(l2);
    expect(l1).toMatch(/^Court 1/);
    expect(l2).toMatch(/^Court 1/);
  });

  it("returns an empty directory for an empty court list", () => {
    expect(buildCourtDirectory([]).size).toBe(0);
  });
});

describe("resolveModelCourtLabels", () => {
  const plan = (
    assignments: { fixture_id: string; scheduled_at: string; court_label: string }[],
  ): AiSchedulePlan => ({
    assignments,
    unschedulable: [],
    explanations: [],
    summary: "x",
  });

  it("resolves a recognised label to its real court id", () => {
    const labelToId = new Map([["Court 1", "uuid-1"]]);
    const out = resolveModelCourtLabels(
      plan([{ fixture_id: "f1", scheduled_at: "2026-08-01T09:00:00Z", court_label: "Court 1" }]),
      labelToId,
    );
    expect(out.assignments[0]!.court_label).toBe("uuid-1");
  });

  it("resolves every assignment independently, on its own label", () => {
    const labelToId = new Map([
      ["Court 1", "uuid-1"],
      ["Court 2 (Annex)", "uuid-2"],
    ]);
    const out = resolveModelCourtLabels(
      plan([
        { fixture_id: "f1", scheduled_at: "2026-08-01T09:00:00Z", court_label: "Court 1" },
        { fixture_id: "f2", scheduled_at: "2026-08-01T10:00:00Z", court_label: "Court 2 (Annex)" },
      ]),
      labelToId,
    );
    expect(out.assignments.map((a) => a.court_label)).toEqual(["uuid-1", "uuid-2"]);
  });

  it("passes an unrecognised label through UNRESOLVED, so the existing settings.courts check still catches it (naming the label, not a stray id)", () => {
    const labelToId = new Map([["Court 1", "uuid-1"]]);
    const out = resolveModelCourtLabels(
      plan([{ fixture_id: "f1", scheduled_at: "2026-08-01T09:00:00Z", court_label: "Centre Court" }]),
      labelToId,
    );
    expect(out.assignments[0]!.court_label).toBe("Centre Court");
  });

  it("is a no-op (same reference) when no directory was supplied", () => {
    const original = plan([{ fixture_id: "f1", scheduled_at: "2026-08-01T09:00:00Z", court_label: "uuid-1" }]);
    const out = resolveModelCourtLabels(original, new Map());
    expect(out).toBe(original);
  });

  it("never touches unschedulable, explanations or summary", () => {
    const original: AiSchedulePlan = {
      assignments: [],
      unschedulable: [{ fixture_id: "f9", reason: "no court free" }],
      explanations: [{ fixture_id: "f9", note: "note" }],
      summary: "summary text",
    };
    const out = resolveModelCourtLabels(original, new Map([["x", "y"]]));
    expect(out.unschedulable).toBe(original.unschedulable);
    expect(out.explanations).toBe(original.explanations);
    expect(out.summary).toBe(original.summary);
  });
});
