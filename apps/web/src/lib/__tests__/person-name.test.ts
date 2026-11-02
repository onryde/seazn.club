// Owner ruling 2026-11-01: the add-entrant form's "New player" creates a person in Players. A typed name is stored
// trimmed, an empty one is refused, and a name the directory already holds (any case) selects that person instead of
// minting a duplicate. These are the two pure decisions behind that, tabled.
import { describe, expect, it } from "vitest";
import { cleanPersonName, findPersonByName, PERSON_NAME_MAX } from "@/lib/person-name";

describe("cleanPersonName — the name a New player is created with", () => {
  it.each([
    ["Zoe Ng", "Zoe Ng"],
    ["  Zoe Ng  ", "Zoe Ng"],
    ["\tZoe Ng\n", "Zoe Ng"],
    ["", ""],
    ["   ", ""],
    ["\t \n", ""],
  ])("%j → %j", (raw, clean) => {
    expect(cleanPersonName(raw)).toBe(clean);
  });

  it("keeps the inside of the name as typed (only the ends are trimmed)", () => {
    expect(cleanPersonName(" Mary  Ann O'Neil ")).toBe("Mary  Ann O'Neil");
  });

  it("never offers a name the API refuses: the bound is the schema's own constant", () => {
    expect(PERSON_NAME_MAX).toBe(200);
  });
});

describe("findPersonByName — the duplicate guard", () => {
  const directory = [
    { id: "p1", full_name: "Ana López" },
    { id: "p2", full_name: "Ben Okafor" },
    { id: "p3", full_name: " Cy Park " }, // a stored name with stray spaces still matches its trimmed form
  ];

  const rows: [string, string | null][] = [
    ["Ana López", "p1"],
    ["ana lópez", "p1"],
    ["  ANA LÓPEZ ", "p1"],
    ["Ben Okafor", "p2"],
    ["cy park", "p3"],
    ["Ana", null], // a prefix is a different person
    ["Ana López Jr", null],
    ["Ben  Okafor", null], // inner spacing is part of the name
    ["Dee Quinn", null],
    ["", null], // nothing typed never matches
    ["   ", null],
  ];

  it("matches whole names, case-insensitively, after trimming; anything else is a new person", () => {
    let checked = 0;
    for (const [typed, id] of rows) {
      expect(findPersonByName(directory, typed)?.id ?? null, JSON.stringify(typed)).toBe(id);
      checked++;
    }
    expect(checked, "anti-vacuity").toBe(rows.length);
    expect(rows.filter(([, id]) => id !== null).length, "both directions are tabled").toBeGreaterThan(0);
    expect(rows.filter(([, id]) => id === null).length).toBeGreaterThan(0);
  });

  it("an empty directory has no duplicate", () => {
    expect(findPersonByName([], "Ana López")).toBeNull();
  });

  it("returns the directory's own row, so the caller selects the existing id", () => {
    expect(findPersonByName(directory, "ben okafor")).toBe(directory[1]);
  });
});
