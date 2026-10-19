// Which deployment a browser Sentry event came from (owner ruling 2026-10-19). NODE_ENV is "production" on staging AND production
// (the Dockerfile sets it for both), so it cannot tell them apart; the one public value that does is the site's own origin,
// NEXT_PUBLIC_BASE_URL, which each fly config bakes into the bundle (fly.toml -> https://seazn.club, fly.stg.toml ->
// https://stg.seazn.club). The expected environments here come from the deploy configs' own declarations (the `app` name each
// ends in), not from the helper under test.
import { describe, expect, it } from "vitest";
import { sentryEnvironment } from "../sentry-environment";
import { deployConfig } from "./_deploy-config";

describe("sentryEnvironment", () => {
  it("names each deployment by what its deploy config says it is (staging is not production)", () => {
    const prod = deployConfig("fly.toml");
    const stg = deployConfig("fly.stg.toml");
    expect([prod.environment, stg.environment], "premise: the two configs are two different environments").toEqual(["production", "staging"]);
    expect(prod.baseUrl).not.toBe(stg.baseUrl);
    // NODE_ENV is "production" in both images, which is exactly why it cannot be the answer.
    expect(sentryEnvironment(prod.baseUrl, "production")).toBe(prod.environment);
    expect(sentryEnvironment(stg.baseUrl, "production")).toBe(stg.environment);
    // ...and the build's NODE_ENV never overrides the deployment.
    expect(sentryEnvironment(stg.baseUrl, "development")).toBe("staging");
    expect(sentryEnvironment(prod.baseUrl, "development")).toBe("production");
  });

  it("falls back to NODE_ENV when the origin names no known deployment (local, CI, a preview)", () => {
    const unknown = [undefined, "", "   ", "not a url", "localhost:3000", "http://localhost:3000", "http://127.0.0.1:3343", "https://example.com"];
    for (const baseUrl of unknown) {
      expect(sentryEnvironment(baseUrl, "production"), `${String(baseUrl)} in a production build`).toBe("production");
      expect(sentryEnvironment(baseUrl, "development"), `${String(baseUrl)} in development`).toBe("development");
    }
    expect(sentryEnvironment(undefined, undefined), "no NODE_ENV either").toBe("development");
    expect(unknown.length, "anti-vacuity: the unknown origins were swept").toBe(8);
  });

  it("matches the host exactly: a lookalike, a suffix or a subdomain of a deployment is not that deployment", () => {
    const lookalikes = [
      "https://seazn.club.evil.test",
      "https://stg.seazn.club.evil.test",
      "https://evilseazn.club",
      "https://notstg.seazn.club",
      "https://www.seazn.club",
      "https://x.stg.seazn.club",
      "https://evil.test/?u=https://stg.seazn.club",
      "https://evil.test/stg.seazn.club",
    ];
    for (const baseUrl of lookalikes) expect(sentryEnvironment(baseUrl, "development"), baseUrl).toBe("development");
    expect(lookalikes.length).toBe(8);
  });

  it("reads the host, not the spelling of the URL (case, port, path and trailing slash do not matter)", () => {
    expect(sentryEnvironment("https://SEAZN.club/", "development")).toBe("production");
    expect(sentryEnvironment("https://seazn.club:443/some/path?q=1", "development")).toBe("production");
    expect(sentryEnvironment("https://Stg.Seazn.Club", "development")).toBe("staging");
    expect(sentryEnvironment("https://stg.seazn.club:8443/", "development")).toBe("staging");
  });

  it("a host that is an Object.prototype name is not a deployment (the table is looked up by own key, not by property access)", () => {
    for (const baseUrl of ["http://constructor", "http://tostring", "http://valueof", "http://hasownproperty"]) {
      // URL lower-cases the host, so `toString` arrives as `tostring`: still not a key, and `constructor` is the real trap.
      expect(sentryEnvironment(baseUrl, "development"), baseUrl).toBe("development");
    }
    expect(sentryEnvironment("http://constructor", "production")).toBe("production");
  });

  it("never throws, whatever the baked value", () => {
    for (const baseUrl of ["http://", "https://[", "//", "\u0000", "javascript:alert(1)", "https://stg.seazn.club\n"]) {
      expect(() => sentryEnvironment(baseUrl, "production"), JSON.stringify(baseUrl)).not.toThrow();
    }
  });
});
