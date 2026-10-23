import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/run";
import { FAST_TRIGGER, FIVE_MINUTES, TRIGGER_CRON } from "../src/schedule";

// The Worker entry is the seam between Cloudflare (controller.cron / scheduledTime) and runDue.
// A pure runDue test cannot see it, so this drives the real default export.
const MONDAY_0817 = Date.parse("2026-09-28T08:17:00Z");
const env: Env = { ENV_NAME: "stg", BASE_URL: "https://stg.seazn.club", ACTIVE: "true", CRON_SECRET: "s" };
const controller = (cron: string, scheduledTime: number) => ({ cron, scheduledTime, noRetry() {} }) as unknown as ScheduledController;
const OK = JSON.stringify({ ok: true, data: { failed: 0, alerted: 0 } });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubNetwork(delayMs: number) {
  const done: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      await new Promise((r) => setTimeout(r, delayMs));
      done.push(new URL(url).pathname);
      return new Response(OK);
    }),
  );
  const lines: Record<string, unknown>[] = [];
  vi.spyOn(console, "log").mockImplementation((l: string) => void lines.push(JSON.parse(l)));
  return { done, lines };
}

describe("worker.scheduled", () => {
  it("I-2: does not resolve until EVERY due job has finished (it awaits the run, never fire-and-forget)", async () => {
    const net = stubNetwork(15);
    await worker.scheduled!(controller(TRIGGER_CRON, MONDAY_0817), env);
    // Monday 08:17: the three every-firing rows plus the weekly digest. Each fetch takes 15 ms, so a
    // handler that returned early would leave all but the first still in flight.
    expect(net.done).toEqual(["/api/cron/registrations", "/api/cron/billing-events", "/api/funnel/remind", "/api/cron/news-digest"]);
    expect(net.lines.at(-1)).toMatchObject({ event: "run", jobs: 4, cron: TRIGGER_CRON, scheduledTime: "2026-09-28T08:17:00.000Z" });
  });

  it("passes the firing's own trigger and scheduled time through (not the wall clock, not swapped)", async () => {
    const net = stubNetwork(0);
    await worker.scheduled!(controller(TRIGGER_CRON, Date.parse("2026-09-29T14:17:00Z")), env);
    expect(net.done, "a Tuesday 14:17 slot runs the three every-firing rows only").toEqual([
      "/api/cron/registrations",
      "/api/cron/billing-events",
      "/api/funnel/remind",
    ]);
    expect(net.lines.filter((l) => l.event === "job").map((l) => l.scheduledTime)).toEqual(Array(3).fill("2026-09-29T14:17:00.000Z"));
  });

  it("the env decides the fast trigger: stg's */5 slot runs the three fast rows; prod's minute trigger runs the outbox every minute and the 5-minute jobs only on a multiple of five", async () => {
    const prodEnv: Env = { ...env, ENV_NAME: "prod", BASE_URL: "https://seazn.club" };
    const HOUR = Date.parse("2026-09-28T08:00:00Z");
    const FAST = ["/api/cron/stream-tick", "/api/cron/external-play", "/api/cron/email-outbox"];

    const stg = stubNetwork(0);
    await worker.scheduled!(controller(FAST_TRIGGER.stg, HOUR + FIVE_MINUTES * 60_000), env);
    expect(stg.done, "stg").toEqual(FAST);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();

    const prodFive = stubNetwork(0);
    await worker.scheduled!(controller(FAST_TRIGGER.prod, HOUR + FIVE_MINUTES * 60_000), prodEnv);
    expect(prodFive.done, "prod, a multiple of five").toEqual(FAST);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();

    const prodOther = stubNetwork(0);
    await worker.scheduled!(controller(FAST_TRIGGER.prod, HOUR + (FIVE_MINUTES + 1) * 60_000), prodEnv);
    expect(prodOther.done, "prod, any other minute").toEqual(["/api/cron/email-outbox"]);
    // The pair: a trigger the env does not use runs nothing.
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    const wrong = stubNetwork(0);
    await worker.scheduled!(controller(FAST_TRIGGER.stg, HOUR), prodEnv);
    expect(wrong.done).toEqual([]);
    expect(wrong.lines).toEqual([expect.objectContaining({ event: "unknown-trigger", cron: FAST_TRIGGER.stg, env: "prod" })]);
  });

  it("an unknown trigger is refused by name and calls nothing", async () => {
    // "*/7": a well-formed trigger no row names ("*/5" is stream-tick's since T7b).
    const net = stubNetwork(0);
    await worker.scheduled!(controller("*/7 * * * *", MONDAY_0817), env);
    expect(net.done).toEqual([]);
    expect(net.lines).toEqual([expect.objectContaining({ event: "unknown-trigger", cron: "*/7 * * * *" })]);
  });
});
