// B07a Task 10 fix round 2 — R62. A tapped fixture's team sheets are SETUP,
// saved through the real lineups API before any tap, built from each side's
// OWN seeded members. A pack event naming a person who is not a seeded member
// of its `by` entrant is a FINDING, never a tolerated key.
import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import type { RawResult, Session } from "../http.ts";
import { PackSchema, type Pack, type PackStream } from "../pack-schema.ts";
import { TINY_PACK_PATH } from "../suites/tiny.ts";
import { personOutsideByEntrantFindings, saveTapLineups, seededMemberRefs, tapLineupSides } from "../tap-setup.ts";

async function tinyPack(): Promise<Pack> {
  return PackSchema.parse(JSON.parse(await readFile(TINY_PACK_PATH, "utf8")));
}

function streamOf(pack: Pack, extKey: string): PackStream {
  const found = pack.streams.find((s) => s.divisionRef === "d-tiny" && s.fixtureExtKey === extKey);
  if (found === undefined) throw new Error(`test: _tiny has no d-tiny stream ${extKey}`);
  return found;
}

/** Two squads in ONE division, two members each — the differential a lineup
 *  built from the wrong entrant, or from every member of the division, fails. */
const TWO_SQUADS = {
  entrants: [
    {
      ref: "e-home",
      divisionRef: "d-x",
      kind: "team",
      displayName: "Home",
      roster: [
        { person: "p-h1", captain: false, roles: [] },
        { person: "p-h2", captain: false, roles: [] },
      ],
    },
    {
      ref: "e-away",
      divisionRef: "d-x",
      kind: "team",
      displayName: "Away",
      roster: [
        { person: "p-a1", captain: false, roles: [] },
        { person: "p-a2", captain: false, roles: [] },
      ],
    },
  ],
} as unknown as Pick<Pack, "entrants">;

const SESSION = {} as Session;

function recorder(answer: (path: string) => RawResult = () => ({ status: 200, json: { ok: true, data: {} } as never })) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  return {
    calls,
    transport: {
      async raw(_base: string, _s: Session, path: string, method = "GET", body?: unknown): Promise<RawResult> {
        calls.push({ method, path, body });
        return answer(path);
      },
    },
  };
}

describe("seededMemberRefs — an entrant's seeded members are its OWN roster (R62)", () => {
  it("returns that entrant's members in roster order, never a sibling entrant's", () => {
    expect(seededMemberRefs(TWO_SQUADS, "e-home")).toEqual(["p-h1", "p-h2"]);
    expect(seededMemberRefs(TWO_SQUADS, "e-away")).toEqual(["p-a1", "p-a2"]);
  });

  it("an entrant the pack does not declare has no members", () => {
    expect(seededMemberRefs(TWO_SQUADS, "e-nobody")).toEqual([]);
  });

  it("_tiny's d-tiny entrants: p-ana is e-alpha's one member, p-bo is e-bravo's", async () => {
    const pack = await tinyPack();
    expect(seededMemberRefs(pack, "e-alpha")).toEqual(["p-ana"]);
    expect(seededMemberRefs(pack, "e-bravo")).toEqual(["p-bo"]);
  });
});

describe("tapLineupSides — each side's sheet comes from THAT side's entrant (R62)", () => {
  it("rr-r2 has e-bravo at home: home gets p-bo, away gets p-ana", async () => {
    const pack = await tinyPack();
    expect(tapLineupSides(pack, streamOf(pack, "rr-r2-c1"))).toEqual([
      { side: "home", entrantRef: "e-bravo", personRefs: ["p-bo"] },
      { side: "away", entrantRef: "e-alpha", personRefs: ["p-ana"] },
    ]);
  });

  it("follows the stream's sides, not the pack's entrant order", () => {
    expect(tapLineupSides(TWO_SQUADS, { home: "e-away", away: "e-home" })).toEqual([
      { side: "home", entrantRef: "e-away", personRefs: ["p-a1", "p-a2"] },
      { side: "away", entrantRef: "e-home", personRefs: ["p-h1", "p-h2"] },
    ]);
  });
});

