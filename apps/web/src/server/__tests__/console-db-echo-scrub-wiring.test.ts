// The seam of server/console-db-echo-scrub.ts: `register()` in instrumentation.ts is what Next calls once before the server takes a
// request, and Next prints an uncaught error with `console.error(err)` on the PROCESS's console. A scrub that nothing installs is
// the inert-seam class (unit-green, nothing in production calls it), so this drives the real `register()` and then prints a REAL
// database error the way Next does, on the global console.
//
// The console is replaced by a recorder BEFORE `register()` runs, so what the recorder receives is exactly what the installed hook
// let through to the underlying `console.error`. (vitest's own console is not a stream to read, and the formatting is not the
// subject here: console-db-echo-scrub.test.ts prints through a real node Console.)
//
// Needs a database (DATABASE_URL): the statement must really fail in Postgres for the driver to build its own error.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { inspect } from "node:util";
import { sql } from "@/lib/db";

vi.mock("@sentry/nextjs", () => ({ captureRequestError: () => {}, init: () => {}, captureMessage: vi.fn(), captureException: vi.fn() }));
vi.mock("../../../sentry.server.config", () => ({}));
vi.mock("../../../sentry.edge.config", () => ({}));
// The other boot checks register() runs are not the subject here; their own tests drive them.
vi.mock("@/server/relay/config", () => ({ relayDriverMode: vi.fn() }));
vi.mock("@/server/public-site/error-no-store", () => ({ installPublicErrorNoStore: vi.fn() }));

const HAS_DB = !!process.env.DATABASE_URL;

type G = { _sql?: { end(): Promise<void> } };
const g = globalThis as unknown as G;

/** The pooled client is a lazy singleton stashed on globalThis; drop it so the next use builds one under the CURRENT env. */
async function dropClient(): Promise<void> {
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
}

const realConsoleError = console.error;
const recorder = vi.fn();

beforeEach(() => {
  recorder.mockClear();
  console.error = recorder;
});
afterEach(() => {
  console.error = realConsoleError;
  vi.unstubAllEnvs();
});

async function boot() {
  const { register } = await import("../../../instrumentation");
  return register();
}

/** A genuine unique violation from the production client; `canary` is the bind value Postgres echoes in `detail`. */
async function uniqueViolation(canary: string): Promise<Error & { code?: string; detail?: string }> {
  vi.stubEnv("VITEST", "");
  await dropClient();
  const err = await sql
    .begin(async (tx) => {
      await tx`create temp table console_wiring_probe (id int primary key, email text unique not null) on commit drop`;
      await tx`insert into console_wiring_probe values (1, ${canary})`;
      await tx`insert into console_wiring_probe values (2, ${canary})`;
    })
    .then(
      () => null,
      (e: unknown) => e,
    );
  await dropClient();
  vi.unstubAllEnvs();
  if (!(err instanceof Error)) throw new Error("premise: the staged statement must fail");
  return err;
}

describe.skipIf(!HAS_DB)("register() (instrumentation.ts) installs the console scrub", () => {
  it("nodejs: console.error(err) as Next calls it reaches the underlying console.error without the echo fields; the error itself is untouched", async () => {
    const canary = `leak-canary-${randomBytes(10).toString("hex")}@example.invalid`;
    const err = await uniqueViolation(canary); // (unstubs the environment when it is done: the runtime is set after it)
    expect(err.code, "premise: Postgres refused it for the staged reason").toBe("23505");
    expect(String(err.detail), "premise: Postgres echoed the bind value in `detail`").toContain(canary);
    expect(recorder, "premise: nothing has printed yet").not.toHaveBeenCalled();

    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    await expect(boot()).resolves.toBeUndefined();
    expect(console.error, "register() replaced the process's console.error").not.toBe(recorder);

    console.error("[next] uncaught", err);
    expect(recorder).toHaveBeenCalledTimes(1);
    const [label, printed] = recorder.mock.calls[0] as [string, Error & { detail?: string }];
    expect(label).toBe("[next] uncaught");
    const rendered = inspect(printed, { depth: 6 });
    expect(rendered, "what the underlying console prints").not.toContain(canary);
    expect(rendered).toContain("duplicate key value violates unique constraint");
    expect(printed.message).toBe(err.message);
    expect(printed.stack).toBe(err.stack);
    expect((printed as { code?: string }).code).toBe("23505");
    expect(String(err.detail), "the original error still has its detail").toContain(canary);
  });

  it("a second register() (dev reloads instrumentation.ts) does not wrap again", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    await boot();
    const installed = console.error;
    expect(installed, "premise: the first register() wrapped it").not.toBe(recorder);
    await boot();
    expect(console.error, "the second left the first wrapper as it was").toBe(installed);
  });

  it("the edge runtime has no database driver and leaves console.error alone (positive pair: nodejs wraps it, above)", async () => {
    vi.stubEnv("NEXT_RUNTIME", "edge");
    await boot();
    expect(console.error).toBe(recorder);
  });
});
