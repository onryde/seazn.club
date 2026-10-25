// stripDbEcho: the fields of a database error that echo the failed statement's data (lib/strip-db-echo.ts).
//
// The two lists below are the RULING (a controller ruling in PR 1009's review fix round), typed here on purpose: the expected values are not
// read from the module under test. A field moved between them is a decision, and this is where it is reviewed.
import { describe, expect, it } from "vitest";
import { inspect } from "node:util";
import pino from "pino";
import { stripDbEcho, stripDbEchoFromErrors, DB_ECHO_FIELDS } from "../strip-db-echo";

const DROPPED = ["detail", "where", "hint", "internal_query", "parameters", "query", "args", "types"];
const KEPT = ["name", "message", "code", "constraint_name", "table_name", "column_name", "schema_name", "stack"];

const SECRET = "echoed-secret-value";

/** An error-shaped object (what pino's serializer, or Sentry's normaliser, makes of a driver error) with every field set. */
function everyField(): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  for (const k of [...DROPPED, ...KEPT]) o[k] = DROPPED.includes(k) ? `${k}: ${SECRET}` : `${k}-value`;
  o.stack = "PostgresError: boom\n    at somewhere";
  return o;
}

describe("stripDbEcho", () => {
  it("drops each echo field and keeps each kept field, on an error-shaped object (8 + 8 checked)", () => {
    const out = stripDbEcho(everyField());
    let dropped = 0;
    let kept = 0;
    for (const k of DROPPED) {
      expect(out, `${k} must be gone`).not.toHaveProperty(k);
      dropped += 1;
    }
    for (const k of KEPT) {
      expect(out, `${k} must stay`).toHaveProperty(k);
      kept += 1;
    }
    expect(dropped).toBe(8);
    expect(kept).toBe(8);
    expect(DB_ECHO_FIELDS.slice().sort(), "the module's own list is the ruling's").toEqual(DROPPED.slice().sort());
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });

  it("takes an Error INSTANCE apart into a plain object that still has its name, message, stack, code and cause", () => {
    const cause = new Error("the cause");
    const err = Object.assign(new Error("duplicate key value", { cause }), { name: "PostgresError", code: "23505", constraint_name: "t_email_key" }, {
      detail: `Key (email)=(${SECRET}) already exists.`,
      parameters: [SECRET],
    });
    const out = stripDbEcho(err) as unknown as Record<string, unknown>;
    expect(out).not.toBeInstanceOf(Error);
    expect(out).toMatchObject({ name: "PostgresError", message: "duplicate key value", code: "23505", constraint_name: "t_email_key" });
    expect(typeof out.stack).toBe("string");
    expect((out.cause as { message: string }).message).toBe("the cause");
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });

  it("cleans an error nested in a field of an error, as pino's own serializer leaves it", () => {
    const inner = Object.assign(new Error("inner"), { detail: `Failing row contains (${SECRET})` });
    const outer = Object.assign(new Error("outer"), { inner });
    const serialized = pino.stdSerializers.err(outer);
    expect(JSON.stringify(serialized), "premise: pino's serializer carries the nested detail").toContain(SECRET);
    expect(JSON.stringify(stripDbEcho(serialized))).not.toContain(SECRET);
  });

  it("reaches an error in an array, deep in an event-shaped tree (a console breadcrumb's data.arguments)", () => {
    const event = {
      breadcrumbs: [{ category: "console", data: { arguments: ["unhandled", everyField()] } }],
      extra: { note: "kept" },
    };
    const out = stripDbEcho(event);
    expect(JSON.stringify(out)).not.toContain(SECRET);
    expect(out.breadcrumbs[0].data.arguments[0]).toBe("unhandled");
    expect(out.extra).toBe(event.extra);
    expect(JSON.stringify(event), "the input is not mutated").toContain(SECRET);
  });

  it("does not over-scrub: a field named like an echo field on something that is not an error stays", () => {
    const plain = { query: "q=1", args: [1], detail: "d", where: "w", hint: "h", types: ["t"] };
    expect(stripDbEcho(plain)).toBe(plain);
    // message + name but no stack: a log attribute, not an error.
    const attr = { message: "m", name: "n", detail: "kept" };
    expect(stripDbEcho(attr)).toBe(attr);
    const tree = { request: { query_string: "a=b" }, list: [{ query: "x" }] };
    expect(stripDbEcho(tree)).toBe(tree);
  });

  it("passes non-data through, keeps the reference of a clean branch, and survives a cycle", () => {
    expect(stripDbEcho(null)).toBeNull();
    expect(stripDbEcho(undefined)).toBeUndefined();
    expect(stripDbEcho("detail: x")).toBe("detail: x");
    expect(stripDbEcho(7)).toBe(7);
    const date = new Date();
    expect(stripDbEcho(date)).toBe(date);
    const clean = { a: { b: [1, 2, { c: 3 }] } };
    expect(stripDbEcho(clean)).toBe(clean);
    const loop: Record<string, unknown> = { message: "m", stack: "s", detail: SECRET };
    loop.self = loop;
    const out = stripDbEcho(loop);
    expect(out).not.toHaveProperty("detail");
  });
});

