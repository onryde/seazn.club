import { baseUrl } from "@/lib/oauth";
import { CaptureRefusalError, captureBearer, captureJson, capturePhoneRoute } from "@/server/api-v1/capture-http";
import { CaptureStartBody } from "@/server/api-v1/capture-schemas";
import { postStart } from "@/server/usecases/capture-phone";
import { defaultDeps } from "@/server/usecases/stream-sessions";

type Ctx = { params: Promise<{ code: string }> };

/** The phone's own start (capture QR v2 §6.3.4). Bearer `tok` only — no cookie, no API key (NEVER_KEY_ROUTES); a
 *  missing or malformed Bearer is the uniform `401 code_ended` (A17). The body is the STRICT `{phone}`: anything else —
 *  not JSON, an unknown key, a phone outside 16..64 — is `422 invalid`. `200 {sid}` bare; every refusal is §6.7.2's
 *  `{code, message}` (only already_live adds `{sid, startedBy}`); every answer is `private, no-store`. Not idempotent:
 *  a retry after a lost 200 meets 409 already_live with the same sid. Rate-limited per §10.4, the start's own budget
 *  included (`capturePhoneRoute`). */
export async function POST(req: Request, { params }: Ctx) {
  const { code } = await params;
  return capturePhoneRoute(req, code, "start", async () => {
    const tok = captureBearer(req);
    let json: unknown;
    try {
      json = await req.json();
    } catch {
      throw new CaptureRefusalError(422, "invalid", "the start is not JSON");
    }
    const parsed = CaptureStartBody.safeParse(json);
    if (!parsed.success) {
      const fields = [...new Set(parsed.error.issues.map((i) => i.path.join(".") || "(body)"))].join(", ");
      throw new CaptureRefusalError(422, "invalid", `the start does not match the contract: ${fields}`);
    }
    return captureJson(200, await postStart(code, tok, parsed.data, defaultDeps(baseUrl(req)), new Date()));
  });
}
