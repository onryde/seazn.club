// RS006 step 5 — REVIEW→PAY. Pure request-body construction + post-submit
// navigation decision (no DOM, no fetch). register-stepper.tsx's actual
// apiV1() call and window.location.assign/router.push stay thin,
// by-inspection wrappers around these two functions — this vitest workspace
// has no jsdom (`environment: "node"`, see _hook-harness.tsx's own header),
// so `window.location.assign` itself is verified by manual browser check
// (dispatch verification §4), not mocked here. Same split the repo already
// uses elsewhere (org-switch-target.test.ts tests the URL a component
// hard-navigates to, not the navigate call itself).
import { describe, expect, it } from "vitest";
import { buildSubmitBody, resolvePostSubmitNavigation } from "../submit";
import { EMPTY_CART, EMPTY_CONSENT, EMPTY_CONTACT, type CartState, type ContactState } from "../types";

describe("buildSubmitBody", () => {
  it("maps contact/consent/cart onto PublicRegisterGroupRequest's wire shape, trimming name/email", () => {
    const contact: ContactState = {
      ...EMPTY_CONTACT,
      name: "  Alex Test  ",
      email: " alex@example.com ",
      dob: "1990-01-01",
      gender: "m",
    };
    const consent = { privacy_consent: true, media_consent: false };
    const cart: CartState = {
      entries: [
        {
          id: "e1",
          division_id: "d1",
          entrant_kind: "individual",
          team_name: null,
          partner_name: null,
          free_agent: false,
          players: [{ full_name: "Alex Test", dob: null, gender: null, email: "", squad_number: "", is_captain: false }],
          answers: { question: "yes" },
          registering_self: true,
          self_player_index: 0,
        },
      ],
    };

    const body = buildSubmitBody(contact, consent, cart, "");

    expect(body.contact).toEqual({
      name: "Alex Test",
      email: "alex@example.com",
      dob: "1990-01-01",
      gender: "m",
      guardian_name: null,
      guardian_consent: false,
    });
    expect(body.privacy_consent).toBe(true);
    expect(body.media_consent).toBe(false);
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]).toMatchObject({
      division_id: "d1",
      entrant_kind: "individual",
      registering_self: true,
      answers: { question: "yes" },
    });
    // Individual entry — the schema implies self_player_index 0, so it must
    // stay undefined rather than repeat what the server already assumes
    // (toGroupEntry's own doc comment).
    expect(body.entries[0]!.self_player_index).toBeUndefined();
    expect(body.entries[0]!.players).toEqual([
      { full_name: "Alex Test", dob: null, gender: null, email: null, squad_number: null, is_captain: undefined },
    ]);
  });

  it("carries guardian_name/guardian_consent through under contact, not as a sibling field", () => {
    const contact: ContactState = { ...EMPTY_CONTACT, guardian_name: "Pat Guardian", guardian_consent: true };
    const body = buildSubmitBody(contact, EMPTY_CONSENT, EMPTY_CART, "");
    expect(body.contact.guardian_name).toBe("Pat Guardian");
    expect(body.contact.guardian_consent).toBe(true);
    expect(body).not.toHaveProperty("guardian_name");
  });

  it("carries the honeypot field through untouched", () => {
    const body = buildSubmitBody(EMPTY_CONTACT, EMPTY_CONSENT, EMPTY_CART, "bot-value");
    expect(body.website).toBe("bot-value");
  });

  it("drops the client-only entry id from every mapped entry (toGroupEntry's own contract)", () => {
    const cart: CartState = {
      entries: [
        {
          id: "client-only-id",
          division_id: "d1",
          entrant_kind: "individual",
          team_name: null,
          partner_name: null,
          free_agent: false,
          players: [],
          answers: {},
          registering_self: false,
          self_player_index: null,
        },
      ],
    };
    const body = buildSubmitBody(EMPTY_CONTACT, EMPTY_CONSENT, cart, "");
    expect(body.entries[0]).not.toHaveProperty("id");
  });

  it("a team entry's players/answers ride alongside toGroupEntry's own fields, per-entry, not a parallel map", () => {
    const cart: CartState = {
      entries: [
        {
          id: "e1",
          division_id: "d1",
          entrant_kind: "team",
          team_name: "Team A",
          partner_name: null,
          free_agent: false,
          players: [
            { full_name: "Sam", dob: null, gender: null, email: "", squad_number: "7", is_captain: true },
            { full_name: "", dob: null, gender: null, email: "", squad_number: "", is_captain: false }, // blank row, never typed
          ],
          answers: {},
          registering_self: false,
          self_player_index: null,
        },
      ],
    };
    const body = buildSubmitBody(EMPTY_CONTACT, EMPTY_CONSENT, cart, "");
    // Team kind drops blank-named rows (toGroupPlayers' own contract).
    expect(body.entries[0]!.players).toEqual([
      { full_name: "Sam", dob: null, gender: null, email: null, squad_number: 7, is_captain: true },
    ]);
  });
});

describe("resolvePostSubmitNavigation", () => {
  it("routes to Stripe checkout when checkout_url is present", () => {
    const nav = resolvePostSubmitNavigation(
      { group_id: "g1", access_token: "tok", checkout_url: "https://checkout.stripe.com/xyz" },
      "riverside",
      "summer-smash",
    );
    expect(nav).toEqual({ kind: "checkout", url: "https://checkout.stripe.com/xyz" });
  });

  it("routes to the group status page, by id + token, when checkout_url is null (free/offline) — the `rid` convention buildCartMail/createRegistrationCheckout already mint", () => {
    const nav = resolvePostSubmitNavigation(
      { group_id: "g1", access_token: "tok", checkout_url: null },
      "riverside",
      "summer-smash",
    );
    expect(nav).toEqual({ kind: "status", url: "/shared/riverside/summer-smash/register/status?rid=g1&token=tok" });
  });

  it("URL-encodes the access token in the status link", () => {
    const nav = resolvePostSubmitNavigation(
      { group_id: "g1", access_token: "tok/with+special", checkout_url: null },
      "riverside",
      "summer-smash",
    );
    expect(nav.url).toContain(encodeURIComponent("tok/with+special"));
  });
});
