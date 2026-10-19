// The seed scripts used to sign in with /api/auth/login (and sign up with /api/auth/signup). Those routes are gone, so
// they sign in by magic link now: request a link, consume the token the server returns in `login_url`.
//
// The fake `call` below reproduces the server's contract rather than the helper's: a link is single-use, an unknown
// email creates the account, and `login_url` is only returned when dev links are exposed. A fake that accepted any
// token would let a helper that sent the wrong thing pass.
//
// Sport: not applicable (auth plumbing).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ApiCall } from "../seed-resume.ts";
import { loginTokenFrom, signInByMagicLink } from "../seed-signin.ts";

function fakeServer(opts: { exposeDevLinks?: boolean } = {}) {
  const exposeDevLinks = opts.exposeDevLinks ?? true;
  const accounts = new Set<string>();
  const liveTokens = new Map<string, string>(); // token -> email
  const sessions: string[] = [];
  const calls: { path: string; method: string | undefined; body: unknown }[] = [];
  let minted = 0;
  const call: ApiCall = async (path, method, body) => {
    calls.push({ path, method, body });
    if (path === "/api/auth/magic-link" && method === "POST") {
      const { email } = body as { email: string };
      accounts.add(email);
      const token = `tok-${++minted}-${"x".repeat(24)}`;
      liveTokens.set(token, email);
      return exposeDevLinks
        ? { message: "Check your email", login_url: `http://localhost:3000/magic-link?token=${token}` }
        : { message: "Check your email" };
    }
    if (path === "/api/auth/magic-link/consume" && method === "POST") {
      const { token } = body as { token: string };
      const email = liveTokens.get(token);
      if (!email) throw new Error("This sign-in link is invalid or has expired");
      liveTokens.delete(token); // single use
      sessions.push(email);
      return { has_org: true, org_id: `org-of-${email}`, redirect: "/dashboard" };
    }
    throw new Error(`no such route: ${method ?? "GET"} ${path}`);
  };
  return { call, accounts, sessions, calls };
}

describe("signInByMagicLink", () => {
  it("creates the account for an unknown email, consumes the very token it was given, and ends signed in", async () => {
    const s = fakeServer();
    const r = await signInByMagicLink(s.call, "new@example.test");
    expect(s.accounts.has("new@example.test"), "the magic-link request created the account").toBe(true);
    expect(s.sessions).toEqual(["new@example.test"]);
    expect(r).toEqual({ has_org: true, org_id: "org-of-new@example.test", redirect: "/dashboard" });
    // Exactly two calls, in order, and the consume body carries ONLY the token the link had.
    expect(s.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /api/auth/magic-link",
      "POST /api/auth/magic-link/consume",
    ]);
    expect(s.calls[0]!.body).toEqual({ email: "new@example.test" });
    expect(Object.keys(s.calls[1]!.body as object)).toEqual(["token"]);
  });

  it("a second sign-in for the same email mints a fresh link and works (a seeder re-run)", async () => {
    const s = fakeServer();
    await signInByMagicLink(s.call, "again@example.test");
    await signInByMagicLink(s.call, "again@example.test");
    expect(s.sessions).toEqual(["again@example.test", "again@example.test"]);
    const tokens = s.calls.filter((c) => c.path.endsWith("/consume")).map((c) => (c.body as { token: string }).token);
    expect(new Set(tokens).size, "each sign-in used its own token").toBe(2);
  });

  it("the empty case: a server that hides the link (production, no AUTH_DEV_LINKS) is a named error, not a bad email", async () => {
    const s = fakeServer({ exposeDevLinks: false });
    await expect(signInByMagicLink(s.call, "hidden@example.test")).rejects.toThrow(/AUTH_DEV_LINKS=1/);
    expect(s.sessions, "nothing was consumed").toEqual([]);
  });
});

describe("loginTokenFrom", () => {
  it("reads the token wherever it sits in the query, and refuses a link without one", () => {
    expect(loginTokenFrom("http://h/magic-link?token=abc")).toBe("abc");
    expect(loginTokenFrom("http://h/magic-link?next=%2Fjoin%2Fx&token=abc")).toBe("abc");
    expect(() => loginTokenFrom("http://h/magic-link?next=%2Fjoin")).toThrow(/no token/);
    expect(() => loginTokenFrom("not a url")).toThrow(/not a URL/);
    expect(() => loginTokenFrom(undefined)).toThrow(/login_url/);
    expect(() => loginTokenFrom("")).toThrow(/login_url/);
  });
});

describe("the seed scripts are wired to it (the inert-seam check)", () => {
  // The helper above is only worth anything if the scripts that need a session actually call it. The two .mjs probes
  // import it too: Node 26 strips the types, so a plain `node scripts/x.mjs` loads a .ts module.
  const SCRIPTS = [
    "seed-demo.ts",
    "seed-showcase.ts",
    "seed-fifa2026.ts",
    "rt-latency-probe.mjs",
    "overlay-eoo-playthrough.mjs",
  ];
  const src = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");

  it("each script imports signInByMagicLink and calls it", () => {
    let checked = 0;
    for (const f of SCRIPTS) {
      const text = src(f);
      expect(text, `${f} imports the helper`).toMatch(/import \{[^}]*signInByMagicLink[^}]*\} from "\.\/seed-signin\.ts"/);
      expect(text, `${f} calls the helper`).toMatch(/await signInByMagicLink\(/);
      checked++;
    }
    expect(checked, "anti-vacuity: every script was read").toBe(SCRIPTS.length);
  });

  it("no script still carries the removed password flow", () => {
    let checked = 0;
    for (const f of SCRIPTS) {
      const text = src(f);
      expect(text, `${f}: no password route`).not.toMatch(/api\/auth\/(login|signup|forgot-password|reset-password)/);
      expect(text, `${f}: no password constant`).not.toMatch(/\bPASSWORD\b/);
      checked++;
    }
    expect(checked).toBe(SCRIPTS.length);
  });
});
