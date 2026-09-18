import { v1 } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { unpairSwissRound } from "@/server/usecases/stages";

type Ctx = { params: Promise<{ id: string }> };

/** Unpair the latest seated Swiss round — shells and schedule columns kept. */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "stage", id, "write");
    return unpairSwissRound(auth, id);
  });
}
