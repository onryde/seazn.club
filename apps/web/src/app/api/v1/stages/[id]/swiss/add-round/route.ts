import { v1 } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { addSwissRound } from "@/server/usecases/swiss-rounds-admin";

type Ctx = { params: Promise<{ id: string }> };

/** W3 T12 (X-SW-17, ruling 250): add round N + 1 to a Swiss stage, minted for the field it will pair. No body. */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "stage", id, "write");
    return addSwissRound(auth, id);
  });
}
