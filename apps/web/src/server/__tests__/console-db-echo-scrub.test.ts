// SECURITY: what Next itself prints about an error must not carry the data Postgres echoed back in it.
//
// THE LEAK. FU1 (PR 1009) strips a database error's echo fields (`detail` = the unique key or the WHOLE failing row, `where`,
// `hint`, `internal_query`, and the statement fields) in the logger's `err` serializer and in Sentry's hooks. Neither sees what
// the process writes with `console.error`: Next logs an uncaught error in a route handler, a server component or a server action
// with a bare `console.error(err)` (route-module.js `onRequestError`, app-render.js, create-error-handler.js, and `Log.error`
// for base-server's `logError`), and about a dozen call sites in the app log `console.error("...", err)` themselves (credits,
// billing, auth, activation). `console.error` prints an error with `util.inspect`, which writes every ENUMERABLE field, and a
// postgres.js error carries `detail` (and `where`, `hint`) as enumerable fields whatever its `debug` option says.
//
// THE FIX. instrumentation.ts `register()` installs server/console-db-echo-scrub.ts on the process's `console.error`; it runs
// every argument through `stripDbEchoFromErrors` (lib/strip-db-echo.ts: FU1's own list and walk, in the mode that keeps an Error an
// Error), so the printed line is the line it always was minus the dropped fields.
//
// THIS FILE drives the REAL pieces with no fixture on either end: a real postgres.js client (lib/db.ts's own, under the
// production posture AND the statement-counting posture) failing a real statement in Postgres whose bind value is a unique
// `leak-canary-...` string; a REAL node `Console` over a captured stream (the same formatter and the same util.inspect the global
// console uses) with the installer on it; and the error printed through it the way Next prints one. The expected values are not
// read from the module: the "line is unchanged apart from the dropped fields" expectation is the raw util.inspect of the raw
// error, taken before anything touches it, with the ruled-out field lines removed.
//
// Needs a database (DATABASE_URL): the statement must really fail in Postgres for the driver to build its own error.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Console } from "node:console";
import { Writable } from "node:stream";
import { inspect } from "node:util";
import { randomBytes } from "node:crypto";
import { sql } from "@/lib/db";
import { installConsoleDbEchoScrub, scrubConsoleArgs } from "../console-db-echo-scrub";

const HAS_DB = !!process.env.DATABASE_URL;

// The ruling (lib/strip-db-echo.ts, PR 1009), typed here on purpose: the fields whose line must be gone from a printed error.
const ECHO_FIELDS = ["detail", "where", "hint", "internal_query", "parameters", "query", "args", "types"];

type G = { _sql?: { end(): Promise<void> } };
const g = globalThis as unknown as G;

/** The pooled client is a lazy singleton stashed on globalThis; drop it so the next use builds one under the CURRENT env. */
async function dropClient(): Promise<void> {
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
}

/** A node Console over captured streams: the real formatter (`formatWithOptions` + util.inspect), nothing of ours in front of it. */
function capturingConsole(): { target: Console; stderr: () => string } {
  const err: string[] = [];
  const sink = (into: string[]) =>
    new Writable({
      write(chunk, _enc, cb) {
        into.push(String(chunk));
        cb();
      },
    });
  const target = new Console({ stdout: sink([]), stderr: sink(err), colorMode: false });
  return { target, stderr: () => err.join("") };
}

/** Two unique secrets per run: an address-shaped canary (echoed in `detail`) and a token-shaped one (a second column). */
function mintCanaries() {
  const id = randomBytes(10).toString("hex");
  return { email: `leak-canary-${id}@example.invalid`, token: `leak-canary-tok-${id}` };
}

type DriverError = Error & Record<string, unknown>;

/** A genuine unique violation raised by Postgres through the app's own client, with the canaries as bind values. */
async function uniqueViolation(canaries: { email: string; token: string }, counting: boolean): Promise<DriverError> {
  vi.stubEnv("VITEST", counting ? "true" : "");
  await dropClient();
  const err = await sql
    .begin(async (tx) => {
      await tx`create temp table console_scrub_probe (id int primary key, email text unique not null, token text not null) on commit drop`;
      await tx`insert into console_scrub_probe values (1, ${canaries.email}, ${canaries.token})`;
      await tx`insert into console_scrub_probe values (2, ${canaries.email}, ${canaries.token})`;
    })
    .then(
      () => null,
      (e: unknown) => e,
    );
  await dropClient();
  vi.unstubAllEnvs();
  if (!(err instanceof Error)) throw new Error("premise: the staged statement must fail");
  expect((err as DriverError).code, "premise: Postgres refused it for the staged reason").toBe("23505");
  return err as DriverError;
}

