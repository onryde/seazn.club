import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FAST_TRIGGER,
  FIVE_MINUTES,
  JOBS,
  MINUTE_CRON,
  STREAM_TICK_CRON,
  TRIGGER_CRON,
  dueJobs,
  firstSlotOfHour,
  triggerFor,
  triggersOf,
  type EnvName,
  type Job,
} from "../src/schedule";

// Expected values come from the spec's table (§4) and the 2026-10-01 rulings
// (§13), never from JOBS itself.
const at = (iso: string) => new Date(iso);
/** The environments the Worker is deployed to (wrangler.json's `env` keys), typed from the ruling, never read from JOBS. */
const ENVS: readonly EnvName[] = ["stg", "prod"];
const ids = (d: Date, cron = TRIGGER_CRON, env: string = "prod", jobs: readonly Job[] = JOBS) =>
  dueJobs(d, cron, env, jobs).map((j) => j.id);
const HOURLY = ["registrations", "billing-events", "funnel-remind"];
/** Capture QR v2 §6.11 (W22): the stream-tick trigger, every 5 minutes. Typed from the spec, never read from JOBS. */
const EVERY_5 = "*/5 * * * *";
/** The 2026-10-20 owner ruling: prod's fast trigger is the minute one (the email outbox's worker runs every minute there). */
const EVERY_MINUTE = "* * * * *";
/** Chess in-page board design §4: "The 5-minute cron stays what it is … but it is NOT optional" — the external-play
 *  sweep (T+20 no-show, mint retry, meeting teardown, reconcile, camera evidence). The email outbox's worker
 *  (owner ruling 2026-10-20) rides the same one fast trigger per env. Typed from the specs, never read from JOBS. The
 *  fast-trigger rows, in table order. */
const FAST_ROWS = ["stream-tick", "external-play", "email-outbox"];
/** The ONE row that is still a 5-minute job: on prod it hangs off the minute trigger and runs on every fifth minute. The
 *  stream tick left this list on 2026-10-28 (YouTube Connect T15, spec §6.7, D9 as amended by owner Q1 = b): it runs on EVERY
 *  fast firing, so a broadcast whose end is due is ended within a minute on prod. */
const FIVE_MINUTE_JOBS = ["external-play"];
/** The rows due at a prod minute that is NOT a multiple of five: the every-firing rows, in table order. */
const EVERY_FIRING_ROWS = ["stream-tick", "email-outbox"];
/** A well-formed trigger no row names. */
const UNKNOWN = "*/7 * * * *";

