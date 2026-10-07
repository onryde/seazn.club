import { baseUrl } from "@/lib/oauth";
import { CaptureRefusalError, captureBearer, captureJson, capturePhoneRoute, clientIpOf } from "@/server/api-v1/capture-http";
import { CaptureStartBody } from "@/server/api-v1/capture-schemas";
import { postScoringLink } from "@/server/usecases/capture-phone";
import { defaultDeps } from "@/server/usecases/stream-sessions";

type Ctx = { params: Promise<{ code: string }> };

/** The match's Remote scoring link for the slot's current phone (capture QR v2 §6.3.5, W27). Bearer `tok` only — no
 *  cookie, no API key (NEVER_KEY_ROUTES); a missing or malformed Bearer is the uniform `401 code_ended` (A17). The body
 *  is the start's STRICT `{phone}`: anything else is `422 invalid`. `200 {url}` bare; every refusal is `{code, message}`;
 *  every answer is `private, no-store`. It returns the match's live link or creates one, and NEVER removes or replaces
 *  an existing link, so a repeat call returns the same url. The url is a credential: never logged. Rate-limited by the
 *  code's budget (`capturePhoneRoute`) and, once the tok and holder checks pass, the console's per-IP mint budget
 *  (`postScoringLink`). */
export async function POST(req: Request, { params }: Ctx) {
  const { code } = await params;
  return capturePhoneRoute(req, code, "scoring-link", async () => {
    const tok = captureBearer(req);
    let json: unknown;
    try {
      json = await req.json();
    } catch {
      throw new CaptureRefusalError(422, "invalid", "the request is not JSON");
    }
    const parsed = CaptureStartBody.safeParse(json);
    if (!parsed.success) {
      const fields = [...new Set(parsed.error.issues.map((i) => i.path.join(".") || "(body)"))].join(", ");
      throw new CaptureRefusalError(422, "invalid", `the request does not match the contract: ${fields}`);
    }
    return captureJson(200, await postScoringLink(code, tok, parsed.data, defaultDeps(baseUrl(req)), new Date(), clientIpOf(req)));
  });
}
