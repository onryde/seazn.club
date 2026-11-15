// Revshare affiliate reporting (lib/revshare.ts + lib/revshare-shared.ts). No DB:
// fetch and the logger are stubbed, so these pin the wire contract Revshare
// documents — body shape, x-api-key header, cents — the master switch, and the
// "never throws inside the webhook" rule.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/logger", () => ({ log: { error: vi.fn(), warn: vi.fn() } }));
vi.mock("next/headers", () => ({ cookies: vi.fn() }));

import { log } from "@/server/logger";
import {
  REVSHARE_PROGRAM_ID,
  buildReferralBody,
  reportSale,
  sanitizeRefCode,
} from "@/lib/revshare";
import {
  REF_CODE_RE,
  REVSHARE_COOKIE,
  revshareCookieString,
  revshareEnabled,
} from "@/lib/revshare-shared";

const sale = {
  refCode: "abc_123",
  transactionId: "in_1",
  amountCents: 5000,
  currency: "gbp",
  customerId: "cus_1",
};

describe("sanitizeRefCode", () => {
  it.each([
    ["abc_123-X", "abc_123-X"],
    ["  padded  ", "padded"],
    ["has space", null],
    ["semi;colon", null],
    ["a".repeat(65), null],
    ["", null],
    [undefined, null],
    [42, null],
  ])("%j -> %j", (input, out) => {
    expect(sanitizeRefCode(input)).toBe(out);
  });
});

describe("master switch", () => {
  afterEach(() => vi.unstubAllEnvs());
  it.each([
    ["1", true],
    ["0", false],
    ["", false],
    ["true", false],
    ["on", false],
    [undefined, false],
  ])("NEXT_PUBLIC_REVSHARE_ENABLED=%j -> %j (only the literal \"1\" turns it on)", (v, on) => {
    if (v === undefined) vi.stubEnv("NEXT_PUBLIC_REVSHARE_ENABLED", undefined as unknown as string);
    else vi.stubEnv("NEXT_PUBLIC_REVSHARE_ENABLED", v);
    expect(revshareEnabled()).toBe(on);
  });
});

describe("browser cookie <-> server reader agree (RevshareCapture's producer half)", () => {
  const valid = ["aff_Zq-9_x", "a", "A".repeat(64), "0", "x-y_z"];
  const invalid = ["", "a b", "a;b", "a=b", "a,b", "a".repeat(65), "é", "a\nb", "<s>"];

  it("a code the client writes is exactly a code the server accepts, and vice versa", () => {
    let checked = 0;
    for (const code of [...valid, ...invalid]) {
      const cookie = revshareCookieString(code, "https:");
      const serverOk = sanitizeRefCode(code) === code;
      expect(cookie !== null, `client/server disagree on ${JSON.stringify(code)}`).toBe(serverOk);
      checked++;
    }
    expect(checked).toBe(valid.length + invalid.length); // anti-vacuity: the sweep ran
    expect(valid.every((c) => REF_CODE_RE.test(c))).toBe(true);
    expect(invalid.every((c) => !REF_CODE_RE.test(c))).toBe(true);
  });

  it("writes the cookie the server reads: name, value, 30-day Max-Age, Path=/, Lax", () => {
    const c = revshareCookieString("aff_1", "http:")!;
    expect(c.startsWith(`${REVSHARE_COOKIE}=aff_1;`)).toBe(true);
    expect(c).toContain("Max-Age=2592000");
    expect(c).toContain("Path=/");
    expect(c).toContain("SameSite=Lax");
    expect(c).not.toContain("Secure");
  });

  it("marks the cookie Secure on https only (positive pair of the case above)", () => {
    expect(revshareCookieString("aff_1", "https:")).toContain("; Secure");
  });

  it("refuses non-string input", () => {
    expect(revshareCookieString(undefined, "https:")).toBeNull();
    expect(revshareCookieString(7, "https:")).toBeNull();
  });
});

describe("buildReferralBody", () => {
  it.each([
    ["gbp", "GBP"],
    ["eur", "EUR"],
    ["usd", "USD"],
  ])("currency %s is sent as %s, amount in cents, in the documented shape", (cur, sent) => {
    expect(buildReferralBody({ ...sale, currency: cur })).toEqual({
      ref_code: "abc_123",
      program_id: REVSHARE_PROGRAM_ID,
      spent_amount: 5000,
      currency: sent,
      transaction_id: "in_1",
      customer_id: "cus_1",
    });
  });
});

describe("reportSale", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    vi.mocked(log.error).mockReset();
    vi.mocked(log.warn).mockReset();
    vi.stubEnv("REVSHARE_API_KEY", "rs_test");
    vi.stubEnv("NEXT_PUBLIC_REVSHARE_ENABLED", "1");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("POSTs to /api/referral with the key header and body", async () => {
    fetchMock.mockResolvedValue({ ok: true });
    await reportSale(sale);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://www.revshare.so/api/referral");
    expect(init.method).toBe("POST");
    expect(init.headers["x-api-key"]).toBe("rs_test");
    expect(JSON.parse(init.body)).toEqual(buildReferralBody(sale));
  });

  it("is a no-op while the master switch is off, even with a key (stg: dummy key + 0)", async () => {
    vi.stubEnv("NEXT_PUBLIC_REVSHARE_ENABLED", "0");
    await reportSale(sale);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([0, -1, Number.NaN, undefined as unknown as number])(
    "skips non-positive / non-numeric amount %j",
    async (amountCents) => {
      await reportSale({ ...sale, amountCents });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("is a no-op without an API key", async () => {
    vi.stubEnv("REVSHARE_API_KEY", "");
    await reportSale(sale);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("warns ONCE in production when enabled but the key is missing", async () => {
    vi.stubEnv("REVSHARE_API_KEY", "");
    vi.stubEnv("NODE_ENV", "production");
    await reportSale(sale);
    await reportSale(sale);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it("never throws: network failure is logged", async () => {
    fetchMock.mockRejectedValue(new Error("down"));
    await expect(reportSale(sale)).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledTimes(1);
  });

  it("never throws: non-2xx is logged", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401 });
    await expect(reportSale(sale)).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledTimes(1);
  });
});
