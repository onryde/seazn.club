import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const BASE = process.env.CRON_E2E_BASE_URL; // e.g. http://localhost:3000 (a local PROD build)
const DB = process.env.DATABASE_URL;
const SECRET = process.env.CRON_SECRET ?? "";
const PORT = 8799;
// A8: pin the firing instant. A Tuesday 14:17 UTC slot runs only the three
// every-firing rows (spec §4). It never runs billing-quantity's Stripe calls
// (06), relay-sweep (04) or a Monday 08 digest, whatever the wall clock says.
const SLOT = Date.parse("2026-09-29T14:17:00Z");
const SLOT_JOBS = ["registrations", "billing-events", "funnel-remind"];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!BASE || !DB || !SECRET)("cron Worker E2E (wrangler dev → local Next → DB)", () => {
  let dev: ChildProcess;
  let out = "";
  // The app pins `search_path` to its schema (apps/web/src/lib/db.ts:88,111); a bare
  // connection lands in `public`, where funnel_drafts does not exist.
  const sql = postgres(DB!, { max: 1, connection: { search_path: process.env.DB_SCHEMA ?? "seazn_club" } });
  const jobLines = () =>
    [...out.matchAll(/\{"event":"job"[^\n]*\}/g)].map((m) => JSON.parse(m[0]) as { job: string; scheduledTime: string });

  beforeAll(async () => {
    dev = spawn(
      "pnpm",
      ["exec", "wrangler", "dev", "--test-scheduled", "--port", String(PORT), "--env", "stg",
        "--var", `BASE_URL:${BASE}`, "--var", "ACTIVE:true", "--var", `CRON_SECRET:${SECRET}`],
      // A8: its own process GROUP. pnpm → wrangler → workerd, and killing pnpm
      // alone leaves workerd holding the port.
      { cwd: `${import.meta.dirname}/..`, detached: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    dev.stdout!.on("data", (b) => void (out += String(b)));
    dev.stderr!.on("data", (b) => void (out += String(b)));
    for (let i = 0; i < 60; i++) {
      try {
        await fetch(`http://localhost:${PORT}/`);
        return;
      } catch {
        await sleep(1_000);
      }
    }
    throw new Error(`wrangler dev did not start:\n${out.slice(-2_000)}`);
  }, 90_000);

  afterAll(async () => {
    if (dev?.pid) {
      try {
        process.kill(-dev.pid, "SIGTERM");
      } catch {
        // already gone
      }
    }
    await sql.end();
  });

  it("a pinned hourly slot stamps reminded_at on a due funnel draft, and runs exactly that slot's jobs", async () => {
    const token = `e2e-${randomUUID()}`;
    const [draft] = await sql<{ id: string }[]>`
      insert into funnel_drafts (token, email, payload, expires_at, created_at)
      values (${token}, ${`${token}@example.test`}, ${sql.json({})}, now() + interval '6 days', now() - interval '25 hours')
      returning id`;
    const res = await fetch(
      `http://localhost:${PORT}/cdn-cgi/handler/scheduled?cron=${encodeURIComponent("17 * * * *")}&time=${SLOT}`,
    );
    expect(res.status).toBe(200);
    // The handler returns before waitUntil settles: poll for the side effect,
    // then for the Worker's own job lines.
    let reminded: Date | null = null;
    for (let i = 0; i < 60 && !reminded; i++) {
      const rows = await sql<{ reminded_at: Date | null }[]>`select reminded_at from funnel_drafts where id = ${draft!.id}`;
      reminded = rows[0]?.reminded_at ?? null;
      if (!reminded) await sleep(1_000);
    }
    expect(reminded).not.toBeNull();
    for (let i = 0; i < 30 && jobLines().length < SLOT_JOBS.length; i++) await sleep(1_000);
    // The pinned slot was honoured. A `time` the runtime ignored, or read in a
    // different unit, lands on another slot and fails here.
    expect(jobLines().map((l) => l.job)).toEqual(SLOT_JOBS);
    expect(new Set(jobLines().map((l) => l.scheduledTime))).toEqual(new Set([new Date(SLOT).toISOString()]));
  }, 120_000);
});
