// Pre-flight checks the bench runs before touching anything: proves the
// target DB is not the shared dev DB, proves a real server is bound to the
// target port, proves the sports catalog is synced, proves the app answers
// healthy, and records (never refuses on) placement-service liveness.
//
// Every check is expressed as an injected async probe (`PreflightProbes`),
// so `runPreflight` itself is pure and unit-testable with fakes — no live
// Postgres, server, or placement container required in vitest. `bench.ts`
// wires the real implementations below (`createRealPreflightProbes`)
// against actual infrastructure; tests wire fakes. This split is not
// optional polish — it is how the unit/regression suite stays DB-free and
// CI-safe (B01 brief).
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { access } from "node:fs/promises";
import { promisify } from "node:util";
import postgres from "postgres";
import * as grpc from "@grpc/grpc-js";
// Plain `playwright`, NEVER `@playwright/test` — this script runs under
// `node --experimental-strip-types` (matching scripts/smoke.ts), and
// `@playwright/test` is a test-runner export that does not exist under
// plain `playwright` (B03r brief §pre-flight, docs/superpowers/specs/
// bench-product-value/bench-prompts/B03r-registration-layer.md:88).
// `chromium.executablePath()` is synchronous and does not launch anything.
import { chromium } from "playwright";

const execFileAsync = promisify(execFile);

/** Ports this bench refuses to ever target — the owner's local dev server
 *  and the e2e target (seazn-local-env skill §1, AGENTS.md). The bench
 *  always owns its own throwaway server. */
const FORBIDDEN_BASE_PORTS = new Set([3000, 3100]);

/** The shared local dev Postgres always listens here (seazn-local-env skill
 *  §1) — a bench DATABASE_URL must never resolve to it. */
const DEV_DB_PORT = 5432;

export type RefusalReason =
  | "base_url_invalid"
  | "base_port_forbidden"
  | "base_host_forbidden"
  | "own_db_dev_db_port"
  | "own_db_data_directory_mismatch"
  | "own_db_connection_failed"
  | "own_port_unbound"
  | "sports_catalog_unsynced"
  | "app_health_unreachable"
  | "app_health_not_ok"
  // ---- B03r task 7: registration-layer additions ----
  // Every reason below is escalated to a refusal ONLY when the resolved
  // selection needs it (a `pay:true` division for the Stripe reasons, a
  // `registration-ui` division for the Chromium one) — otherwise the exact
  // same finding lands in `PreflightResult.warnings` instead. The one
  // exception is `stripe_live_key_detected`, which is always a refusal
  // (see `runPreflight`'s doc comment on that branch).
  | "stripe_live_key_detected"
  | "stripe_secret_key_missing_or_invalid"
  | "stripe_connect_test_account_missing"
  | "stripe_webhook_not_confirmed"
  | "registration_ui_chromium_missing";

export interface Refusal {
  reason: RefusalReason;
  detail: string;
}

export interface OwnDatabaseResult {
  ok: boolean;
  reason?: RefusalReason;
  detail: string;
  dataDirectory?: string;
  port?: number;
}

export interface OwnPortResult {
  ok: boolean;
  reason?: RefusalReason;
  detail: string;
  pid?: number;
}

/** Both `"live"` and `"absent"` are legitimate outcomes — this is a report
 *  field, never a refusal (B01 brief, `_RULES.md` §2: "run gates BOTH with
 *  and without a live placement container"). */
export interface PlacementHealthResult {
  status: "live" | "absent";
  detail: string;
}

export interface SportsCatalogResult {
  ok: boolean;
  reason?: RefusalReason;
  detail: string;
}

export interface AppHealthResult {
  ok: boolean;
  reason?: RefusalReason;
  detail: string;
}

