// A shared /present link keeps the competition's share card. Under the chrome
// tree the board inherited `[competitionSlug]/opengraph-image.tsx` from its
// parent segment; in the `(kiosk)` group it has no such parent, so the same
// image is re-exported here (K-1). `revalidate` is segment config and must be
// a literal in this file, so it is restated, matching the source (300).
//
// A rename is NOT followed here (K fix round, accepted): the page beside this
// one 308s a stale slug, this card just renders whatever the URL carries, so an
// unfurl of an old printed link still misses.
export { default, size, contentType } from "../../../../[orgSlug]/[competitionSlug]/opengraph-image";
export const revalidate = 300;
