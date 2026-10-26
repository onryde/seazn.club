// The other route Next reports an uncaught error by: `onRequestError` (instrumentation.ts), which Next calls with the error, the
// request and the context AFTER it has printed the error with console.error. The export is Sentry's `captureRequestError`; this
// pins that what it sends for a REAL database error carries no echoed data, so a change to the SDK's defaults, to its integrations
// or to sentry.server.config.ts's hooks that put an error's own fields on the event (`extraErrorDataIntegration` does exactly that)
// turns this red. It found the route clean when it was written; the console route (console-db-echo-scrub*.test.ts) is the one that
// was not.
//
// No fixture on either end: the real SDK initialised by the real sentry.server.config.ts (its beforeSend, beforeSendLog,
// pinoIntegration), with only the TRANSPORT replaced so the envelopes it would send can be read; the real `onRequestError` export;
// a real postgres.js failure whose bind value is a unique `leak-canary-...` string.
//
// Needs a database (DATABASE_URL): the statement must really fail in Postgres for the driver to build its own error.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { sql } from "@/lib/db";

const HAS_DB = !!process.env.DATABASE_URL;

const sent = vi.hoisted(() => [] as unknown[]);
vi.mock("@sentry/nextjs", async () => {
  const real = await vi.importActual<typeof import("@sentry/nextjs")>("@sentry/nextjs");
  const init = (options: Parameters<typeof real.init>[0]) =>
    real.init({
      ...options,
      transport: () => ({
        send: async (envelope: unknown) => {
          sent.push(envelope);
          return {};
        },
        flush: async () => true,
      }),
    });
  // A Proxy, not a spread: the SDK's exports are not all own enumerable properties of the module object.
  return new Proxy(real, { get: (target, prop, receiver) => (prop === "init" ? init : Reflect.get(target, prop, receiver)) });
});

type G = { _sql?: { end(): Promise<void> } };
const g = globalThis as unknown as G;

/** The pooled client is a lazy singleton stashed on globalThis; drop it so the next use builds one under the CURRENT env. */
async function dropClient(): Promise<void> {
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
}

let Sentry: typeof import("@sentry/nextjs");
let onRequestError: (err: unknown, request: unknown, context: unknown) => void | Promise<void>;

beforeAll(async () => {
  if (!HAS_DB) return;
  vi.stubEnv("SENTRY_DSN", "https://publickey@o0.ingest.sentry.io/0");
  await import("../../../sentry.server.config");
  Sentry = await import("@sentry/nextjs");
  ({ onRequestError } = (await import("../../../instrumentation")) as unknown as { onRequestError: typeof onRequestError });
});
beforeEach(() => {
  sent.length = 0;
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await dropClient();
});

async function uniqueViolation(canary: string): Promise<Error & { code?: string; detail?: string }> {
  vi.stubEnv("VITEST", ""); // the production client: no statement counter
  await dropClient();
  const err = await sql
    .begin(async (tx) => {
      await tx`create temp table on_request_error_probe (id int primary key, email text unique not null) on commit drop`;
      await tx`insert into on_request_error_probe values (1, ${canary})`;
      await tx`insert into on_request_error_probe values (2, ${canary})`;
    })
    .then(
      () => null,
      (e: unknown) => e,
    );
  await dropClient();
  vi.stubEnv("VITEST", "true");
  if (!(err instanceof Error)) throw new Error("premise: the staged statement must fail");
  return err;
}

/** Every item of every envelope the SDK would have posted. */
function items() {
  const out: { type: string; payload: unknown }[] = [];
  for (const envelope of sent as [unknown, [{ type: string }, unknown][]][]) {
    for (const [header, payload] of envelope[1]) out.push({ type: header.type, payload });
  }
  return out;
}

describe.skipIf(!HAS_DB)("onRequestError (instrumentation.ts) reports a database error to Sentry without its echoed data", () => {
  it("a unique violation in a route handler: one event, the message and route kept, the canary nowhere in what would be sent", async () => {
    const canary = `leak-canary-${randomBytes(10).toString("hex")}@example.invalid`;
    const err = await uniqueViolation(canary);
    expect(err.code, "premise: Postgres refused it for the staged reason").toBe("23505");
    expect(String(err.detail), "premise: Postgres echoed the bind value in `detail`").toContain(canary);

    // The harness can see a leak: a canary that IS in an event shows up in the envelope text.
    Sentry.captureMessage(`control ${canary}`);
    await Sentry.flush(5000);
    expect(JSON.stringify(sent), "the rig reads what the SDK sends").toContain(canary);
    sent.length = 0;

    await onRequestError(
      err,
      { path: "/api/probe?x=1", method: "POST", headers: { "content-type": "application/json" } },
      { routerKind: "App Router", routePath: "/api/probe", routeType: "route", renderSource: undefined, revalidateReason: undefined, renderType: "dynamic" },
    );
    await Sentry.flush(5000);

    const events = items().filter((i) => i.type === "event");
    expect(events.length, "anti-vacuity: the request error produced an event").toBe(1);
    const text = JSON.stringify(sent);
    expect(text, "the whole of what Sentry would receive must not contain the canary").not.toContain(canary);
    expect(text, "the error's message still reaches Sentry").toContain("duplicate key value violates unique constraint");
    expect(text, "and so does the route it came from").toContain("/api/probe");
    expect(String(err.detail), "the original error still has its detail").toContain(canary);
  });
});
