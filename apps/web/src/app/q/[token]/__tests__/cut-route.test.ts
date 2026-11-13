// Quick match plan 5, Task 4 (plan docs/superpowers/plans/2026-11-13-quick-match-5-league-knockout.md D2, D5; spec
// docs/superpowers/specs/2026-11-12-quick-match-league-knockout-design.md §5, §11): a League + Knockout's answer to a tie at
// the cut, `POST /q/<token>/cut/toss` ("Toss a coin") and `POST /q/<token>/cut/pick` ("Pick who goes through").
//
// The contract is the skip and put back posts' own (match-action-post.ts, one handler): every answer a 303 with a relative
// Location, never JSON; a post that works lands on the bare home after the decision, the knockout's advance (caller c, best-
// effort) and the activity touch; a refusal lands on `?e=<code>`; an unknown token on its own `/q/<token>` with nothing
// called; anything else is a fault, reported once and shown as the generic line. The decision itself, its order and its
// sequences are `server/usecases/__tests__/quick-match-advance.test.ts`'s (real Postgres); here the decision, the advance,
// the token read and the touch are mocks, so every refusal the decision can throw is driven through BOTH routes as thrown.
//
// Expected codes come from QUICK_MATCH_ERRORS (T1) and the plan's REFUSALS list (Task 4: ALREADY_DECIDED, TIE_NOT_OPEN,
// PICK_INVALID, 429 → ACTION_FAILED); the Pick's body is the home's form, `entrant` repeated (plan Task 4 "Routes"); never
// the route's own answer.
import * as Sentry from "@sentry/nextjs";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HttpError } from "@/lib/errors";
import { QUICK_MATCH_ERRORS } from "@/lib/quick-match-constants";
import type { QuickMatchRow } from "@/server/usecases/quick-match-home";

const mocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  decide: vi.fn(),
  advance: vi.fn(),
  touch: vi.fn(),
  logError: vi.fn(),
}));
vi.mock("@sentry/nextjs", async (orig) => ({
  ...(await orig<typeof import("@sentry/nextjs")>()),
  captureException: vi.fn(),
}));
vi.mock("@/server/usecases/quick-match-home", () => ({ resolveQuickMatchToken: mocks.resolve }));
vi.mock("@/server/usecases/quick-match-advance", () => ({ decideQuickMatchCut: mocks.decide, advanceQuickMatch: mocks.advance }));
vi.mock("@/server/usecases/quick-match-activity", () => ({ touchQuickMatchActivity: mocks.touch }));
vi.mock("@/server/logger", () => ({ log: { error: mocks.logError, warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

import { POST as TOSS } from "../cut/toss/route";
import { POST as PICK } from "../cut/pick/route";

const TOKEN = "qm_cut-route-test-token";
const ROW = { id: "qm-row-1", competitionId: "c-1", format: "league_knockout" } as unknown as QuickMatchRow;
const A = "0d7a3f9e-1b2c-4d5e-8f6a-7b8c9d0e1f2a";
const B = "5e4d3c2b-1a09-4f8e-9d7c-6b5a4f3e2d1c";
const reported = () => vi.mocked(Sentry.captureException).mock.calls.map(([err]) => err);

/** Both routes, each with the decision input a form post must reach it as. Every case below runs on each. */
const ROUTES = [
  { name: "toss", post: TOSS, path: "toss", body: "", input: { how: "toss" } },
  { name: "pick", post: PICK, path: "pick", body: `entrant=${A}&entrant=${B}`, input: { how: "pick", entrantIds: [A, B] } },
] as const;

function call(route: (typeof ROUTES)[number], token = TOKEN, body: string = route.body, contentType = "application/x-www-form-urlencoded") {
  return route.post(
    new Request(`http://localhost/q/${token}/cut/${route.path}`, { method: "POST", headers: { "content-type": contentType }, body }),
    { params: Promise.resolve({ token }) },
  );
}
/** A 303 to a relative Location: never JSON (D3 of plan 2). */
function landed(res: Response): string {
  expect(res.status).toBe(303);
  const location = res.headers.get("location") ?? "";
  expect(location.startsWith("/q/"), location).toBe(true);
  return location;
}

/** The refusals the decision throws, each with the `?e=` it must land on (plan Task 4 REFUSALS). The limiter's 429 carries no
 *  code. */
const REFUSED: readonly { thrown: HttpError; e: string }[] = [
  { thrown: new HttpError(429, "slow down"), e: QUICK_MATCH_ERRORS.ACTION_FAILED },
  { thrown: new HttpError(422, "decided", QUICK_MATCH_ERRORS.ALREADY_DECIDED), e: QUICK_MATCH_ERRORS.ALREADY_DECIDED },
  { thrown: new HttpError(422, "no tie", QUICK_MATCH_ERRORS.TIE_NOT_OPEN), e: QUICK_MATCH_ERRORS.TIE_NOT_OPEN },
  { thrown: new HttpError(422, "pick two", QUICK_MATCH_ERRORS.PICK_INVALID), e: QUICK_MATCH_ERRORS.PICK_INVALID },
];
/** Faults: not on the closed list, so reported and shown as the generic line. */
const FAULTS: readonly unknown[] = [
  new Error("database went away"),
  new HttpError(422, "a code-less 422 no step throws"),
  new HttpError(422, "another code", QUICK_MATCH_ERRORS.LEAGUE_COMPLETE),
  new HttpError(500, "a 500 with a refusal's code", QUICK_MATCH_ERRORS.ALREADY_DECIDED),
];

afterEach(() => {
  vi.clearAllMocks();
});

describe("POST /q/<token>/cut/toss and /cut/pick (plan 5 T4)", () => {
  it("the table covers both routes (anti-vacuity)", () => {
    expect(ROUTES).toHaveLength(2);
    expect(REFUSED).toHaveLength(4);
    expect(FAULTS.length).toBeGreaterThan(0);
  });

  for (const route of ROUTES) {
    describe(route.name, () => {
      it("an answer that works lands on the bare home: the decision as posted, then the advance once, then one touch", async () => {
        mocks.resolve.mockResolvedValue(ROW);
        mocks.decide.mockResolvedValue({ through: [A] });
        mocks.advance.mockResolvedValue({ state: "filled" });
        mocks.touch.mockResolvedValue(undefined);
        expect(landed(await call(route))).toBe(`/q/${TOKEN}`);
        expect(mocks.resolve).toHaveBeenCalledWith(TOKEN);
        expect(mocks.decide).toHaveBeenCalledExactlyOnceWith(ROW, route.input);
        expect(mocks.advance).toHaveBeenCalledExactlyOnceWith(ROW);
        expect(mocks.touch).toHaveBeenCalledExactlyOnceWith(ROW.id);
        const [decided, advanced, touched] = [mocks.decide, mocks.advance, mocks.touch].map((m) => m.mock.invocationCallOrder[0]!);
        expect(decided).toBeLessThan(advanced!);
        expect(advanced).toBeLessThan(touched!);
        expect(reported()).toEqual([]);
      });

      it("the token is trimmed as the home page trims it", async () => {
        mocks.resolve.mockResolvedValue(ROW);
        mocks.decide.mockResolvedValue({ through: [A] });
        expect(landed(await call(route, `  ${TOKEN} `))).toBe(`/q/${TOKEN}`);
        expect(mocks.resolve).toHaveBeenCalledWith(TOKEN);
      });

      it("an unknown, changed or expired token lands on its own /q/<token>, the dead screen, and nothing is called", async () => {
        mocks.resolve.mockResolvedValue(null);
        expect(landed(await call(route, "qm_nobody"))).toBe("/q/qm_nobody");
        expect(mocks.decide).not.toHaveBeenCalled();
        expect(mocks.advance).not.toHaveBeenCalled();
        expect(mocks.touch).not.toHaveBeenCalled();
        expect(reported()).toEqual([]);
      });

      it("every refusal lands on the home with its own code: no advance, no touch, never reported", async () => {
        let checked = 0;
        for (const { thrown, e } of REFUSED) {
          mocks.resolve.mockResolvedValue(ROW);
          mocks.decide.mockRejectedValueOnce(thrown);
          expect(landed(await call(route)), `${thrown.status} ${thrown.code}`).toBe(`/q/${TOKEN}?e=${e}`);
          checked++;
        }
        expect(checked, "every refusal on the list").toBe(REFUSED.length);
        expect(mocks.advance, "a refused answer wrote nothing to advance from").not.toHaveBeenCalled();
        expect(mocks.touch, "a refusal is no activity").not.toHaveBeenCalled();
        expect(reported(), "a refusal is the guest's, not a fault").toEqual([]);
        expect(mocks.logError).not.toHaveBeenCalled();
      });

      it("a competition gone since the token resolved (404 EXPIRED) lands on the bare home, its dead screen: no flash, never reported", async () => {
        mocks.resolve.mockResolvedValue(ROW);
        mocks.decide.mockRejectedValueOnce(new HttpError(404, "gone", QUICK_MATCH_ERRORS.EXPIRED));
        expect(landed(await call(route))).toBe(`/q/${TOKEN}`);
        expect(reported()).toEqual([]);
        expect(mocks.advance).not.toHaveBeenCalled();
      });

      it("a fault lands on the generic line and is reported to Sentry exactly once each", async () => {
        let checked = 0;
        for (const fault of FAULTS) {
          vi.mocked(Sentry.captureException).mockClear();
          mocks.resolve.mockResolvedValue(ROW);
          mocks.decide.mockRejectedValueOnce(fault);
          expect(landed(await call(route)), String(fault)).toBe(`/q/${TOKEN}?e=${QUICK_MATCH_ERRORS.ACTION_FAILED}`);
          expect(reported(), String(fault)).toEqual([fault]);
          checked++;
        }
        expect(checked).toBe(FAULTS.length);
        expect(mocks.advance).not.toHaveBeenCalled();
        expect(mocks.touch).not.toHaveBeenCalled();
      });

      it("an advance that fails is logged (quick_match_advance_failed) and never reported: the answer stands, the guest lands on the bare home, still activity", async () => {
        mocks.resolve.mockResolvedValue(ROW);
        mocks.decide.mockResolvedValue({ through: [A] });
        mocks.touch.mockResolvedValue(undefined);
        const boom = new Error("confirm failed");
        mocks.advance.mockRejectedValueOnce(boom);
        expect(landed(await call(route))).toBe(`/q/${TOKEN}`);
        expect(mocks.logError).toHaveBeenCalledTimes(1);
        expect(mocks.logError.mock.calls[0]![0]).toMatchObject({ err: boom, event: "quick_match_advance_failed", quickMatch: ROW.id });
        expect(reported(), "the home's next load retries it: not a route fault").toEqual([]);
        expect(mocks.touch).toHaveBeenCalledExactlyOnceWith(ROW.id);
      });

      it("an advance that throws before it returns a promise is the same best-effort failure: logged, never reported, the bare home", async () => {
        mocks.resolve.mockResolvedValue(ROW);
        mocks.decide.mockResolvedValue({ through: [A] });
        mocks.touch.mockResolvedValue(undefined);
        const boom = new Error("threw synchronously");
        mocks.advance.mockImplementationOnce(() => {
          throw boom;
        });
        expect(landed(await call(route))).toBe(`/q/${TOKEN}`);
        expect(mocks.logError).toHaveBeenCalledTimes(1);
        expect(mocks.logError.mock.calls[0]![0]).toMatchObject({ err: boom, event: "quick_match_advance_failed" });
        expect(reported()).toEqual([]);
        expect(mocks.touch).toHaveBeenCalledExactlyOnceWith(ROW.id);
      });

      it("a token read that throws is a fault: reported once, the generic line on this token's home, nothing called", async () => {
        const boom = new Error("db down");
        mocks.resolve.mockRejectedValue(boom);
        const res = await call(route);
        expect(res.status).toBe(303);
        expect(res.headers.get("location")).toBe(`/q/${TOKEN}?e=${QUICK_MATCH_ERRORS.ACTION_FAILED}`);
        expect(reported()).toEqual([boom]);
        expect(mocks.decide).not.toHaveBeenCalled();
      });
    });
  }
});

describe("the Pick's body (the home's form: `entrant` repeated)", () => {
  const pick = ROUTES[1];
  it("names every `entrant` field in the order posted; anything else in the body is ignored", async () => {
    mocks.resolve.mockResolvedValue(ROW);
    mocks.decide.mockResolvedValue({ through: [B, A] });
    landed(await call(pick, TOKEN, `entrant=${B}&other=x&entrant=${A}`));
    expect(mocks.decide).toHaveBeenCalledExactlyOnceWith(ROW, { how: "pick", entrantIds: [B, A] });
  });

  it("a body that names nobody, or is no form at all, reaches the decision as an empty pick (its PICK_INVALID), never a JSON 400", async () => {
    let checked = 0;
    for (const [body, type] of [
      ["", "application/x-www-form-urlencoded"],
      ["{not a form", "multipart/form-data; boundary=x"],
      [`{"entrant":["${A}"]}`, "application/json"],
    ] as const) {
      mocks.decide.mockClear();
      mocks.resolve.mockResolvedValue(ROW);
      mocks.decide.mockRejectedValueOnce(new HttpError(422, "pick", QUICK_MATCH_ERRORS.PICK_INVALID));
      expect(landed(await call(pick, TOKEN, body, type)), type).toBe(`/q/${TOKEN}?e=${QUICK_MATCH_ERRORS.PICK_INVALID}`);
      expect(mocks.decide, type).toHaveBeenCalledExactlyOnceWith(ROW, { how: "pick", entrantIds: [] });
      checked++;
    }
    expect(checked).toBe(3);
    expect(reported()).toEqual([]);
  });

  it("the Toss reads no body: whatever is posted, it is a toss", async () => {
    mocks.resolve.mockResolvedValue(ROW);
    mocks.decide.mockResolvedValue({ through: [A] });
    landed(await call(ROUTES[0], TOKEN, `entrant=${A}`));
    expect(mocks.decide).toHaveBeenCalledExactlyOnceWith(ROW, { how: "toss" });
  });
});
