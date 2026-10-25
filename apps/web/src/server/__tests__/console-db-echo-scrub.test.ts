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
import { format, inspect } from "node:util";
import { randomBytes } from "node:crypto";
import { sql } from "@/lib/db";
import { formatSpecifiersReach, installConsoleDbEchoScrub, scrubConsoleArgs } from "../console-db-echo-scrub";

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

  it("fails closed PER ARGUMENT: an argument the scrub cannot read is withheld, the others (the message strings) still print", () => {
    const secret = `leak-canary-${randomBytes(6).toString("hex")}`;
    // A Proxy whose trap throws: `instanceof Error` (the strip's first question) asks it for its prototype.
    const hostile = new Proxy(
      { secret },
      {
        getPrototypeOf() {
          throw new Error("a trap that throws");
        },
      },
    );
    const { target, stderr } = capturingConsole();
    installConsoleDbEchoScrub(target);
    expect(() => target.error("context message", hostile, "after")).not.toThrow();
    const line = stderr();
    expect(line, "the unreadable argument is replaced by a note").toContain("withheld");
    expect(line, "and none of it was printed").not.toContain(secret);
    expect(line, "the message before it still prints").toContain("context message");
    expect(line, "and so does the argument after it").toContain("after");

    // The unit under the Console: one withheld note in the slot of the one argument, the rest by identity.
    const err = new Error("kept");
    const out = scrubConsoleArgs(["m", hostile, err]);
    expect(out.length).toBe(3);
    expect(out[0]).toBe("m");
    expect(String(out[1])).toContain("withheld");
    expect(out[2], "a clean Error after it is the same object").toBe(err);
  });
});

// For a line made by inspect's defaults the scrub walks what inspect prints and no more: its depth and array length are Node's own
// declared defaults, read at the call. (A %j / %o line is another matter: see the format-specifier suites below.)
describe("the scrub walks what console.error prints, bounded by util.inspect's defaults", () => {
  const driverShaped = () => {
    const err = new Error("duplicate key value") as DriverError;
    err.name = "PostgresError";
    err.detail = "Key (email)=(leak-canary-shape) already exists.";
    return err;
  };

  it("an item past the array length inspect prints, and an error past its depth, are neither walked nor printed", () => {
    const late = driverShaped();
    const big: unknown[] = new Array<unknown>(2_000_000).fill(0);
    big[big.length - 1] = late;
    expect(scrubConsoleArgs([big])[0], "nothing printed changed: the very same array").toBe(big);
    expect(inspect(big)).not.toContain("leak-canary-shape");

    const depth = inspect.defaultOptions.depth as number;
    let nested: Record<string, unknown> = { err: driverShaped() };
    for (let i = 0; i < depth + 1; i++) nested = { next: nested };
    expect(inspect(nested), "premise: inspect elides it").not.toContain("leak-canary-shape");
    expect(scrubConsoleArgs([nested])[0], "not walked: the very same object").toBe(nested);
  });

  it("the bounds are read from util.inspect.defaultOptions at the call (not typed here): a deeper default reaches the deeper error", () => {
    const depth = inspect.defaultOptions.depth as number;
    let nested: Record<string, unknown> = { err: driverShaped() };
    for (let i = 0; i < depth + 1; i++) nested = { next: nested };
    expect(scrubConsoleArgs([nested])[0]).toBe(nested);
    const was = inspect.defaultOptions.depth;
    try {
      inspect.defaultOptions.depth = depth + 4;
      const reached = scrubConsoleArgs([nested])[0];
      expect(reached, "with a deeper default the walk reaches it").not.toBe(nested);
      expect(inspect(reached, { depth: depth + 8 })).not.toContain("leak-canary-shape");
    } finally {
      inspect.defaultOptions.depth = was;
    }
  });
});

