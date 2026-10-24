// SECURITY: a failed query's error must not carry the statement's BIND VALUES into any log or telemetry path.
//
// THE LEAK. postgres.js decides whether to attach the failed statement to the error it throws from its `debug` option:
// with a truthy `debug` it defines `query`, `parameters`, `args` and `types` on the error as ENUMERABLE own properties
// (connection.js `queryError`, `enumerable: options.debug`); with a falsy one the same properties exist but are not
// enumerable. lib/db.ts used to pass a `debug` function ALWAYS (to count statements), so every failed query's error
// carried its bind values - a token, an email address, sealed body bytes - in fields that
//   * pino's `err` serializer (and `JSON.stringify`, so any `{ error }` key) copies into the stdout log line,
//   * `Sentry.pinoIntegration()` forwards, from that same line, to Sentry Logs,
//   * Node's `util.inspect` prints, i.e. every `console.error(err)` and Next's own uncaught-error log,
// which no key-by-key redaction list can cover. The fix is at the source: the statement counter (a test instrument) is
// switched on under vitest only, so a production client's errors carry nothing to leak.
//
// THIS FILE drives the REAL pieces end to end, with no fixture on either end:
//   * a real postgres.js client, built by lib/db.ts's own `getClient()` under each posture, failing a real query whose bind
//     values are unique random strings;
//   * the app logger's REAL options (server/logger.ts LOGGER_OPTIONS: serializers, redact, mixin) on a pino that writes into
//     an array;
//   * the REAL Sentry SDK, initialised by the REAL sentry.server.config.ts (its beforeSend, beforeSendLog and pinoIntegration),
//     with only the TRANSPORT replaced so the envelopes it would send can be read. Both Sentry paths are exercised: the pino
//     line that `pinoIntegration` forwards as a Sentry Log, and `Sentry.captureException`.
// The positive control is the SAME rig with the counting posture on: there the secrets DO come out, so the clean result of the
// production posture is not a harness that cannot see a leak.
//
// Needs a database (DATABASE_URL): the statement must really fail in Postgres for the driver to build its own error.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { inspect } from "node:util";
import { randomBytes } from "node:crypto";
import pino from "pino";
import { LOGGER_OPTIONS } from "@/server/logger";
import { countsStatements, sql, statementCount, withTenant } from "@/lib/db";

const HAS_DB = !!process.env.DATABASE_URL;

// The envelopes the real SDK would have posted, captured by a transport swapped in underneath the real Sentry.init.
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

const lines: string[] = [];
const sink = pino({ ...LOGGER_OPTIONS, level: "trace" }, { write: (s: string) => { lines.push(s); } });

/** Two unique secrets per run: a token-shaped and an address-shaped value, never present anywhere else. */
function mintSecrets() {
  const id = randomBytes(12).toString("hex");
  return { token: `tok-${id}`, email: `leak-${id}@example.invalid` };
}

/** A genuine failed query, raised by Postgres through the app's own client: the table does not exist (42P01), and the
 *  message does not echo the bind values, so what is carried is down to the driver's own error fields. */
async function failedQuery(secrets: { token: string; email: string }, via: "pool" | "tenant"): Promise<Error> {
  const attempt =
    via === "pool"
      ? () => sql`insert into no_such_table_for_redaction (token, recipient) values (${secrets.token}, ${secrets.email})`
      : () =>
          withTenant("00000000-0000-0000-0000-000000000000", (tx) =>
            tx`insert into no_such_table_for_redaction (token, recipient) values (${secrets.token}, ${secrets.email})`,
          );
  const err = await attempt().then(
    () => null,
    (e: unknown) => e,
  );
  if (!(err instanceof Error)) throw new Error("premise: the staged statement must fail");
  expect((err as { code?: string }).code, "premise: Postgres refused it for the staged reason").toBe("42P01");
  return err;
}

/** Everything the real SDK would have sent, as one searchable string, plus the items by type. */
function sentItems() {
  const items: { type: string; payload: unknown }[] = [];
  for (const envelope of sent as [unknown, [{ type: string }, unknown][]][]) {
    for (const [header, payload] of envelope[1]) items.push({ type: header.type, payload });
  }
  return { text: JSON.stringify(sent), items };
}

let Sentry: typeof import("@sentry/nextjs");
let flush: () => Promise<void>;

beforeAll(async () => {
  if (!HAS_DB) return;
  vi.stubEnv("SENTRY_DSN", "https://publickey@o0.ingest.sentry.io/0");
  await import("../../../sentry.server.config");
  Sentry = await import("@sentry/nextjs");
  flush = async () => {
    await Sentry.flush(5000);
  };
});

beforeEach(() => {
  lines.length = 0;
  sent.length = 0;
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await dropClient();
});

/** Log the error as the app does, on both keys it is found under, and report it to Sentry as an exception. */
async function emit(err: Error): Promise<void> {
  sink.error({ err }, "query failed");
  sink.error({ error: err }, "query failed under another key");
  Sentry.captureException(err);
  await flush();
}

