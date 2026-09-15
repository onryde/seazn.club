// The kiosk tree's 404 is the same branded page as the rest of /shared. Without
// this file a /present page's notFound() (a private competition, a bad slug,
// the org door in the kiosk layout) would bubble past the `(kiosk)` group to
// Next's bare built-in page. Re-exported, not copied: that file's "renders in
// DEFAULT_LOCALE, must stay static" constraint lives in one place.
export { default } from "../../[orgSlug]/not-found";
