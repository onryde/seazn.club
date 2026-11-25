// IndexNow (indexnow.org/documentation): after a production deploy, prod.yml tells the search engines which pages to
// fetch again (scripts/indexnow-submit.ts), and the site proves it owns them with a key file at its root. Two promises
// are held here: ONLY a production deploy can submit (never staging, a laptop, a test or a pull request run), and the
// submission can neither fail nor hold up that deploy.
//
// NOTHING here calls the real endpoint: the function takes its `fetch` as an argument with no default, and the one test
// that runs the script itself replaces the process's fetch with a recorder before the script loads.
//
// Expected values: the limits and the key's shape are the protocol's own (10,000 URLs a post; 8 to 128 of a-z, A-Z, 0-9
// and "-"), and the production origin is the one fly.toml deploys with.
//
// Single-sport reason: no sport is involved; this is the deploy workflow.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { INDEXNOW_KEY, refusal, sitemapUrls, submitIndexNow } from "../indexnow-submit.ts";

const REPO = join(import.meta.dirname, "../..");
const PROTOCOL_MAX = 10_000;
const FLY_ORIGIN = /^\s*OAUTH_BASE_URL\s*=\s*"([^"]+)"/m.exec(readFileSync(join(REPO, "fly.toml"), "utf8"))![1]!;
const STG_ORIGIN = /^\s*OAUTH_BASE_URL\s*=\s*"([^"]+)"/m.exec(readFileSync(join(REPO, "fly.stg.toml"), "utf8"))![1]!;

