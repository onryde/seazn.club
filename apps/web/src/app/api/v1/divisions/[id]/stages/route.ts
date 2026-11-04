import { v1, reply, parseBody } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { CreateStages } from "@/server/api-v1/schemas";
import { listStagesWithTableRules, createStages, previewReplaceStages, replaceStages } from "@/server/usecases/stages";

type Ctx = { params: Promise<{ id: string }> };

/** The division's stages in board order, each with its table rules (W2d: `tableRules`, null where they do not read). */
export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "division", id, "read");
    return listStagesWithTableRules(auth, id);
  });
}

/** Replace the whole stage graph (FMT5: the Division rules card's Format dialog) — 409 FORMAT_LOCKED once a result
 *  exists. `?dry_run=1` answers what the change would clear and writes nothing; a change that clears fixtures sends that
 *  answer's token back as `?clear=`. */
export async function PUT(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const body = await parseBody(req, CreateStages);
    const auth = await requireResourceAuth(req, "division", id, "write");
    const query = new URL(req.url).searchParams;
    if (query.get("dry_run") === "1") return previewReplaceStages(auth, id, body);
    const clear = query.get("clear");
    return replaceStages(auth, id, body, clear === null ? {} : { clear });
  });
}

/** Define the division's stage graph (doc 08 §3). */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const body = await parseBody(req, CreateStages);
    const auth = await requireResourceAuth(req, "division", id, "write");
    const rows = await createStages(auth, id, body);
    return reply(201, Array.isArray(body) ? rows : rows[0]);
  });
}
