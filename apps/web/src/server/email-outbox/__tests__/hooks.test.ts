// The kind-hook lookup table and its caller. Spec "The two kinds": a kind may react when one of its rows ends badly
// (the chess invite releases its seat stamp). Pure: the hook is a spy, so this file needs no database.
//
// Claims:
//  - there is exactly one entry per kind in the closed vocabulary, so a third kind cannot be added without a decision
//    about its hook (this task registers none);
//  - afterEndedBadly runs a kind's hook once per row, with that row, and does nothing for an empty list;
//  - a hook that throws is logged and never rethrown, and the rows after it still run (a bad hook on one row must not
//    leave the next seat stamped);
//  - a row that did NOT end badly is refused, because a hook releases a seat and `sent` must never release one.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const logMock = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }));
vi.mock("@/server/logger", () => ({ log: logMock }));

import { ENDED_BADLY_STATUSES, OUTBOX_KINDS, OUTBOX_STATUSES, type OutboxKind } from "../constants";
import { KIND_HOOKS, afterEndedBadly, findUnappliedEndings, type EndedRow } from "../hooks";

const row = (over: Partial<EndedRow> = {}): EndedRow => ({
  id: "00000000-0000-4000-8000-000000000001",
  kind: "chess_invite",
  refType: "fixture_seat",
  refId: "f1:white",
  status: "dead",
  meta: { fixtureId: "f1" },
  ...over,
});

const saved: Partial<typeof KIND_HOOKS> = {};
beforeEach(() => {
  logMock.error.mockClear();
  for (const k of OUTBOX_KINDS) saved[k] = KIND_HOOKS[k];
});
afterEach(() => {
  for (const k of OUTBOX_KINDS) KIND_HOOKS[k] = saved[k]!;
});

describe("KIND_HOOKS", () => {
  it("has one entry for every kind and no other (checked: every kind)", () => {
    expect(Object.keys(KIND_HOOKS).sort()).toEqual([...OUTBOX_KINDS].sort());
    let checked = 0;
    for (const k of OUTBOX_KINDS) {
      expect(typeof KIND_HOOKS[k], k).toBe("object");
      checked++;
    }
    expect(checked).toBe(OUTBOX_KINDS.length);
  });
});

describe("afterEndedBadly", () => {
  it("an empty list does nothing and resolves", async () => {
    const hook = vi.fn(async () => {});
    KIND_HOOKS.chess_invite = { onEndedBadly: hook };
    await expect(afterEndedBadly([])).resolves.toBeUndefined();
    expect(hook).not.toHaveBeenCalled();
  });

  it("runs the row's kind's hook once, with that row, and not the other kind's", async () => {
    const chess = vi.fn(async () => {});
    const magic = vi.fn(async () => {});
    KIND_HOOKS.chess_invite = { onEndedBadly: chess };
    KIND_HOOKS.magic_link = { onEndedBadly: magic };
    const r = row({ kind: "chess_invite" });
    await afterEndedBadly([r]);
    expect(chess).toHaveBeenCalledTimes(1);
    expect(chess).toHaveBeenCalledWith(r);
    expect(magic).not.toHaveBeenCalled();
  });

  it("a kind with no hook is skipped silently", async () => {
    KIND_HOOKS.chess_invite = {};
    await expect(afterEndedBadly([row()])).resolves.toBeUndefined();
    expect(logMock.error).not.toHaveBeenCalled();
  });

  it("every ended-badly status runs the hook (swept: checked = ENDED_BADLY_STATUSES)", async () => {
    const hook = vi.fn(async () => {});
    KIND_HOOKS.chess_invite = { onEndedBadly: hook };
    let checked = 0;
    for (const status of ENDED_BADLY_STATUSES) {
      await afterEndedBadly([row({ status })]);
      checked++;
    }
    expect(checked).toBe(ENDED_BADLY_STATUSES.length);
    expect(hook).toHaveBeenCalledTimes(ENDED_BADLY_STATUSES.length);
  });

  it("a throwing hook is logged and not rethrown, and the rows after it still run", async () => {
    const seen: string[] = [];
    KIND_HOOKS.chess_invite = {
      onEndedBadly: async (r) => {
        seen.push(r.id);
        if (r.id === "a") throw new Error("hook blew up");
      },
    };
    await expect(afterEndedBadly([row({ id: "a" }), row({ id: "b" }), row({ id: "c" })])).resolves.toBeUndefined();
    expect(seen).toEqual(["a", "b", "c"]);
    expect(logMock.error).toHaveBeenCalledTimes(1);
    const [fields] = logMock.error.mock.calls[0]!;
    expect(fields).toMatchObject({ outboxId: "a", kind: "chess_invite" });
  });

  it("a synchronous throw from a hook is handled the same way", async () => {
    KIND_HOOKS.magic_link = {
      onEndedBadly: (() => {
        throw new Error("sync boom");
      }) as unknown as (r: EndedRow) => Promise<void>,
    };
    await expect(afterEndedBadly([row({ kind: "magic_link" })])).resolves.toBeUndefined();
    expect(logMock.error).toHaveBeenCalledTimes(1);
  });

  it("refuses a row that did not end badly: the hook is not run and the refusal is logged (swept over the other statuses)", async () => {
    const hook = vi.fn(async () => {});
    KIND_HOOKS.chess_invite = { onEndedBadly: hook };
    const notBad = OUTBOX_STATUSES.filter((s) => !ENDED_BADLY_STATUSES.includes(s));
    let checked = 0;
    for (const status of notBad) {
      await afterEndedBadly([row({ status })]);
      checked++;
    }
    expect(checked).toBe(OUTBOX_STATUSES.length - ENDED_BADLY_STATUSES.length);
    expect(checked).toBeGreaterThan(0);
    expect(hook).not.toHaveBeenCalled();
    expect(logMock.error).toHaveBeenCalledTimes(notBad.length);
  });

  it("does not log the row's meta or any body (ids and status only)", async () => {
    KIND_HOOKS.chess_invite = {
      onEndedBadly: async () => {
        throw new Error("x");
      },
    };
    await afterEndedBadly([row({ meta: { stampedAt: "2026-10-23T00:00:00.000Z", token: "SECRET-LEAK" } })]);
    expect(JSON.stringify(logMock.error.mock.calls)).not.toContain("SECRET-LEAK");
  });
});

