// Test fixture: the body of Bunny's `GET /library/{id}/videos/{vid}/resolutions` in the shape the controller's stg probe read
// (2026-11-24, two videos, HTTP 200, mp4 set 240/360/480/720/1080). The MP4 fallback files are `data.mp4Resolutions`; the same
// paths also sit under `storageResolutions` / `storageObjects`, which are NOT downloadable. One place, so every fake answers alike.
const label = (h: number) => `${h}p`;
const file = (h: number) => `play_${h}p.mp4`;

export function bunnyResolutionsBody(o: { guid: string; mp4: readonly number[]; storage?: readonly number[]; success?: boolean }) {
  const storage = o.storage ?? o.mp4;
  return {
    data: {
      videoId: o.guid,
      videoLibraryId: 424242,
      availableResolutions: o.mp4.map(label),
      configuredResolutions: o.mp4.map(label),
      playlistResolutions: o.mp4.map((h) => ({ resolution: label(h), path: `${h}p/video.m3u8` })),
      storageResolutions: storage.map((h) => ({ resolution: label(h), path: file(h) })),
      mp4Resolutions: o.mp4.map((h) => ({ resolution: label(h), path: file(h) })),
      storageObjects: storage.map((h) => ({ path: `/${o.guid}/${file(h)}`, size: 1000 + h })),
      oldResolutions: {},
      hasBothOldAndNewResolutionFormat: false,
      hasOriginal: true,
    },
    success: o.success ?? true,
    message: "",
    statusCode: 200,
  };
}