// Next patches Error.prototype[nodejs.util.inspect.custom] in EVERY server process (server/node-environment-extensions/error-inspect.js,
// loaded by node-environment.js): it rebuilds the error as `new Error(message, { cause })` and copies every enumerable key of `this`
// (reading each one, so an enumerable GETTER is called) before handing it to util.inspect. So what console.error really prints in
// production goes through that, not through the bare formatter the other tests use.
/** Run `fn` with Next's own patch installed, in Next's boot order, and put everything back afterwards. */
async function withNextPatchedInspect<T>(fn: () => Promise<T>): Promise<T> {
  // node-environment-baseline puts AsyncLocalStorage on globalThis (the patch's storage is a fake without it).
  const hadAls = "AsyncLocalStorage" in globalThis;
  // @ts-expect-error -- a side-effect-only module whose declaration file is empty, so TypeScript does not call it a module
  await import("next/dist/server/node-environment-baseline");
  const { patchErrorInspectNodeJS } = await import("next/dist/server/patch-error-inspect");
  const inspectSymbol = Symbol.for("nodejs.util.inspect.custom");
  const priorPrepare = Error.prepareStackTrace;
  const priorCustom = Object.getOwnPropertyDescriptor(Error.prototype, inspectSymbol);
  try {
    patchErrorInspectNodeJS(Error);
    expect(Object.getOwnPropertyDescriptor(Error.prototype, inspectSymbol), "premise: Next's patch is installed").toBeDefined();
    return await fn();
  } finally {
    Error.prepareStackTrace = priorPrepare;
    if (!hadAls) delete (globalThis as unknown as Record<string, unknown>).AsyncLocalStorage;
    if (priorCustom) Object.defineProperty(Error.prototype, inspectSymbol, priorCustom);
    else delete (Error.prototype as unknown as Record<symbol, unknown>)[inspectSymbol];
  }
}

describe.skipIf(!HAS_DB)("with Next's patched Error inspect installed", () => {
  it("a real database error printed through the wrapped console has no canary, and still has its message, SQLSTATE and stack", async () => {
    await withNextPatchedInspect(async () => {
      const canaries = mintCanaries();
      const err = await uniqueViolation(canaries, false);

      const raw = capturingConsole();
      raw.target.error(err);
      expect(raw.stderr(), "premise: through Next's inspect, an unscrubbed print carries the canary").toContain(canaries.email);

      const { target, stderr } = capturingConsole();
      installConsoleDbEchoScrub(target);
      target.error("[next] uncaught", err);
      target.error(new Error("wrapper", { cause: err }));
      const line = stderr();
      expect(line.length, "anti-vacuity: something was printed").toBeGreaterThan(0);
      expect(line, "no canary").not.toContain(canaries.email);
      expect(line, "no canary").not.toContain(canaries.token);
      expect(line, "the message is still printed").toContain("duplicate key value violates unique constraint");
      expect(line, "the SQLSTATE is still printed").toContain("23505");
      expect(line, "a stack frame is still printed").toMatch(/\n\s+at /);
      expect(line, "both prints happened").toContain("wrapper");
    });
  });

  it("VECTOR: an Error with an ENUMERABLE GETTER that returns a database error (Next's inspect reads every enumerable key, so it calls it)", async () => {
    await withNextPatchedInspect(async () => {
      const canaries = mintCanaries();
      const db = await uniqueViolation(canaries, false);
      const wrapper = new Error("wrapper with a getter");
      Object.defineProperty(wrapper, "failure", { enumerable: true, get: () => db });

      const raw = capturingConsole();
      raw.target.error(wrapper);
      expect(raw.stderr(), "premise: without the scrub, Next's inspect calls the getter and prints the database error's fields").toContain(canaries.email);

      const { target, stderr } = capturingConsole();
      installConsoleDbEchoScrub(target);
      target.error(wrapper);
      expect(stderr().length, "anti-vacuity: something was printed").toBeGreaterThan(0);
      expect(stderr(), "no canary").not.toContain(canaries.email);
      expect(stderr(), "the wrapper's message is still printed").toContain("wrapper with a getter");
      expect(stderr(), "and the database error's SQLSTATE, which the getter returned").toContain("23505");
    });
  });
});