beforeEach(() => {
  vi.unstubAllEnvs();
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await dropClient();
});

const POSTURES = [
  { name: "production client (debug off: the statement fields are not enumerable)", counting: false },
  { name: "statement-counting client (debug on: query, parameters, args and types are enumerable too)", counting: true },
];

describe.skipIf(!HAS_DB)("console.error of a real database error, through the installed scrub", () => {
  it.each(POSTURES)("$name: no canary on the line; the message, SQLSTATE, constraint and stack frames stay", async ({ counting }) => {
    const canaries = mintCanaries();
    const all = [canaries.email, canaries.token];
    const err = await uniqueViolation(canaries, counting);

    // PREMISE: the leak is real. The error carries the canary in `detail`, and the same Console without the scrub prints it.
    expect(String(err.detail), "Postgres echoed the bind value in `detail`").toContain(canaries.email);
    const rawConsole = capturingConsole();
    rawConsole.target.error(err);
    expect(rawConsole.stderr(), "an unscrubbed console.error(err) prints the canary").toContain(canaries.email);
    if (counting) {
      expect(Object.keys(err), "the counting posture makes the statement fields enumerable").toEqual(
        expect.arrayContaining(["query", "parameters", "args", "types"]),
      );
      expect(rawConsole.stderr(), "and the bind values come out with them").toContain(canaries.token);
    }

    // THE FIX, through the Console the scrub is installed on.
    const { target, stderr } = capturingConsole();
    installConsoleDbEchoScrub(target);
    target.error(err);
    const line = stderr();
    expect(line.length, "anti-vacuity: something was printed").toBeGreaterThan(0);
    for (const s of all) expect(line, `the printed error must not contain ${s}`).not.toContain(s);
    // Nothing else was swallowed: the head, the SQLSTATE, the constraint, and the stack frames (the same ones the raw print has).
    expect(line.startsWith(`PostgresError: ${err.message}\n`), "the line keeps its `PostgresError: message` head").toBe(true);
    expect(line).toContain("code: '23505'");
    expect(line).toContain(`constraint_name: '${String(err.constraint_name)}'`);
    const frames = String(err.stack).split("\n").slice(1);
    expect(frames.length, "anti-vacuity: the error has stack frames").toBeGreaterThan(3);
    for (const frame of frames) expect(line, "every stack frame is still printed").toContain(frame);
    // And the error object itself is untouched: code that reads err.detail after the line is printed still can.
    expect(String(err.detail)).toContain(canaries.email);
  });

  it("the printed line is the raw one minus exactly the dropped fields' lines (production client)", async () => {
    const canaries = mintCanaries();
    const err = await uniqueViolation(canaries, false);
    // Taken from the raw error before anything touches it; node's own rendering is the authority on what the line looked like.
    const raw = inspect(err, { depth: 6 });
    const dropped = raw.split("\n").filter((l) => ECHO_FIELDS.some((k) => l.startsWith(`  ${k}: `)));
    expect(dropped.length, "anti-vacuity: the raw line has an echo field line to drop").toBeGreaterThan(0);
    expect(dropped.join("\n")).toContain(canaries.email);
    const expected = raw
      .split("\n")
      .filter((l) => !dropped.includes(l))
      .join("\n");

    const { target, stderr } = capturingConsole();
    installConsoleDbEchoScrub(target);
    target.error(err);
    expect(stderr()).toBe(`${expected}\n`);
  });

  it("every shape the app and Next print an error in is clean: a message and the error, an object holding it, a wrapper's cause, an AggregateError", async () => {
    const canaries = mintCanaries();
    const err = await uniqueViolation(canaries, false);
    const forms: [string, unknown[]][] = [
      ["bare (Next: console.error(err))", [err]],
      ["after a message (credits.ts: console.error(`...`, err))", ["[credits] earn grant failed (org o1, signup)", err]],
      ["after two arguments (billing.ts: console.error(label, orgId, err))", ["syncPaymentMethodFlagFromCards: mirror write failed", "org-1", err]],
      ["inside an object", [{ err, context: "x" }]],
      ["as the cause of another error", [new Error("wrapper", { cause: err })]],
      ["in an AggregateError", [new AggregateError([new Error("clean sibling"), err], "many")]],
    ];
    let clean = 0;
    for (const [label, args] of forms) {
      const { target, stderr } = capturingConsole();
      installConsoleDbEchoScrub(target);
      target.error(...args);
      const line = stderr();
      expect(line.length, `${label}: something was printed`).toBeGreaterThan(0);
      expect(line, `${label}: the canary must not be printed`).not.toContain(canaries.email);
      expect(line, `${label}: the SQLSTATE is still printed`).toContain("23505");
      expect(line, `${label}: the message is still printed`).toContain("duplicate key value violates unique constraint");
      clean += 1;
    }
    expect(clean, "anti-vacuity: every form was checked").toBe(forms.length);
  });
});