// R9 (M2): a hook runs AFTER the terminal write, in the same process, so a process that dies between the two (or a hook
// that throws) leaves a badly-ended row whose effect was never applied. A kind says how to FIND those rows from its own
// state (a chess seat still stamped while every row for it has ended badly); the worker re-drives them. The hook must
// recompute from state, so running it again for an already-applied row is harmless.
describe("findUnappliedEndings", () => {
  it("a kind with no finder contributes nothing, and nothing is asked of it (the default table is exactly that)", async () => {
    KIND_HOOKS.chess_invite = { onEndedBadly: vi.fn(async () => {}) };
    KIND_HOOKS.magic_link = {};
    await expect(findUnappliedEndings(10)).resolves.toEqual([]);
    expect(logMock.error).not.toHaveBeenCalled();
  });

  it("asks each kind's finder for at most the limit and returns every kind's rows", async () => {
    const chess = vi.fn(async () => [row({ id: "c1" }), row({ id: "c2" })]);
    const magic = vi.fn(async () => [row({ id: "m1", kind: "magic_link", status: "expired" })]);
    KIND_HOOKS.chess_invite = { findUnapplied: chess };
    KIND_HOOKS.magic_link = { findUnapplied: magic };
    const found = await findUnappliedEndings(7);
    expect(chess).toHaveBeenCalledWith(7);
    expect(magic).toHaveBeenCalledWith(7);
    expect(found.map((r) => r.id).sort()).toEqual(["c1", "c2", "m1"]);
    expect(found.length, "rows found").toBe(3);
  });

  it("a finder that ignores the limit is cut to it (the tick's work stays bounded whatever a kind returns)", async () => {
    KIND_HOOKS.chess_invite = { findUnapplied: async () => [row({ id: "a" }), row({ id: "b" }), row({ id: "c" })] };
    KIND_HOOKS.magic_link = {};
    expect((await findUnappliedEndings(2)).map((r) => r.id)).toEqual(["a", "b"]);
    const asked = vi.fn(async () => [row({ id: "z" })]);
    KIND_HOOKS.chess_invite = { findUnapplied: asked };
    expect(await findUnappliedEndings(0)).toEqual([]);
    expect(asked, "a limit of nothing asks for nothing").not.toHaveBeenCalled();
  });

  // Both orders: a throw must not stop the kinds AFTER it, and must not discard the rows of the kinds BEFORE it. With two
  // kinds each order exercises one of those (the loop runs the vocabulary's order, so the first kind has a successor and the
  // last has a predecessor).
  const [FIRST_KIND, LAST_KIND] = [OUTBOX_KINDS[0], OUTBOX_KINDS[OUTBOX_KINDS.length - 1]!] as [OutboxKind, OutboxKind];
  it.each([
    { throwing: FIRST_KIND, healthy: LAST_KIND },
    { throwing: LAST_KIND, healthy: FIRST_KIND },
  ])("a finder that throws ($throwing) is logged by name and does not stop or lose the other kind's rows ($healthy)", async ({ throwing, healthy }) => {
    expect(FIRST_KIND, "two distinct kinds, or the order cases below are one case").not.toBe(LAST_KIND);
    KIND_HOOKS[throwing] = {
      findUnapplied: async () => {
        throw new Error("SECRET-LEAK finder blew up");
      },
    };
    KIND_HOOKS[healthy] = { findUnapplied: async () => [row({ id: "h1", kind: healthy, status: "dead" })] };
    const found = await findUnappliedEndings(10);
    expect(found.map((r) => r.id)).toEqual(["h1"]);
    expect(logMock.error).toHaveBeenCalledTimes(1);
    expect(logMock.error.mock.calls[0]![0]).toMatchObject({ kind: throwing });
    expect(JSON.stringify(logMock.error.mock.calls), "raw error text is not logged").not.toContain("SECRET-LEAK");
  });

  it("a row of another kind is dropped and logged: one kind's finder cannot fire another kind's hook", async () => {
    const magic = vi.fn(async () => {});
    KIND_HOOKS.chess_invite = { findUnapplied: async () => [row({ id: "wrong", kind: "magic_link" }), row({ id: "ok" })] };
    KIND_HOOKS.magic_link = { onEndedBadly: magic };
    const found = await findUnappliedEndings(10);
    expect(found.map((r) => r.id)).toEqual(["ok"]);
    expect(logMock.error).toHaveBeenCalledTimes(1);
    expect(logMock.error.mock.calls[0]![0]).toMatchObject({ outboxId: "wrong" });
  });

  it("a synchronous throw from a finder is handled the same way", async () => {
    KIND_HOOKS.chess_invite = {
      findUnapplied: (() => {
        throw new Error("sync boom");
      }) as unknown as () => Promise<EndedRow[]>,
    };
    KIND_HOOKS.magic_link = {};
    await expect(findUnappliedEndings(10)).resolves.toEqual([]);
    expect(logMock.error).toHaveBeenCalledTimes(1);
  });
});

// Type-level: the table is keyed by the kind vocabulary, so this stays a compile-time fact too.
const _kinds: Record<OutboxKind, unknown> = KIND_HOOKS;
void _kinds;
