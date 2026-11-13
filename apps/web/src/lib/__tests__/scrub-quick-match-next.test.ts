// Quick match plan 3, Task 5 (plan Amend T5, C19): the Save button's sign-in hand-off carries the match's credential.
//
// A signed-out guest who taps Save is sent to `/login?next=/q/<token>/save`, and from there the token rides every hop of the
// sign-in: the login page's URL (plain, then encoded again wherever that URL is itself carried: a referrer, a breadcrumb), the
// magic-link mail's consume URL (`/magic-link?token=<one-time>&next=%2Fq%2F<token>%2Fsave`), and back. Whoever holds the home
// token can score the match, so every one of those strings must reach telemetry without it, and each without breaking the rest
// of the URL. The home token is also scrubbed where it stands BARE, with no route around it (an error message, a log field, a
// path where `q` is not the route root): `qm_` + 43 base64url is the shape `quick-match-tokens.ts` mints, and nothing else in
// the app carries that prefix with a 32+ character tail.
//
// And the far end of the hand-off: a visitor who is ALREADY signed in and follows `/login?next=/q/<token>/save` is sent
// straight on to that path, which the save page's own file serves (the route is read off the disk, not typed).
//
// The tokens are minted by the REAL minter (`mintHomeToken`). Expected values: the same string with each token swapped for the
// placeholder (`[token]` after a route, `qm_[token]` bare, the dl_ rule's shape), never computed by the scrubber.
//
// Sport: not applicable (no match is read).
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ user: null as { id: string } | null }));
vi.mock("@/lib/auth", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth")>()),
  getCurrentUser: vi.fn(async () => h.user),
}));
vi.mock("@/lib/resolve-locale", () => ({ resolveLocale: vi.fn(async () => "en") }));

import { routes } from "@/lib/routes";
import { mintHomeToken } from "@/server/usecases/quick-match-tokens";
import LoginPage from "@/app/login/page";
import { holdsCredential, scrubScoreUrl } from "../scrub-score-url";

const ORIGIN = "https://seazn.club";
const PLACEHOLDER = "[token]";
const TOKENS = Array.from({ length: 50 }, () => mintHomeToken());
const encode = (value: string, depth: number) => {
  let out = value;
  for (let i = 0; i < depth; i++) out = encodeURIComponent(out);
  return out;
};
const without = (url: string, ...secrets: string[]) => secrets.reduce((s, secret) => s.split(secret).join(PLACEHOLDER), url);
/** A one-time sign-in token's stand-in: the scrubber's `token=` rule reads the route, never the value's shape. */
const oneTime = () => randomBytes(32).toString("base64url");

