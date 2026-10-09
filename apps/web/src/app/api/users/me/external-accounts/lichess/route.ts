import { handler } from "@/lib/http";
import { requireUser } from "@/lib/auth";
import { unlinkLichess } from "@/server/usecases/external-accounts";

/** DELETE /api/users/me/external-accounts/lichess — unlink Lichess from the session user. */
export async function DELETE() {
  return handler(async () => {
    const user = await requireUser();
    await unlinkLichess(user.id);
    return { ok: true };
  });
}
