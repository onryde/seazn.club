// Match Day PB3 item 6 - the New competition form's "will this be created private?" answer.
//
// The server never refuses a create over `dashboard.public.max`: it creates the competition PRIVATE and says so on the 201
// (`resolveCreateVisibility`: a visibility the cap meters, with no slot left, is degraded). The form asks the same question BEFORE
// Create so its "Who will find it" checklist does not promise reach the create will not deliver. This is the client's half of that
// rule; the server's half is held to it by public-slots-left.test.ts, which asks both about every point of a filling cap.
import { describe, expect, it } from "vitest";
import { createdPrivateOverCap, PUBLICLY_READABLE_VISIBILITIES } from "../competition-listing";

describe("createdPrivateOverCap", () => {
  it("is the metered visibilities with NO slot left, and nothing else - every visibility x every count of slots", () => {
    const VISIBILITIES = ["private", "unlisted", "public"];
    // Rulebook, not this code: the cap meters what a stranger can OPEN (public and link-only); a private competition is outside it.
    const metered = new Set<string>(PUBLICLY_READABLE_VISIBILITIES);
    expect(metered.has("private")).toBe(false);
    expect(metered.size).toBe(2);
    let checked = 0;
    for (const visibility of VISIBILITIES) {
      for (const left of [null, 0, 1, 2, 10]) {
        // null = no cap (or none we could read): nothing to warn about. 0 = every slot used. Anything above 0 still has room.
        const want = metered.has(visibility) && left === 0;
        expect(createdPrivateOverCap(visibility, left), `${visibility} / left ${left}`).toBe(want);
        checked++;
      }
    }
    expect(checked, "anti-vacuity: every cell was asked").toBe(VISIBILITIES.length * 5);
  });

  it("the cases that differ from the wrong answer: private at the cap is NOT degraded; public with one slot is NOT; public at zero IS", () => {
    expect(createdPrivateOverCap("private", 0)).toBe(false);
    expect(createdPrivateOverCap("public", 1)).toBe(false);
    expect(createdPrivateOverCap("public", 0)).toBe(true);
    expect(createdPrivateOverCap("unlisted", 0)).toBe(true);
  });

  it("an unknown visibility never claims a degrade (the empty case: the form is mid-edit, a segment is not yet chosen)", () => {
    expect(createdPrivateOverCap("", 0)).toBe(false);
    expect(createdPrivateOverCap("nonsense", 0)).toBe(false);
  });
});
