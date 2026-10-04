import { baseUrl } from "@/lib/oauth";
import { CaptureRefusalError, captureBearer, captureJson, captureRoute } from "@/server/api-v1/capture-http";
import { CaptureBeat } from "@/server/api-v1/capture-schemas";
import { postBeat } from "@/server/usecases/capture-phone";
import { defaultDeps } from "@/server/usecases/stream-sessions";

type Ctx = { params: Promise<{ code: string }> };

/** The phone's beat (capture QR v2 §6.3.2). Bearer `tok` only — no cookie, no API key (NEVER_KEY_ROUTES); a missing or
 *  malformed Bearer is the uniform `401 code_ended` (A17). The body is the STRICT contract (`CaptureBeat`, its D16
 *  cross-field rules included): anything else — not JSON, an unknown key, an over-long string — is `422 invalid`, which
 *  the phone counts as a failed beat and which changes nothing. The 2xx is the BARE answer; every answer is
 *  `private, no-store`. The message names the offending fields, never their values. */
export async function POST(req: Request, { params }: Ctx) {
  return captureRoute(async () => {
    const { code } = await params;
    const tok = captureBearer(req);
    let json: unknown;
    try {
      json = await req.json();
    } catch {
      throw new CaptureRefusalError(422, "invalid", "the beat is not JSON");
    }
    const parsed = CaptureBeat.safeParse(json);
    if (!parsed.success) {
      const fields = [...new Set(parsed.error.issues.map((i) => i.path.join(".") || "(body)"))].join(", ");
      throw new CaptureRefusalError(422, "invalid", `the beat does not match the contract: ${fields}`);
    }
    return captureJson(200, await postBeat(code, tok, parsed.data, defaultDeps(baseUrl(req)), new Date()));
  });
}
