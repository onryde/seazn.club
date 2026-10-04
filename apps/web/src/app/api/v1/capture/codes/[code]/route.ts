import { baseUrl } from "@/lib/oauth";
import { CaptureRefusalError, captureBearer, captureJson, capturePhoneRoute } from "@/server/api-v1/capture-http";
import { CaptureStartBody } from "@/server/api-v1/capture-schemas";
import { getCode } from "@/server/usecases/capture-phone";
import { defaultDeps } from "@/server/usecases/stream-sessions";

type Ctx = { params: Promise<{ code: string }> };

/** The phone's descriptor (capture QR v2 §6.3.1). Bearer `tok` only — no cookie, no API key (NEVER_KEY_ROUTES): a
 *  missing or malformed Bearer, a wrong tok and an ended code all answer the same `401 code_ended` (A17, C1). The 2xx
 *  is the BARE contract shape; every answer is `private, no-store`. `?slot=` defaults to 0, any other slot is
 *  `422 invalid` (T41); `?phone=` picks the session shape and, for the session's own phone, `cred` — a present one is the
 *  contract's phone (16–64 characters), an empty or over-long one `422 invalid` like the beat body's. Rate-limited per
 *  §10.4 (`capturePhoneRoute`). */
export async function GET(req: Request, { params }: Ctx) {
  const { code } = await params;
  return capturePhoneRoute(req, code, "get", async () => {
    const tok = captureBearer(req);
    const url = new URL(req.url);
    const rawSlot = url.searchParams.get("slot");
    // A non-numeric slot is not 0, so it reaches the use-case's 422 rather than defaulting.
    const slot = rawSlot === null ? 0 : /^\d+$/.test(rawSlot) ? Number(rawSlot) : Number.NaN;
    // B6 review M-4: absent is "without phone" (waiting); present, it must be the contract's phone — never an empty
    // string read as a phone, never an over-long one used as-is.
    const rawPhone = url.searchParams.get("phone");
    const parsed = rawPhone === null ? null : CaptureStartBody.shape.phone.safeParse(rawPhone);
    if (parsed !== null && !parsed.success) throw new CaptureRefusalError(422, "invalid", "phone must be 16 to 64 characters");
    const phone = parsed === null ? null : parsed.data;
    return captureJson(200, await getCode(code, tok, { slot, phone }, defaultDeps(baseUrl(req)), new Date()));
  });
}
