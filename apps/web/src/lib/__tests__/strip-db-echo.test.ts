// stripDbEcho: the fields of a database error that echo the failed statement's data (lib/strip-db-echo.ts).
//
// The two lists below are the RULING (a controller ruling in PR 1009's review fix round), typed here on purpose: the expected values are not
// read from the module under test. A field moved between them is a decision, and this is where it is reviewed.
import { describe, expect, it } from "vitest";
import pino from "pino";
import { stripDbEcho, DB_ECHO_FIELDS } from "../strip-db-echo";

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
