// Pure view-model logic for the public join page (RS007 §2 — "join becomes
// CLAIM-first", `_INDEX.md` ruling 2026-08-27). No React, no DB: every
// branch here is a plain function of plain data.
import { describe, expect, it } from "vitest";
import { guardianRequired, validateConsent } from "@/components/public-site/register/validation";
import { cartHasOtherPlayers } from "@/components/public-site/register/cart";
import {
  buildJoinBody,
  canSubmitJoin,
  classifyJoinFailure,
  defaultSlotChoice,
  joinerCart,
  joinWhoRequirements,
  NEW_PLAYER_CHOICE,
  rosterMeterAfterJoin,
} from "../view-model";

const CONTACT = {
  name: "Alex Test",
  email: "alex@example.com",
  dob: null as string | null,
  gender: null as "m" | "f" | "x" | null,
  guardian_name: null as string | null,
  guardian_consent: false,
};

describe("defaultSlotChoice", () => {
  const SLOTS = [
    { player_id: "p1" },
    { player_id: "p2" },
  ];

  it("honours a per-slot link that names a real unclaimed slot, even with other slots present", () => {
    expect(defaultSlotChoice(SLOTS, true, "p2")).toBe("p2");
  });

  it("ignores a requested id that does not match any unclaimed slot — never a distinct error, just no preselection", () => {
    expect(defaultSlotChoice(SLOTS, true, "stale-or-bogus")).toBeNull();
  });

  it("auto-picks the sole slot when there is exactly one and no add-new option (the pair shape)", () => {
    expect(defaultSlotChoice([{ player_id: "only" }], false, null)).toBe("only");
  });

  it("auto-picks 'someone else' when there are zero slots and add-new is the only option", () => {
    expect(defaultSlotChoice([], true, null)).toBe(NEW_PLAYER_CHOICE);
  });

  it("is null (forces an explicit pick) when genuinely ambiguous — 2+ slots, no matching request", () => {
    expect(defaultSlotChoice(SLOTS, true, null)).toBeNull();
  });

  it("is null when there is exactly one slot but add-new is ALSO offered — still a real choice between two options", () => {
    expect(defaultSlotChoice([{ player_id: "only" }], true, null)).toBeNull();
  });
});

describe("canSubmitJoin", () => {
  it("false until something is selected", () => {
    expect(canSubmitJoin(null)).toBe(false);
  });
  it("true once a slot or the new-player sentinel is selected", () => {
    expect(canSubmitJoin("p1")).toBe(true);
    expect(canSubmitJoin(NEW_PLAYER_CHOICE)).toBe(true);
  });
});

describe("joinerCart — the adapter that lets StepConsent's REAL guardian/roster-notice rules see a join", () => {
  it("never trips cartHasOtherPlayers — a join never names anyone but the joiner", () => {
    expect(cartHasOtherPlayers(joinerCart({ name: "Alex" }))).toBe(false);
  });

  it("guardianRequired reads the CONTACT's own dob via the synthetic self row, same as the main register flow", () => {
    const cart = joinerCart({ name: "Kid Joiner" });
    expect(guardianRequired(cart, { dob: "2015-01-01" }, new Date("2026-08-27"))).toBe(true);
    expect(guardianRequired(cart, { dob: "1990-01-01" }, new Date("2026-08-27"))).toBe(false);
  });

  it("validateConsent's guardian gate fires through the same adapter, end to end", () => {
    const cart = joinerCart({ name: "Kid Joiner" });
    const minorContact = { ...CONTACT, name: "Kid Joiner", dob: "2015-01-01" };
    const consentOnly = { privacy_consent: true, media_consent: false };
    const verdict = validateConsent(cart, minorContact, consentOnly, new Date("2026-08-27"));
    expect(verdict.valid).toBe(false);
    expect(verdict.errors.guardianName).toBe("required");
    expect(verdict.errors.guardianConsent).toBe("required");
  });
});

describe("joinWhoRequirements", () => {
  it("is a straight pass-through of the division's own requirement — never gated behind an imPlaying toggle", () => {
    expect(joinWhoRequirements(true, false)).toEqual({ dobRequired: true, genderRequired: false });
    expect(joinWhoRequirements(false, true)).toEqual({ dobRequired: false, genderRequired: true });
    expect(joinWhoRequirements(false, false)).toEqual({ dobRequired: false, genderRequired: false });
  });
});

describe("buildJoinBody", () => {
  it("claim path — sends the chosen player_id", () => {
    const body = buildJoinBody("JOIN123", "p2", { ...CONTACT, dob: "1990-01-01", gender: "f" });
    expect(body).toEqual({
      join_code: "JOIN123",
      player_id: "p2",
      player: { full_name: "Alex Test", dob: "1990-01-01", gender: "f", email: "alex@example.com" },
      guardian_name: null,
      guardian_consent: false,
    });
  });

  it("insert path (NEW_PLAYER_CHOICE) — player_id is OMITTED, not sent as null/undefined", () => {
    const body = buildJoinBody("JOIN123", NEW_PLAYER_CHOICE, CONTACT);
    expect("player_id" in body).toBe(false);
  });

  it("trims name/email, carries the guardian pair through untouched", () => {
    const body = buildJoinBody("JOIN123", "p1", {
      ...CONTACT,
      name: "  Kid Joiner  ",
      email: "  kid@example.com  ",
      guardian_name: "A Guardian",
      guardian_consent: true,
    });
    expect(body.player.full_name).toBe("Kid Joiner");
    expect(body.player.email).toBe("kid@example.com");
    expect(body.guardian_name).toBe("A Guardian");
    expect(body.guardian_consent).toBe(true);
  });

  it("CRITICAL: the join_code capability token is never echoed anywhere except its own field", () => {
    const body = buildJoinBody("SECRET-CODE-999", "p1", CONTACT);
    const { join_code, ...rest } = body;
    expect(join_code).toBe("SECRET-CODE-999");
    expect(JSON.stringify(rest)).not.toContain("SECRET-CODE-999");
  });
});

describe("classifyJoinFailure — 409 here means a real conflict, unlike submit.ts's checkout-race 409", () => {
  it("404 -> notFound (join_code or player_id no longer resolves — same shape as a dead link)", () => {
    expect(classifyJoinFailure(404)).toBe("notFound");
  });
  it("409 -> conflict (someone else already claimed this exact slot)", () => {
    expect(classifyJoinFailure(409)).toBe("conflict");
  });
  it("422/400 -> rejected (the server refused what was submitted)", () => {
    expect(classifyJoinFailure(422)).toBe("rejected");
    expect(classifyJoinFailure(400)).toBe("rejected");
  });
  it("5xx and no-response -> retry", () => {
    expect(classifyJoinFailure(500)).toBe("retry");
    expect(classifyJoinFailure(503)).toBe("retry");
    expect(classifyJoinFailure(undefined)).toBe("retry");
  });
});

describe("rosterMeterAfterJoin", () => {
  it("a CLAIM flips one pending row to granted — total unchanged, claimed +1", () => {
    expect(rosterMeterAfterJoin(4, 2, false)).toEqual({ claimed: 3, total: 4 });
  });
  it("an INSERT (new player) adds a fresh, already-consented row — both +1", () => {
    expect(rosterMeterAfterJoin(4, 2, true)).toEqual({ claimed: 3, total: 5 });
  });
  it("the last unclaimed slot being claimed reads as fully confirmed", () => {
    expect(rosterMeterAfterJoin(4, 1, false)).toEqual({ claimed: 4, total: 4 });
  });
});
