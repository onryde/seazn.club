// Org branding blob merges (v3/10 #5): the brand colour shares one jsonb column with whatever else the blob holds — the
// regression this pins is the wipe bug (writing one key used to replace the whole blob, deleting the others). The blob's
// sponsor list, its merge and its reader went in R4 fix batch 3 (sponsors live in the `sponsors` table only).
import { describe, expect, it } from "vitest";
import { mergeBrandColor } from "@/lib/org-branding";

describe("org branding merges", () => {
  const existing = {
    colors: { primary: "#1d4ed8" },
    banner: "orgs/banner.png",
  };

  it("setting a color keeps every other key", () => {
    const next = mergeBrandColor(existing, "#0F766E");
    expect(next.colors).toEqual({ primary: "#0f766e" }); // lowercased
    expect(next.banner).toBe(existing.banner);
  });

  it("clearing the color keeps every other key", () => {
    const next = mergeBrandColor(existing, null);
    expect(next.colors).toBeUndefined();
    expect(next.banner).toBe(existing.banner);
  });
});
