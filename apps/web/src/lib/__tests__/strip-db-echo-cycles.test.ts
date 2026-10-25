// SECURITY: a reference back to an error from inside it must not hand the strip the UNSCRUBBED original.
//
// THE BUG (found in review of the console scrub). `walk` marked a node as seen with the node ITSELF while it built the copy, so
// anything below the node that points back at it (`e.self = e`, `e.ctx = { back: e }`, `e.list = [e]`, a cause cycle, a holder that
// contains itself) was given the original, with its `detail`, `where` and `hint`, inside the "clean" copy. `util.inspect` of the
// copy then printed it, at console.error's default depth. The node is now marked with its COPY before the walk goes below it, so a
// back-reference lands on the copy (and prints as `[Circular]`).
//
// No fixture on either end: the error is a REAL postgres.js unique violation raised by Postgres, carrying a unique `leak-canary-...`
// bind value in `detail`, and the assertion is on the TEXT `util.inspect` makes of what the strip returns (what a log line is made
// of), in both modes: `stripDbEcho` (the plain-data form the logger's serializer and Sentry's hooks use) and
// `stripDbEchoFromErrors` (the form the console wrapper prints). Each shape also carries a positive pair: the same shape unstripped
// prints the canary, so a clean result is not a rig that cannot see it.
//
// Needs a database (DATABASE_URL): the statement must really fail in Postgres for the driver to build its own error.
import { afterAll, describe, expect, it, vi } from "vitest";
import { inspect } from "node:util";
import { randomBytes } from "node:crypto";
import pino from "pino";
import { LOGGER_OPTIONS } from "@/server/logger";
import { sql } from "@/lib/db";
import { stripDbEcho, stripDbEchoFromErrors } from "../strip-db-echo";

const HAS_DB = !!process.env.DATABASE_URL;

type G = { _sql?: { end(): Promise<void> } };
const g = globalThis as unknown as G;

async function dropClient(): Promise<void> {
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
}
afterAll(async () => {
  vi.unstubAllEnvs();
  await dropClient();
});

type DriverError = Error & Record<string, unknown>;

async function uniqueViolation(canary: string): Promise<DriverError> {
  vi.stubEnv("VITEST", ""); // the production client: no statement counter
  await dropClient();
  const err = await sql
    .begin(async (tx) => {
      await tx`create temp table strip_cycle_probe (id int primary key, email text unique not null) on commit drop`;
      await tx`insert into strip_cycle_probe values (1, ${canary})`;
      await tx`insert into strip_cycle_probe values (2, ${canary})`;
    })
    .then(
      () => null,
      (e: unknown) => e,
    );
  await dropClient();
  vi.unstubAllEnvs();
  if (!(err instanceof Error)) throw new Error("premise: the staged statement must fail");
  return err as DriverError;
}

/** Every way something below an error (or the thing holding it) can point back up at it. Each returns the value to strip. */
const SHAPES: { name: string; build: (e: DriverError) => unknown; entersAtError: boolean }[] = [
  { name: "e.self = e", build: (e) => ((e.self = e), e), entersAtError: true },
  { name: "e.ctx = { back: e }", build: (e) => ((e.ctx = { back: e }), e), entersAtError: true },
  { name: "e.list = [e]", build: (e) => ((e.list = [e]), e), entersAtError: true },
  { name: "a cause cycle, entered at the database error", build: (e) => ((e.cause = new Error("wrapper", { cause: e })), e), entersAtError: true },
  {
    name: "a cause cycle, entered at the wrapper",
    build: (e) => {
      const w = new Error("wrapper", { cause: e });
      e.cause = w;
      return w;
    },
    entersAtError: false,
  },
  {
    name: "a plain holder that points at itself",
    build: (e) => {
      const h: Record<string, unknown> = { err: e };
      h.me = h;
      return h;
    },
    entersAtError: false,
  },
  {
    name: "an array that contains itself",
    build: (e) => {
      const a: unknown[] = [e];
      a.push(a);
      return a;
    },
    entersAtError: false,
  },
];

const MODES: { name: string; strip: (v: unknown) => unknown }[] = [
  { name: "stripDbEcho (logger serializer, Sentry hooks)", strip: (v) => stripDbEcho(v) },
  { name: "stripDbEchoFromErrors (console wrapper)", strip: (v) => stripDbEchoFromErrors(v) },
];

describe.skipIf(!HAS_DB)("a back-reference inside an error does not carry its echoed data into the copy", () => {
  it("every cycle shape, in both modes: the text util.inspect makes of the result has no canary, and still has the SQLSTATE and message", async () => {
    let checked = 0;
    for (const shape of SHAPES) {
      for (const mode of MODES) {
        const canary = `leak-canary-${randomBytes(10).toString("hex")}@example.invalid`;
        const err = await uniqueViolation(canary);
        const input = shape.build(err);
        const where = `${shape.name} / ${mode.name}`;

        // PREMISE (positive pair): the unstripped shape prints the canary, at console.error's depth and at a deeper one.
        expect(String(err.detail), `${where}: Postgres echoed the bind value in detail`).toContain(canary);
        expect(inspect(input), `${where}: premise, the raw value prints the canary`).toContain(canary);

        const out = mode.strip(input);
        for (const [label, text] of [
          ["default depth", inspect(out)],
          ["depth 8", inspect(out, { depth: 8 })],
        ] as const) {
          expect(text, `${where} (${label}): no canary`).not.toContain(canary);
          expect(text, `${where} (${label}): the SQLSTATE is still printed`).toContain("23505");
          expect(text, `${where} (${label}): the message is still printed`).toContain("duplicate key value violates unique constraint");
        }
        // The copy points at itself where the original did: a cycle stays a cycle rather than being flattened or dropped.
        expect(inspect(out, { depth: 8 }), `${where}: the cycle is still a cycle`).toMatch(/\[Circular \*\d+\]/);
        // The input is untouched.
        expect(String(err.detail), `${where}: the original keeps its detail`).toContain(canary);
        checked += 1;
      }
    }
    expect(checked, "anti-vacuity: every shape was checked in both modes").toBe(SHAPES.length * MODES.length);
  });

  it("the logger's own err serializer (pino) holds for the shapes that start at an error", async () => {
    const lines: string[] = [];
    const sink = pino({ ...LOGGER_OPTIONS, level: "trace" }, { write: (s: string) => { lines.push(s); } });
    let checked = 0;
    for (const shape of SHAPES.filter((s) => s.entersAtError)) {
      const canary = `leak-canary-${randomBytes(10).toString("hex")}@example.invalid`;
      const err = await uniqueViolation(canary);
      lines.length = 0;
      sink.error({ err: shape.build(err) }, "cyclic");
      expect(lines.length, `${shape.name}: a line was written`).toBe(1);
      expect(lines[0], `${shape.name}: no canary on the pino line`).not.toContain(canary);
      expect(lines[0], `${shape.name}: the SQLSTATE is still logged`).toContain("23505");
      checked += 1;
    }
    expect(checked, "anti-vacuity").toBeGreaterThan(0);
  });
});
