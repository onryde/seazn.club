// S4 (#428) — the closed suspension-`reason` vocabulary shared by hockey
// (FIH) and icehockey (IIHF) over the SAME `period/kernel.ts` payload field.
// The kernel's zod schema stays ONE permissive union (so a frozen corpus
// payload from either sport still parses, and a payload from either federation
// is structurally valid regardless of which fold reads it — the discriminator
// is the envelope's event type, not this field, exactly like every other
// "same shape, gated by variant" fact in this kernel). What must actually
// differ per federation is declared separately, per sport, and pinned here —
// "gate by variant, not by kernel" (S04 prompt gotcha), mirroring how
// `SetBasedSanctionLevel` is a shared union with the per-sport mapping living
// beside each sport, not enforced by the shared schema.
import { describe, expect, it } from "vitest";
import { PeriodSuspensionReason, PeriodSuspensionStart } from "./kernel.ts";
import { HOCKEY_SUSPENSION_REASONS } from "../hockey/hockey.ts";
import { ICEHOCKEY_SUSPENSION_REASONS } from "../icehockey/icehockey.ts";

describe("PeriodSuspensionReason — shared union, per-sport subsetting (S4/#428)", () => {
  it("every member either sport declares is a member of the shared kernel union", () => {
    const union = new Set(PeriodSuspensionReason.options);
    for (const r of HOCKEY_SUSPENSION_REASONS) expect(union.has(r), `hockey: ${r}`).toBe(true);
    for (const r of ICEHOCKEY_SUSPENSION_REASONS) expect(union.has(r), `icehockey: ${r}`).toBe(true);
  });

  it("the two sports' declared sets, together, cover the whole shared union exactly", () => {
    // No orphaned kernel member that neither federation claims.
    const claimed = new Set([...HOCKEY_SUSPENSION_REASONS, ...ICEHOCKEY_SUSPENSION_REASONS]);
    expect([...claimed].sort()).toEqual([...PeriodSuspensionReason.options].sort());
  });

  it("hockey's set is deliberately SMALLER than icehockey's (S04 prompt gotcha)", () => {
    expect(HOCKEY_SUSPENSION_REASONS.length).toBeLessThan(ICEHOCKEY_SUSPENSION_REASONS.length);
  });

  it("hockey never offers an icehockey-only member, e.g. fighting", () => {
    // The literal example the S04 prompt names: "do not offer an
    // icehockey-only member (e.g. fighting) on an FIH card."
    expect(HOCKEY_SUSPENSION_REASONS).not.toContain("fighting");
    const iceOnly = ICEHOCKEY_SUSPENSION_REASONS.filter(
      (r) => !(HOCKEY_SUSPENSION_REASONS as readonly string[]).includes(r),
    );
    for (const r of HOCKEY_SUSPENSION_REASONS) {
      expect(iceOnly, `hockey member "${r}" must not be icehockey-exclusive`).not.toContain(r);
    }
  });

  it("hockey and icehockey share the physical-infraction core (tripping, hooking) plus other", () => {
    for (const shared of ["tripping", "hooking", "other"] as const) {
      expect(HOCKEY_SUSPENSION_REASONS).toContain(shared);
      expect(ICEHOCKEY_SUSPENSION_REASONS).toContain(shared);
    }
  });

  it("PeriodSuspensionReason (the bare enum) rejects a value outside the 23 declared members", () => {
    expect(
      PeriodSuspensionReason.safeParse(HOCKEY_SUSPENSION_REASONS[0]).success,
    ).toBe(true);
    expect(
      PeriodSuspensionReason.safeParse(ICEHOCKEY_SUSPENSION_REASONS[0]).success,
    ).toBe(true);
    expect(PeriodSuspensionReason.safeParse("professional_foul").success).toBe(false);
  });

  // Review round 1, finding 2 — `reason` on `hockey.suspension.start` /
  // `icehockey.suspension.start` has been API-writable free text since W4
  // (#407), before this session's enum existed. `parsePayload` throws
  // INVALID_EVENT on a schema mismatch and nothing catches it on the read
  // path (engine-db/fold.ts), so hard-narrowing the FIELD (not just adding
  // the enum) risked a 500 on any already-recorded suspension whose reason
  // is not one of the 23 members — the exact "no existing recorded payload
  // becomes invalid" constraint the brief itself states. `reason` is
  // therefore a UNION (enum members parse identically to before; ANY other
  // non-empty string also still parses, exactly as it did pre-#428) — only
  // the bare `PeriodSuspensionReason` export (used for ENUM_VOCAB, the
  // per-sport declared subsets, and the adjudication rule's canonical
  // values) stays closed.
  it("PeriodSuspensionStart.reason still accepts pre-existing free text — no throw on an unrecognized value", () => {
    const legacy = { by: "H", class: "yellow", reason: "dangerous tackle, ref's own words" };
    const parsed = PeriodSuspensionStart.safeParse(legacy);
    expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues)).toBe(true);
    expect(parsed.success && parsed.data.reason).toBe("dangerous tackle, ref's own words");
  });

  it("PeriodSuspensionStart.reason still accepts every canonical enum member", () => {
    for (const r of PeriodSuspensionReason.options) {
      const parsed = PeriodSuspensionStart.safeParse({ by: "H", class: "yellow", reason: r });
      expect(parsed.success, r).toBe(true);
    }
  });

  it("PeriodSuspensionStart.reason still rejects an EMPTY string (both branches require min(1))", () => {
    expect(PeriodSuspensionStart.safeParse({ by: "H", class: "yellow", reason: "" }).success).toBe(
      false,
    );
  });
});