// The other half: what the scrub must not touch. These need no database.
describe("console.error of anything else is untouched", () => {
  it("a non-database Error reaches the underlying console.error as the SAME object, and prints exactly as the plain console does", () => {
    const plain = Object.assign(new Error("boom", { cause: new Error("root") }), { code: "ECONNRESET" });
    const under = vi.fn();
    const target = { error: under } as unknown as Pick<Console, "error">;
    installConsoleDbEchoScrub(target);
    target.error("while saving", plain, { n: 1 }, 7, null);
    expect(under).toHaveBeenCalledTimes(1);
    const sent = under.mock.calls[0];
    expect(sent[1], "the very same Error object").toBe(plain);
    expect(sent.length).toBe(5);

    const a = capturingConsole();
    const b = capturingConsole();
    installConsoleDbEchoScrub(b.target);
    a.target.error(plain);
    b.target.error(plain);
    expect(a.stderr().length, "anti-vacuity: the plain console printed it").toBeGreaterThan(0);
    expect(b.stderr()).toBe(a.stderr());
  });

  it("strings, format specifiers and a call with no arguments pass through", () => {
    const a = capturingConsole();
    const b = capturingConsole();
    installConsoleDbEchoScrub(b.target);
    for (const t of [a.target, b.target]) {
      t.error("plain message");
      t.error("%s has %d items", "cart", 3);
      t.error();
    }
    expect(a.stderr().length).toBeGreaterThan(0);
    expect(b.stderr()).toBe(a.stderr());
  });

  it("an error-shaped log attribute that is not an Error keeps a field that merely shares an echo name", () => {
    const attr = { message: "m", name: "n", detail: "kept" };
    expect(scrubConsoleArgs([attr])[0]).toBe(attr);
  });
});

describe("installing the scrub", () => {
  it("is idempotent (a second install, as dev's re-run of register() does, wraps nothing more), and the returned function restores the original", () => {
    const under = vi.fn();
    const target = { error: under } as unknown as Pick<Console, "error">;
    const uninstall = installConsoleDbEchoScrub(target);
    expect(target.error).not.toBe(under);
    const first = target.error;
    const second = installConsoleDbEchoScrub(target);
    expect(target.error, "a second install leaves the first wrapper in place").toBe(first);
    target.error("x");
    expect(under, "the original is called exactly once per call").toHaveBeenCalledTimes(1);
    second(); // the no-op uninstall of a repeat install
    expect(target.error).toBe(first);
    uninstall();
    expect(target.error).toBe(under);
  });

  it("fails closed: if the scrub itself throws, the call does not throw and the arguments are withheld, not printed raw", () => {
    const secret = `leak-canary-${randomBytes(6).toString("hex")}`;
    const hostile = {
      get boom(): string {
        throw new Error("a getter that throws");
      },
      secret,
    };
    const { target, stderr } = capturingConsole();
    installConsoleDbEchoScrub(target);
    expect(() => target.error("context", hostile)).not.toThrow();
    const line = stderr();
    expect(line, "a note says arguments were withheld").toContain("withheld");
    expect(line, "and nothing of them was printed").not.toContain(secret);
    expect(line).not.toContain("context");
  });
});