/** What the runner sets on prod.yml's tag push, plus the origin its step names. */
const PROD_ENV = { INDEXNOW_ORIGIN: FLY_ORIGIN, GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/tags/v1.2.3" };

const sitemapXml = (locs: string[]) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${locs
    .map((l) => `<url>\n<loc>${l}</loc>\n<xhtml:link rel="alternate" hreflang="fr" href="${FLY_ORIGIN}/fr/only-an-alternate" />\n</url>`)
    .join("\n")}\n</urlset>\n`;

interface Call {
  url: string;
  init: RequestInit | undefined;
}
/** A stand-in fetch: the sitemap for a GET, `status` for each POST in turn. */
function fakeFetch(locs: string[], opts: { sitemapStatus?: number; statuses?: number[] } = {}) {
  const calls: Call[] = [];
  let posts = 0;
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    if (init?.method !== "POST") return new Response(sitemapXml(locs), { status: opts.sitemapStatus ?? 200 });
    return new Response(null, { status: opts.statuses?.[posts++] ?? 200 });
  }) as typeof globalThis.fetch;
  return { fetch, calls, posted: () => calls.filter((c) => c.init?.method === "POST") };
}
const pages = (n: number) => Array.from({ length: n }, (_, i) => `${FLY_ORIGIN}/help/page-${i}`);

describe("the IndexNow key file", () => {
  it("is served at the site's root under its own name, and holds exactly the key", () => {
    expect(INDEXNOW_KEY).toMatch(/^[a-zA-Z0-9-]{8,128}$/);
    const file = join(REPO, "apps/web/public", `${INDEXNOW_KEY}.txt`);
    expect(existsSync(file), file).toBe(true);
    expect(readFileSync(file, "utf8")).toBe(INDEXNOW_KEY);
  });

  it("is the only key file there: a rotated key leaves no old one behind", () => {
    const names = readdirSync(join(REPO, "apps/web/public")).filter((f) => /^[0-9a-f]{32}\.txt$/.test(f));
    expect(names).toEqual([`${INDEXNOW_KEY}.txt`]);
  });
});

describe("who may submit: a production deploy and nothing else", () => {
  it("premise: production and staging, as fly deploys them, are different origins", () => {
    expect(FLY_ORIGIN).toBe("https://seazn.club");
    expect(STG_ORIGIN).not.toBe(FLY_ORIGIN);
  });

  const refused: [string, Record<string, string | undefined>][] = [
    ["no origin at all (a laptop, a unit test)", { ...PROD_ENV, INDEXNOW_ORIGIN: undefined }],
    ["staging's origin", { ...PROD_ENV, INDEXNOW_ORIGIN: STG_ORIGIN }],
    ["a local server", { ...PROD_ENV, INDEXNOW_ORIGIN: "http://localhost:3000" }],
    ["a trailing slash", { ...PROD_ENV, INDEXNOW_ORIGIN: "https://seazn.club/" }],
    ["http", { ...PROD_ENV, INDEXNOW_ORIGIN: "http://seazn.club" }],
    ["www", { ...PROD_ENV, INDEXNOW_ORIGIN: "https://www.seazn.club" }],
    ["a look-alike host", { ...PROD_ENV, INDEXNOW_ORIGIN: "https://seazn.club.example.test" }],
    ["upper case", { ...PROD_ENV, INDEXNOW_ORIGIN: "https://SEAZN.club" }],
    ["the right origin outside GitHub Actions", { INDEXNOW_ORIGIN: FLY_ORIGIN }],
    // Everything but the runner's own flag, so no other check can answer for this one.
    ["a hand-set tag push outside GitHub Actions", { ...PROD_ENV, GITHUB_ACTIONS: undefined }],
    ["a pull request run", { ...PROD_ENV, GITHUB_EVENT_NAME: "pull_request", GITHUB_REF: "refs/pull/1/merge" }],
    ["a push to main (staging's workflow)", { ...PROD_ENV, GITHUB_REF: "refs/heads/main" }],
    ["a manual run on a tag", { ...PROD_ENV, GITHUB_EVENT_NAME: "workflow_dispatch" }],
    ["a tag that is not a release", { ...PROD_ENV, GITHUB_REF: "refs/tags/nightly" }],
  ];

  it("refuses each of these, and makes no request of any kind", async () => {
    let checked = 0;
    for (const [label, env] of refused) {
      expect(refusal(env), label).toEqual(expect.any(String));
      const f = fakeFetch(pages(1));
      await expect(submitIndexNow({ env, fetch: f.fetch }), label).rejects.toThrow(/refusing/i);
      expect(f.calls, label).toEqual([]);
      checked++;
    }
    console.log(`[indexnow] refused environments checked: ${checked}`);
    expect(checked).toBe(14);
  });

  it("allows the production deploy's own environment (the positive pair)", () => {
    expect(refusal(PROD_ENV)).toBeNull();
  });

  it("the script itself, run outside a production deploy, exits non-zero and sends nothing", () => {
    // The process's fetch is replaced before the script loads, so no run of this test can reach the network.
    const dir = mkdtempSync(join(tmpdir(), "indexnow-"));
    const marker = join(dir, "fetched");
    const preload = join(dir, "no-network.mjs");
    writeFileSync(
      preload,
      `import { appendFileSync } from "node:fs";\nglobalThis.fetch = async (u) => { appendFileSync(${JSON.stringify(marker)}, String(u) + "\\n"); throw new Error("the test's fetch: no network"); };\n`,
    );
    const run = (env: Record<string, string>) =>
      spawnSync(process.execPath, ["--experimental-strip-types", "--import", pathToFileURL(preload).href, "scripts/indexnow-submit.ts"], {
        cwd: REPO,
        env: { PATH: process.env.PATH ?? "", ...env } as unknown as NodeJS.ProcessEnv,
        encoding: "utf8",
        timeout: 30_000,
      });
    const cases: Record<string, string>[] = [{}, { INDEXNOW_ORIGIN: STG_ORIGIN }, { INDEXNOW_ORIGIN: FLY_ORIGIN }, { ...PROD_ENV, GITHUB_EVENT_NAME: "pull_request" }];
    let checked = 0;
    for (const env of cases) {
      const r = run(env);
      expect(r.status, `${JSON.stringify(env)}: ${r.stdout}${r.stderr}`).toBe(1);
      expect(`${r.stdout}${r.stderr}`).toMatch(/refusing/i);
      checked++;
    }
    expect(checked).toBe(4);
    expect(existsSync(marker), "a refused run fetched something").toBe(false);
    // Positive pair: the production environment gets as far as the sitemap read (and this stub stops it there).
    const prod = run(PROD_ENV);
    expect(prod.status, `${prod.stdout}${prod.stderr}`).toBe(1);
    expect(readFileSync(marker, "utf8")).toBe(`${FLY_ORIGIN}/sitemap.xml\n`);
    expect(prod.stdout).toContain("::warning::");
  }, 60_000);
});

describe("what is submitted", () => {
  it("reads each <loc> of the sitemap, XML-unescaped, and no hreflang alternate", () => {
    const xml = sitemapXml([`${FLY_ORIGIN}/en`, `${FLY_ORIGIN}/live/a/b?x=1&amp;y=2`]);
    expect(sitemapUrls(xml)).toEqual([`${FLY_ORIGIN}/en`, `${FLY_ORIGIN}/live/a/b?x=1&y=2`]);
  });

  it("posts the production sitemap's URLs to the shared endpoint, with the key and where it is served", async () => {
    const f = fakeFetch([...pages(3), pages(3)[0]!, `${STG_ORIGIN}/help/other-host`, "https://example.test/x"]);
    const result = await submitIndexNow({ env: PROD_ENV, fetch: f.fetch });
    expect(f.calls[0]!.url).toBe(`${FLY_ORIGIN}/sitemap.xml`);
    const posts = f.posted();
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toBe("https://api.indexnow.org/indexnow");
    expect(new Headers(posts[0]!.init!.headers).get("content-type")).toBe("application/json; charset=utf-8");
    expect(JSON.parse(String(posts[0]!.init!.body))).toEqual({
      host: "seazn.club",
      key: INDEXNOW_KEY,
      keyLocation: `${FLY_ORIGIN}/${INDEXNOW_KEY}.txt`,
      urlList: pages(3),
    });
    // The protocol refuses a URL of another host (422), so it is left out and counted; a repeat is sent once.
    expect(result).toEqual({ submitted: 3, batches: 1, otherHost: 2 });
  });

  it("sends at most 10,000 URLs a post, and every URL exactly once", async () => {
    let checked = 0;
    for (const [n, sizes] of [[PROTOCOL_MAX, [PROTOCOL_MAX]], [PROTOCOL_MAX + 1, [PROTOCOL_MAX, 1]], [2 * PROTOCOL_MAX + 5, [PROTOCOL_MAX, PROTOCOL_MAX, 5]]] as const) {
      const f = fakeFetch(pages(n));
      await submitIndexNow({ env: PROD_ENV, fetch: f.fetch });
      const lists = f.posted().map((c) => (JSON.parse(String(c.init!.body)) as { urlList: string[] }).urlList);
      expect(lists.map((l) => l.length), String(n)).toEqual(sizes);
      expect(lists.flat(), String(n)).toEqual(pages(n));
      checked += n;
    }
    expect(checked).toBe(4 * PROTOCOL_MAX + 6);
  });

  it("accepts 200 and 202, and names any other answer", async () => {
    for (const status of [200, 202]) {
      await expect(submitIndexNow({ env: PROD_ENV, fetch: fakeFetch(pages(1), { statuses: [status] }).fetch })).resolves.toMatchObject({ submitted: 1 });
    }
    let checked = 0;
    for (const status of [400, 403, 422, 429, 500]) {
      await expect(submitIndexNow({ env: PROD_ENV, fetch: fakeFetch(pages(1), { statuses: [status] }).fetch }), String(status)).rejects.toThrow(String(status));
      checked++;
    }
    expect(checked).toBe(5);
  });

  it("stops at the first refused batch", async () => {
    const f = fakeFetch(pages(PROTOCOL_MAX + 1), { statuses: [429, 200] });
    await expect(submitIndexNow({ env: PROD_ENV, fetch: f.fetch })).rejects.toThrow("429");
    expect(f.posted()).toHaveLength(1);
  });

  it("zero URLs is a failure, and a sitemap that does not answer posts nothing", async () => {
    for (const f of [fakeFetch([]), fakeFetch([`${STG_ORIGIN}/en`]), fakeFetch(pages(2), { sitemapStatus: 503 })]) {
      await expect(submitIndexNow({ env: PROD_ENV, fetch: f.fetch })).rejects.toThrow(/sitemap/i);
      expect(f.posted()).toEqual([]);
    }
  });

  it("every request gives up on its own: each carries an abort signal", async () => {
    const f = fakeFetch(pages(1));
    await submitIndexNow({ env: PROD_ENV, fetch: f.fetch });
    expect(f.calls).toHaveLength(2);
    for (const c of f.calls) expect(c.init?.signal, c.url).toBeInstanceOf(AbortSignal);
  });
});

describe("the workflows", () => {
  const dir = join(REPO, ".github/workflows");
  const workflows = readdirSync(dir).filter((f) => f.endsWith(".yml"));
  /** A workflow's lines with comment lines dropped. */
  const code = (f: string) => readFileSync(join(dir, f), "utf8").split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");

  it("only prod.yml runs the script, and nothing else anywhere posts to IndexNow", () => {
    expect(workflows.length, "workflows read").toBeGreaterThan(5);
    expect(workflows.filter((f) => /indexnow-submit|api\.indexnow\.org|INDEXNOW_ORIGIN/.test(code(f)))).toEqual(["prod.yml"]);
    const manifests = ["package.json", "apps/web/package.json", "apps/cron-worker/package.json"];
    for (const m of manifests) expect(readFileSync(join(REPO, m), "utf8"), m).not.toContain("indexnow");
  });

  it("prod.yml submits after the deploy, only on success, and can neither fail nor hold up the job", () => {
    const text = code("prod.yml");
    const steps = text.split(/\n(?= {6}- )/);
    const at = steps.findIndex((s) => s.includes("scripts/indexnow-submit.ts"));
    const deployAt = steps.findIndex((s) => /name: Deploy the pushed image/.test(s));
    expect(deployAt, "the deploy step").toBeGreaterThan(-1);
    expect(at, "the IndexNow step, after the deploy").toBeGreaterThan(deployAt);
    expect(steps.filter((s) => s.includes("scripts/indexnow-submit.ts"))).toHaveLength(1);
    const step = steps[at]!.split(/\n {2}[a-z][a-z0-9-]*:\n/)[0]!;
    expect(step).toMatch(/^ {8}continue-on-error: true$/m);
    const minutes = Number(/^ {8}timeout-minutes: (\d+)$/m.exec(step)?.[1]);
    expect(minutes).toBeGreaterThan(0);
    expect(minutes).toBeLessThanOrEqual(2);
    // No `if:`, so it runs only when every step before it, the deploy among them, succeeded.
    expect(step).not.toMatch(/^ {8}if:/m);
    expect(step).toMatch(/^ {8}run: node --experimental-strip-types scripts\/indexnow-submit\.ts$/m);
    expect(step).toContain(`INDEXNOW_ORIGIN: ${FLY_ORIGIN}`);
    // In the deploying job, not the cron Worker's.
    const worker = text.indexOf("\n  deploy-cron-worker-prod:");
    expect(worker).toBeGreaterThan(-1);
    expect(text.indexOf("scripts/indexnow-submit.ts")).toBeLessThan(worker);
  });

  it("prod.yml fires on a release tag and on nothing else, which is what the script's guard requires", () => {
    const on = /\non:\n((?: {2}.*\n)+)/.exec(code("prod.yml"))![1]!;
    expect(on.trim()).toBe('push:\n    tags: ["v*.*.*"]');
  });
});
