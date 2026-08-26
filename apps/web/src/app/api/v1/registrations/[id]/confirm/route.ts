import { v1 } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { organiserRegistration } from "@/server/api-v1/registration-response";
import { confirmRegistration } from "@/server/usecases/registrations";

type Ctx = { params: Promise<{ id: string }> };

/** Organiser approve: materialises the entrant (idempotent). */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "registration", id, "write");
    return organiserRegistration(await confirmRegistration(auth, id), auth);
  });
}
