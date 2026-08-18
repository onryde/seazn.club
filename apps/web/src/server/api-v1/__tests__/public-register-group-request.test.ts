// RS003 W1 — group-shaped public register + join schemas (no DB, no routes;
// wave 2 wires these into an actual route).
//
// The schema is the door, not the guarantee: `submitRegistrationGroup` /
// `joinTeamEntry` (registration-submit.ts) still refuse anything unsafe no
// matter what arrives here (division windows, capacity, eligibility, the
// privacy-consent-must-be-true gate). What THIS file owes is the useful
// 400 — a cart that breaks a rule this schema CAN see is told exactly why,
// rather than reaching the usecase and either failing some other way or
// (self_player_index out of range) not failing at all: `registration-
// submit.ts:384-390` silently drops an unresolvable self declaration
// instead of erroring, so the schema-level check is the only place that
// tells the registrant their link didn't take.
//
// #402 lineage: the pre-redesign single-entry `PublicRegisterRequest` had
// this same self-declaration coherence rule, expressed per-player-row (a
// top-level `registering_self` PLUS a `players[].self` flag). See this
// file's history at `850cc6308^` and `public-register-request.test.ts` at
// that revision. The group shape collapses the two flags into one
// per-entry pair (`registering_self` + `self_player_index`) and this suite
// is its cart-wide replacement.
import { describe, expect, it } from "vitest";
import {
  PublicJoinRequest,
  PublicJoinResponse,
  PublicRegisterGroupRequest,
  PublicRegisterGroupResponse,
} from "../schemas";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";
const UUID_C = "33333333-3333-4333-8333-333333333333";
const ADULT_DOB = "1990-05-05";

/** A minimal valid contact; each case overrides only what it tests. */
function contact(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { name: "Sam Player", email: "sam@example.com", ...over };
}

/** A minimal valid individual entry (one division, one player). */
function entry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    division_id: UUID_A,
    entrant_kind: "individual",
    players: [{ full_name: "Sam Player" }],
    ...over,
  };
}

/** A minimal valid one-entry cart; each case overrides only what it tests. */
function cart(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contact: contact(),
    privacy_consent: true,
    entries: [entry()],
    ...over,
  };
}

/** The dotted path of every issue on a body expected to fail — attributed,
 *  not just counted, since a body can be refused for the wrong reason and
 *  still "fail". */
function issuePaths(input: Record<string, unknown>): string[] {
  const r = PublicRegisterGroupRequest.safeParse(input);
  expect(r.success).toBe(false);
  return r.success ? [] : r.error.issues.map((i) => i.path.join("."));
}

