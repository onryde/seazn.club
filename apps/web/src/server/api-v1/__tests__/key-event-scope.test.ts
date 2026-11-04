// SEC1 (owner OK 2026-11-03) — an API key's scope gates the EVENT it sends, not only the route it hits. The pure half: the ONE
// table (`keyScopeForEvent`, key-scopes.ts), decided per engine core type and held to the doors that already gate the same
// events. The DB half — real keys through the real door, at both ledger doors — is
// server/usecases/__tests__/api-key-event-scope.test.ts.
import { describe, expect, it } from "vitest";
import { CORE_EVENT_SCHEMAS } from "@seazn/engine/core";
import { builtinModules } from "@seazn/engine/sports";
import { ORGANISER_ONLY_EVENT_TYPES, ORGANISER_ONLY_SPORT_EVENTS } from "@/lib/organiser-only-events";
import {
  MANAGE_KEY_EVENT_TYPES,
  keyEventScopeRefusal,
  keyScopeForEvent,
  matchKeyRoute,
  scopeSatisfies,
  type KeyScope,
} from "../key-scopes";

/** The decision table (task SEC1's report), one row per core type the engine declares. Typed here on purpose — it is the
 *  spec, not a copy of the code: a core type the engine adds reds the coverage test below until someone decides it. */
const DECISIONS: Readonly<Record<string, { scope: KeyScope; why: string }>> = {
  "core.finalize": { scope: "manage", why: "locks the ledger; its own door, POST /fixtures/:id/finalize, is manage" },
  "core.settle": { scope: "manage", why: "organiser-only (X-ST-2): decides a level or abandoned match" },
  "core.forfeit": { scope: "manage", why: "organiser-only (X-ST-2); its dedicated doors (withdraw, DQ) are manage" },
  "core.abandon": { scope: "manage", why: "organiser-only (X-ST-2): ends a match unplayed" },
  "core.start": { scope: "score", why: "starting play — a scorer's and a device link's first tap" },
  "core.void": { scope: "score", why: "undo of an entry — a scorer's own correction (device links: own events only)" },
  "core.note": { scope: "score", why: "an annotation; moves no score" },
  "core.award": { scope: "score", why: "a per-person award, recorded by the scorer" },
  "core.suspend": { scope: "score", why: "a stoppage — the scorer pauses play" },
  "core.resume": { scope: "score", why: "the stoppage's end" },
  "core.lineup.substitution": { scope: "score", why: "an in-match change, recorded by the scorer" },
  "core.lineup.replacement": { scope: "score", why: "an in-match change, recorded by the scorer" },
  "core.lineup.position": { scope: "score", why: "an in-match change, recorded by the scorer" },
  "core.lineup.retirement": { scope: "score", why: "an in-match change, recorded by the scorer" },
  "core.lineup.entry": { scope: "score", why: "an in-match change, recorded by the scorer" },
};

const CORE_TYPES = Object.keys(CORE_EVENT_SCHEMAS);