describe("personOutsideByEntrantFindings — a person outside their `by` entrant is a FINDING (R62)", () => {
  it("every d-tiny stream in _tiny names only its `by` entrant's own members", async () => {
    const pack = await tinyPack();
    const dTiny = pack.streams.filter((s) => s.divisionRef === "d-tiny");
    expect(dTiny.length).toBeGreaterThan(0);
    for (const stream of dTiny) expect(personOutsideByEntrantFindings(pack, stream)).toEqual([]);
  });

  it("names the event, the person and the entrant when a person is not that entrant's member", async () => {
    const pack = await tinyPack();
    const findings = personOutsideByEntrantFindings(pack, {
      events: [
        { type: "core.start" },
        { type: "generic.score", payload: { by: "@e-alpha", points: 1, person: "@p-bo" } },
        { type: "generic.score", payload: { by: "@e-alpha", points: 1, person: "@p-ana" } },
        { type: "generic.score", payload: { by: "@e-bravo", points: 1 } },
      ],
    } as unknown as Pick<PackStream, "events">);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatch(/event 1 \(generic\.score\).*"p-bo".*not a seeded member.*"e-alpha"/);
  });
});

describe("saveTapLineups — PUTs each side's sheet through the lineups API (R62)", () => {
  const entrantIdByRef = new Map([
    ["e-bravo", "id-bravo"],
    ["e-alpha", "id-alpha"],
  ]);
  const personIdByRef = new Map([
    ["p-bo", "id-bo"],
    ["p-ana", "id-ana"],
  ]);
  const sides = [
    { side: "home", entrantRef: "e-bravo", personRefs: ["p-bo"] },
    { side: "away", entrantRef: "e-alpha", personRefs: ["p-ana"] },
  ] as const;

  it("writes one PUT per side, to that side's entrant, naming that side's resolved members", async () => {
    const rec = recorder();
    const findings = await saveTapLineups({
      base: "http://bench.example",
      session: SESSION,
      fixtureId: "fx-1",
      sides,
      entrantIdByRef,
      personIdByRef,
      transport: rec.transport,
    });
    expect(findings).toEqual([]);
    expect(rec.calls).toEqual([
      {
        method: "PUT",
        path: "/api/v1/fixtures/fx-1/lineups/id-bravo",
        body: { slots: [{ person_id: "id-bo", slot: "starting", order_no: 1 }] },
      },
      {
        method: "PUT",
        path: "/api/v1/fixtures/fx-1/lineups/id-alpha",
        body: { slots: [{ person_id: "id-ana", slot: "starting", order_no: 1 }] },
      },
    ]);
  });

  it("a refused PUT is a finding naming the side, the entrant, the status and the code", async () => {
    const rec = recorder((path) =>
      path.endsWith("/id-bravo")
        ? ({ status: 422, json: { ok: false, error: { code: "VALIDATION", message: "not a member" } } } as unknown as RawResult)
        : ({ status: 200, json: { ok: true, data: {} } } as unknown as RawResult),
    );
    const findings = await saveTapLineups({
      base: "http://bench.example",
      session: SESSION,
      fixtureId: "fx-1",
      sides,
      entrantIdByRef,
      personIdByRef,
      transport: rec.transport,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatch(/home.*"e-bravo".*HTTP 422.*VALIDATION/);
    expect(rec.calls).toHaveLength(2);
  });

  it("an unresolved entrant or member is a finding, and that side is never written half-built", async () => {
    const rec = recorder();
    const findings = await saveTapLineups({
      base: "http://bench.example",
      session: SESSION,
      fixtureId: "fx-1",
      sides: [
        { side: "home", entrantRef: "e-ghost", personRefs: ["p-bo"] },
        { side: "away", entrantRef: "e-alpha", personRefs: ["p-ana", "p-ghost"] },
      ],
      entrantIdByRef,
      personIdByRef,
      transport: rec.transport,
    });
    expect(findings).toHaveLength(2);
    expect(findings[0]).toMatch(/home.*"e-ghost"/);
    expect(findings[1]).toMatch(/away.*"p-ghost"/);
    expect(rec.calls).toEqual([]);
  });

  it("a side with no seeded members writes nothing and reports nothing", async () => {
    const rec = recorder();
    const findings = await saveTapLineups({
      base: "http://bench.example",
      session: SESSION,
      fixtureId: "fx-1",
      sides: [{ side: "home", entrantRef: "e-bravo", personRefs: [] }],
      entrantIdByRef,
      personIdByRef,
      transport: rec.transport,
    });
    expect(findings).toEqual([]);
    expect(rec.calls).toEqual([]);
  });
});
