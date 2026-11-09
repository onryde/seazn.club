// lib/sponsor-moment-id.ts - R4 sponsors on stream: the ONE authority on the two moment-id shapes a sponsor airing
// carries (final review m3). Client-safe and pure: the planner, the overlay queue, the carousel, the server's assignment
// and airing writers and the frame route all build and read ids through here, so the grammar is spelled once.
//
//   break card (S4/S5):        `<seq>:sponsor.<breakKind>` - the overlay queue's `${seq}:${kind}` for a sponsor moment, whose
//                              kind is `sponsor.<breakKind>`; seq a decimal integer with no leading zero, breakKind non-empty.
//   scene carousel (S7, P5):   `scene:<sceneId>:<bucket>` - the bucket a whole number with no leading zero (the showing's
//                              start over its length: `carouselMomentId` in components/overlay/sponsor-card.tsx).
//
// Which break kinds and which scenes are REAL is not this module's to say (the engine's `naturalBreaks` declarations,
// `SPONSOR_CAROUSEL_SCENES`): it only knows the shape.

/** Every sponsor moment's queue kind starts with this, so its queue id is `${seq}:sponsor.<breakKind>`. No score rule
 *  emits a kind under it. */
export const SPONSOR_MOMENT_KIND_PREFIX = "sponsor.";

const SCENE_PREFIX = "scene:";
const BREAK_MOMENT_ID = /^(?:0|[1-9][0-9]*):sponsor\.(.+)$/;
const SCENE_MOMENT_ID = /^scene:([^:]+):(?:0|[1-9][0-9]*)$/;

/** The queue kind of a break card for `breakKind`: `sponsor.<breakKind>`. */
export function sponsorMomentKind(breakKind: string): string {
  return `${SPONSOR_MOMENT_KIND_PREFIX}${breakKind}`;
}

/** A break card's moment id: `<seq>:sponsor.<breakKind>` - the queue's `${seq}:${kind}` for the card's moment. */
export function sponsorMomentId(seq: number, breakKind: string): string {
  return `${seq}:${sponsorMomentKind(breakKind)}`;
}

/** The inverse of `sponsorMomentId`: the break kind a break card's moment id names, or null for any other id (a scene
 *  carousel showing's id, or anything malformed). */
export function breakKindOfMomentId(momentId: string): string | null {
  return BREAK_MOMENT_ID.exec(momentId)?.[1] ?? null;
}

/** Is this overlay QUEUE id (`${seq}:${kind}`) a sponsor moment's? Its kind is under the sponsor prefix. Read by the
 *  queue's `sync`, which holds only ids. */
export function isSponsorMomentId(queueId: string): boolean {
  return queueId.slice(queueId.indexOf(":") + 1).startsWith(SPONSOR_MOMENT_KIND_PREFIX);
}

/** A scene carousel showing's moment id: `scene:<sceneId>:<bucket>`. The caller owns the bucket's arithmetic. */
export function sceneMomentId(sceneId: string, bucket: number): string {
  return `${SCENE_PREFIX}${sceneId}:${bucket}`;
}

/** The inverse of `sceneMomentId`: the scene a carousel showing's id names, or null for any other id. */
export function sceneOfMomentId(momentId: string): string | null {
  return SCENE_MOMENT_ID.exec(momentId)?.[1] ?? null;
}