describe("the Save hand-off's URLs reach telemetry without the home token", () => {
  it("premise: the save path is the route builder's, and the minter's tokens are qm_ + 43 base64url", () => {
    let checked = 0;
    for (const t of TOKENS) {
      expect(t).toMatch(/^qm_[A-Za-z0-9_-]{43}$/);
      expect(routes.quickMatchSave(t)).toBe(`/q/${t}/save`);
      checked++;
    }
    expect(checked).toBe(TOKENS.length);
  });

  it("/login?next=/q/<token>/save, the next encoded 1, 2 and 3 times, plain and inside another URL", () => {
    let checked = 0;
    const failures: string[] = [];
    for (const t of TOKENS) {
      const save = routes.quickMatchSave(t);
      for (const depth of [1, 2, 3]) {
        const login = `/login?next=${encode(save, depth)}`;
        for (const input of [login, `${ORIGIN}${login}`, `${ORIGIN}/start?from=${encodeURIComponent(`${ORIGIN}${login}`)}`]) {
          if (!input.includes(t)) failures.push(`${input}: premise, the input does not carry the token`);
          const out = scrubScoreUrl(input);
          if (out !== without(input, t)) failures.push(`${input} -> ${out}`);
          else if (scrubScoreUrl(out) !== out) failures.push(`${input}: not idempotent`);
          checked++;
        }
      }
    }
    expect(failures.slice(0, 5), `${failures.length} of ${checked} failed`).toEqual([]);
    expect(checked).toBe(TOKENS.length * 3 * 3);
  });

  it("the magic-link mail's consume URL: the one-time token and the home token in its next are both gone", () => {
    let checked = 0;
    const failures: string[] = [];
    for (const t of TOKENS) {
      const once = oneTime();
      // The sign-in route's own template: `${baseUrl}/magic-link?token=${token}&next=${encodeURIComponent(next)}`.
      const consume = `${ORIGIN}/magic-link?token=${once}&next=${encodeURIComponent(routes.quickMatchSave(t))}`;
      for (const input of [consume, `${ORIGIN}/login?ref=${encodeURIComponent(consume)}`]) {
        const out = scrubScoreUrl(input);
        if (out !== without(input, once, t)) failures.push(`${input} -> ${out}`);
        if (out.includes("qm_")) failures.push(`${input}: a qm_ run is left`);
        checked++;
      }
    }
    expect(failures.slice(0, 5), `${failures.length} of ${checked} failed`).toEqual([]);
    expect(checked).toBe(TOKENS.length * 2);
  });

  it("a bare home token (an error message, a log field, a path where `q` is not the root) becomes qm_[token]", () => {
    let checked = 0;
    const failures: string[] = [];
    for (const t of TOKENS) {
      for (const input of [
        `no quick match for ${t}`,
        `{"token":"${t}","at":"home"}`,
        `${ORIGIN}/o/club/c/q/${t}`,
        `token=${t}`,
      ]) {
        const out = scrubScoreUrl(input);
        const expected = input.split(t).join(`qm_${PLACEHOLDER}`);
        if (out !== expected) failures.push(`${input} -> ${out}`);
        else if (scrubScoreUrl(out) !== out) failures.push(`${input}: not idempotent`);
        if (!holdsCredential(input)) failures.push(`${input}: holdsCredential says no`);
        checked++;
      }
    }
    expect(failures.slice(0, 5), `${failures.length} of ${checked} failed`).toEqual([]);
    expect(checked).toBe(TOKENS.length * 4);
  });

  it("the bare rule's negative pair: a short qm_ run and the word itself are left alone", () => {
    const left = ["qm_short", "qm_", `qm_${"a".repeat(31)}`, "the qm_ prefix", `${ORIGIN}/q/`];
    for (const input of left) expect(scrubScoreUrl(input), input).toBe(input);
    expect(left).toHaveLength(5);
  });
});

describe("a signed-in visitor at /login?next=/q/<token>/save goes straight to the save page", () => {
  it("is redirected to the save path, which app/q/[token]/save/page.tsx serves", async () => {
    const appDir = path.resolve(import.meta.dirname, "../../app");
    const pageFile = path.join(appDir, "q", "[token]", "save", "page.tsx");
    expect(fs.existsSync(pageFile), "premise: the save page is on disk").toBe(true);
    const segments = path.relative(appDir, path.dirname(pageFile)).split(path.sep);
    const served = new RegExp(`^/${segments.map((s) => (/^\[.+\]$/.test(s) ? "([^/]+)" : s)).join("/")}$`);

    h.user = { id: "00000000-0000-4000-8000-000000000001" };
    let checked = 0;
    for (const t of TOKENS.slice(0, 5)) {
      let digest = "";
      try {
        await LoginPage({ searchParams: Promise.resolve({ next: routes.quickMatchSave(t) }) });
      } catch (e) {
        digest = String((e as { digest?: string }).digest ?? "");
      }
      expect(digest.startsWith("NEXT_REDIRECT"), "the login page redirects a signed-in visitor").toBe(true);
      const to = digest.split(";")[2]!;
      expect(to).toBe(`/q/${t}/save`);
      expect(served.exec(to)?.[1]).toBe(t);
      checked++;
    }
    expect(checked).toBe(5);
    h.user = null;
  });
});