/** The two registration-shaped facts pre-flight needs about ONE division
 *  selected for this bench run — deliberately NOT the full `PackDivision` /
 *  `PackRegistrationBlock` shape (`lib/pack-schema.ts`). A concurrent agent
 *  is building the `--entry` resolver (`lib/register.ts`) that will produce
 *  this list; this file never imports from it and never builds it — the
 *  caller (`bench.ts` / `register.ts`, both out of this task's scope)
 *  reduces its resolved run down to this shape before calling
 *  `runPreflight` (B03r task 7 brief: "take the resolved division list as
 *  a PARAMETER... that keeps you decoupled"). */
export interface SelectedDivisionExposure {
  /** `divisions[].entry` from the pack (default `"admin"`, `pack-schema.ts:464`). */
  entry: "admin" | "registration-api" | "registration-ui";
  /** true when ANY entry in this division's registration block
   *  (`registration.byDivision[ref].entries[].pay`, `pack-schema.ts:1218`)
   *  is `true` — i.e. this division needs a real Stripe charge. */
  pay: boolean;
}

/** Raw Stripe-readiness facts. Never carries any part of a secret's VALUE —
 *  only booleans derived from it (B03r brief: "Never do this" — no prefix,
 *  suffix, or length beyond the fixed `sk_test_`/`sk_live_` discriminator).
 *  `webhookListenerLive` is intentionally three-valued: `true`/`false` are
 *  confirmed outcomes, `null` is the honest "could not be determined either
 *  way" state the brief asks for instead of passing by default. */
export interface StripeConfigResult {
  testModeKeyPresent: boolean;
  /** Present but shaped like a LIVE secret key — checked independently of
   *  `testModeKeyPresent` so this can be reported as its own, more severe
   *  finding rather than folded into "missing/invalid". */
  liveKeyDetected: boolean;
  connectTestAccountPresent: boolean;
  webhookSecretPresent: boolean;
  webhookListenerLive: boolean | null;
  webhookListenerDetail: string;
}

export interface ChromiumInstalledResult {
  ok: boolean;
  detail: string;
}

/** One async probe per pre-flight fact. Real implementations do real I/O
 *  (see `createRealPreflightProbes`); tests inject fakes — see
 *  `lib/__tests__/env.test.ts`. */
export interface PreflightProbes {
  checkOwnDatabase(): Promise<OwnDatabaseResult>;
  checkOwnPort(port: number): Promise<OwnPortResult>;
  checkPlacementHealth(): Promise<PlacementHealthResult>;
  checkSportsCatalogSynced(): Promise<SportsCatalogResult>;
  checkAppHealth(base: string): Promise<AppHealthResult>;
  checkStripeConfig(): Promise<StripeConfigResult>;
  checkChromiumInstalled(): Promise<ChromiumInstalledResult>;
}

export interface PreflightResult {
  ok: boolean;
  refusals: Refusal[];
  /** Same shape as `refusals`, for a finding that does not gate this run —
   *  e.g. Stripe/Chromium missing when no selected division needs them.
   *  Report-only, exactly like `placement`, but keyed by `RefusalReason` so
   *  a warning and its escalated-to-refusal twin share one vocabulary. */
  warnings: Refusal[];
  placement: PlacementHealthResult;
  base: string;
  port: number;
}

function resolvePort(url: URL): number {
  if (url.port) return Number(url.port);
  return url.protocol === "https:" ? 443 : 80;
}

/**
 * Pure orchestration: runs every probe, collects named refusals, never
 * throws itself. A probe's own failure is a returned `{ ok: false, reason,
 * detail }`, not an exception (see each probe's doc comment) — the only way
 * this function throws is a bug in a probe implementation, not an expected
 * environmental failure. Every probe runs regardless of the others' outcome
 * so a run refuses on ALL applicable reasons at once, not just the first.
 * A malformed `--base` is the one exception: nothing else here is checkable
 * without a parseable URL (there is no port to bind, no host to fetch), so
 * that alone short-circuits straight to a named refusal instead of a raw
 * `TypeError` escaping this function's own "never throws itself" contract.
 *
 * `selectedDivisions` (B03r task 7) is this run's RESOLVED selection,
 * reduced to `SelectedDivisionExposure` by the caller — see that type's doc
 * comment for why this file takes it as a plain parameter instead of
 * resolving `--entry` itself. It defaults to `[]` so an existing caller
 * (`bench.ts`, out of this task's scope) that has not yet been updated to
 * pass it keeps compiling and keeps behaving like "nothing selected needs
 * Stripe or Chromium" — i.e. every registration finding below only warns,
 * never aborts, until that caller is updated to pass the real selection.
 */