describe("PublicRegisterGroupRequest", () => {
  it("accepts a minimal one-entry cart", () => {
    expect(PublicRegisterGroupRequest.safeParse(cart()).success).toBe(true);
  });

  it("accepts a full valid 3-entry cart (team + pair + individual, one self row)", () => {
    const r = PublicRegisterGroupRequest.safeParse({
      contact: contact({ dob: ADULT_DOB }),
      privacy_consent: true,
      locale: "fr",
      entries: [
        {
          division_id: UUID_A,
          entrant_kind: "team",
          team_name: "The Aces",
          players: [
            { full_name: "Sam Player", is_captain: true },
            { full_name: "Alex Mate" },
          ],
          registering_self: true,
          self_player_index: 0,
        },
        {
          division_id: UUID_B,
          entrant_kind: "pair",
          partner_name: "Jamie Partner",
          players: [{ full_name: "Jamie Partner" }, { full_name: "Robin Third" }],
        },
        {
          division_id: UUID_C,
          entrant_kind: "individual",
          players: [{ full_name: "Morgan Solo" }],
        },
      ],
    });
    expect(r.success).toBe(true);
  });

  it("rejects more than 10 entries in one cart", () => {
    const entries = Array.from({ length: 11 }, () => entry());
    expect(issuePaths(cart({ entries }))).toContain("entries");
  });

  it("accepts exactly 10 entries (the boundary)", () => {
    const entries = Array.from({ length: 10 }, () => entry());
    expect(PublicRegisterGroupRequest.safeParse(cart({ entries })).success).toBe(true);
  });

  it("rejects more than 50 players on one entry", () => {
    const players = Array.from({ length: 51 }, (_, i) => ({ full_name: `Player ${i}` }));
    expect(
      issuePaths(
        cart({ entries: [entry({ entrant_kind: "team", team_name: "Big Team", players })] }),
      ),
    ).toContain("entries.0.players");
  });

  it("accepts exactly 50 players (the boundary)", () => {
    const players = Array.from({ length: 50 }, (_, i) => ({ full_name: `Player ${i}` }));
    const r = PublicRegisterGroupRequest.safeParse(
      cart({ entries: [entry({ entrant_kind: "team", team_name: "Big Team", players })] }),
    );
    expect(r.success).toBe(true);
  });

  it("rejects TWO entries both marked registering_self — one contact, one row, cart-wide", () => {
    expect(
      issuePaths(
        cart({
          contact: contact({ dob: ADULT_DOB }),
          entries: [
            entry({ division_id: UUID_A, registering_self: true, self_player_index: 0 }),
            entry({ division_id: UUID_B, registering_self: true, self_player_index: 0 }),
          ],
        }),
      ),
    ).toContain("entries");
  });

  it("accepts ONE entry marked registering_self (not two) with a contact dob", () => {
    const r = PublicRegisterGroupRequest.safeParse(
      cart({
        contact: contact({ dob: ADULT_DOB }),
        entries: [
          entry({ division_id: UUID_A, registering_self: true, self_player_index: 0 }),
          entry({ division_id: UUID_B }),
        ],
      }),
    );
    expect(r.success).toBe(true);
  });

  it("rejects registering_self without a contact dob", () => {
    expect(
      issuePaths(cart({ entries: [entry({ registering_self: true, self_player_index: 0 })] })),
    ).toContain("contact.dob");
  });

  it("registering_self WITH a contact dob is fine", () => {
    const r = PublicRegisterGroupRequest.safeParse(
      cart({
        contact: contact({ dob: ADULT_DOB }),
        entries: [entry({ registering_self: true, self_player_index: 0 })],
      }),
    );
    expect(r.success).toBe(true);
  });

  it("a cart with no self row at all needs no contact dob", () => {
    const r = PublicRegisterGroupRequest.safeParse(cart());
    expect(r.success).toBe(true);
  });

  it("rejects self_player_index out of range for that entry's own players", () => {
    expect(
      issuePaths(
        cart({
          contact: contact({ dob: ADULT_DOB }),
          entries: [
            entry({
              registering_self: true,
              self_player_index: 5,
              players: [{ full_name: "Sam Player" }],
            }),
          ],
        }),
      ),
    ).toContain("entries.0.self_player_index");
  });

  // The resolution below must stay identical to the usecase's own
  // (registration-submit.ts:383-393). An earlier version of this schema
  // defaulted a missing index to 0, which validated a TEAM/pair cart that the
  // usecase then dropped the self declaration from silently — the entry
  // submits, the registrant is never linked to their own player row, and no
  // layer errors.
  //
  // Only the first case below discriminates: mutated back to `?? 0` it is the
  // one and only failure (verified, 27 tests / 1 failed). The two after it
  // hold under BOTH rules — they are characterisation, kept because they pin
  // the other two arms of the usecase's resolution against a future edit that
  // moves them, not because they prove this fix.
  it("rejects registering_self on a TEAM entry that names no self_player_index", () => {
    expect(
      issuePaths(
        cart({
          contact: contact({ dob: ADULT_DOB }),
          entries: [
            entry({
              entrant_kind: "team",
              team_name: "The Aces",
              registering_self: true,
              players: [{ full_name: "Sam Player" }, { full_name: "Alex Mate" }],
            }),
          ],
        }),
      ),
    ).toContain("entries.0.self_player_index");
  });

  it("rejects registering_self on a free-agent entry carrying no player row", () => {
    expect(
      issuePaths(
        cart({
          contact: contact({ dob: ADULT_DOB }),
          entries: [
            entry({
              entrant_kind: "team",
              free_agent: true,
              registering_self: true,
              players: [],
            }),
          ],
        }),
      ),
    ).toContain("entries.0.self_player_index");
  });

  it("accepts registering_self with no index on a one-player INDIVIDUAL entry (the usecase's own implied 0)", () => {
    const r = PublicRegisterGroupRequest.safeParse(
      cart({
        contact: contact({ dob: ADULT_DOB }),
        entries: [entry({ registering_self: true })],
      }),
    );
    expect(r.success).toBe(true);
  });

  it("self_player_index pointing at the last valid row is fine (boundary)", () => {
    const r = PublicRegisterGroupRequest.safeParse(
      cart({
        contact: contact({ dob: ADULT_DOB }),
        entries: [
          entry({
            registering_self: true,
            self_player_index: 1,
            players: [{ full_name: "Alex Mate" }, { full_name: "Sam Player" }],
          }),
        ],
      }),
    );
    expect(r.success).toBe(true);
  });

  it("accepts the honeypot `website` field when present (the ROUTE decides what to do with it, not the schema)", () => {
    const r = PublicRegisterGroupRequest.safeParse(cart({ website: "http://spam.example" }));
    expect(r.success).toBe(true);
  });

  it("`website` is optional — a cart with no such field at all still parses", () => {
    const parsed = PublicRegisterGroupRequest.parse(cart());
    expect(parsed.website).toBeUndefined();
  });

  it("never carries currency — a request that sends one is not honoured", () => {
    // The public request schema must NEVER let a client set currency: it is
    // server-resolved from organizations.currency and snapshotted by the
    // usecase (registration-submit.ts:497). This schema achieves that by
    // simply never declaring the field; Zod's default (non-`.strict()`)
    // object mode then STRIPS unrecognised keys rather than rejecting the
    // whole request — matching every other public request schema in this
    // file, including the old, now-deleted `PublicRegisterRequest`. Proven
    // here at runtime rather than assumed: `.parse()` throws on a genuine
    // rejection, so reaching the assertion already proves acceptance: only
    // whether the stray key survived into the parsed value is in question.
    const parsed = PublicRegisterGroupRequest.parse(cart({ currency: "GBP" }));
    expect("currency" in parsed).toBe(false);
  });
});

