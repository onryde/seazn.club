import { describe, expect, it } from "vitest";
import { posterFileName } from "@/lib/poster-file-name";

describe("posterFileName — a saved poster has to be a file something will open", () => {
  it("always ends in .png, whatever the names are", () => {
    // The reason this exists: the route path already ends in `poster.png`, and
    // the file still arrived with no extension, because the browser names the
    // download from `Content-Disposition` when there is one.
    for (const [h, a] of [
      ["Northfield CC", "Riverside FC"],
      ["", ""],
      ["...", "???"],
      ["Ærø IF", "Ñuñoa"],
    ]) {
      expect(posterFileName(h!, a!)).toMatch(/\.png$/);
    }
  });

  it("names the two sides, so a downloads folder is not four files called poster", () => {
    expect(posterFileName("Northfield CC", "Riverside FC")).toBe(
      "seazn-northfield-cc-v-riverside-fc.png",
    );
  });

  it("falls back to a usable name when neither side slugifies to anything", () => {
    // Non-latin names slugify to nothing, and "seazn--v-.png" is not a name.
    expect(posterFileName("東京", "大阪")).toBe("seazn-match.png");
  });

  it("keeps one side from crowding the other out — each is capped before joining", () => {
    const long = "The Extremely Long Football And Cricket Club Of Southend On Sea";
    const name = posterFileName(long, "Riverside FC");
    expect(name).toContain("-v-riverside-fc.png");
    // Capped, and never left ending on the separator the cap cut through.
    expect(name).not.toMatch(/-v-/.source + ".*-v-");
    expect(name.split("-v-")[0]).not.toMatch(/-$/);
  });
});
