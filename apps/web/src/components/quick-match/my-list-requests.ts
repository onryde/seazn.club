// The account list's two requests (quick match plan 3, Task 6): the saver's rename and delete, sent to
// `PATCH`/`DELETE /api/quick-match/<id>` (app/api/quick-match/[id]/route.ts), and each answer turned into what the person reads.
// Client-safe: no server import. Kept apart from the island (my-list.tsx) so the route's own test drives these exact requests
// through the real route (app/api/quick-match/__tests__/owner-routes.test.ts): the method, path and body sent are the ones read.
//
// Every refusal the route answers has its OWN line, by its code (QUICK_MATCH_ERRORS); anything else (a fault, a broken network,
// an answer with no code) is the generic line, never a raw message.
import type { MessageKey } from "@/lib/messages";
import { QUICK_MATCH_ERRORS } from "@/lib/quick-match-constants";

/** What a request came to: done (a rename answers the name as stored, trimmed), or the line to show. */
export type OwnerAnswer = { ok: true; name?: string } | { ok: false; key: MessageKey };

const REFUSAL_LINES: Readonly<Record<string, MessageKey>> = {
  [QUICK_MATCH_ERRORS.SIGNED_OUT]: "quickMatch.me.signedOut",
  [QUICK_MATCH_ERRORS.RENAME_IMPERSONATED]: "quickMatch.me.renameImpersonating",
  [QUICK_MATCH_ERRORS.DELETE_IMPERSONATED]: "quickMatch.me.deleteImpersonating",
  [QUICK_MATCH_ERRORS.RENAME_INVALID]: "quickMatch.me.renameInvalid",
  [QUICK_MATCH_ERRORS.NOT_IN_ACCOUNT]: "quickMatch.me.notInAccount",
};
const GENERIC: MessageKey = "quickMatch.flash.generic";

/** The line for a refusal's code: its own, or the generic one for anything unknown. */
export function ownerRefusalLine(code: unknown): MessageKey {
  return typeof code === "string" && Object.hasOwn(REFUSAL_LINES, code) ? REFUSAL_LINES[code]! : GENERIC;
}

const pathOf = (id: string) => `/api/quick-match/${encodeURIComponent(id)}`;

async function send(id: string, init: RequestInit, fetchImpl: typeof fetch): Promise<{ res: Response; body: unknown } | null> {
  try {
    const res = await fetchImpl(pathOf(id), init);
    const body: unknown = res.status === 204 ? null : await res.json().catch(() => null);
    return { res, body };
  } catch {
    return null; // offline, or the request never left
  }
}

const codeOf = (body: unknown): unknown => (body !== null && typeof body === "object" ? (body as { code?: unknown }).code : undefined);

/** Rename the saved match `id` to `name` (sent as typed: the server trims and bounds it). */
export async function renameMyQuickMatch(id: string, name: string, fetchImpl: typeof fetch = fetch): Promise<OwnerAnswer> {
  const sent = await send(
    id,
    { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) },
    fetchImpl,
  );
  if (!sent) return { ok: false, key: GENERIC };
  if (sent.res.ok) {
    const stored = (sent.body as { data?: { name?: unknown } } | null)?.data?.name;
    return typeof stored === "string" ? { ok: true, name: stored } : { ok: true };
  }
  return { ok: false, key: ownerRefusalLine(codeOf(sent.body)) };
}

/** Delete the saved match `id` for everyone. */
export async function deleteMyQuickMatch(id: string, fetchImpl: typeof fetch = fetch): Promise<OwnerAnswer> {
  const sent = await send(id, { method: "DELETE" }, fetchImpl);
  if (!sent) return { ok: false, key: GENERIC };
  if (sent.res.ok) return { ok: true };
  return { ok: false, key: ownerRefusalLine(codeOf(sent.body)) };
}