export async function runPreflight(
  base: string,
  probes: PreflightProbes,
  selectedDivisions: SelectedDivisionExposure[] = [],
): Promise<PreflightResult> {
  let url: URL;
  try {
    url = new URL(base);
  } catch (err) {
    return {
      ok: false,
      refusals: [
        {
          reason: "base_url_invalid",
          detail: `--base "${base}" is not a parseable URL: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
      warnings: [],
      placement: await probes.checkPlacementHealth(),
      base,
      port: NaN,
    };
  }
  const port = resolvePort(url);
  const refusals: Refusal[] = [];

  if (FORBIDDEN_BASE_PORTS.has(port)) {
    refusals.push({
      reason: "base_port_forbidden",
      detail:
        `--base resolves to port ${port}, which this bench refuses outright ` +
        "(3000 = the owner's local dev server, 3100 = the e2e target). Point --base " +
        "at a bench-owned server on another port.",
    });
  }

  // Secure-cookie rule: the app's auth cookie is Secure-flagged, so it is
  // silently dropped over plain http to a non-"localhost" host — a
  // `127.0.0.1` base signs in "successfully" and then 401s on every
  // subsequent call, which reads as an app bug rather than an env mistake.
  if (url.hostname === "127.0.0.1") {
    refusals.push({
      reason: "base_host_forbidden",
      detail:
        `--base resolves to host "127.0.0.1" — the Secure-cookie rule drops the ` +
        'auth cookie there. Use "localhost" instead (same server, same port).',
    });
  }

  const [db, ownPort, catalog, health, placement, stripe, chromiumInstalled] = await Promise.all([
    probes.checkOwnDatabase(),
    probes.checkOwnPort(port),
    probes.checkSportsCatalogSynced(),
    probes.checkAppHealth(base),
    probes.checkPlacementHealth(),
    probes.checkStripeConfig(),
    probes.checkChromiumInstalled(),
  ]);

  for (const result of [db, ownPort, catalog, health]) {
    if (!result.ok && result.reason) refusals.push({ reason: result.reason, detail: result.detail });
  }

  const warnings: Refusal[] = [];

  // The escalation rule (design §6 / B03r-repins §2, quoting the brief
  // verbatim): "Abort only if a SELECTED division has pay:true or
  // entry:registration-ui. Otherwise warn." So every Stripe/Chromium probe
  // runs unconditionally (same "every probe runs regardless" discipline as
  // the checks above) but its finding is graded by what THIS run's resolved
  // selection actually needs, never by "is Stripe configured" in general.
  const needsStripe = selectedDivisions.some((d) => d.pay);
  const needsChromium = selectedDivisions.some((d) => d.entry === "registration-ui");
  const escalate = (needed: boolean, finding: Refusal) => (needed ? refusals : warnings).push(finding);

  // A LIVE Stripe key is a hard failure ALWAYS, independent of `needsStripe`
  // — the brief is explicit this one is "never a warning": the bench must
  // never hold live Stripe credentials, needed for this run's selection or
  // not. Checked before, and instead of, the plain "missing/invalid" finding
  // below so the two stay distinguishable (a live key must not read as
  // merely "absent").
  if (stripe.liveKeyDetected) {
    refusals.push({
      reason: "stripe_live_key_detected",
      detail:
        "STRIPE_SECRET_KEY is shaped like a LIVE-mode key (sk_live_ prefix) — refusing outright " +
        "regardless of this run's selection; the bench must never hold live Stripe credentials.",
    });
  } else if (!stripe.testModeKeyPresent) {
    escalate(needsStripe, {
      reason: "stripe_secret_key_missing_or_invalid",
      detail: "STRIPE_SECRET_KEY is not set, or is not shaped like a test-mode key (sk_test_ prefix).",
    });
  }

  if (!stripe.connectTestAccountPresent) {
    escalate(needsStripe, {
      reason: "stripe_connect_test_account_missing",
      detail: "STRIPE_CONNECT_TEST_ACCOUNT is not set — needed for the destination-charge test fixture.",
    });
  }

  if (!stripe.webhookSecretPresent || stripe.webhookListenerLive !== true) {
    // Never passes by default on an indeterminate probe (brief: "say so
    // honestly ... rather than passing by default") — only `=== true` counts
    // as confirmed; `false` and `null` both land here, worded differently.
    const detail = !stripe.webhookSecretPresent
      ? "no webhook secret is configured — a paid entry's checkout.session.completed would have nowhere to verify against."
      : stripe.webhookListenerLive === false
        ? `webhook secret is present but no live \`stripe listen\` forwarder to /api/webhooks/stripe was confirmed: ${stripe.webhookListenerDetail}`
        : `webhook secret is present but whether a \`stripe listen\` forwarder is live could not be determined: ${stripe.webhookListenerDetail}`;
    escalate(needsStripe, { reason: "stripe_webhook_not_confirmed", detail });
  }

  if (!chromiumInstalled.ok) {
    escalate(needsChromium, { reason: "registration_ui_chromium_missing", detail: chromiumInstalled.detail });
  }

  return { ok: refusals.length === 0, refusals, warnings, placement, base, port };
}

/**
 * Probes whether a `stripe listen` forwarder to /api/webhooks/stripe is
 * actually live (B03r brief item 3). There is no repo-wide convention for a
 * `stripe listen` status file — the CLI does not write one on its own — so
 * this checks, in order: an explicit `STRIPE_LISTEN_STATUS_FILE` (a file the
 * runner that launched `stripe listen` may write itself); then `lsof` on the
 * PID named by `STRIPE_LISTEN_PID`, per the brief. If NEITHER env var is set,
 * this honestly returns `live: null` ("could not be determined either way")
 * rather than defaulting to a pass — the brief's own instruction.
 */
async function probeStripeListenLiveness(): Promise<{ live: boolean | null; detail: string }> {
  const statusFile = process.env.STRIPE_LISTEN_STATUS_FILE;
  if (statusFile) {
    try {
      await access(statusFile);
      return { live: true, detail: `STRIPE_LISTEN_STATUS_FILE "${statusFile}" exists.` };
    } catch {
      return { live: false, detail: `STRIPE_LISTEN_STATUS_FILE is set to "${statusFile}", but no file exists there.` };
    }
  }

  const pidEnv = process.env.STRIPE_LISTEN_PID;
  if (pidEnv) {
    const pid = Number(pidEnv);
    if (!Number.isFinite(pid) || pid <= 0) {
      return { live: false, detail: `STRIPE_LISTEN_PID="${pidEnv}" is not a usable PID.` };
    }
    try {
      await execFileAsync("lsof", ["-p", String(pid)]);
      return { live: true, detail: `PID ${pid} (from STRIPE_LISTEN_PID) is a live process.` };
    } catch (err) {
      return {
        live: false,
        detail: `lsof -p ${pid} (STRIPE_LISTEN_PID) found no live process: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  return {
    live: null,
    detail:
      "neither STRIPE_LISTEN_STATUS_FILE nor STRIPE_LISTEN_PID is set — whether a `stripe listen` " +
      "forwarder is live could not be determined either way.",
  };
}

/* -------------------------------------------------------------------------
 * Real probe implementations — the I/O boundary. Deliberately untested at
 * the unit level: each needs a live Postgres, a live process bound to a
 * port, or a live app server, which is exactly what the DI split above
 * exists to keep OUT of vitest. Proven only by an actual `_tiny` run
 * against real infrastructure (this task's smoke/e2e layer).
 * ---------------------------------------------------------------------- */

export interface RealProbesHandle {
  probes: PreflightProbes;
  /** Closes the DB connection this factory opened. Call once, after the
   *  pre-flight (and any other DB-touching check) is done with it.
   *
   *  A property with a function type, NOT a method shorthand: callers
   *  destructure it (`const { probes, dispose } = ...`), and a method
   *  separated from its object loses `this` — which `unbound-method` flags and
   *  which would be a real bug the day this stops being a closure. */
  dispose: () => Promise<void>;
}

/**
 * Wires every probe to real infrastructure. The `postgres` usage
 * (connection.search_path, DATABASE_SSL convention) is hand-copied from
 * `scripts/smoke.ts`'s own pattern (e.g. smoke.ts:4219) — smoke.ts itself is
 * never imported (_RULES.md §1 / B01 brief: no smoke.ts refactor, the
 * 13k-line monolith stays untouched).
 */
export function createRealPreflightProbes(): RealProbesHandle {
  const databaseUrl = process.env.DATABASE_URL;
  let sqlClient: ReturnType<typeof postgres> | undefined;

  function getSql(): ReturnType<typeof postgres> {
    if (!databaseUrl) {
      throw new Error("DATABASE_URL is not set — the bench needs its own throwaway DB (seazn-local-env skill §1).");
    }
    if (!sqlClient) {
      const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(databaseUrl);
      sqlClient = postgres(databaseUrl, {
        connection: { search_path: process.env.DB_SCHEMA ?? "seazn_club" },
        ssl: process.env.DATABASE_SSL === "disable" ? false : isLocal ? false : "require",
        max: 1,
      });
    }
    return sqlClient;
  }

  const probes: PreflightProbes = {
    async checkOwnDatabase(): Promise<OwnDatabaseResult> {
      if (!databaseUrl) {
        return { ok: false, reason: "own_db_connection_failed", detail: "DATABASE_URL is not set." };
      }
      let port: number;
      try {
        const parsed = new URL(databaseUrl);
        port = parsed.port ? Number(parsed.port) : DEV_DB_PORT;
      } catch (err) {
        return {
          ok: false,
          reason: "own_db_connection_failed",
          detail: `DATABASE_URL is not a valid URL: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      // Port checked first — a pure check against the parsed URL, no
      // connection opened — so a dev-DB target is refused on that fact
      // alone without ever running `show data_directory` against it. The
      // two are still independent traps (seazn-local-env skill §1) and
      // either can fire without the other; this only orders which one is
      // allowed to touch the shared dev DB at all (neither, ideally).
      if (port === DEV_DB_PORT) {
        return {
          ok: false,
          reason: "own_db_dev_db_port",
          detail: `DATABASE_URL targets port ${DEV_DB_PORT}, the shared local dev DB (seazn-local-env skill §1). Use a throwaway bench DB on another port.`,
          port,
        };
      }
      try {
        const sql = getSql();
        const [row] = await sql<{ data_directory: string }[]>`show data_directory`;
        const dataDirectory = row?.data_directory ?? "";
        const expected = process.env.BENCH_EXPECTED_DATA_DIR;
        if (expected && dataDirectory !== expected) {
          return {
            ok: false,
            reason: "own_db_data_directory_mismatch",
            detail: `show data_directory returned "${dataDirectory}", which does not match BENCH_EXPECTED_DATA_DIR "${expected}" — this DATABASE_URL reaches someone else's Postgres.`,
            dataDirectory,
            port,
          };
        }
        return { ok: true, detail: `own DB confirmed: ${dataDirectory} on port ${port}.`, dataDirectory, port };
      } catch (err) {
        return {
          ok: false,
          reason: "own_db_connection_failed",
          detail: `could not connect to DATABASE_URL: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },

    async checkOwnPort(port: number): Promise<OwnPortResult> {
      // `execFile`, never a shell pipeline — no intermediate wrapper can mask
      // the real exit code the way `cmd | tail` or `rtk` do (_RULES.md §3 /
      // AGENTS.md verification traps); Node hands back lsof's own
      // exit/error directly, so there is no `EXIT=$?` capture to add here.
      // `-sTCP:LISTEN`, not a bare `-i` — without it lsof also matches a
      // CLIENT socket through this port (some unrelated process's outbound
      // connection), which can false-alarm on a healthy server or, worse,
      // false-clear a foreign process squatting the port (documented repo
      // trap, `reference_server_ownership_check_needs_listen_filter`).
      try {
        const { stdout } = await execFileAsync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]);
        const pid = Number(stdout.trim().split("\n")[0]);
        if (!Number.isFinite(pid) || pid <= 0) {
          return {
            ok: false,
            reason: "own_port_unbound",
            detail: `lsof -nP -iTCP:${port} -sTCP:LISTEN -t returned no usable PID ("${stdout.trim()}").`,
          };
        }
        return { ok: true, detail: `port ${port} is bound (LISTEN) to PID ${pid}.`, pid };
      } catch (err) {
        // lsof exits non-zero (and prints nothing) when nothing matches —
        // the expected shape of "no server on this port", not a bug.
        return {
          ok: false,
          reason: "own_port_unbound",
          detail: `lsof -nP -iTCP:${port} -sTCP:LISTEN -t found no listening process on that port (${err instanceof Error ? err.message : String(err)}).`,
        };
      }
    },

    async checkPlacementHealth(): Promise<PlacementHealthResult> {
      const host = process.env.PLACEMENT_SERVICE_HOST ?? "placement.flycast:50051";
      // NOT `@seazn/engine/scheduling/placement-client` — that module's
      // static import graph reaches `./generated/scheduler.ts`, which
      // declares a TS `enum`. Node's `--experimental-strip-types` (this
      // script's own runtime, matching `scripts/smoke.ts`) erases types but
      // cannot synthesize an enum's runtime object, so ANY static or dynamic
      // import of that file throws `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` at
      // load time — confirmed live: a full `_tiny` run crashed the whole CLI
      // before a single probe ran. `@grpc/grpc-js` itself is plain published
      // JS (no stripping involved) and needs no generated proto stubs for a
      // liveness-only check, so it's added as a root dependency (pinned to
      // packages/engine's own `^1.14.4`) and used directly here via the raw
      // `grpc.Client` channel API — this proves a real HTTP/2 gRPC
      // connection came up, without decoding any RPC response.
      const channel = new grpc.Client(host, grpc.credentials.createInsecure());
      const deadline = Date.now() + 3000;
      try {
        await new Promise<void>((resolve, reject) => {
          channel.waitForReady(deadline, (err) => {
            if (err) reject(err);
            else resolve();
          });
        });
        return { status: "live", detail: `placement channel to ${host} reached READY within 3s.` };
      } catch (err) {
        return {
          status: "absent",
          detail: `placement channel to ${host} did not reach READY within 3s (${err instanceof Error ? err.message : String(err)}).`,
        };
      } finally {
        channel.close();
      }
    },

    async checkSportsCatalogSynced(): Promise<SportsCatalogResult> {
      // Reuses the "funnel badminton" witness (apps/web/src/lib/__tests__/
      // funnel.test.ts:91, `expect(div.sport_key).toBe("badminton")` — the
      // B01 brief cited :88-89, which is the query building `div`, not
      // the assertion itself; re-verified 2026-08-26 per _RULES.md §1) by
      // checking
      // the same underlying fact `sync:sports` establishes — badminton and
      // its system variants are present in `sports`/`sport_variants` —
      // directly against the DB, rather than re-importing the test's own
      // helpers (createFunnelDraft/consumeFunnelDraft/createFromDraft are
      // app internals, off limits per the brief's read-only-reference
      // rule). There is no read-only HTTP endpoint that exposes the sport
      // catalog as JSON (checked: no GET /api/v1/sports-shaped route
      // exists anywhere under apps/web/src/app/api, and adding one would be
      // product code, out of this task's scope) — the funnel test itself
      // proves the fact by direct SQL, and this probe mirrors exactly that
      // query shape rather than inventing an HTTP call that does not exist.
      try {
        const sql = getSql();
        const [sport] = await sql<{ key: string }[]>`select key from sports where key = 'badminton'`;
        if (!sport) {
          return {
            ok: false,
            reason: "sports_catalog_unsynced",
            detail: "sports.key = 'badminton' not found — run `npm run sync:sports` against this DB.",
          };
        }
        const [variant] = await sql<{ key: string }[]>`
          select key from sport_variants where sport_key = 'badminton' and is_system limit 1`;
        if (!variant) {
          return {
            ok: false,
            reason: "sports_catalog_unsynced",
            detail: "badminton has no system sport_variants rows — run `npm run sync:sports` against this DB.",
          };
        }
        return { ok: true, detail: "sports catalog synced: badminton + system variants present." };
      } catch (err) {
        return {
          ok: false,
          reason: "sports_catalog_unsynced",
          detail: `could not query the sports catalog: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },

    async checkAppHealth(base: string): Promise<AppHealthResult> {
      // localhost, never 127.0.0.1 — the Secure-cookie rule
      // (apps/web/e2e/global-setup.ts:75-85's own contract): require
      // res.ok AND the body to include `"ok":true`, not just a 200 (a
      // standalone build served without its static tree staged, or a DB
      // the server cannot reach, both still answer 200/503 with a body
      // that says otherwise).
      try {
        const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(10_000) });
        const body = await res.text().catch(() => "");
        if (!res.ok || !body.includes('"ok":true')) {
          return {
            ok: false,
            reason: "app_health_not_ok",
            detail: `${base}/api/health returned ${res.status}: ${body.slice(0, 200)}`,
          };
        }
        return { ok: true, detail: `${base}/api/health is healthy.` };
      } catch (err) {
        return {
          ok: false,
          reason: "app_health_unreachable",
          detail: `no server answering at ${base}/api/health: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },

    async checkStripeConfig(): Promise<StripeConfigResult> {
      // Booleans derived from the secret ONLY via a fixed-prefix check —
      // never logged or returned as a substring of the key itself (B03r
      // brief: "Never do this" — no prefix beyond the sk_test_/sk_live_
      // discriminator, no suffix, no length).
      const secretKey = process.env.STRIPE_SECRET_KEY;
      const testModeKeyPresent = !!secretKey && secretKey.startsWith("sk_test_");
      const liveKeyDetected = !!secretKey && secretKey.startsWith("sk_live_");
      const connectTestAccountPresent = !!process.env.STRIPE_CONNECT_TEST_ACCOUNT;
      const webhookSecretPresent = !!process.env.STRIPE_WEBHOOK_SECRET;
      const { live: webhookListenerLive, detail: webhookListenerDetail } = await probeStripeListenLiveness();
      return {
        testModeKeyPresent,
        liveKeyDetected,
        connectTestAccountPresent,
        webhookSecretPresent,
        webhookListenerLive,
        webhookListenerDetail,
      };
    },

    // Not `async` — `chromium.executablePath()` and `existsSync` are both
    // synchronous, and an `async` function with no `await` inside is an
    // eslint `require-await` error. Still satisfies `PreflightProbes`
    // (`Promise<ChromiumInstalledResult>`) via the explicit `Promise.resolve`.
    checkChromiumInstalled(): Promise<ChromiumInstalledResult> {
      try {
        const execPath = chromium.executablePath();
        if (!existsSync(execPath)) {
          return Promise.resolve({
            ok: false,
            detail: `chromium.executablePath() resolved to "${execPath}", but no file exists there — run \`npx playwright install chromium\`.`,
          });
        }
        return Promise.resolve({ ok: true, detail: `Chromium found at ${execPath}.` });
      } catch (err) {
        return Promise.resolve({
          ok: false,
          detail: `could not resolve a Chromium executable via playwright: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    },
  };

  return {
    probes,
    async dispose() {
      await sqlClient?.end();
    },
  };
}
