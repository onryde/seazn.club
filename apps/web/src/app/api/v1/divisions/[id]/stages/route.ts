import { v1, reply, parseBody } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { CreateStages } from "@/server/api-v1/schemas";
import { listStagesWithTableRules, createStages, replaceStages } from "@/server/usecases/stages";

type Ctx = { params: Promise<{ id: string }> };

/** The division's stages in board order, each with its table rules (W2d: `tableRules`, null where they do not read). */
export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "division", id, "read");
    return listStagesWithTableRules(auth, id);
  });
}

/** Replace the whole stage graph (v8 Settings → Format) — 409 FORMAT_LOCKED
 *  once fixtures exist. */
export async function PUT(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const body = await parseBody(req, CreateStages);
    const auth = await requireResourceAuth(req, "division", id, "write");
    return replaceStages(auth, id, body);
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
