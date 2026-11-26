// lib/android-ua.ts — is this browser on Android? Asked on the client, after mount, by the "Open in app" buttons
// (spec 2026-11-25 §5.4): the app is Android only. Android Chrome's "desktop site" mode sends a Linux UA and reads as
// not Android; the QR and the link still work there.
export function isAndroidUa(ua: string): boolean {
  return /\bAndroid\b/.test(ua);
}
