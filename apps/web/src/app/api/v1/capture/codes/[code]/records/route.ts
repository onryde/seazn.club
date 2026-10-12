import { captureBearer, captureJson, capturePhoneRoute } from "@/server/api-v1/capture-http";
import { postCaptureRecord } from "@/server/usecases/capture-record";

type Ctx = { params: Promise<{ code: string }> };

/** The operator's "Send record to Seazn" (spec 2026-10-12, capture-record.v1). Bearer `tok` only — no cookie, no API
 *  key (NEVER_KEY_ROUTES); any phone holding a currently valid tok of the code may send (R4). The body is NDJSON, gzip
 *  or none, at most 1000 non-empty lines and 1 MB decompressed (413 `too_large`); a line off the allow-list or a
 *  secret-shaped value is 422 `invalid`, naming the line, key and rule, never the value. Lines of another code are
 *  dropped before storage (§6). 201 is the BARE `{ref, kept, dropped}`; every answer is `private, no-store`. Rate:
 *  10 records an hour per code, in a bucket of its own (§8). Not idempotent: each tap stores a new record. */
export async function POST(req: Request, { params }: Ctx) {
  const { code } = await params;
  return capturePhoneRoute(req, code, "records", async () => {
    const tok = captureBearer(req);
    return captureJson(201, await postCaptureRecord(code, tok, req, new Date()));
  });
}
