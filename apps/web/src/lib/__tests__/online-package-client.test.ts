// The browser side of the package doors (lib/online-package-client.ts): the URL and body a receipt sends, and what it refuses to draw.
// `fetch` is the one thing replaced; `apiV1` and the quote schema are real, so the envelope is read the way the app reads it.
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiV1Error } from "@/lib/client-v1";
import { OnlinePackagePayInput, OnlinePackageQuoteQuery } from "@/server/api-v1/schemas/online-package";
import { CAMERA_POLICIES } from "@/lib/camera-policy";
import { ONLINE_PACKAGE_CODES } from "@/lib/online-chess-package";
import { payPackage, readPackageQuote, UnreadableQuoteError } from "@/lib/online-package-client";
import { quoteOf } from "./_receipt-quote";

const ok = (data: unknown) => new Response(JSON.stringify({ ok: true, data }), { status: 200, headers: { "content-type": "application/json" } });
const fail = (status: number, error: Record<string, unknown>) => new Response(JSON.stringify({ ok: false, error }), { status, headers: { "content-type": "application/json" } });
const DIV = "11111111-1111-4111-8111-111111111111";

afterEach(() => vi.unstubAllGlobals());

describe("readPackageQuote", () => {
  it("GETs the quote route with the size and the camera answer, and returns the parsed quote", async () => {
    const quote = quoteOf({ size: 64, cameras: true, monthly: 20 });
    const fetchMock = vi.fn(async () => ok(quote));
    vi.stubGlobal("fetch", fetchMock);
    expect(await readPackageQuote(DIV, { size: 64, cameras: true })).toEqual(quote);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit | undefined];
    expect(url).toBe(`/api/v1/divisions/${DIV}/online-package?size=64&cameras=true`);
    expect(init?.method ?? "GET").toBe("GET");
  });

  it("sends cameras=false for the answer No: absent would mean 'as the division stands', which is not what the organiser chose", async () => {
    const fetchMock = vi.fn(async () => ok(quoteOf({ size: 16, monthly: 5 })));
    vi.stubGlobal("fetch", fetchMock);
    await readPackageQuote(DIV, { size: 16, cameras: false });
    const url = (fetchMock.mock.calls[0] as unknown as [string])[0];
    expect(url).toContain("size=16&cameras=false");
    // the route's own query schema reads it as the answer No (not as absent)
    const q = OnlinePackageQuoteQuery.parse(Object.fromEntries(new URL(url, "http://x").searchParams));
    expect(q.cameras).toBe(false);
  });

  it("refuses a body that is not a quote: it is never drawn", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ok({ size: 64 })));
    await expect(readPackageQuote(DIV, { size: 64, cameras: false })).rejects.toBeInstanceOf(UnreadableQuoteError);
  });

  it("throws the route's own error (a 403 for a reader who may not pay)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => fail(403, { code: "FORBIDDEN", message: "no" })));
    await expect(readPackageQuote(DIV, { size: 64, cameras: false })).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
  });
});

describe("payPackage", () => {
  it("POSTs exactly the body it is given, which the pay door's own strict schema accepts", async () => {
    const fetchMock = vi.fn(async () => ok({ applied: true, capacityLoweredTo: 32, quote: quoteOf({ size: 32, monthly: 5 }), cameraPolicy: null }));
    vi.stubGlobal("fetch", fetchMock);
    const body = { size: 32 as const, expectedOwed: 2, cameras: false };
    expect(OnlinePackagePayInput.safeParse(body).success).toBe(true);
    expect(await payPackage(DIV, body)).toEqual({ applied: true, capacityLoweredTo: 32, cameraPolicySetTo: null });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`/api/v1/divisions/${DIV}/online-package`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual(body);
  });

  it("an applied:false answer ('already at that size') resolves; it is not an error and says nothing was moved", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ok({ applied: false, capacityLoweredTo: null })));
    expect(await payPackage(DIV, { size: 32, expectedOwed: 2, cameras: false })).toEqual({ applied: false, capacityLoweredTo: null, cameraPolicySetTo: null });
  });

  it("a malformed answer reads as 'not applied', never as a payment", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ok(null)));
    expect(await payPackage(DIV, { size: 32, expectedOwed: 2, cameras: false })).toEqual({ applied: false, capacityLoweredTo: null, cameraPolicySetTo: null });
  });

  it("reads the division camera setting the answer wrote, and only one of the three settings (Task 15)", async () => {
    let checked = 0;
    for (const to of CAMERA_POLICIES) {
      vi.stubGlobal("fetch", vi.fn(async () => ok({ applied: true, capacityLoweredTo: null, cameraPolicy: { from: null, to } })));
      expect((await payPackage(DIV, { size: 32, expectedOwed: 2, cameras: to !== "off" })).cameraPolicySetTo, to).toBe(to);
      checked += 1;
    }
    expect(checked).toBe(3);
    for (const junk of [{ from: null, to: "sometimes" }, { from: null }, "required", 1]) {
      vi.stubGlobal("fetch", vi.fn(async () => ok({ applied: true, capacityLoweredTo: null, cameraPolicy: junk })));
      expect((await payPackage(DIV, { size: 32, expectedOwed: 2, cameras: true })).cameraPolicySetTo, JSON.stringify(junk)).toBeNull();
    }
  });

  it("a 409 and a 402 reject with the quote and the numbers the receipt reads, on the real error class", async () => {
    const quote = quoteOf({ size: 32, monthly: 5 });
    vi.stubGlobal("fetch", vi.fn(async () => fail(409, { code: ONLINE_PACKAGE_CODES.quoteChanged, message: "changed", quote })));
    const changed = await payPackage(DIV, { size: 32, expectedOwed: 2, cameras: false }).catch((e: unknown) => e);
    expect(changed).toBeInstanceOf(ApiV1Error);
    expect((changed as ApiV1Error).extra).toEqual({ quote });
    vi.stubGlobal("fetch", vi.fn(async () => fail(402, { code: ONLINE_PACKAGE_CODES.noCredits, message: "short", owed: 4, balance: 1 })));
    const short = await payPackage(DIV, { size: 32, expectedOwed: 4, cameras: false }).catch((e: unknown) => e);
    expect((short as ApiV1Error).extra).toEqual({ owed: 4, balance: 1 });
    expect((short as ApiV1Error).code).toBe("ONLINE_CHESS_NO_CREDITS");
  });
});
