// A shared /present link keeps the competition's share card. Under the chrome
// tree the board inherited `[competitionSlug]/opengraph-image.tsx` from its
// parent segment; in the `(kiosk)` group it has no such parent, so the same
// image is re-exported here (K-1). `revalidate` is segment config and must be
// a literal in this file, so it is restated, matching the source (300).
export { default, size, contentType } from "../../../../[orgSlug]/[competitionSlug]/opengraph-image";
export const revalidate = 300;
