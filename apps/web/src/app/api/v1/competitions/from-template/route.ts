import { v1, reply, parseBody } from "@/server/api-v1/http";
import { requireAuth } from "@/server/api-v1/auth";
import { CreateFromTemplate } from "@/server/api-v1/schemas";
import { createFromTemplate } from "@/server/usecases/templates";

/** Instantiate a curated format template (D1a design doc) — competition +
 *  divisions + stages in one transaction, through the same validation a
 *  manual create would hit. `write` scope: same editor-role gate as every
 *  other mutating /competitions route (the design doc's "403 non-admin"). */
export async function POST(req: Request) {
  return v1(async () => {
    const auth = await requireAuth(req, "write");
    const body = await parseBody(req, CreateFromTemplate);
    return reply(201, await createFromTemplate(auth, body));
  });
}
