// Quick match plan 4, Task 3 (plan docs/superpowers/plans/2026-11-13-quick-match-4-skip-match.md; spec
// docs/superpowers/specs/2026-11-12-quick-match-cancel-and-skip-design.md §3, §6): the home's two posts,
// `POST /q/<token>/skip/<fixtureId>` ("Not played") and `POST /q/<token>/put-back/<fixtureId>` ("Put back").
//
// The contract, the Score and Add a match routes' own (D3 of plan 2): every answer is a 303 with a relative Location, never
// JSON. A post that works lands on the bare home; a refusal lands on the home with `?e=<code>` (QUICK_MATCH_ERRORS), the
// viewer's own flash; an unknown token lands on its own `/q/<token>`, the dead screen, with nothing called; anything else is a
// fault, reported once and shown as the generic line. The skip and put back themselves, and their sequences, are
// `server/usecases/__tests__/quick-match-skip.test.ts`'s (real Postgres); here the usecase, the token read and the activity
// touch are mocks, so every refusal the usecase can throw is driven through the route exactly as thrown, on BOTH routes.
//
// Expected codes come from QUICK_MATCH_ERRORS (T1), the refusals' table from the plan's Task 3 ("REFUSALS"), and the
// activity rule from plan D5 (a skip and a put back are activity, best-effort); never from the route's own answer.
import * as Sentry from "@sentry/nextjs";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HttpError } from "@/lib/errors";
import { QUICK_MATCH_ERRORS } from "@/lib/quick-match-constants";
import type { QuickMatchRow } from "@/server/usecases/quick-match-home";

const mocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  skip: vi.fn(),
  putBack: vi.fn(),
  touch: vi.fn(),
  logError: vi.fn(),
}));
vi.mock("@sentry/nextjs", async (orig) => ({
  ...(await orig<typeof import("@sentry/nextjs")>()),
  captureException: vi.fn(),
}));
vi.mock("@/server/usecases/quick-match-home", () => ({ resolveQuickMatchToken: mocks.resolve }));
vi.mock("@/server/usecases/quick-match-skip", () => ({
  skipQuickMatchFixture: mocks.skip,
  putBackQuickMatchFixture: mocks.putBack,
}));
vi.mock("@/server/usecases/quick-match-activity", () => ({ touchQuickMatchActivity: mocks.touch }));
vi.mock("@/server/logger", () => ({ log: { error: mocks.logError, warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

import { POST as SKIP } from "../skip/[fixtureId]/route";
import { POST as PUT_BACK } from "../put-back/[fixtureId]/route";

const TOKEN = "qm_route-test-token";
const FIXTURE = "4b7c9a52-6d0e-4f1a-9c3b-2e8d7f6a5b41";
const ROW = { id: "qm-row-1", competitionId: "c-1", format: "league" } as unknown as QuickMatchRow;
const reported = () => vi.mocked(Sentry.captureException).mock.calls.map(([err]) => err);

/** Both routes, each with the usecase it calls. Every case below runs on each. */
const ROUTES = [
  { name: "skip", post: SKIP, usecase: mocks.skip, ok: { changed: true }, path: "skip" },
  { name: "put back", post: PUT_BACK, usecase: mocks.putBack, ok: { changed: true, status: "scheduled" }, path: "put-back" },
] as const;

function call(route: (typeof ROUTES)[number], token = TOKEN, fixtureId = FIXTURE) {
  return route.post(new Request(`http://localhost/q/${token}/${route.path}/${fixtureId}`, { method: "POST" }), {
    params: Promise.resolve({ token, fixtureId }),
  });
}
/** A 303 to a relative Location: never JSON (D3). */
function landed(res: Response): string {
  expect(res.status).toBe(303);
  const location = res.headers.get("location") ?? "";
  expect(location.startsWith("/q/"), location).toBe(true);
  return location;
}

/** The refusals the usecase throws, each with the `?e=` it must land on (plan T3 "REFUSALS"; a knockout is NOT_SKIPPABLE,
 *  T1 review G2). The limiter's 429 carries no code. */
const REFUSED: readonly { thrown: HttpError; e: string }[] = [
  { thrown: new HttpError(429, "slow down"), e: QUICK_MATCH_ERRORS.ACTION_FAILED },
  { thrown: new HttpError(404, "no such match", QUICK_MATCH_ERRORS.NOT_FOUND), e: QUICK_MATCH_ERRORS.NOT_FOUND },
  { thrown: new HttpError(422, "has a result", QUICK_MATCH_ERRORS.NOT_SKIPPABLE), e: QUICK_MATCH_ERRORS.NOT_SKIPPABLE },
  { thrown: new HttpError(422, "finished", QUICK_MATCH_ERRORS.LEAGUE_FINISHED), e: QUICK_MATCH_ERRORS.LEAGUE_FINISHED },
];
/** Faults: not on the closed list, so reported and shown as the generic line. */
const FAULTS: readonly unknown[] = [
  new Error("database went away"),
  new HttpError(422, "a code-less 422 no step throws"),
  new HttpError(404, "a code-less 404"),
  new HttpError(422, "another code", QUICK_MATCH_ERRORS.LEAGUE_ONLY),
  new HttpError(500, "a 500 with a refusal's code", QUICK_MATCH_ERRORS.NOT_FOUND),
];

afterEach(() => {
  vi.clearAllMocks();
});

describe("POST /q/<token>/skip/<id> and /put-back/<id> (plan 4 T3)", () => {
  it("the table covers both routes (anti-vacuity)", () => {
    expect(ROUTES).toHaveLength(2);
    expect(REFUSED.length).toBeGreaterThan(0);
    expect(FAULTS.length).toBeGreaterThan(0);
  });

  for (const route of ROUTES) {
    describe(route.name, () => {
      it("a post that works lands on the bare home, after the usecase, and is activity (one touch, D5)", async () => {
        mocks.resolve.mockResolvedValue(ROW);
        route.usecase.mockResolvedValue(route.ok);
        mocks.touch.mockResolvedValue(undefined);
        expect(landed(await call(route))).toBe(`/q/${TOKEN}`);
        expect(mocks.resolve).toHaveBeenCalledWith(TOKEN);
        expect(route.usecase).toHaveBeenCalledExactlyOnceWith(ROW, FIXTURE);
        expect(mocks.touch).toHaveBeenCalledExactlyOnceWith(ROW.id);
        expect(mocks.touch.mock.invocationCallOrder[0]!).toBeGreaterThan(route.usecase.mock.invocationCallOrder[0]!);
        expect(reported()).toEqual([]);
      });

      it("a second tap that changes nothing (D3) lands on the bare home too", async () => {
        mocks.resolve.mockResolvedValue(ROW);
        route.usecase.mockResolvedValue({ ...route.ok, changed: false });
        mocks.touch.mockResolvedValue(undefined);
        expect(landed(await call(route))).toBe(`/q/${TOKEN}`);
        expect(reported()).toEqual([]);
      });

      it("the token is trimmed as the home page trims it", async () => {
        mocks.resolve.mockResolvedValue(ROW);
        route.usecase.mockResolvedValue(route.ok);
        mocks.touch.mockResolvedValue(undefined);
        expect(landed(await call(route, `  ${TOKEN} `))).toBe(`/q/${TOKEN}`);
        expect(mocks.resolve).toHaveBeenCalledWith(TOKEN);
      });

      it("an unknown, changed or expired token lands on its own /q/<token>, the dead screen, and nothing is called", async () => {
        mocks.resolve.mockResolvedValue(null);
        expect(landed(await call(route, "qm_nobody"))).toBe("/q/qm_nobody");
        expect(route.usecase).not.toHaveBeenCalled();
        expect(mocks.touch).not.toHaveBeenCalled();
        expect(reported()).toEqual([]);
      });

      it("every refusal lands on the home with its own code, untouched and never reported", async () => {
        let checked = 0;
        for (const { thrown, e } of REFUSED) {
          mocks.resolve.mockResolvedValue(ROW);
          route.usecase.mockRejectedValueOnce(thrown);
          expect(landed(await call(route)), `${thrown.status} ${thrown.code}`).toBe(`/q/${TOKEN}?e=${e}`);
          checked++;
        }
        expect(checked, "every refusal on the list").toBe(REFUSED.length);
        expect(mocks.touch, "a refusal is no activity").not.toHaveBeenCalled();
        expect(reported(), "a refusal is the guest's, not a fault").toEqual([]);
        expect(mocks.logError).not.toHaveBeenCalled();
      });

      it("a fault lands on the generic line and is reported to Sentry exactly once each", async () => {
        let checked = 0;
        for (const fault of FAULTS) {
          vi.mocked(Sentry.captureException).mockClear();
          mocks.resolve.mockResolvedValue(ROW);
          route.usecase.mockRejectedValueOnce(fault);
          expect(landed(await call(route)), String(fault)).toBe(`/q/${TOKEN}?e=${QUICK_MATCH_ERRORS.ACTION_FAILED}`);
          expect(reported(), String(fault)).toEqual([fault]);
          checked++;
        }
        expect(checked).toBe(FAULTS.length);
        expect(mocks.touch).not.toHaveBeenCalled();
      });

      it("a failed touch is logged and the guest still lands on the bare home: the write stands", async () => {
        mocks.resolve.mockResolvedValue(ROW);
        route.usecase.mockResolvedValue(route.ok);
        mocks.touch.mockRejectedValue(new Error("touch failed"));
        expect(landed(await call(route))).toBe(`/q/${TOKEN}`);
        expect(mocks.logError).toHaveBeenCalledTimes(1);
        expect(reported(), "a touch failure is logged, not a route fault").toEqual([]);
      });

      it("a token read that throws is a fault: reported once, the generic line on this token's home, nothing called", async () => {
        const boom = new Error("db down");
        mocks.resolve.mockRejectedValue(boom);
        const res = await call(route);
        expect(res.status).toBe(303);
        // The home is built from the token before the read, so even a failed read lands on it.
        expect(res.headers.get("location")).toBe(`/q/${TOKEN}?e=${QUICK_MATCH_ERRORS.ACTION_FAILED}`);
        expect(reported()).toEqual([boom]);
        expect(route.usecase).not.toHaveBeenCalled();
      });
    });
  }
});
