// Shared by the suites that send or open an email-verification link:
// verify-email/__tests__/route.test.ts, login/__tests__/route.test.ts and
// admin/users/[id]/resend-verification/__tests__/route.test.ts.
//
// `openVerifyLink` opens an emailed link the way a person does. First, the
// link's path must be a PAGE a browser can open, not an API route. Second, the
// page hands its `token` and `next` query to VerifyEmail exactly as
// app/verify-email/page.tsx does. Third, VerifyEmail's own request, built by
// the real `api()` helper, is answered by the real verify-email route. It
// returns where the page sent the browser, so the expected value is the
// destination a person lands on, not the shape of a payload.
//
// Not a test file (no `.test.` in the name), so vitest never collects it. The
// caller owns the mocks it needs, because `vi.mock` is per file: `next/headers`
// (a cookie jar) and a STABLE `next/navigation` router whose `push` is passed in.
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, vi, type Mock } from "vitest";
import { renderIsland } from "@/components/__tests__/_hook-harness";
import { VerifyEmail } from "@/components/verify-email";
import en from "@/dictionaries/en/ui.json";
import { routes } from "@/lib/routes";
import { POST as verifyEmailRoute } from "../verify-email/route";

export const ORIGIN = "https://seazn.club";

/** The four real producers of a signup `next`, which are the pages that hand
 *  `AuthForm` one: join/[token]/page.tsx, claim/[token]/page.tsx,
 *  checkin/[token]/page.tsx, and login/page.tsx. The login page forwards
 *  whatever safe `?next=` it arrived with, for example the settings
 *  destination that page-auth's org-less bounce carries. */
export const INVITE_NEXT = "/join/inv0123456789";
export const CLAIM_NEXT = routes.claim("clm0123456789");
export const CHECKIN_NEXT = "/checkin/chk0123456789";
export const LOGIN_CARRIED_NEXT = "/settings?tab=account&email_change=success";
export const PRODUCER_NEXTS = [INVITE_NEXT, CLAIM_NEXT, CHECKIN_NEXT, LOGIN_CARRIED_NEXT];

/** Each one leaves the origin once a browser resolves it. Each test proves
 *  that before relying on it. */
export const UNSAFE_NEXTS = ["https://evil.example", "//evil.example", "/\\evil", "javascript:alert(1)"];

/** The first-run wizard (app/onboarding/page.tsx). postAuthLanding's rule is
 *  that, without a safe `next`, a user is guaranteed an org, and a NEW user
 *  (onboarding not completed) goes to the wizard. */
export const FIRST_RUN_WIZARD = "/onboarding";

/** apps/web/src/app/, with a trailing slash: this file sits in app/api/auth/__tests__/. */
const APP_DIR = fileURLToPath(new URL("../../../", import.meta.url));

/** The app-router page file a top-level pathname renders, or null when there
 *  is none. A route handler (`route.ts`) is not a page: a browser opening a
 *  POST-only route gets a 405, not a screen. */
export function pageFileFor(pathname: string): string | null {
  const file = `${APP_DIR}${pathname.replace(/^\//, "")}/page.tsx`;
  return fs.existsSync(file) ? file : null;
}

/** Pay postAuthLanding's cold dynamic imports up front, in a `beforeAll`.
 *  Its default branch `await import()`s `@/server/usecases/me` and
 *  `@/lib/activation`. The first transform of that graph took 3 s to 15 s
 *  here, which is half the 30 s test budget, charged to whichever test first
 *  reaches a default landing. */
export async function warmDefaultLanding(): Promise<void> {
  await import("@/server/usecases/me");
  await import("@/lib/activation");
}

export async function openVerifyLink(
  link: string,
  push: Mock,
): Promise<{ landed: string | null; posted: unknown[] }> {
  const url = new URL(link);
  expect(pageFileFor(url.pathname), `${url.pathname} must be a page a browser can open`).not.toBeNull();
  const posted: unknown[] = [];
  vi.stubGlobal("fetch", async (input: string, init: RequestInit) => {
    posted.push(JSON.parse(String(init.body)));
    return verifyEmailRoute(new Request(new URL(input, url.origin), init));
  });
  try {
    // app/verify-email/page.tsx: `token ?? null` and `next ?? null`, both read
    // from searchParams. URLSearchParams decodes the same way Next does.
    const page = renderIsland(VerifyEmail, {
      token: url.searchParams.get("token"),
      next: url.searchParams.get("next"),
    });
    // Wider than vi.waitFor's 1 s default, which timed out while a DEFAULT
    // landing was still on its way to the right answer. See
    // `warmDefaultLanding`: the cold path is that slow, and it can be paid here
    // too if a caller skips the warm-up.
    await vi.waitFor(
      () => {
        const settled = push.mock.calls.length > 0 || page.text().includes(en["verifyEmail.failed"]);
        expect(settled, "the verify page settled").toBe(true);
      },
      { timeout: 20_000 },
    );
    return { landed: (push.mock.calls[0]?.[0] as string | undefined) ?? null, posted };
  } finally {
    vi.unstubAllGlobals();
  }
}
