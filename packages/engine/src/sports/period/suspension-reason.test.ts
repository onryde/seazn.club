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
import { PeriodSuspensionReason } from "./kernel.ts";
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

  it("PeriodSuspensionStart accepts a valid reason from either sport's set, and rejects a foreign one", () => {
    expect(
      PeriodSuspensionReason.safeParse(HOCKEY_SUSPENSION_REASONS[0]).success,
    ).toBe(true);
    expect(
      PeriodSuspensionReason.safeParse(ICEHOCKEY_SUSPENSION_REASONS[0]).success,
    ).toBe(true);
    expect(PeriodSuspensionReason.safeParse("professional_foul").success).toBe(false);
  });
});
