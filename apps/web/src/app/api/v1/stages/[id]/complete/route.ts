import { v1 } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { completeStage } from "@/server/usecases/stages";

type Ctx = { params: Promise<{ id: string }> };

/** Guarded progression: no-op unless the stage's completion predicate holds.
 *  R10g: the organiser's completion publishes the hub once after ANY
 *  completion that commits — the bracket it drew, a seed proposal, the
 *  division completing, or nothing drawn at all (the hub carries stage and
 *  division status too) — so the hub stops showing the old phase without
 *  waiting for its cache to expire. `publish: true` is the default since
 *  R10g; it stays written out here as the route's intent. */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "stage", id, "write");
    return completeStage(auth, id, { publish: true });
  });
}
