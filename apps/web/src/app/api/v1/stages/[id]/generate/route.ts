import { v1 } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { GenerateStageInput } from "@/server/api-v1/schemas";
import { HttpError } from "@/lib/errors";
import { generateStageFixtures } from "@/server/usecases/stages";

type Ctx = { params: Promise<{ id: string }> };

/** Generate fixtures for a stage — idempotent, returns the diff (doc 08 §3).
 *  Optional body `{ pairing }`: a round-1-only Swiss pairing override. */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "stage", id, "write");
    const text = await req.text();
    let raw: unknown = {};
    if (text.trim() !== "") {
      try {
        raw = JSON.parse(text);
      } catch {
        throw new HttpError(400, "Request body must be valid JSON");
      }
    }
    const body = GenerateStageInput.parse(raw);
    return generateStageFixtures(auth, id, body.pairing ? { pairing: body.pairing } : {});
  });
}
