// Blog P2 Task 5: /help and /blog are cached at Cloudflare's edge, so a production deploy purges the zone (prod.yml,
// "Purge the Cloudflare cache"). The step's job is to fail LOUDLY: a purge that quietly skipped would leave pages at the
// edge naming JavaScript chunks the new build no longer serves. So this reads the step out of the workflow and RUNS its
// script against a stand-in curl on PATH: a missing secret, a refused purge, an unreadable answer and a failed request
// each exit non-zero; only `"success": true` exits 0. It never calls Cloudflare.
//
// Single-sport reason: no sport is involved; this is the deploy workflow.
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(import.meta.dirname, "../../../..");
const PROD = readFileSync(join(REPO_ROOT, ".github/workflows/prod.yml"), "utf8");

/** The `deploy-prod` job's text: from its header to the next job header. */
function job(name: string): string {
  const start = PROD.indexOf(`\n  ${name}:\n`);
  if (start === -1) throw new Error(`no job ${name} in prod.yml`);
  const next = PROD.slice(start + 1).search(/\n  [a-z][a-z0-9-]*:\n/);
  return next === -1 ? PROD.slice(start) : PROD.slice(start, start + 1 + next);
}
/** Each `- name:` step of a job, as its own text block, in order. */
function steps(jobText: string): { name: string; text: string }[] {
  return jobText.split(/\n(?=      - )/).slice(1).map((text) => ({ name: /^\s*- name:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? "", text }));
}
/** A step's `run: |` block, dedented. */
function runBlock(text: string): string {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => /^\s{8}run: \|\s*$/.test(l));
  if (at === -1) throw new Error("the purge step has no `run: |` block");
  const body: string[] = [];
  for (const l of lines.slice(at + 1)) {
    if (l.trim() !== "" && !l.startsWith("          ")) break;
    body.push(l.slice(10));
  }
  return body.join("\n");
}

const deploy = steps(job("deploy-prod"));
const purgeAt = deploy.findIndex((s) => s.name === "Purge the Cloudflare cache");
const purge = deploy[purgeAt];

describe("prod.yml: the Cloudflare purge after a deploy", () => {
  it("is a step of the deploying job, after the deploy, never conditional, never allowed to fail", () => {
    expect(deploy.length, "steps read from deploy-prod").toBeGreaterThan(3);
    expect(purge, "the purge step").toBeDefined();
    const deployAt = deploy.findIndex((s) => s.name === "Deploy the pushed image");
    expect(deployAt).toBeGreaterThanOrEqual(0);
    expect(purgeAt).toBeGreaterThan(deployAt);
    expect(purge!.text).not.toMatch(/^\s*if:/m);
    expect(purge!.text).not.toMatch(/continue-on-error/);
    expect(purge!.text).toContain("CF_ZONE_ID: ${{ secrets.CLOUDFLARE_ZONE_ID }}");
    expect(purge!.text).toContain("CF_PURGE_TOKEN: ${{ secrets.CLOUDFLARE_CACHE_PURGE_TOKEN }}");
  });

  // The script, run for real against a stand-in curl that records its argv and stdin and prints a chosen answer.
  const script = purge ? runBlock(purge.text) : "";
  const run = (env: Record<string, string>, answer: string, curlExit = 0) => {
    const dir = mkdtempSync(join(tmpdir(), "purge-"));
    const curl = join(dir, "curl");
    writeFileSync(
      curl,
      `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${dir}/argv"\ncat > "${dir}/stdin"\nprintf '%s' '${answer}'\nexit ${curlExit}\n`,
    );
    chmodSync(curl, 0o755);
    const res = spawnSync("bash", ["-e", "-c", script], {
      env: { PATH: `${dir}:${process.env.PATH}`, ...env } as unknown as NodeJS.ProcessEnv,
      encoding: "utf8",
    });
    const read = (f: string) => { try { return readFileSync(join(dir, f), "utf8"); } catch { return null; } };
    return { status: res.status, out: `${res.stdout}${res.stderr}`, argv: read("argv"), stdin: read("stdin") };
  };
  const SECRETS = { CF_ZONE_ID: "zone123", CF_PURGE_TOKEN: "tok-secret-456" };

  it("needs jq on the runner (ubuntu-latest has it), and so does this test", () => {
    expect(execFileSync("jq", ["--version"], { encoding: "utf8" })).toMatch(/jq/);
  });

  it("success: purges everything on the zone, with the token on stdin and never on curl's command line", () => {
    const r = run(SECRETS, '{"success":true,"errors":[],"result":{"id":"zone123"}}');
    expect(r.status, r.out).toBe(0);
    expect(r.argv).toContain("https://api.cloudflare.com/client/v4/zones/zone123/purge_cache");
    expect(r.argv).toContain('{"purge_everything":true}');
    expect(r.argv).not.toContain("tok-secret-456");
    expect(r.stdin).toBe("Authorization: Bearer tok-secret-456\n");
  });

  it("fails loudly, never skips: each failure exits non-zero with an ::error:: line", () => {
    const cases: [string, Record<string, string>, string, number, boolean][] = [
      ["no zone id", { CF_PURGE_TOKEN: "t" }, '{"success":true}', 0, false],
      ["no token", { CF_ZONE_ID: "z" }, '{"success":true}', 0, false],
      ["Cloudflare refuses", SECRETS, '{"success":false,"errors":[{"code":10000,"message":"Authentication error"}]}', 0, true],
      ["an answer that is not JSON", SECRETS, "<html>502</html>", 0, true],
      ["an empty answer", SECRETS, "", 0, true],
      ["the request never completes", SECRETS, "", 28, true],
    ];
    let checked = 0;
    for (const [label, env, answer, curlExit, called] of cases) {
      const r = run(env, answer, curlExit);
      expect(r.status, `${label}: ${r.out}`).not.toBe(0);
      expect(r.out, label).toContain("::error::");
      expect(r.argv !== null, `${label}: curl ${called ? "called" : "never called"}`).toBe(called);
      checked++;
    }
    console.log(`[purge] failure cases checked: ${checked}`);
    expect(checked).toBe(cases.length);
  });
});
