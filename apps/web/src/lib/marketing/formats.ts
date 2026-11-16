/** The formats a marketing link into /start can name. Slugs match src/config/format-gallery.tsx. */
export const MARKETING_FORMATS = [
  "league",
  "groups-knockout",
  "knockout",
  "double_elim",
] as const;
export type MarketingFormat = (typeof MARKETING_FORMATS)[number];
