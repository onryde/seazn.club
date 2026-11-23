/**
 * What a downloaded match poster is called once it is on someone's phone.
 *
 * ONE authority, because two ends name the same file and they must not
 * disagree: the `<a download>` attribute on the Poster button, and the
 * `Content-Disposition` the `poster.png` route sets. The route's path already
 * ends in `poster.png`, which looks like it settles the question and does not —
 * the browser prefers the disposition when there is one, and a file arriving
 * with no extension is a file nothing will open.
 *
 * It carries the two sides rather than the word "poster" so a phone's downloads
 * folder ends up with `seazn-northfield-cc-v-riverside-fc.png` instead of four
 * files called `poster`. Each side is capped before joining, not after, so one
 * very long club name cannot crowd the other out of the name entirely.
 */
export function posterFileName(home: string, away: string): string {
  return `${matchFileStem(home, away)}.png`;
}

/**
 * What a downloaded Seazn replay part is called (Seazn-hosted video, Task 26):
 * the poster's stem for the same two sides, then the part —
 * `seazn-northfield-cc-v-riverside-fc-part-2.mp4`. The download route's
 * `Content-Disposition` is the one place that names the file; the panel's
 * `<a download>` carries no name of its own, so the two cannot disagree.
 */
export function replayFileName(home: string, away: string, partNo: number): string {
  // A part number is V542's `part_no` (CHECK >= 1); anything else names no part, and must not name a file.
  if (!Number.isInteger(partNo) || partNo < 1) throw new RangeError(`replayFileName: a part number is a whole number from 1, got ${partNo}`);
  return `${matchFileStem(home, away)}-part-${partNo}.mp4`;
}

/** `seazn-<home>-v-<away>`, each side slugged and capped before joining; `seazn-match` when neither side has a usable name. */
function matchFileStem(home: string, away: string): string {
  const slug = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/g, "");
  const pair = [slug(home), slug(away)].filter((part) => part !== "").join("-v-");
  return `seazn-${pair === "" ? "match" : pair}`;
}
