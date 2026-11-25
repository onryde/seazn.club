// The release hold-back for the "Open in app" buttons (plan 2026-11-25, Task 4). The buttons ship to STAGING only until
// the phone release that handles /app/* links is on Play: before that, every tap on production would land on "isn't on
// this phone yet". `NEXT_PUBLIC_*` is baked at BUILD time, so the switch is a build arg: "1" in fly.stg.toml, declared
// and exported by the Dockerfile (docker silently drops an undeclared build arg), and NOT in fly.toml. Adding it to
// fly.toml is Task 6, which also changes this file.
//
// CI's e2e builds with it too, in every job that runs Playwright, so the button specs there run against a real bundle.
//
// Pure: no DB, no network; runs in every unit job and cannot self-skip.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openInAppEnabled } from "../open-in-app";

const REPO_ROOT = resolve(import.meta.dirname, "../../../../..");
const read = (file: string) => readFileSync(resolve(REPO_ROOT, file), "utf8");
const FLAG = "NEXT_PUBLIC_OPEN_IN_APP";

/** The [build.args] section of a fly config, as `KEY = "value"` pairs. */
function buildArgs(file: string): Map<string, string> {
  const section = read(file).split(/^\s*\[build\.args\]\s*$/m)[1] ?? "";
  const body = section.split(/^\s*\[/m)[0] ?? "";
  return new Map([...body.matchAll(/^\s*([A-Z0-9_]+)\s*=\s*"([^"]*)"/gm)].map((m) => [m[1]!, m[2]!]));
}

describe("openInAppEnabled", () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    [undefined, false],
    ["", false],
    ["0", false],
    ["true", false],
    ["1", true],
  ])("NEXT_PUBLIC_OPEN_IN_APP=%j → %j (only the literal \"1\" turns it on)", (value, on) => {
    vi.stubEnv(FLAG, value as string);
    expect(openInAppEnabled()).toBe(on);
  });
});

describe("the release hold-back", () => {
  it("staging builds with the flag on", () => {
    expect(buildArgs("fly.stg.toml").get(FLAG)).toBe("1");
  });

  it("production does NOT: fly.toml names the flag nowhere (not even commented, so a deploy cannot pick it up)", () => {
    const args = buildArgs("fly.toml");
    // Anti-vacuity: the same reader sees production's other build args.
    expect(args.size).toBeGreaterThan(5);
    expect(args.get("NEXT_PUBLIC_BASE_URL")).toBe("https://seazn.club");
    expect(read("fly.toml")).not.toContain(FLAG);
  });

  it("no deploying workflow sets it past the fly config", () => {
    let checked = 0;
    for (const file of [".github/workflows/prod.yml", ".github/workflows/stg.yml"]) {
      expect(read(file), file).not.toContain(FLAG);
      checked += 1;
    }
    expect(checked).toBe(2);
  });

  it("the Dockerfile declares and exports it, and gives it no default", () => {
    const dockerfile = read("Dockerfile");
    expect(dockerfile).toMatch(new RegExp(`^ARG ${FLAG}$`, "m"));
    expect(dockerfile).toMatch(new RegExp(`^ENV ${FLAG}=\\$${FLAG}$`, "m"));
  });

  it("every e2e.yml job that runs Playwright builds and runs with it, at JOB level — counted", () => {
    const lines = read(".github/workflows/e2e.yml").split("\n");
    const jobsAt = lines.findIndex((l) => l === "jobs:");
    expect(jobsAt).toBeGreaterThanOrEqual(0);
    const jobs: { name: string; body: string[] }[] = [];
    for (const line of lines.slice(jobsAt + 1)) {
      const header = /^ {2}([a-z0-9_-]+):\s*$/.exec(line);
      if (header) jobs.push({ name: header[1]!, body: [] });
      else if (/^\S/.test(line)) break;
      else jobs.at(-1)?.body.push(line);
    }
    const playwrightJobs = jobs.filter((j) => j.body.some((l) => /^\s+run:.*playwright test/.test(l)));
    expect(playwrightJobs.length).toBeGreaterThan(0);
    let checked = 0;
    for (const job of playwrightJobs) {
      const envAt = job.body.findIndex((l) => l === "    env:");
      expect(envAt, `${job.name}: a job-level env block`).toBeGreaterThanOrEqual(0);
      const env: string[] = [];
      for (const l of job.body.slice(envAt + 1)) {
        if (l.trim() === "" || /^ {6}#/.test(l)) continue;
        if (!/^ {6}\S/.test(l)) break;
        env.push(l);
      }
      expect(env, job.name).toContain(`      ${FLAG}: "1"`);
      checked += 1;
    }
    expect(checked).toBe(playwrightJobs.length);
    // And no step overrides it back off.
    expect(read(".github/workflows/e2e.yml").match(new RegExp(`${FLAG}:`, "g"))).toHaveLength(playwrightJobs.length);
  });
});
