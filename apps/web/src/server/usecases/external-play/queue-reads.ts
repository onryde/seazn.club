import "server-only";
// One reader's access to the two queue listers - the held boards (`listNeedsOrganiserExternalPlay`) and the flagged ones
// (`listFlaggedExternalPlay`) - with the caller's authority already bound, and the choice of WHETHER a second reader of the same
// poll shares the first one's read.
//
// Match Day's poll asks the two listers for every online division from two places: the desk's per-board attentions
// (`getCompetitionDesk`, which the Needs-you rows come from) and the online rounds (`readOnlineRounds`, which decides which boards
// of earlier rounds the list must carry). They are asked the same question by the same caller within the same poll, and the flagged
// lister is the dear one (it builds every flagged board: its sides, its camera policy, its facts), so `getMatchDay` makes ONE
// `sharedQueueReads` and hands it to both: whichever asks first reads, the other gets that answer. A reader with no sibling in its
// poll (the competition page, the org home, the sponsor-deals desk) takes `directQueueReads` and reads for itself, as it always did.
//
// The methods keep the listers' own names and arguments (less the caller): a consumer of the one source still reads as a caller of the
// two listers (owner O2, online-queue-one-source.test.ts), and no second query for "held" or "flagged" is written anywhere.
//
// An answer is shared as the lister gave it - the same arrays and rows - so a consumer never writes to what it is handed. A failed read
// is shared too: both readers see the same rejection and each keeps its own way of answering it (the desk leaves that division's
// attentions out; the online read fails closed, `getMatchDay`'s MD-R9 isolation). The shared object also says WHICH divisions had a read
// fail (`unreadDivisions()`): the poll carries them as `boards_unread`, because the desk's per-board rows of such a division are as unread
// as its online round is, and the page holds its last rows of exactly those divisions (gaps wave A fix round 2).
import type { AuthCtx } from "@/server/api-v1/auth";
import { listFlaggedExternalPlay } from "./arbiter";
import { listNeedsOrganiserExternalPlay } from "./queue";

export type QueueReads = {
  listNeedsOrganiserExternalPlay(divisionId: string): ReturnType<typeof listNeedsOrganiserExternalPlay>;
  listFlaggedExternalPlay(divisionId: string): ReturnType<typeof listFlaggedExternalPlay>;
};

/** Every call reads: the listers, with the caller bound. */
export function directQueueReads(auth: AuthCtx): QueueReads {
  return {
    listNeedsOrganiserExternalPlay: (divisionId) => listNeedsOrganiserExternalPlay(auth, divisionId),
    listFlaggedExternalPlay: (divisionId) => listFlaggedExternalPlay(auth, divisionId),
  };
}

/** A `QueueReads` that keeps its answers for its own life and remembers which divisions had a read fail. */
export type SharedQueueReads = QueueReads & {
  /** The divisions any read made through this object has rejected for, sorted, each once. Ask it AFTER the readers have settled: a read
   *  still in flight is not yet a failure. */
  unreadDivisions(): string[];
};

/** One read of each lister per division, kept for as long as the object lives - make ONE per poll, never longer: a held board settled a
 *  minute later must read settled. The second asker of a division gets the first one's promise, so two readers running side by side
 *  still make one read between them. */
export function sharedQueueReads(auth: AuthCtx): SharedQueueReads {
  const direct = directQueueReads(auth);
  const held = new Map<string, ReturnType<typeof listNeedsOrganiserExternalPlay>>();
  const flagged = new Map<string, ReturnType<typeof listFlaggedExternalPlay>>();
  const unread = new Set<string>();
  const once = <T>(kept: Map<string, Promise<T>>, divisionId: string, read: () => Promise<T>): Promise<T> => {
    let answer = kept.get(divisionId);
    if (answer === undefined) {
      answer = read();
      // A side branch that only notes the rejection (so it is never an unhandled one); the readers get `answer` itself and keep their own way of failing.
      answer.catch(() => {
        unread.add(divisionId);
      });
      kept.set(divisionId, answer);
    }
    return answer;
  };
  return {
    unreadDivisions: () => [...unread].sort(),
    listNeedsOrganiserExternalPlay: (divisionId) => once(held, divisionId, () => direct.listNeedsOrganiserExternalPlay(divisionId)),
    listFlaggedExternalPlay: (divisionId) => once(flagged, divisionId, () => direct.listFlaggedExternalPlay(divisionId)),
  };
}