describe("dueJobs on the hourly trigger", () => {
  it("runs only the every-firing jobs at an ordinary hour", () => {
    expect(ids(at("2026-09-29T14:17:00Z"))).toEqual(HOURLY); // Tuesday
  });

  it("adds each daily job at its own hour, in table order", () => {
    expect(ids(at("2026-09-29T03:17:00Z"))).toEqual([...HOURLY, "ai-previews"]);
    expect(ids(at("2026-09-29T04:17:00Z"))).toEqual([...HOURLY, "relay-sweep"]); // R1
    expect(ids(at("2026-09-29T06:17:00Z"))).toEqual([...HOURLY, "billing-quantity"]);
    expect(ids(at("2026-09-29T07:17:00Z"))).toEqual([...HOURLY, "billing-grant"]);
  });

  it("runs news-digest on Monday 08 UTC and on no other day at 08", () => {
    expect(ids(at("2026-09-28T08:17:00Z"))).toEqual([...HOURLY, "news-digest"]); // Monday
    for (const day of ["2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"]) {
      expect(ids(at(`${day}T08:17:00Z`))).toEqual(HOURLY);
    }
  });

  it("keys on the SCHEDULED hour: a late invocation still runs its own slot", () => {
    // Cloudflare hands a late invocation its slot's scheduledTime. Within the
    // hourly trigger, the minute is irrelevant.
    expect(ids(at("2026-09-28T08:59:59Z"))).toContain("news-digest");
    expect(ids(at("2026-09-28T09:00:00Z"))).not.toContain("news-digest");
  });

  it("over one full week: each every-firing job 168×, each daily 7×, the digest 1×", () => {
    const counts = new Map<string, number>();
    const start = Date.parse("2026-09-28T00:17:00Z"); // Monday
    for (let h = 0; h < 168; h++) {
      for (const id of ids(new Date(start + h * 3_600_000))) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    expect(Object.fromEntries(counts)).toEqual({
      registrations: 168,
      "billing-events": 168,
      "funnel-remind": 168,
      "ai-previews": 7,
      "relay-sweep": 7,
      "billing-quantity": 7,
      "billing-grant": 7,
      "news-digest": 1,
    });
  });
});

describe("dueJobs is keyed on the firing trigger (R4)", () => {
  it("a trigger no row names selects nothing", () => {
    for (const env of ENVS) {
      expect(ids(at("2026-09-28T08:05:00Z"), UNKNOWN, env), env).toEqual([]);
      expect(ids(at("2026-09-28T08:17:00Z"), "", env), env).toEqual([]);
    }
  });

  it("the fast trigger is one per env: stg keeps the spec's */5, prod's is the minute trigger that REPLACES it (owner ruling 2026-10-20)", () => {
    expect(STREAM_TICK_CRON).toBe(EVERY_5);
    expect(MINUTE_CRON).toBe(EVERY_MINUTE);
    expect(FAST_TRIGGER).toEqual({ stg: EVERY_5, prod: EVERY_MINUTE });
    expect(Object.keys(FAST_TRIGGER).sort()).toEqual([...ENVS].sort());
    expect(FIVE_MINUTES).toBe(5);
  });

  it("the stream-tick row is in the table exactly once, on the env's fast trigger, due on EVERY firing, never retried (YouTube Connect T15; was every fifth minute, W22)", () => {
    expect(JOBS.filter((j) => j.id === "stream-tick")).toEqual([
      {
        id: "stream-tick",
        path: "/api/cron/stream-tick",
        trigger: FAST_TRIGGER,
        due: { kind: "every" },
        retry: false,
        manual: true,
        // The session pass's `failed` and the YouTube end step's `failed` (route answer `data.youtube.failed`).
        failureCounts: ["data.failed", "data.youtube.failed"],
      },
    ]);
  });

  it("the external-play row is in the table exactly once, on the env's fast trigger, due on every fifth minute (chess in-page design §4)", () => {
    expect(JOBS.filter((j) => j.id === "external-play")).toEqual([
      // Never retried: the next firing, 5 minutes later, IS the retry, and the sweep's pass lock answers an overlapping
      // re-send with `skipped`. Final review I-1: a failed fixture and a skipped pass are both failures to the monitor.
      {
        id: "external-play",
        path: "/api/cron/external-play",
        trigger: FAST_TRIGGER,
        due: { kind: "minuteMod", every: FIVE_MINUTES },
        retry: false,
        manual: true,
        failureCounts: ["data.failed", "data.skipped"],
      },
    ]);
  });

  it("the email-outbox row is in the table exactly once, on the env's fast trigger, due on EVERY firing, never retried (spec 'The retry worker')", () => {
    expect(JOBS.filter((j) => j.id === "email-outbox")).toEqual([
      // Never retried: the next firing IS the retry, and skip-locked claims plus the lease make an overlap safe.
      {
        id: "email-outbox",
        path: "/api/cron/email-outbox",
        trigger: FAST_TRIGGER,
        due: { kind: "every" },
        retry: false,
        manual: true,
        failureCounts: ["data.failed"],
      },
    ]);
  });

  it("a second trigger runs ONLY its own rows: never news-digest or an hourly row, even at Monday 08:05", () => {
    expect(ids(at("2026-09-28T08:05:00Z"), FAST_TRIGGER.stg, "stg")).toEqual(FAST_ROWS);
    expect(ids(at("2026-09-28T08:05:00Z"), FAST_TRIGGER.prod, "prod")).toEqual(FAST_ROWS);
    expect(ids(at("2026-09-28T08:17:00Z"), TRIGGER_CRON)).toEqual([...HOURLY, "news-digest"]);
  });

  it("each env answers only to its OWN fast trigger: prod ignores stg's */5 and stg ignores the minute trigger", () => {
    expect(ids(at("2026-09-28T08:05:00Z"), EVERY_5, "prod")).toEqual([]);
    expect(ids(at("2026-09-28T08:05:00Z"), EVERY_MINUTE, "stg")).toEqual([]);
  });

  it("on prod's minute trigger the stream tick and the outbox run on EVERY minute and the 5-minute job only on minutes divisible by 5", () => {
    let checked = 0;
    for (let m = 0; m < 60; m++) {
      const want = m % FIVE_MINUTES === 0 ? FAST_ROWS : EVERY_FIRING_ROWS;
      expect(ids(new Date(Date.UTC(2026, 8, 28, 8, m)), MINUTE_CRON, "prod"), `:${m}`).toEqual(want);
      checked++;
    }
    expect(checked).toBe(60);
  });

  // YouTube Connect T15 (spec §6.7; owner Q1 = b, 2026-10-27). The four cadence rulings, each at the instants the owner's words name.
  describe("T15: the stream tick runs on every fast firing; stg keeps */5", () => {
    it("stream-tick is due on EVERY fast firing on prod: 10:01, 10:02 and 10:03 each include it (it was due only at 10:00 and 10:05 before)", () => {
      let checked = 0;
      for (const minute of [1, 2, 3, 4, 6, 7, 59]) {
        const got = ids(new Date(Date.UTC(2026, 9, 28, 10, minute)), MINUTE_CRON, "prod");
        expect(got, `10:${String(minute).padStart(2, "0")}`).toContain("stream-tick");
        expect(got, `10:${String(minute).padStart(2, "0")} is not a fifth minute`).not.toContain("external-play");
        checked++;
      }
      expect(checked).toBe(7);
    });

    it("stg's fast trigger stays '*/5 * * * *' (owner Q1 = b: a minute trigger would keep stg awake all day); stream-tick is due at every stg firing, 10:05 and 10:10", () => {
      expect(FAST_TRIGGER.stg).toBe("*/5 * * * *");
      let checked = 0;
      for (const minute of [0, 5, 10, 15, 55]) {
        expect(ids(new Date(Date.UTC(2026, 9, 28, 10, minute)), FAST_TRIGGER.stg, "stg"), `stg 10:${String(minute).padStart(2, "0")}`).toEqual(FAST_ROWS);
        checked++;
      }
      expect(checked).toBe(5);
      // The pair: stg's trigger is the only one that fires it there — the minute trigger is unknown to stg.
      expect(ids(new Date(Date.UTC(2026, 9, 28, 10, 1)), MINUTE_CRON, "stg")).toEqual([]);
    });

    it("external-play stays 5-minutely on prod: due at 10:05, NOT at 10:06 (the positive pair of the case above)", () => {
      expect(ids(new Date(Date.UTC(2026, 9, 28, 10, 5)), MINUTE_CRON, "prod")).toContain("external-play");
      expect(ids(new Date(Date.UTC(2026, 9, 28, 10, 6)), MINUTE_CRON, "prod")).not.toContain("external-play");
      expect(JOBS.find((j) => j.id === "external-play")!.due).toEqual({ kind: "minuteMod", every: 5 });
    });

    it("email-outbox cadence is unchanged: every fast firing in both envs (prod every minute, stg every 5 minutes)", () => {
      let prod = 0;
      for (let m = 0; m < 60; m++) {
        expect(ids(new Date(Date.UTC(2026, 9, 28, 10, m)), MINUTE_CRON, "prod"), `prod :${m}`).toContain("email-outbox");
        prod++;
      }
      expect(prod).toBe(60);
      let stg = 0;
      for (let m = 0; m < 60; m += 5) {
        expect(ids(new Date(Date.UTC(2026, 9, 28, 10, m)), FAST_TRIGGER.stg, "stg"), `stg :${m}`).toContain("email-outbox");
        stg++;
      }
      expect(stg).toBe(12);
      expect(JOBS.find((j) => j.id === "email-outbox")!.due).toEqual({ kind: "every" });
    });
  });

  describe("keyed on the SCHEDULED minute, never the wall clock", () => {
    afterEach(() => vi.useRealTimers());

    it("scheduled :05 delivered at :06 runs the 5-minute job; scheduled :06 delivered at :10 does not", () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(at("2026-09-28T08:06:00Z"));
      expect(ids(at("2026-09-28T08:05:00Z"), MINUTE_CRON, "prod")).toEqual(FAST_ROWS);
      vi.setSystemTime(at("2026-09-28T08:10:00Z"));
      expect(ids(at("2026-09-28T08:06:00Z"), MINUTE_CRON, "prod")).toEqual(EVERY_FIRING_ROWS);
      // Anti-vacuity: the fake clock is the one the code would have read.
      expect(new Date().getUTCMinutes()).toBe(10);
    });
  });

  it("a minuteMod row whose period is not a whole number of minutes in 1..59 is refused by name, never silently never-due", () => {
    let refused = 0;
    for (const every of [0, -5, 2.5, Number.NaN, 60]) {
      const bad: Job = { ...JOBS.find((j) => j.id === "stream-tick")!, trigger: MINUTE_CRON, due: { kind: "minuteMod", every } };
      expect(() => dueJobs(at("2026-09-28T08:05:00Z"), MINUTE_CRON, "prod", [bad]), String(every)).toThrow(/minuteMod/);
      refused++;
    }
    expect(refused).toBe(5);
  });

  it("triggersOf lists each distinct trigger once: stg the hourly and */5, prod the hourly and the minute one (2 per env: 4 of the account's 5)", () => {
    expect(triggersOf("stg")).toEqual([TRIGGER_CRON, EVERY_5]);
    expect(triggersOf("prod")).toEqual([TRIGGER_CRON, EVERY_MINUTE]);
  });

  it("prod's triggers are exactly the hourly and the minute one: the */5 entry is gone, not doubled", () => {
    expect(triggersOf("prod").sort()).toEqual([TRIGGER_CRON, MINUTE_CRON].sort());
    expect(triggersOf("prod")).not.toContain(STREAM_TICK_CRON);
  });

  it("the trigger count is unchanged: 2 per env", () => {
    let checked = 0;
    for (const env of ENVS) {
      expect(triggersOf(env).length, env).toBe(2);
      checked++;
    }
    expect(checked).toBe(ENVS.length);
  });

  it("triggersOf refuses an env a per-env row does not name, by name", () => {
    expect(() => triggersOf("qa")).toThrow('triggerFor: no trigger for env "qa" on job stream-tick');
  });
});

