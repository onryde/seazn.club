// PATCH /api/quick-match/<id> { name } and DELETE /api/quick-match/<id>: the saver's rename and delete of a saved quick match, from
// the account's Quick matches (quick match plan 3, Task 6; spec docs/superpowers/specs/2026-11-03-quick-match-design.md §7.7, C13;
// plan 3 Amend T6 [B28, D14]; ledger carry "rename + delete refuse under imp"). The account list (components/quick-match/
// my-list.tsx) sends both with `fetch` (my-list-requests.ts maps each refusal's code to its own line).
//
// Each verb, in this order:
//   1. no session: 401 QUICK_MATCH_SIGNED_OUT (a deleted account's session included: `getCurrentSession` reads no deleted user);
//   2. a session staff impersonation started (`getCurrentSession().impersonated`, the session's signed `imp` claim): 403, the
//      verb's own code. Staff never rename, or delete for everyone, the match of the person they look through;
//   3. the usecase (server/usecases/quick-match-owner.ts): rename refuses a name the create would refuse (422
//      QUICK_MATCH_RENAME_INVALID), then both refuse a match this person has not saved (404 QUICK_MATCH_NOT_IN_ACCOUNT, one answer
//      whether it is someone else's or does not exist). PATCH answers 200 `{ ok, data: { id, name } }`; DELETE answers 204.
//
// Cross-site requests: proxy.ts refuses a mutating `/api` request whose Origin names another host, and the session cookie is
// SameSite=Lax, so a cross-site PATCH or DELETE never carries it. Bot check: none, as for every signed-in write (the Turnstile
// route-tree sweep reads the session door below, turnstile-gate.test.ts).
import { NextResponse } from "next/server";
import { getCurrentSession } from "@/lib/auth";
import { handler, HttpError } from "@/lib/http";
import { QUICK_MATCH_ERRORS } from "@/lib/quick-match-constants";
import { deleteSavedQuickMatch, renameSavedQuickMatch } from "@/server/usecases/quick-match-owner";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, { params }: Ctx) {
  return handler(async () => {
    const session = await getCurrentSession();
    if (!session) throw new HttpError(401, "Sign in to rename a quick match.", QUICK_MATCH_ERRORS.SIGNED_OUT);
    if (session.impersonated) {
      throw new HttpError(403, "A staff view cannot rename this person's quick match.", QUICK_MATCH_ERRORS.RENAME_IMPERSONATED);
    }
    const { id } = await params;
    // A body that is not JSON, or not an object, names no name: the usecase refuses it as it refuses any other bad name.
    const body: unknown = await req.json().catch(() => null);
    const name = body !== null && typeof body === "object" ? (body as { name?: unknown }).name : undefined;
    return renameSavedQuickMatch(session.user.id, id, name);
  });
}

export async function DELETE(_req: Request, { params }: Ctx) {
  return handler(async () => {
    const session = await getCurrentSession();
    if (!session) throw new HttpError(401, "Sign in to delete a quick match.", QUICK_MATCH_ERRORS.SIGNED_OUT);
    if (session.impersonated) {
      throw new HttpError(403, "A staff view cannot delete this person's quick match.", QUICK_MATCH_ERRORS.DELETE_IMPERSONATED);
    }
    const { id } = await params;
    await deleteSavedQuickMatch(session.user.id, id);
    return new NextResponse(null, { status: 204 });
  });
}
