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
import { KIND_HOOKS, afterEndedBadly, type EndedRow } from "../hooks";

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

// Type-level: the table is keyed by the kind vocabulary, so this stays a compile-time fact too.
const _kinds: Record<OutboxKind, unknown> = KIND_HOOKS;
void _kinds;
