import { describe, expect, it, vi } from "vitest";
import { handleManual, secretMatches } from "../src/manual";
import type { Env, RunDeps } from "../src/run";
import { JOBS, type Job } from "../src/schedule";

const env: Env = { ENV_NAME: "stg", BASE_URL: "https://stg.seazn.club", ACTIVE: "false", CRON_SECRET: "s3cret" };
function deps() {
  const fetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response('{"deleted":0}'));
  const d: RunDeps = { fetch: fetch as never, sleep: async () => {}, now: () => 0, log: () => {}, uuid: () => "u" };
  return { d, fetch };
}
const req = (path: string, secret?: string, method = "POST") =>
  new Request(`https://seazn-cron-stg.example.workers.dev${path}`, {
    method,
    headers: secret === undefined ? {} : { "x-cron-secret": secret },
  });

describe("handleManual", () => {
  it("runs an idempotent job on demand, even while inactive", async () => {
    const { d, fetch } = deps();
    const res = await handleManual(req("/run?job=ai-previews", "s3cret"), env, d);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject([{ job: "ai-previews", status: "ok" }]);
    expect(fetch).toHaveBeenCalledWith("https://stg.seazn.club/api/cron/ai-previews", expect.anything());
  });

  it.each([[undefined], [""], ["wrong"]])("401 for secret %j, runs nothing", async (s) => {
    const { d, fetch } = deps();
    expect((await handleManual(req("/run?job=ai-previews", s), env, d)).status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
  });

  // M-5: authentication comes BEFORE the job lookup, so a caller without the secret learns nothing
  // about which job ids exist (a lookup-first order would answer 404 for them and 401 for real ones).
  it.each([[undefined], ["wrong"]])("an unknown job with secret %j is 401, not 404", async (s) => {
    const { d, fetch } = deps();
    expect((await handleManual(req("/run?job=nope", s), env, d)).status).toBe(401);
    expect((await handleManual(req("/run", s), env, d)).status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("401 when the Worker has no secret configured, whatever is sent", async () => {
    const { d, fetch } = deps();
    expect((await handleManual(req("/run?job=ai-previews", ""), { ...env, CRON_SECRET: "" }, d)).status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("R2: news-digest runs on demand and is never re-sent", async () => {
    const { d, fetch } = deps();
    fetch.mockResolvedValueOnce(new Response("busy", { status: 503 }));
    expect((await handleManual(req("/run?job=news-digest", "s3cret"), env, d)).status).toBe(502);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("https://stg.seazn.club/api/cron/news-digest", expect.anything());
  });

  it("403 for a row that says manual: false (no row does today; the guard stays reachable)", async () => {
    const { d, fetch } = deps();
    const locked: Job = { ...JOBS.find((j) => j.id === "ai-previews")!, id: "locked", manual: false };
    expect((await handleManual(req("/run?job=locked", "s3cret"), env, d, [locked])).status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("404 for an unknown job, a wrong path or a GET", async () => {
    const { d } = deps();
    expect((await handleManual(req("/run?job=nope", "s3cret"), env, d)).status).toBe(404);
    expect((await handleManual(req("/other?job=ai-previews", "s3cret"), env, d)).status).toBe(404);
    expect((await handleManual(req("/run?job=ai-previews", "s3cret", "GET"), env, d)).status).toBe(404);
  });

  it("502 when the job itself failed", async () => {
    const { d, fetch } = deps();
    fetch.mockResolvedValueOnce(new Response("bad", { status: 500 }));
    expect((await handleManual(req("/run?job=ai-previews", "s3cret"), env, d)).status).toBe(502);
  });

  it("R5: a failed manual run raises ONE error event tagged run=manual, and never touches a check-in endpoint", async () => {
    const { d, fetch } = deps();
    fetch.mockResolvedValueOnce(new Response("bad", { status: 500 }));
    const withDsn: Env = { ...env, SENTRY_DSN: "https://k@o1.ingest.sentry.io/9" };
    expect((await handleManual(req("/run?job=ai-previews", "s3cret"), withDsn, d)).status).toBe(502);
    const urls = fetch.mock.calls.map(([u]) => String(u));
    expect(urls).toEqual(["https://stg.seazn.club/api/cron/ai-previews", "https://o1.ingest.sentry.io/api/9/envelope/?sentry_key=k&sentry_version=7"]);
    const event = JSON.parse(String(fetch.mock.calls[1]![1]!.body).split("\n")[2]!);
    expect(event.tags).toMatchObject({ job: "ai-previews", run: "manual" });
  });
});

describe("secretMatches", () => {
  it("matches only an identical non-empty secret", () => {
    expect(secretMatches("abc", "abc")).toBe(true);
    expect(secretMatches("abd", "abc")).toBe(false);
    expect(secretMatches("ab", "abc")).toBe(false);
    expect(secretMatches(null, "abc")).toBe(false);
    expect(secretMatches("", "")).toBe(false);
  });
});