describe("SEC1: the scope a key needs to SEND an event", () => {
  it("the empty case first: an empty or unknown type needs only the door's own scope, and a key with no scope satisfies nothing", () => {
    // An unknown type is not this gate's to refuse — the engine refuses it by value (422) after the door let it in.
    expect(keyScopeForEvent("", undefined)).toBe("score");
    expect(keyScopeForEvent("no.such.event", {})).toBe("score");
    expect(keyScopeForEvent("constructor", {})).toBe("score"); // no prototype key is a table row
    // Fail closed: a key ctx that carries no scopes is below every event.
    expect(scopeSatisfies([], "score")).toBe(false);
    expect(scopeSatisfies([], "manage")).toBe(false);
  });

  it("every core type the engine declares is decided, and the table names no type the engine lacks", () => {
    expect(CORE_TYPES.length, "the engine declares core types (zero = nothing checked)").toBeGreaterThan(0);
    expect(CORE_TYPES.filter((t) => !Object.hasOwn(DECISIONS, t)), "an undecided core type").toEqual([]);
    expect(Object.keys(DECISIONS).filter((t) => !CORE_TYPES.includes(t)), "a stale decision").toEqual([]);
  });

  it("keyScopeForEvent answers every decision, whatever the payload", () => {
    let checked = 0;
    for (const type of CORE_TYPES) {
      for (const payload of [undefined, null, {}, { by: "home", reason: "walkover" }]) {
        expect(keyScopeForEvent(type, payload), `${type} ${JSON.stringify(payload)}: ${DECISIONS[type]!.why}`).toBe(DECISIONS[type]!.scope);
        checked++;
      }
    }
    expect(checked).toBe(CORE_TYPES.length * 4);
    expect(checked).toBeGreaterThan(0);
  });

  it("the manage table is exactly the manage rows, and is held to the doors that already gate the same events", () => {
    const manageRows = Object.entries(DECISIONS).filter(([, d]) => d.scope === "manage").map(([t]) => t);
    expect(manageRows.length, "the table has manage rows (zero = nothing gated)").toBeGreaterThan(0);
    expect([...MANAGE_KEY_EVENT_TYPES].sort()).toEqual(manageRows.sort());
    // core.finalize: whatever its own door is gated at, the same event through the ledger doors is gated equally.
    const finalizeDoor = matchKeyRoute("POST", "/api/v1/fixtures/f1/finalize");
    expect(finalizeDoor, "the finalize door is key-reachable").not.toBeNull();
    expect(keyScopeForEvent("core.finalize", {})).toBe(finalizeDoor!.scope);
    // X-ST-2's organiser-only types: never a scorer's, so never the scorer-level key's.
    expect(ORGANISER_ONLY_EVENT_TYPES.length).toBeGreaterThan(0);
    for (const t of ORGANISER_ONLY_EVENT_TYPES) expect(keyScopeForEvent(t, {}), t).toBe("manage");
    // The premise the gate exists for: both ledger doors admit a key BELOW manage, so the route table alone lets a score
    // key send every manage row. Raise either door to manage and this gate has nothing left to do there.
    for (const door of ["/api/v1/fixtures/f1/events", "/api/v1/divisions/d1/events/import"]) {
      const m = matchKeyRoute("POST", door);
      expect(m, door).not.toBeNull();
      expect(m!.scope, door).toBe("score");
    }
  });

  it("every sport event of every sport is score (no sport event records a forfeit by payload since W2b)", () => {
    // A sport event becoming organiser-only by payload (ORGANISER_ONLY_SPORT_EVENTS) answers manage through the shared
    // predicate; this sweep would then name it, and its payload case is owed here.
    expect(Object.keys(ORGANISER_ONLY_SPORT_EVENTS), "a sport event is organiser-only by payload: sweep its payloads here").toEqual([]);
    let checked = 0;
    for (const m of builtinModules) {
      const types = Object.keys((m as { eventSchemas?: Record<string, unknown> }).eventSchemas ?? {});
      expect(types.length, `${m.key} declares sport events`).toBeGreaterThan(0);
      for (const type of types) {
        expect(keyScopeForEvent(type, {}), `${m.key} ${type}`).toBe("score");
        checked++;
      }
    }
    expect(builtinModules.length).toBeGreaterThan(0);
    expect(checked).toBeGreaterThan(builtinModules.length);
  });

  it("the refusal has the route refusal's shape: the key's scopes, the scope needed, the event, and where to fix it", () => {
    const msg = keyEventScopeRefusal(["score"], "manage", "core.finalize");
    expect(msg).toBe(
      "This key is limited to 'score' — sending core.finalize needs the 'manage' scope. Create a key with the right scope in org settings.",
    );
    expect(keyEventScopeRefusal(["read", "score"], "manage", "core.settle")).toContain("limited to 'read', 'score'");
    // The empty case: a ctx with no scopes says so rather than printing an empty quote pair.
    expect(keyEventScopeRefusal([], "score", "core.start")).toBe(
      "This key has no scope — sending core.start needs the 'score' scope. Create a key with the right scope in org settings.",
    );
  });
});
