// The CS-4 probes' write guard (realtime push nudges, Task 14 review m2). A probe that WRITES — the division probe's delivery
// test appends a `schedule_edited` ledger step — does so wherever PLAYWRIGHT_BASE points, so it refuses every host that is
// not stg or a local server unless REALTIME_PROBE_ALLOW_PROD is exactly "1". Pure: unit-tested by
// src/lib/__tests__/realtime-probe-target-guard.test.ts (vitest never collects e2e/). Not a spec: the probes project's
// testMatch is `*.spec.ts`.

/** The hosts a probe may write to without the override: stg, its Fly app, and a local server. */
export const PROBE_WRITE_HOSTS: readonly string[] = ["stg.seazn.club", "seazn-club-stg.fly.dev", "localhost", "127.0.0.1", "[::1]"];

/** Why a probe must not write to `base`, or null when it may. `base` unset is Playwright's default (playwright.config.ts:
 *  `http://localhost:3000`). A base that is not a URL names no host and is refused even with the override. */
export function probeWriteRefusal(base: string | undefined, allowProd: string | undefined): string | null {
  const target = base ?? "http://localhost:3000";
  let host: string;
  try {
    host = new URL(target).hostname;
  } catch {
    return `the probe writes; PLAYWRIGHT_BASE ${JSON.stringify(target)} is not a URL (REALTIME_PROBE_ALLOW_PROD=1 cannot make it one)`;
  }
  if (PROBE_WRITE_HOSTS.includes(host)) return null;
  if (allowProd === "1") return null;
  return (
    `the probe writes a ledger step; PLAYWRIGHT_BASE ${JSON.stringify(target)} is not stg or local ` +
    `(${PROBE_WRITE_HOSTS.join(", ")}). Set REALTIME_PROBE_ALLOW_PROD=1 to write there on purpose.`
  );
}
