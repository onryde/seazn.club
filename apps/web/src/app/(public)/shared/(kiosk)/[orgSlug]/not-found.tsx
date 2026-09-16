// The kiosk tree's 404 is the same branded page as the rest of /shared. Without
// this file a /present PAGE's notFound() would bubble past the `(kiosk)` group
// to Next's bare built-in page. Since the org door split (K fix round, F2) that
// is every miss the boards answer for: a private competition, a slug the rename
// history has no answer for, and a missing org too — the layout used to 404
// that one itself.
//
// The one notFound() left in the LAYOUT — a reserved slug, `publicOrgOrNull` —
// does NOT land here: a layout's throw skips its own segment's boundary and
// renders Next's bare page. Measured against this build on 2026-09-16:
// /shared/admin/<comp>/present came back bare, /shared/<no-such-org>/<comp>/
// present branded.
//
// Re-exported, not copied: that file's "renders in DEFAULT_LOCALE, must stay
// static" constraint lives in one place.
export { default } from "../../[orgSlug]/not-found";