describe("PublicRegisterGroupResponse", () => {
  it("parses a full submit result shape (SubmitGroupResult mirror, registration-submit.ts:121-130)", () => {
    const r = PublicRegisterGroupResponse.safeParse({
      group_id: UUID_A,
      ref_code: "SZ-ABCD-1234",
      access_token: "rg_abc123",
      currency: "GBP",
      amount_cents: 5000,
      checkout_url: null,
      entries: [
        {
          registration_id: UUID_B,
          division_id: UUID_C,
          status: "pending",
          amount_cents: 2500,
          join_code: "SZ-JOIN-0001",
          free_agent: false,
        },
        {
          registration_id: UUID_A,
          division_id: UUID_C,
          status: "waitlisted",
          amount_cents: 0,
          join_code: null,
          free_agent: true,
        },
      ],
    });
    expect(r.success).toBe(true);
  });

  it("checkout_url is required-but-nullable — a response omitting it is rejected", () => {
    const r = PublicRegisterGroupResponse.safeParse({
      group_id: UUID_A,
      ref_code: null,
      access_token: "rg_abc123",
      currency: "GBP",
      amount_cents: 0,
      entries: [],
    });
    expect(r.success).toBe(false);
  });
});

describe("PublicJoinRequest", () => {
  it("accepts a minimal join body", () => {
    const r = PublicJoinRequest.safeParse({
      join_code: "SZ-JOIN-0001",
      player: { full_name: "New Joiner" },
    });
    expect(r.success).toBe(true);
  });

  it("accepts a minor joiner with guardian fields", () => {
    const r = PublicJoinRequest.safeParse({
      join_code: "SZ-JOIN-0001",
      player: { full_name: "Young Joiner", dob: "2015-01-01" },
      guardian_name: "Parent Name",
      guardian_consent: true,
    });
    expect(r.success).toBe(true);
  });

  it("rejects a body with no join_code", () => {
    const r = PublicJoinRequest.safeParse({ player: { full_name: "New Joiner" } });
    expect(r.success).toBe(false);
  });

  it("rejects a body with no player", () => {
    const r = PublicJoinRequest.safeParse({ join_code: "SZ-JOIN-0001" });
    expect(r.success).toBe(false);
  });
});

describe("PublicJoinResponse", () => {
  it("parses a join result shape (JoinTeamEntryResult mirror, registration-submit.ts:143-147)", () => {
    const r = PublicJoinResponse.safeParse({
      registration_id: UUID_A,
      player_id: UUID_B,
      consent_status: "guardian",
    });
    expect(r.success).toBe(true);
  });

  it("rejects a consent_status outside the 2-value set the usecase actually returns", () => {
    const r = PublicJoinResponse.safeParse({
      registration_id: UUID_A,
      player_id: UUID_B,
      consent_status: "pending", // registration_players' own 3rd value — join never returns it
    });
    expect(r.success).toBe(false);
  });
});