describe("triggerFor", () => {
  const row = (id: string) => JOBS.find((j) => j.id === id)!;

  it("a per-env row resolves to its env's trigger", () => {
    for (const id of ["stream-tick", "external-play", "email-outbox"]) {
      expect(triggerFor(row(id), "stg"), `${id} stg`).toBe(EVERY_5);
      expect(triggerFor(row(id), "prod"), `${id} prod`).toBe(EVERY_MINUTE);
    }
  });

  it("a plain-string row is the same trigger in every env, including one it has never heard of", () => {
    expect(triggerFor(row("registrations"), "stg")).toBe(TRIGGER_CRON);
    expect(triggerFor(row("registrations"), "prod")).toBe(TRIGGER_CRON);
    expect(triggerFor(row("registrations"), "qa")).toBe(TRIGGER_CRON);
  });

  it("refuses an unknown env by name, naming the job", () => {
    expect(() => triggerFor(row("email-outbox"), "qa")).toThrow('triggerFor: no trigger for env "qa" on job email-outbox');
    expect(() => triggerFor(row("stream-tick"), "")).toThrow('triggerFor: no trigger for env "" on job stream-tick');
  });

  it("an env spelled like an Object.prototype member is unknown, not inherited", () => {
    let refused = 0;
    for (const env of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(() => triggerFor(row("email-outbox"), env), env).toThrow(/triggerFor: no trigger for env/);
      refused++;
    }
    expect(refused).toBe(4);
  });

  it("every per-env row names exactly the deployed envs (a third env, or a missing one, is a table error)", () => {
    const perEnv = JOBS.filter((j) => typeof j.trigger !== "string");
    expect(perEnv.map((j) => j.id), "per-env rows checked").toEqual(FAST_ROWS);
    for (const j of perEnv) expect(Object.keys(j.trigger).sort(), j.id).toEqual([...ENVS].sort());
  });
});

