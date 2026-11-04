import { HttpError } from "@/lib/errors";
import { v1, reply, parseBody, assertOneOf } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { CreateStages } from "@/server/api-v1/schemas";
import { listStagesWithTableRules, createStages, previewReplaceStages, replaceStages } from "@/server/usecases/stages";

type Ctx = { params: Promise<{ id: string }> };

/** `?dry_run=`'s one value (OpenAPI `enum: ["1"]`). */
const DRY_RUN = ["1"] as const;

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
    // Fix round 1 (review m1): `dry_run` takes only its documented value (`assertOneOf`). Any other one is a 400, never
    // the write - a preview flag that falls through to a real change on `?dry_run=true` fails open.
    const dryRun = query.get("dry_run");
    assertOneOf(dryRun, DRY_RUN, "dry_run");
    if (dryRun === "1") return previewReplaceStages(auth, id, body);
    const clear = query.get("clear");
    // Re-review r1-m2: an empty `?clear=` names no dry run. A 400, never a token compared against the board.
    if (clear === "") throw new HttpError(400, "clear must be a dry run's token");
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
