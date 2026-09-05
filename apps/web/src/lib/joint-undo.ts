// The joint-undo "superseded" refusal's machine-readable half, said ONCE.
//
// A joint undo rewinds every division of one competition against the anchors
// the apply left. If a NEWER joint apply lands part-way through, the rewind
// stops and every remaining division is reported as unattempted — a refusal
// with a sentence (`SUPERSEDED_REASON`, in
// `server/usecases/competition-schedule-restore.ts`) and, from here, a CODE.
//
// WHY THE CODE MATTERS: that sentence is ENGLISH PROSE, and it lands in
// `board.ai.joint.undoneReason`'s `{reason}` placeholder — a raw English clause
// mid-sentence inside a fully translated card, on the ordinary path rather than
// a race. Exactly the defect `SCHEDULE_LOCKED_CODE` was added to close for the
// freeze refusal in the SAME card, one release earlier. A client that could
// only recognise this refusal by matching its prose would break the moment the
// prose was reworded, so the code is the thing to branch on.
//
// WHY A LEAF WITH NO IMPORTS, exactly like `schedule-lock.ts` beside it: the
// producer is a server usecase (which reaches `server-only` through `@/lib/db`)
// and the consumer is a CLIENT component
// (`components/v2/board/ai-competition-console.tsx`). A client component that
// imports from `@/server` breaks the BUILD, so the only shape that lets both
// sides name one constant is a module that imports nothing. Adding any import
// here — above all `server-only`, or anything that reaches it — silently
// un-shares the constant again.
//
// The SENTENCE deliberately stays server-side. It is the fallback for a client
// that does not recognise the code (an API consumer, an older build), and
// putting it here would put English prose one import away from every browser
// surface — which is how the leak this closes got written in the first place.

/** `failed[].code` on every division a joint undo did NOT attempt because a
 *  newer joint apply landed on the competition part-way through.
 *
 *  Not an `HttpError.code`: this refusal is never thrown. The rewind keeps
 *  going on purpose (the caller needs to know WHICH divisions still carry the
 *  AI board), so it is reported per division on the 200 envelope —
 *  `CompetitionRestoreOut.failed[]` — beside the codes that DID come off a
 *  thrown `HttpError`. One namespace, one meaning per value. */
export const JOINT_UNDO_SUPERSEDED_CODE = "JOINT_UNDO_SUPERSEDED";
