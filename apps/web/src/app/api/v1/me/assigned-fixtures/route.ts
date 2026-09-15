import { v1 } from "@/server/api-v1/http";
import { requireUser } from "@/lib/auth";
import { HttpError } from "@/lib/errors";
/** The scorer console read — Task 3 deletes this route (#707). */
export async function GET(req: Request) {
  return v1(async () => {
    await requireUser();
    const raw = new URL(req.url).searchParams.get("date");
    if (raw !== null && !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      throw new HttpError(400, "Invalid date — expected YYYY-MM-DD");
    }
    return [];
  });
}