/** A just-big-enough crontab matcher for the three shapes the table uses (`M * * * *`, `* * * * *`, `*\/N * * * *`);
 *  anything else is refused BY NAME, so a new trigger shape cannot be silently counted as zero firings. */
function firesAt(cron: string, minute: number): boolean {
  if (cron === "* * * * *") return true;
  const every = /^\*\/(\d+) \* \* \* \*$/.exec(cron);
  if (every) return minute % Number(every[1]) === 0;
  const fixed = /^(\d+) \* \* \* \*$/.exec(cron);
  if (fixed) return minute === Number(fixed[1]);
  throw new Error(`firesAt: cannot match trigger ${JSON.stringify(cron)}`);
}
/** Firings per hour of a trigger, in closed form (so the tally below is checked against arithmetic, not against itself). */
const firingsPerHour = (cron: string): number => {
  if (cron === "* * * * *") return 60;
  const every = /^\*\/(\d+) \* \* \* \*$/.exec(cron);
  if (every) return 60 / Number(every[1]);
  throw new Error(`firingsPerHour: cannot count trigger ${JSON.stringify(cron)}`);
};

describe("a simulated hour: how many times each job actually runs (derived from the constants)", () => {
  // 08:00 UTC on a Tuesday: no daily or weekly row is due, so only the every-firing and fast rows count.
  const HOUR_START = Date.parse("2026-09-29T08:00:00Z");
  /** job id -> firings over minutes 0..59: every trigger of the env fires at each scheduled minute it matches. */
  function tally(env: EnvName): Record<string, number> {
    const counts: Record<string, number> = {};
    for (let m = 0; m < 60; m++) {
      const scheduled = new Date(HOUR_START + m * 60_000);
      for (const cron of triggersOf(env)) {
        if (!firesAt(cron, m)) continue;
        for (const id of ids(scheduled, cron, env)) counts[id] = (counts[id] ?? 0) + 1;
      }
    }
    return counts;
  }

  it("the matcher understands the table's shapes and refuses any other by name (anti-vacuity for the tally)", () => {
    expect(firesAt("* * * * *", 7)).toBe(true);
    expect(firesAt("*/5 * * * *", 10)).toBe(true);
    expect(firesAt("*/5 * * * *", 11)).toBe(false);
    expect(firesAt("17 * * * *", 17)).toBe(true);
    expect(firesAt("17 * * * *", 18)).toBe(false);
    expect(() => firesAt("0 9 * * 1", 0)).toThrow(/firesAt/);
    expect(() => firesAt("*/5 9 * * *", 0)).toThrow(/firesAt/);
  });

  it("prod runs the stream tick and the outbox 60 times and the 5-minute job 12; stg runs all three 12 (stg's trigger fires every 5 minutes)", () => {
    const prod = tally("prod");
    const stg = tally("stg");
    const fiveMin = 60 / FIVE_MINUTES; // 12, from the constant
    const stgTick = firingsPerHour(STREAM_TICK_CRON); // 12, from the constant
    const minute = firingsPerHour(MINUTE_CRON); // 60, from the constant
    for (const id of FIVE_MINUTE_JOBS) {
      expect(prod[id], `prod ${id}`).toBe(fiveMin);
      expect(stg[id], `stg ${id}`).toBe(fiveMin);
    }
    // T15: the stream tick runs on every firing of the env's fast trigger, as the outbox does.
    expect(prod["stream-tick"], "prod stream-tick").toBe(minute);
    expect(stg["stream-tick"], "stg stream-tick").toBe(stgTick);
    expect(prod["email-outbox"], "prod email-outbox").toBe(minute);
    expect(stg["email-outbox"], "stg email-outbox").toBe(stgTick);
    // The hourly rows are untouched by any of this: once an hour on both envs.
    for (const id of HOURLY) {
      expect(prod[id], `prod ${id}`).toBe(1);
      expect(stg[id], `stg ${id}`).toBe(1);
    }
    expect(Object.keys(prod).length, "prod jobs tallied").toBeGreaterThanOrEqual(3);
    expect(Object.keys(stg).length, "stg jobs tallied").toBe(Object.keys(prod).length);
  });
});

