// safeNextPath decides where a freshly-authenticated user is sent. It had no
// test anywhere in the repo, and it was an open redirect: `startsWith("/") &&
// !startsWith("//")` reads a backslash as an ordinary character, while the URL
// parser normalises it to a slash in the authority position. `/\evil.com`
// therefore passed and resolved to `https://evil.com/`.
//
// Every rejection case below asserts the HAZARD as well as the verdict — what
// the string actually resolves to — so the file proves the trap is real rather
// than asserting a fix against a danger that may have stopped existing.
import { describe, expect, it } from "vitest";
import { safeNextPath } from "@/lib/auth";
// Both halves of the contract live in `page-auth.ts`, NOT in
// `app/orgs/new/page.tsx` where the consumer half would read more naturally.
// Next's generated page types are `checkFields<Diff<{ default, dynamic,
// metadata, generateStaticParams, … }, typeof import(page), ''>>`
// (next/dist/build/webpack/plugins/next-types-plugin), so any export a page
// file adds beyond that set is a `next build` type error — and no page.tsx in
// this repo has one. The helper is exported from the server module instead so
// its refusals stay pinnable.
import { newOrgDestination, orgLessRedirect } from "@/server/page-auth";

const ORIGIN = "https://seazn.club";
const resolves = (p: string) => new URL(p, ORIGIN).origin;

