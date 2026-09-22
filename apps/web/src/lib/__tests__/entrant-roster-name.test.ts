// The name an ad-hoc entrant is born with (its people, joined), and how that
// name follows a roster edit. Pure — the DB-backed half, `patchEntrant`
// actually calling this, is `entrant-rename.test.ts` in usecases/__tests__.
//
// Every expected name below is BUILT with `rosterDerivedName`, never typed, so
// a change to the create-time join moves these tests with it instead of
// leaving them asserting yesterday's separator.
import { describe, expect, it } from "vitest";
import { followRosterEdit, rosterDerivedName } from "../entrant-roster-name";

const sankar = { person_id: "p-sankar", full_name: "Sankar" };
const ritwik = { person_id: "p-ritwik", full_name: "Ritwik" };
const venkatesh = { person_id: "p-venkatesh", full_name: "Venkatesh" };
const priya = { person_id: "p-priya", full_name: "Priya" };

const derived = (...people: { full_name: string }[]) =>
  rosterDerivedName(people.map((p) => p.full_name));

describe("rosterDerivedName — the create-time join", () => {
  it("joins a pair's full names with ' & ', in the order given", () => {
    expect(rosterDerivedName(["Sankar", "Ritwik"])).toBe("Sankar & Ritwik");
    expect(rosterDerivedName(["Ritwik", "Sankar"])).toBe("Ritwik & Sankar");
  });

  it("is the bare name for one person, and empty for nobody", () => {
    expect(rosterDerivedName(["Sankar"])).toBe("Sankar");
    expect(rosterDerivedName([])).toBe("");
  });

  it("skips missing names rather than printing a dangling separator", () => {
    // registration-submit composes [row0, partner || partner_name] and relies
    // on exactly this: an absent partner must not leave "Sankar & ".
    expect(rosterDerivedName(["Sankar", undefined])).toBe("Sankar");
    expect(rosterDerivedName([null, "Ritwik", ""])).toBe("Ritwik");
  });
});

describe("followRosterEdit — a derived name follows the roster", () => {
  it("the production case: 'Sankar & Ritwik' − Ritwik + Venkatesh → 'Sankar & Venkatesh'", () => {
    const stale = derived(sankar, ritwik);
    const next = followRosterEdit(stale, [sankar, ritwik], [sankar, venkatesh]);
    expect(next).toBe(derived(sankar, venkatesh));
    // The differential: the right answer is not the stale one.
    expect(next).not.toBe(stale);
  });

  it("a survivor keeps its POSITION in the name, whatever order the roster arrives in", () => {
    // Ritwik is second in the name; the swap replaces him in place. The roster
    // was submitted with Venkatesh FIRST — the name must not follow that.
    expect(followRosterEdit(derived(sankar, ritwik), [sankar, ritwik], [venkatesh, sankar])).toBe(
      derived(sankar, venkatesh),
    );
    // Removed person first in the name → the newcomer takes the first place.
    expect(followRosterEdit(derived(ritwik, sankar), [sankar, ritwik], [sankar, venkatesh])).toBe(
      derived(venkatesh, sankar),
    );
  });

  it("matches the name against the roster as a MULTISET — entrant_members has no order column", () => {
    // Prior roster read back in the opposite order to the name: still derived.
    expect(followRosterEdit(derived(sankar, ritwik), [ritwik, sankar], [sankar, venkatesh])).toBe(
      derived(sankar, venkatesh),
    );
  });

  it("both people replaced → the newcomers, in submitted order", () => {
    expect(followRosterEdit(derived(sankar, ritwik), [sankar, ritwik], [priya, venkatesh])).toBe(
      derived(priya, venkatesh),
    );
  });

  it("counts differ: a newcomer with no seat to take is APPENDED, a removal with no replacement is DROPPED", () => {
    expect(followRosterEdit(derived(sankar), [sankar], [sankar, ritwik])).toBe(derived(sankar, ritwik));
    expect(followRosterEdit(derived(sankar, ritwik), [sankar, ritwik], [ritwik])).toBe(derived(ritwik));
  });

  it("an individual's single name follows a swap too (it is the one-person derivation)", () => {
    expect(followRosterEdit(derived(sankar), [sankar], [venkatesh])).toBe(derived(venkatesh));
  });

  it("returns null — leave the name alone — when nothing about it would change", () => {
    // Same people, same or different submission order.
    expect(followRosterEdit(derived(sankar, ritwik), [sankar, ritwik], [sankar, ritwik])).toBeNull();
    expect(followRosterEdit(derived(sankar, ritwik), [sankar, ritwik], [ritwik, sankar])).toBeNull();
  });

  it("never empties a name: a roster cleared to nobody keeps the last name it had", () => {
    expect(followRosterEdit(derived(sankar, ritwik), [sankar, ritwik], [])).toBeNull();
  });
});

describe("followRosterEdit — a name that is NOT the roster's own is never touched", () => {
  it("a custom name ('Smash Bros') survives any roster edit", () => {
    expect(followRosterEdit("Smash Bros", [sankar, ritwik], [sankar, venkatesh])).toBeNull();
  });

  it("a name naming only SOME of the roster is custom, not derived", () => {
    // Two people on the roster, one in the name: the organiser chose it.
    expect(followRosterEdit(derived(sankar), [sankar, ritwik], [sankar, venkatesh])).toBeNull();
    // More tokens than people.
    expect(followRosterEdit(derived(sankar, ritwik, priya), [sankar, ritwik], [sankar, venkatesh])).toBeNull();
  });

  it("the same people joined differently (not the create-time separator) is custom", () => {
    expect(followRosterEdit("Sankar / Ritwik", [sankar, ritwik], [sankar, venkatesh])).toBeNull();
    expect(followRosterEdit("Sankar and Ritwik", [sankar, ritwik], [sankar, venkatesh])).toBeNull();
  });

  it("matches names EXACTLY — a hand-edited spelling or case is the organiser's", () => {
    expect(followRosterEdit("sankar & Ritwik", [sankar, ritwik], [sankar, venkatesh])).toBeNull();
    expect(followRosterEdit("Sankar & Ritwik K", [sankar, ritwik], [sankar, venkatesh])).toBeNull();
  });

  it("each name token must be claimed by a DISTINCT person", () => {
    // "Sankar & Sankar" over a roster of one Sankar and one Ritwik is not a
    // derivation of that roster, even though every token names somebody on it.
    expect(followRosterEdit("Sankar & Sankar", [sankar, ritwik], [sankar, venkatesh])).toBeNull();
  });

  it("two different people who share a name are still two seats", () => {
    const sankar2 = { person_id: "p-sankar-2", full_name: "Sankar" };
    expect(followRosterEdit("Sankar & Sankar", [sankar, sankar2], [sankar, venkatesh])).toBe(
      derived(sankar, venkatesh),
    );
  });

  it("an entrant that had nobody derives nothing, so its name is custom", () => {
    // A name-only pair (typed at create, no people picked) gains its first
    // members: the typed name stays.
    expect(followRosterEdit("Sankar & Ritwik", [], [sankar, ritwik])).toBeNull();
  });
});