/** One posture end to end: a fresh client under `env VITEST`, a pooled and a tenant-transaction failure, everything emitted. */
async function run(counting: boolean) {
  vi.stubEnv("VITEST", counting ? "true" : "");
  await dropClient();
  const secrets = mintSecrets();
  const errors = [await failedQuery(secrets, "pool"), await failedQuery(secrets, "tenant")];
  await dropClient();
  vi.stubEnv("VITEST", "true");
  for (const err of errors) await emit(err);
  return { secrets, errors, all: [secrets.token, secrets.email] };
}

describe.skipIf(!HAS_DB)("a failed query's error does not carry its bind values into logs or Sentry", () => {
  it("the production client (no statement counter): no log line, no Sentry log, no Sentry event, no console rendering has a secret; the code and message still do", async () => {
    const { errors, all } = await run(false);

    // The error itself: nothing enumerable to copy (what pino's serializer, JSON.stringify and util.inspect all read).
    for (const err of errors) {
      const keys = Object.keys(err);
      for (const leaky of ["query", "parameters", "args", "types"]) expect(keys, `own enumerable keys of the error: ${keys}`).not.toContain(leaky);
      for (const s of all) {
        expect(JSON.stringify(err), "JSON.stringify(err)").not.toContain(s);
        expect(inspect(err, { depth: 6 }), "util.inspect(err), what console.error prints").not.toContain(s);
      }
    }

    // pino -> stdout: the app logger's real options, on the `err` key (the std serializer) and on another key.
    expect(lines.length, "anti-vacuity: log lines were written").toBe(errors.length * 2);
    for (const line of lines) {
      for (const s of all) expect(line).not.toContain(s);
      expect(line, "the SQLSTATE is still logged").toContain("42P01");
    }
    // The std `err` serializer also writes the message; a bare `{ error }` key is JSON.stringify's, which has never had it.
    const underErr = lines.filter((l) => l.includes('"msg":"query failed"'));
    expect(underErr.length, "anti-vacuity: the `err`-key lines were found").toBe(errors.length);
    for (const line of underErr) expect(line, "the message is still logged").toContain("no_such_table_for_redaction");

    // pino -> Sentry Logs and Sentry.captureException: the real SDK, the real beforeSend / beforeSendLog.
    const { text, items } = sentItems();
    const logs = items.filter((i) => i.type === "log");
    const events = items.filter((i) => i.type === "event");
    expect(logs.length, "anti-vacuity: Sentry Log items were produced from the pino lines").toBeGreaterThan(0);
    expect(events.length, "anti-vacuity: Sentry event items were produced by captureException").toBe(errors.length);
    for (const s of all) expect(text, `the whole of what Sentry would receive must not contain ${s}`).not.toContain(s);
    expect(JSON.stringify(logs), "the SQLSTATE and message still reach Sentry Logs").toContain("42P01");
    expect(JSON.stringify(events), "the message still reaches the Sentry event").toContain("no_such_table_for_redaction");
  });

  it("POSITIVE CONTROL - the same rig with the statement counter on does carry the secrets, on every path (the rig can see a leak)", async () => {
    const { errors, all } = await run(true);
    for (const err of errors) {
      expect(Object.keys(err)).toEqual(expect.arrayContaining(["query", "parameters", "args", "types"]));
      for (const s of all) {
        expect(JSON.stringify(err)).toContain(s);
        expect(inspect(err, { depth: 6 })).toContain(s);
      }
    }
    for (const s of all) {
      expect(lines.filter((l) => l.includes(s)).length, `${s} in the pino lines`).toBe(errors.length * 2);
    }
    const logs = sentItems().items.filter((i) => i.type === "log");
    expect(logs.length).toBeGreaterThan(0);
    for (const s of all) expect(JSON.stringify(logs), `${s} in Sentry Logs`).toContain(s);
  });
});

// The other half of the gate: what the fix must not take away. The counter is what the round-trip budget tests pin (fixture
// generation, the outbox's "no statement was issued" assertions); a counter that silently stays at 0 would pass every one of
// the latter, so it is proven live against a real client here.
describe.skipIf(!HAS_DB)("the statement counter stays live under vitest", () => {
  it("counts one per statement on a real client, and counting is on", async () => {
    vi.stubEnv("VITEST", "true");
    expect(countsStatements(), "premise: the runner's VITEST flag turns counting on").toBe(true);
    await dropClient();
    await sql`select 1`; // the first use also opens the connection and may fetch types
    const before = statementCount();
    await sql`select 1`;
    expect(statementCount() - before).toBe(1);
    await sql`select ${"a"}::text`;
    await sql`select ${"b"}::text`;
    expect(statementCount() - before).toBe(3);
  });

  it("refuses to be read where counting is off, instead of reporting 0", () => {
    vi.stubEnv("VITEST", "");
    expect(countsStatements()).toBe(false);
    expect(() => statementCount()).toThrow(/only live under vitest/);
  });
});
