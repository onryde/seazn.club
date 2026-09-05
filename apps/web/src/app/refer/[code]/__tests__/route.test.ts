// /refer/<code> (#267 T2, SPEC-5 §2): always redirects to /start; a code
// that resolves also drops the "ref" cookie for consumeReferralCookie to
// pick up at org-creation time. A bad/expired code is graceful — no 404,
// no cookie, straight to /start.
import { it, expect, vi, beforeEach } from "vitest";

const resolveReferralCode = vi.fn(async (_code: string) => null as { orgId: string } | null);
vi.mock("@/lib/referral", () => ({
  REFERRAL_COOKIE: "ref",
  resolveReferralCode: (...a: [string]) => resolveReferralCode(...a),
}));

const get = async (code: string) => {
  const { GET } = await import("../route");
  const res = await GET(new Request(`http://t/refer/${code}`), { params: Promise.resolve({ code }) });
  return res;
};

beforeEach(() => resolveReferralCode.mockReset());

it("valid code → redirects to /start and sets the ref cookie", async () => {
  resolveReferralCode.mockResolvedValue({ orgId: "org-1" });
  const res = await get("VALIDCODE1");
  expect(res.status).toBe(307);
  expect(new URL(res.headers.get("location")!, "http://t").pathname).toBe("/start");
  expect(res.cookies.get("ref")?.value).toBe("VALIDCODE1");
});

it("unknown code → redirects to /start, no cookie set", async () => {
  resolveReferralCode.mockResolvedValue(null);
  const res = await get("NOSUCHCODE");
  expect(res.status).toBe(307);
  expect(new URL(res.headers.get("location")!, "http://t").pathname).toBe("/start");
  expect(res.cookies.get("ref")).toBeUndefined();
});

// The Location must carry NO origin. `req.url` — and `baseUrl(req)` when no
// proxy sets x-forwarded-host — is the server's INTERNAL BINDING, so an
// absolute header sends a real browser to the bind address. The two tests
// above cannot see that: they parse the header and read `.pathname`, which is
// identical either way, and they were written against `new URL(loc)` with no
// base, which THREW once the header went relative.
it("redirects with no origin, so the bind address cannot leak into it", async () => {
  resolveReferralCode.mockResolvedValue(null);
  // A request whose origin is not where a browser would be.
  const { GET } = await import("../route");
  const res = await GET(new Request("http://0.0.0.0:3000/refer/X"), {
    params: Promise.resolve({ code: "X" }),
  });
  expect(res.headers.get("location")).toBe("/start");
});