describe.skipIf(!HAS_DB)("an error that points back at itself, printed through the wrapped console", () => {
  it.each([
    ["e.self = e", (e: DriverError) => void (e.self = e)],
    ["e.ctx = { back: e }", (e: DriverError) => void (e.ctx = { back: e })],
    ["e.list = [e]", (e: DriverError) => void (e.list = [e])],
  ])("%s: no canary on the line", async (_name, link) => {
    const canaries = mintCanaries();
    const err = await uniqueViolation(canaries, false);
    link(err);
    const raw = capturingConsole();
    raw.target.error(err);
    expect(raw.stderr(), "premise: the unscrubbed print carries the canary").toContain(canaries.email);
    const { target, stderr } = capturingConsole();
    installConsoleDbEchoScrub(target);
    target.error(err);
    expect(stderr().length).toBeGreaterThan(0);
    expect(stderr()).not.toContain(canaries.email);
    expect(stderr()).toContain("23505");
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
// A line is not always made by util.inspect's defaults. When the first argument is a FORMAT STRING, util.format hands the operand to
// something else: %j is JSON.stringify (no depth or length limit, and it calls getters), %o is inspect with showHidden and depth 4,
// %O is inspect. So a call whose format has one of those is scrubbed with no bounds.
// ---------------------------------------------------------------------------------------------------------------------------
describe("which calls util.format sends past inspect's limits", () => {
  /**
   * Node is the oracle for %j and %o: what each operand of `format(fmt, ...operands)` was actually consumed by, observed from inside
   * the operand (`toJSON` is JSON.stringify's; `showHidden` is %o's inspect). It cannot see %O: that is `inspect` with its defaults,
   * indistinguishable from the way an unconsumed operand is appended. So %O (which reaches no further than the default print, but
   * is named in the ruling) is typed per row from the documented grammar.
   */
  function consumedBy(fmt: string, operands: number): ("j" | "o" | null)[] {
    const seen: ("j" | "o" | null)[] = Array.from({ length: operands }, () => null);
    const ops = seen.map((_, i) => ({
      toJSON() {
        seen[i] = "j";
        return 1;
      },
      [inspect.custom](_depth: number, options: { showHidden?: boolean }) {
        if (options.showHidden) seen[i] = "o";
        return "x";
      },
    }));
    format(fmt, ...ops);
    return seen;
  }

  // [format, operands, a %O takes an operand (documented grammar; the oracle cannot see it)]
  const TABLE: [string, number, boolean][] = [
    ["%j", 1, false],
    ["%o", 1, false],
    ["%O", 1, true],
    ["%s", 1, false],
    ["%d %i %f %c", 4, false],
    ["%%j", 1, false], //           an escaped percent: the j is text
    ["%%%j", 1, false], //          an escaped percent, then a real %j
    ["100%%", 1, false],
    ["%x%j", 1, false], //          %x is no specifier and consumes nothing; the %j takes the operand
    ["%s%j", 1, false], //          %s takes the only operand; %j finds none and stays text
    ["%s%O", 1, false], //          likewise for %O
    ["%j %o", 2, false],
    ["%s %j", 2, false],
    ["%", 1, false],
    ["tag %j", 1, false],
    ["no specifier at all", 2, false],
    ["%%O", 1, false],
  ];

  it.each(TABLE)("%s with %i operand(s): the module agrees with what Node did to the operands", (fmt, operands, oTakesOperand) => {
    const nodeSays = consumedBy(fmt, operands);
    const json = nodeSays.includes("j");
    const wide = json || nodeSays.includes("o") || oTakesOperand;
    const ours = formatSpecifiersReach([fmt, ...Array.from({ length: operands }, () => ({}))]);
    expect(ours, `${JSON.stringify(fmt)} ${JSON.stringify(nodeSays)}`).toEqual({ json, wide });
  });

  it("anti-vacuity: the table has rows where Node reached past the limits and rows where it did not", () => {
    const outcomes = TABLE.map(([fmt, n, o]) => o || consumedBy(fmt, n).some((c) => c !== null));
    expect(outcomes.filter(Boolean).length).toBeGreaterThan(3);
    expect(outcomes.filter((x) => !x).length).toBeGreaterThan(3);
  });

  it("only the FIRST argument is a format string, and only when something follows it; a later '%j' is text", () => {
    expect(formatSpecifiersReach(["%j"])).toEqual({ json: false, wide: false });
    expect(formatSpecifiersReach(["tag", "%j", {}])).toEqual({ json: false, wide: false });
    expect(formatSpecifiersReach([{ a: 1 }, "%j", {}])).toEqual({ json: false, wide: false });
    expect(formatSpecifiersReach(["%j", {}])).toEqual({ json: true, wide: true });
  });

  it("a call with no such specifier stays bounded (the very same object back); one with %j / %o / %O is walked in full", () => {
    const deep = () => {
      const err = new Error("duplicate key value") as DriverError;
      err.name = "PostgresError";
      err.detail = "Key (email)=(leak-canary-shape) already exists.";
      return { a: { b: { c: { err } } } }; // the error is at level 4: past inspect's default depth, inside %o's
    };
    for (const [fmt, bounded] of [["%%j", true], ["100%%", true], ["%s", true], ["%j", false], ["%o", false], ["%O", false]] as const) {
      const arg = deep();
      const out = scrubConsoleArgs([fmt, arg])[1];
      expect(Object.is(out, arg), `${fmt}: ${bounded ? "left as it was" : "walked and copied"}`).toBe(bounded);
    }
    const arg = deep();
    expect(Object.is(scrubConsoleArgs(["tag", "%j", arg])[2], arg), "a later argument's '%j' is text").toBe(true);
  });
});

describe.skipIf(!HAS_DB)("a line made by a format specifier, with a real database error", () => {
  const nested = (err: Error) => ({ a: { b: { err } } }); // the error is at level 3: past console.error's depth 2, inside %o's 4

  it.each([
    ["%j: a database error at nesting level 3", "%j", (e: Error) => nested(e)],
    ["%j: a database error at item 101 of an array", "%j", (e: Error) => [...Array<number>(100).fill(0), e]],
    ["%j: a database error returned by a getter", "%j", (e: Error) => ({ get failure() { return e; } })],
    ["%o: a database error at nesting level 3", "%o", (e: Error) => nested(e)],
  ] as [string, string, (e: Error) => unknown][])("%s", async (_name, fmt, build) => {
    const canaries = mintCanaries();
    const err = await uniqueViolation(canaries, false);
    const operand = build(err);

    // POSITIVE PAIR: the same call on a Console without the scrub writes the canary.
    const raw = capturingConsole();
    raw.target.error(fmt, operand);
    expect(raw.stderr(), "premise: the unscrubbed line carries the canary").toContain(canaries.email);

    const { target, stderr } = capturingConsole();
    installConsoleDbEchoScrub(target);
    target.error(fmt, operand);
    expect(stderr().length, "anti-vacuity: something was printed").toBeGreaterThan(0);
    expect(stderr(), "no canary on the line").not.toContain(canaries.email);
    expect(stderr(), "no canary on the line").not.toContain(canaries.token);
    expect(stderr(), "the SQLSTATE is still printed").toContain("23505");
  });

  it("%o prints an error's NON-ENUMERABLE own properties too: postgres.js's hidden statement fields, with the bind values in them, are not on the line", async () => {
    const canaries = mintCanaries();
    vi.stubEnv("VITEST", ""); // the production client: query/parameters/args/types exist but are not enumerable
    await dropClient();
    const err = await sql`insert into no_such_table_for_console_scrub (token, recipient) values (${canaries.token}, ${canaries.email})`.then(
      () => null,
      (e: unknown) => e,
    );
    await dropClient();
    vi.unstubAllEnvs();
    if (!(err instanceof Error)) throw new Error("premise: the staged statement must fail");
    expect((err as DriverError).code, "premise: Postgres refused it for the staged reason").toBe("42P01");
    expect(Object.keys(err).filter((k) => ECHO_FIELDS.includes(k)), "premise: nothing ENUMERABLE to strip").toEqual([]);

    const raw = capturingConsole();
    raw.target.error("%o", err);
    expect(raw.stderr(), "premise: %o (showHidden) prints the hidden bind values").toContain(canaries.token);

    const { target, stderr } = capturingConsole();
    installConsoleDbEchoScrub(target);
    target.error("%o", err);
    expect(stderr().length).toBeGreaterThan(0);
    expect(stderr()).not.toContain(canaries.token);
    expect(stderr()).not.toContain(canaries.email);
    expect(stderr(), "the SQLSTATE is still printed").toContain("42P01");
    expect(stderr(), "and the message").toContain("no_such_table_for_console_scrub");
  });
});