// stripDbEchoFromErrors: the same strip, for a value that is about to be PRINTED (console.error), where an Error must stay an Error so
// the line keeps its `PostgresError: message` head and its stack frames. Same field list, same walk, same depth and cycle handling
// (they are one function in the module); the differences are only what the output is made of.
describe("stripDbEchoFromErrors", () => {
  /** A driver-shaped error: own enumerable name and server fields (as PostgresError has them), a cause, every echo field set. */
  function driverError(): Error & Record<string, unknown> {
    const cause = new Error("the cause");
    const err = new Error("duplicate key value", { cause }) as Error & Record<string, unknown>;
    err.name = "PostgresError";
    err.code = "23505";
    err.constraint_name = "t_email_key";
    for (const k of DROPPED) err[k] = `${k}: ${SECRET}`;
    return err;
  }

  it("returns an Error of the same class with its message, stack, name, code and cause, and none of the 8 echo fields (own, enumerable or not)", () => {
    class DriverError extends Error {}
    const err = Object.assign(new DriverError("duplicate key value", { cause: new Error("the cause") }), {
      name: "PostgresError",
      code: "23505",
      constraint_name: "t_email_key",
    }) as unknown as DriverError & Record<string, unknown>;
    // The postgres.js shape with `debug` off: the statement fields exist but are NOT enumerable.
    for (const k of ["query", "parameters", "args", "types"]) Object.defineProperty(err, k, { value: `${k}: ${SECRET}`, enumerable: false });
    for (const k of ["detail", "where", "hint", "internal_query"]) err[k] = `${k}: ${SECRET}`;

    const out = stripDbEchoFromErrors(err);
    expect(out).not.toBe(err);
    expect(out).toBeInstanceOf(DriverError);
    expect(Object.getPrototypeOf(out)).toBe(DriverError.prototype);
    expect(out).toMatchObject({ name: "PostgresError", message: "duplicate key value", code: "23505", constraint_name: "t_email_key" });
    expect(out.stack, "the stack is the same string").toBe(err.stack);
    expect((out.cause as Error).message).toBe("the cause");
    expect(Object.keys(out), "message and stack stay non-enumerable, as on an Error").not.toEqual(expect.arrayContaining(["message", "stack"]));
    let checked = 0;
    for (const k of DROPPED) {
      expect(Object.getOwnPropertyNames(out), `${k} must be gone, enumerable or not`).not.toContain(k);
      checked += 1;
    }
    expect(checked).toBe(8);
    expect(inspect(out, { depth: 6 })).not.toContain(SECRET);
    // The input is untouched: code that reads err.detail after the log line still can.
    expect(err.detail).toContain(SECRET);
    expect(Object.getOwnPropertyNames(err)).toEqual(expect.arrayContaining(DROPPED));
  });

  it("prints as the original does, less the echo lines: util.inspect of the copy is util.inspect of the error with only the dropped keys removed", () => {
    const err = driverError();
    const raw = inspect(err, { depth: 6 });
    expect(raw, "premise: the raw rendering carries the secret").toContain(SECRET);
    const expected = raw
      .split("\n")
      .filter((line) => !DROPPED.some((k) => line.startsWith(`  ${k}: `)))
      .join("\n");
    expect(inspect(stripDbEchoFromErrors(err), { depth: 6 })).toBe(expected);
  });

  it("an Error with nothing to strip comes back as the SAME object, and so does a clean cause chain and a clean AggregateError", () => {
    const plain = Object.assign(new Error("boom", { cause: new Error("root") }), { code: "ECONNRESET" });
    expect(stripDbEchoFromErrors(plain)).toBe(plain);
    const agg = new AggregateError([new Error("a"), new Error("b")], "many");
    expect(stripDbEchoFromErrors(agg)).toBe(agg);
    const holder = { err: plain, list: [agg], note: "kept" };
    expect(stripDbEchoFromErrors(holder)).toBe(holder);
    for (const v of [null, undefined, "detail: x", 7, new Date()]) expect(stripDbEchoFromErrors(v)).toBe(v);
  });

  it("strips an echoing error found as a cause, in an AggregateError, and in a plain object holding the error; only the changed branches are copied", () => {
    const clean = new Error("clean sibling");
    const wrapped = new Error("outer", { cause: driverError() });
    const agg = new AggregateError([clean, driverError()], "many");
    const holder = { err: driverError(), untouched: { a: 1 } };

    const w = stripDbEchoFromErrors(wrapped);
    expect(w).not.toBe(wrapped);
    expect(w).toBeInstanceOf(Error);
    expect((w.cause as Error).message).toBe("duplicate key value");
    expect(w.cause).toBeInstanceOf(Error);
    expect(inspect(w, { depth: 6 })).not.toContain(SECRET);

    const a = stripDbEchoFromErrors(agg);
    expect(a).toBeInstanceOf(AggregateError);
    expect(a.errors[0], "the clean sibling keeps its identity").toBe(clean);
    expect(a.errors[1]).not.toBe(agg.errors[1]);
    expect(inspect(a, { depth: 6 })).not.toContain(SECRET);

    const h = stripDbEchoFromErrors(holder);
    expect(h.err).toBeInstanceOf(Error);
    expect(h.untouched).toBe(holder.untouched);
    expect(inspect(h, { depth: 6 })).not.toContain(SECRET);
  });

  it("is the same strip as stripDbEcho for everything that is not an Error instance (error-shaped plain objects, depth, cycles)", () => {
    const plain = everyField();
    expect(stripDbEchoFromErrors(plain)).toEqual(stripDbEcho(plain));
    const loop: Record<string, unknown> = { message: "m", stack: "s", detail: SECRET };
    loop.self = loop;
    expect(stripDbEchoFromErrors(loop)).not.toHaveProperty("detail");
    const attr = { message: "m", name: "n", detail: "kept" };
    expect(stripDbEchoFromErrors(attr)).toBe(attr);
  });
});
