// The one user-agent question Open in app asks (spec 2026-11-25 §5.4): is this an Android browser? The app is Android
// only, so every other browser must get no button — a button there could only ever say "not installed". Real UA strings.
import { describe, expect, it } from "vitest";
import { isAndroidUa } from "../android-ua";

const ANDROID: Record<string, string> = {
  "Pixel Chrome": "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
  "Chrome, reduced UA": "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
  "Samsung Internet": "Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/23.0 Chrome/115.0.0.0 Mobile Safari/537.36",
  "Android tablet (md:hidden hides it by width, not by UA)": "Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
};

const OTHER: Record<string, string> = {
  "iPhone Safari": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  iPad: "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  "macOS Chrome": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  // Android Chrome's "desktop site" mode: no button, the QR and link still work (spec §5.4).
  "Android desktop-site mode": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  empty: "",
};

describe("isAndroidUa", () => {
  it("is true for each Android browser — counted", () => {
    let checked = 0;
    for (const [name, ua] of Object.entries(ANDROID)) {
      expect(isAndroidUa(ua), name).toBe(true);
      checked += 1;
    }
    expect(checked).toBe(4);
  });

  it("is false for every other browser — counted", () => {
    let checked = 0;
    for (const [name, ua] of Object.entries(OTHER)) {
      expect(isAndroidUa(ua), name).toBe(false);
      checked += 1;
    }
    expect(checked).toBe(5);
  });
});
