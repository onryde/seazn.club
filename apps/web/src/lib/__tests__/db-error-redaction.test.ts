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
// switched on under vitest only, and production passes `debug: false` EXPLICITLY (an absent key falls back to a `?debug=` on
// DATABASE_URL and to PGDEBUG, both probed below), so a production client's errors carry nothing to leak.
//
// A SECOND CLASS, beyond postgres.js: Postgres' own error fields (`detail` = the unique key or the whole failing row, `where`,
// `hint`) are enumerable whatever `debug` says. The logger's `err` serializer and Sentry's `beforeSend` / `beforeSendLog` strip
// them (lib/strip-db-echo.ts); the last describe below drives real constraint violations through every route. The same strip
// is also a second guard for the statement fields, which the CONTROL test exercises with the counter on.
//
// THIS FILE drives the REAL pieces end to end, with no fixture on either end:
//   * a real postgres.js client, built by lib/db.ts's own `getClient()` under each posture, failing a real query whose bind
//     values are unique random strings;
//   * the app logger's REAL options (server/logger.ts LOGGER_OPTIONS: serializers, redact, mixin) on a pino that writes into
//     an array;
//   * the REAL Sentry SDK, initialised by the REAL sentry.server.config.ts (its beforeSend, beforeSendLog and pinoIntegration),
//     with only the TRANSPORT replaced so the envelopes it would send can be read. Both Sentry paths are exercised: the pino
//     line that `pinoIntegration` forwards as a Sentry Log, and `Sentry.captureException`.
// The positive control is the SAME rig with the counting posture on: there the secrets DO come out of the error itself and
// off a line written without the app's serializers, so the clean result of the production posture is not a harness that
// cannot see a leak. (Sentry's side has no remaining leak to show, by design; its guards are mutation-checked instead.)
//
// Needs a database (DATABASE_URL): the statement must really fail in Postgres for the driver to build its own error.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { inspect } from "node:util";
import { randomBytes } from "node:crypto";
import pino from "pino";
import postgres from "postgres";
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

  it("CONTROL - with the statement counter on the error itself carries the secrets, and a pino WITHOUT the app's serializers writes them; the app's logger and Sentry hold even then", async () => {
    const { errors, all } = await run(true);
    for (const err of errors) {
      expect(Object.keys(err)).toEqual(expect.arrayContaining(["query", "parameters", "args", "types"]));
      for (const s of all) {
        expect(JSON.stringify(err), "the error carries the secret").toContain(s);
        expect(inspect(err, { depth: 6 }), "util.inspect of it, i.e. console.error").toContain(s);
      }
    }
    // The rig can see a leak on a line: the logger's options WITHOUT the app's serializers write the secrets out.
    const bare: string[] = [];
    const bareLogger = pino({ ...LOGGER_OPTIONS, serializers: {}, level: "trace" }, { write: (s: string) => { bare.push(s); } });
    for (const err of errors) bareLogger.error({ err }, "query failed");
    expect(bare.length).toBe(errors.length);
    for (const s of all) expect(bare.filter((l) => l.includes(s)).length, `${s} on a line from a logger without the serializers`).toBe(errors.length);

    // Defence in depth: the guard at the source is `debug: false`; if it were ever lost, the app's own logger and the real
    // Sentry hooks still strip the statement fields (the line and the Sentry payload carry the SQLSTATE and no secret).
    expect(lines.length, "anti-vacuity: the app logger wrote its lines").toBe(errors.length * 2);
    for (const line of lines) {
      for (const s of all) expect(line).not.toContain(s);
      expect(line).toContain("42P01");
    }
    const { text, items } = sentItems();
    expect(items.filter((i) => i.type === "log").length, "anti-vacuity: Sentry Logs were produced").toBeGreaterThan(0);
    for (const s of all) expect(text).not.toContain(s);
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

// ---------------------------------------------------------------------------------------------------------------------------
// I-1. "No `debug` key" is not "debug off": postgres.js falls back to `?debug=` on the connection string and to PGDEBUG when the
// option is absent. Both are probed here against the production client; the control builds a bare postgres.js client the
// same way and finds the leak, so the arming is known to work and the clean result below is the explicit `debug: false`.
// ---------------------------------------------------------------------------------------------------------------------------
const withDebugParam = (url: string) => `${url}${url.includes("?") ? "&" : "?"}debug=1`;
const ARMINGS: [string, () => void][] = [
  ["a ?debug=1 on DATABASE_URL", () => vi.stubEnv("DATABASE_URL", withDebugParam(process.env.DATABASE_URL!))],
  ["PGDEBUG=1 in the environment", () => vi.stubEnv("PGDEBUG", "1")],
];

describe.skipIf(!HAS_DB)("the production client stays clean when something else asks postgres.js for debug", () => {
  it.each(ARMINGS)("%s: a failed query's error still carries no statement fields and no bind values", async (_name, arm) => {
    vi.stubEnv("VITEST", "");
    arm();
    await dropClient();
    const secrets = mintSecrets();
    const err = await failedQuery(secrets, "pool");
    await dropClient();
    vi.unstubAllEnvs();
    const keys = Object.keys(err);
    for (const leaky of ["query", "parameters", "args", "types"]) expect(keys, `own enumerable keys of the error: ${keys}`).not.toContain(leaky);
    for (const s of [secrets.token, secrets.email]) {
      expect(JSON.stringify(err)).not.toContain(s);
      expect(inspect(err, { depth: 6 })).not.toContain(s);
    }
  });

  it.each(ARMINGS)("CONTROL - %s does turn the leak on for a client that leaves `debug` out", async (_name, arm) => {
    arm();
    const secrets = mintSecrets();
    const bare = postgres(process.env.DATABASE_URL!, { max: 1, ssl: false });
    const err = await bare`insert into no_such_table_for_redaction (token) values (${secrets.token})`.then(
      () => null,
      (e: unknown) => e,
    );
    await bare.end();
    vi.unstubAllEnvs();
    if (!(err instanceof Error)) throw new Error("premise: the staged statement must fail");
    expect(Object.keys(err)).toContain("parameters");
    expect(JSON.stringify(err)).toContain(secrets.token);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
// I-3. Postgres' OWN fields echo data too, whatever postgres.js does: `detail` carries the unique key or the WHOLE failing row
// ("Failing row contains (3, <email>, <token>, -1)"), and PostgresError copies every server field onto the error as an
// enumerable property. The app logs `{ err }` in ~60 places, so the logger's `err` serializer and Sentry's two hooks strip them,
// leaving name, message, code, constraint_name, table_name, column_name, schema_name and the stack.
//
// Each case is a REAL constraint violation raised by Postgres through the production client, carrying unique secrets as bind
// values. Four routes are driven: the app logger's pino line (on `err`, on `error`, and with the driver error nested inside
// another error), Sentry Logs from that same line, Sentry.captureException with the console breadcrumb Next's own
// `console.error(err)` leaves on the event, and a Sentry Log written directly with the error as an attribute.
// ---------------------------------------------------------------------------------------------------------------------------
type Kind = "unique" | "not null" | "check";
const KINDS: { kind: Kind; code: string; keep: "constraint_name" | "column_name" }[] = [
  { kind: "unique", code: "23505", keep: "constraint_name" },
  { kind: "not null", code: "23502", keep: "column_name" },
  { kind: "check", code: "23514", keep: "constraint_name" },
];

async function constraintFailure(kind: Kind, secrets: { token: string; email: string }): Promise<Error & Record<string, unknown>> {
  const err = await sql
    .begin(async (tx) => {
      await tx`create temp table redact_probe (id int primary key, email text unique not null, token text not null, qty int check (qty >= 0)) on commit drop`;
      if (kind === "unique") {
        await tx`insert into redact_probe values (1, ${secrets.email}, ${secrets.token}, 1)`;
        await tx`insert into redact_probe values (2, ${secrets.email}, 'another', 1)`;
      } else if (kind === "not null") {
        await tx`insert into redact_probe values (3, ${secrets.email}, null, 1)`;
      } else {
        await tx`insert into redact_probe values (4, ${secrets.email}, ${secrets.token}, -1)`;
      }
    })
    .then(
      () => null,
      (e: unknown) => e,
    );
  if (!(err instanceof Error)) throw new Error("premise: the staged statement must fail");
  return err as Error & Record<string, unknown>;
}

/** Every route an error takes out of the process, in one go. */
async function emitEverywhere(err: Error): Promise<void> {
  const outer = Object.assign(new Error("outer"), { inner: err });
  sink.error({ err }, "constraint failed");
  sink.error({ error: err }, "constraint failed (error key)");
  sink.error({ err: outer }, "constraint failed (nested)");
  console.error("unhandled", err); // what Next's own uncaught-error log does; Sentry's console integration keeps it as a breadcrumb
  Sentry.captureException(err);
  Sentry.logger.error("direct", { failure: err });
  await flush();
}

describe.skipIf(!HAS_DB)("Postgres' own echo fields (detail, where, hint) do not reach logs or Sentry; the code and the constraint stay", () => {
  it.each(KINDS)("$kind violation ($code)", async ({ kind, code, keep }) => {
    vi.stubEnv("VITEST", "");
    await dropClient();
    const secrets = mintSecrets();
    const err = await constraintFailure(kind, secrets);
    await dropClient();
    vi.unstubAllEnvs();
    vi.stubEnv("VITEST", "true");

    const all = [secrets.email, secrets.token];
    expect(err.code, "premise: Postgres refused it for the staged reason").toBe(code);
    expect(String(err.detail), "premise: Postgres echoed the bind value in `detail`").toContain(secrets.email);
    expect(JSON.stringify(err), "premise: a raw log of the error would write it").toContain(secrets.email);
    const kept = String(err[keep]);
    expect(kept.length, `premise: the error names its ${keep}`).toBeGreaterThan(0);

    await emitEverywhere(err);

    // pino -> stdout: the app logger's real options.
    expect(lines.length, "anti-vacuity: the three pino lines were written").toBe(3);
    for (const line of lines) {
      for (const s of all) expect(line, "a pino line").not.toContain(s);
      expect(line, "the SQLSTATE is still logged").toContain(code);
    }
    for (const line of lines.filter((l) => !l.includes('"msg":"constraint failed (error key)"'))) {
      expect(line, `the err serializer keeps ${keep}`).toContain(kept);
    }

    // Sentry: everything the real SDK would have sent (Logs from the pino lines, the direct Log, the event and its breadcrumbs).
    const { text, items } = sentItems();
    const logs = items.filter((i) => i.type === "log");
    const events = items.filter((i) => i.type === "event");
    expect(events.length, "anti-vacuity: the event was produced").toBe(1);
    expect(JSON.stringify(events[0].payload), "anti-vacuity: the console breadcrumb carried the error to the event").toContain("breadcrumbs");
    expect(JSON.stringify(logs), "anti-vacuity: the direct Sentry Log was produced").toContain('"direct"');
    for (const s of all) expect(text, `the whole of what Sentry would receive must not contain ${s}`).not.toContain(s);
    expect(JSON.stringify(events[0].payload), "the event still names the SQLSTATE (breadcrumb)").toContain(code);
    expect(JSON.stringify(events[0].payload), `the event still names the ${keep}`).toContain(kept);
    expect(JSON.stringify(logs), "the Logs still name the SQLSTATE").toContain(code);
  });
});