describe("JOBS table", () => {
  it("has unique ids and paths", () => {
    expect(new Set(JOBS.map((j) => j.id)).size).toBe(JOBS.length);
    expect(new Set(JOBS.map((j) => j.path)).size).toBe(JOBS.length);
  });

  it("retry is off for exactly news-digest (P3/D7), relay-sweep (R1), stream-tick, external-play and email-outbox (each one's next firing is the retry); every job may be run by hand (R1, R2)", () => {
    expect(JOBS.filter((j) => !j.retry).map((j) => j.id)).toEqual(["relay-sweep", "news-digest", "stream-tick", "external-play", "email-outbox"]);
    expect(JOBS.filter((j) => !j.manual)).toEqual([]);
  });

  it("every daily or weekly row hangs off the hourly trigger (on a faster one its hour test would pass every tick)", () => {
    // `minuteMod` is not a timed-of-day row: it is the slower of two jobs sharing a FAST trigger (pinned by the simulated hour).
    const timed = JOBS.filter((j) => j.due.kind === "daily" || j.due.kind === "weekly");
    expect(timed.map((j) => j.id), "rows checked").toEqual([
      "ai-previews",
      "relay-sweep",
      "billing-quantity",
      "billing-grant",
      "news-digest",
    ]);
    expect(timed.filter((j) => j.trigger !== TRIGGER_CRON)).toEqual([]);
  });

  it("R3: the money jobs name the exact failure counters of their 200 body", () => {
    // From the routes' return types inside lib/http.ts handler's { ok, data }
    // envelope: billing-events → sweepStuckEvents; billing-quantity →
    // reconcileGroupQuantities + sweepOrphanGroups + sweepStaleOrgAddonPrices;
    // billing-grant → grantMonthlyForAllWallets.
    const withCounts = Object.fromEntries(JOBS.filter((j) => j.failureCounts).map((j) => [j.id, j.failureCounts]));
    expect(withCounts).toEqual({
      "billing-events": ["data.failed", "data.alerted"],
      "billing-quantity": ["data.failed", "data.orphanGroups.failed", "data.addonPrices.mismatched"],
      "billing-grant": ["data.failed"],
      // T7b: stream-tick's StreamTickResult.failed — `deferred` is NOT a failure (reached at the next firing). T15: and the
      // YouTube end step's YoutubeEndResult.failed (broadcasts that failed this pass and will be retried), at data.youtube.failed.
      "stream-tick": ["data.failed", "data.youtube.failed"],
      // Final review I-1: SweepReport.failed (fixtures whose action threw) and .skipped (1 when another pass held the
      // lock). `deferred` is NOT a failure (the pass budget ran out; the next firing reaches the rest).
      "external-play": ["data.failed", "data.skipped"],
      // The outbox worker's OutboxTickReport.failed — rows whose attempt threw in our own code, or a tick that could not
      // run (role check). `deferred` is NOT a failure (the next minute reaches those rows).
      "email-outbox": ["data.failed"],
    });
  });
});