describe("safeNextPath", () => {
  it("accepts ordinary internal paths, with query and fragment", () => {
    for (const ok of [
      "/dashboard",
      "/settings?tab=account&email_change=taken",
      "/o/my-org/c/spring/d/a1?tab=fixtures",
      "/join/abc123",
      "/",
    ]) {
      expect(resolves(ok), `${ok} is same-origin`).toBe(ORIGIN);
      expect(safeNextPath(ok), ok).toBe(ok);
    }
  });

  it("rejects a backslash authority — the open redirect this test exists for", () => {
    for (const evil of ["/\\evil.com", "/\\/evil.com", "/\\\\evil.com"]) {
      // The hazard, proven rather than asserted: these leave the origin.
      expect(resolves(evil), `${evil} escapes the origin`).not.toBe(ORIGIN);
      expect(
        safeNextPath(evil),
        `${evil} resolves to ${new URL(evil, ORIGIN).href} — it must never be a redirect target`,
      ).toBeNull();
    }
  });

  it("rejects protocol-relative and absolute URLs", () => {
    for (const evil of ["//evil.com", "//evil.com/path", "https://evil.com", "http://evil.com"]) {
      expect(safeNextPath(evil), evil).toBeNull();
    }
    // A same-origin ABSOLUTE url is still rejected: the contract is a path.
    expect(safeNextPath(`${ORIGIN}/dashboard`)).toBeNull();
  });

  it("rejects control characters, CR/LF included", () => {
    const cr = "/" + String.fromCharCode(13) + String.fromCharCode(10) + "X";
    for (const evil of [cr, "/x" + String.fromCharCode(0), "/x" + String.fromCharCode(9)]) {
      expect(safeNextPath(evil), JSON.stringify(evil)).toBeNull();
    }
  });

  it("rejects anything that is not a string, and relative paths", () => {
    for (const bad of [undefined, null, 42, {}, [], "dashboard", "../admin", ""]) {
      expect(safeNextPath(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// The /orgs/new destination contract (W2 task 6 — F7's residual).
//
// `requirePageAuth` used to bounce an org-less visitor with a bare
// `redirect("/orgs/new")`, throwing away wherever they were going. W1.5 made
// that path MORE reachable, not less: `postAuthLanding` honours a safe `next`
// WITHOUT provisioning an org (lib/auth.ts:444-453), so a first-time signup
// arriving at `/login?next=/settings?tab=account&email_change=success` now
// lands org-less on the shim, is bounced, and the outcome of their email
// change is gone.
//
// The two ends of the contract are pinned separately below, because a mutant
// that removes the validator from ONE of them is the failure this exists to
// catch. Both ends REUSE `safeNextPath` — the validator W1.5 hardened — and
// neither may widen it: `safeNextPath` is the only origin check in this repo
// and a second one would be a second answer to the same question.
// ---------------------------------------------------------------------------

/** What `next` resolves to when a mutant strips its encoding — used below so
 *  the expected string is derived, not a literal typed twice. */
const carried = (p: string) => `/orgs/new?next=${encodeURIComponent(p)}`;

describe("orgLessRedirect — the producer half, in page-auth", () => {
  it("carries a settings destination through the org-less bounce", () => {
    const dest = "/settings?tab=account&email_change=success";
    expect(orgLessRedirect(dest)).toBe(carried(dest));
    // The whole point of encoding it: the destination's own `?` and `&` must
    // not become extra params of /orgs/new. Read it back the way the page will.
    const back = new URL(orgLessRedirect(dest), ORIGIN).searchParams.get("next");
    expect(back).toBe(dest);
  });

  it("keeps today's behaviour EXACTLY when there is nothing to carry", () => {
    // No `next`, no query — the bare literal this branch has always emitted.
    for (const none of [undefined, null, ""]) {
      expect(orgLessRedirect(none), JSON.stringify(none)).toBe("/orgs/new");
    }
  });

  it("refuses a smuggled origin rather than carrying it into /orgs/new", () => {
    for (const evil of ["/\\evil.com", "/\\/evil.com", "//evil.com", "https://evil.com"]) {
      // HAZARD, proven not asserted: each of these LEAVES the origin once a
      // browser resolves it — `new URL("/\\evil.com", "https://seazn.club").href`
      // is "https://evil.com/", because the URL parser normalises a backslash
      // to a slash in the authority position while `startsWith("/")` reads it
      // as an ordinary character. Carried into `?next=`, /orgs/new would then
      // `router.push()` a stranger's host after a successful create — a
      // phishing landing reached from a real, trusted seazn.club sign-up flow.
      expect(resolves(evil), `${evil} escapes the origin`).not.toBe(ORIGIN);
      expect(
        orgLessRedirect(evil),
        `${evil} resolves to ${new URL(evil, ORIGIN).href} — it must never reach ?next=`,
      ).toBe("/orgs/new");
    }
  });

  it("refuses CR/LF and control characters", () => {
    // HAZARD: a bare CR/LF in a redirect target is response-splitting material
    // — the value is echoed into a Location header by the framework, and a
    // newline there starts a header (or a body) the attacker chose.
    const cr = "/" + String.fromCharCode(13) + String.fromCharCode(10) + "X";
    for (const evil of [cr, "/x" + String.fromCharCode(0)]) {
      expect(orgLessRedirect(evil), JSON.stringify(evil)).toBe("/orgs/new");
    }
  });
});

describe("newOrgDestination — the consumer half, at /orgs/new", () => {
  it("hands the form the destination the bounce carried", () => {
    expect(newOrgDestination({ next: "/settings?tab=account&email_change=success" })).toBe(
      "/settings?tab=account&email_change=success",
    );
  });

  it("null when absent or empty — the form then keeps its /dashboard default", () => {
    expect(newOrgDestination({})).toBeNull();
    expect(newOrgDestination({ next: undefined })).toBeNull();
    expect(newOrgDestination({ next: "" })).toBeNull();
  });

  it("refuses the backslash authority at THIS end too, not just at the producer", () => {
    // HAZARD: /orgs/new is reachable directly — nothing stops anyone mailing
    // `/orgs/new?next=/\evil.com`. If only the producer validated, this page
    // would `router.push("/\evil.com")` on a successful create, which the
    // browser resolves to https://evil.com/. Two ends, two checks, because a
    // guard that another guard covers for is a guard nothing tests.
    for (const evil of ["/\\evil.com", "//evil.com", "https://evil.com", "../admin"]) {
      expect(newOrgDestination({ next: evil }), evil).toBeNull();
    }
  });
});