describe("firstSlotOfHour (R2 option S: one Sentry event per job per UTC hour)", () => {
  it("every trigger either env uses is one it can judge (anti-vacuity: the hourly, */5 and the minute trigger)", () => {
    let checked = 0;
    for (const env of ENVS) {
      for (const t of triggersOf(env)) {
        expect(() => firstSlotOfHour(t, at("2026-09-28T08:00:00Z")), `${env} ${t}`).not.toThrow();
        checked++;
      }
    }
    expect(new Set(ENVS.flatMap((e) => triggersOf(e))).size, "distinct triggers").toBeGreaterThanOrEqual(3);
    expect(checked).toBe(ENVS.length * 2);
  });

  it("every minute: only the :00 slot is the hour's first, so a job on the minute trigger raises at most one event an hour", () => {
    const truths: number[] = [];
    for (let m = 0; m < 60; m++) if (firstSlotOfHour(MINUTE_CRON, new Date(Date.UTC(2026, 8, 28, 8, m, 30)))) truths.push(m);
    expect(truths).toEqual([0]);
    // The slot, not the wall clock, decides: a late :00 invocation is handed :00; one scheduled :01 is never first.
    expect(firstSlotOfHour(MINUTE_CRON, at("2026-09-28T09:00:00Z"))).toBe(true);
    expect(firstSlotOfHour(MINUTE_CRON, at("2026-09-28T09:01:00Z"))).toBe(false);
    expect(firstSlotOfHour(MINUTE_CRON, at("2026-09-28T09:59:59Z"))).toBe(false);
  });

  it("the hourly trigger fires once an hour, so every firing is its hour's first", () => {
    let checked = 0;
    for (let m = 0; m < 60; m++) {
      expect(firstSlotOfHour(TRIGGER_CRON, new Date(Date.UTC(2026, 8, 28, 8, m))), `:${m}`).toBe(true);
      checked++;
    }
    expect(checked).toBe(60);
  });

  it("*/5: only the :00 slot is the hour's first — minutes 0..4 true, 5..59 false, keyed on UTC", () => {
    const truths: number[] = [];
    for (let m = 0; m < 60; m++) if (firstSlotOfHour(EVERY_5, new Date(Date.UTC(2026, 8, 28, 8, m, 30)))) truths.push(m);
    expect(truths).toEqual([0, 1, 2, 3, 4]);
    // A late invocation of the :00 slot is handed :00 as its scheduledTime, so the slot, not the wall clock, decides.
    expect(firstSlotOfHour(EVERY_5, at("2026-09-28T08:05:00Z"))).toBe(false);
    expect(firstSlotOfHour(EVERY_5, at("2026-09-28T09:00:00Z"))).toBe(true);
  });

  it("any other trigger shape is refused by name — a guard, not a guess", () => {
    let refused = 0;
    for (const t of ["0 9 * * 1", "17 */2 * * *", "*/0 * * * *", "*/60 * * * *", "*/5 9 * * *", ""]) {
      expect(() => firstSlotOfHour(t, at("2026-09-28T08:00:00Z")), JSON.stringify(t)).toThrow(/firstSlotOfHour/);
      refused++;
    }
    expect(refused).toBe(6);
  });
});
