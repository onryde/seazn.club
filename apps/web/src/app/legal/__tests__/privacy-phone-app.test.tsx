import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

// Google Play (User Data policy) requires the privacy policy an app links to to say what the app itself accesses,
// collects and shares. The Seazn Club phone app (com.seazn.capture) uses the camera and the microphone, sends a
// status report while it is paired, and uploads a technical record on the operator's tap; the policy must say so.
//
// WHERE THE EXPECTED VALUES COME FROM. The two retention figures are read from the declarations in
// server/relay/config.ts (the sweep's own constants), never typed here, so moving a constant moves this test with it.
// The page is static English like the rest of /legal: no dictionary is involved.
vi.mock("@/components/marketing-nav", () => ({ MarketingNav: () => null }));
vi.mock("@/components/marketing-footer", () => ({ MarketingFooter: () => null }));

import PrivacyPage from "../privacy/page";

const configSrc = readFileSync(join(__dirname, "../../../server/relay/config.ts"), "utf8");
const declared = (name: string): number => {
  const m = configSrc.match(new RegExp(`export const ${name} = (\\d+);`));
  if (!m) throw new Error(`${name} is no longer declared as a plain number in server/relay/config.ts; read the new declaration here`);
  return Number(m[1]);
};
const BEAT_HOURS = declared("PHONE_BEAT_RETENTION_HOURS");
const RECORD_DAYS = declared("CAPTURE_RECORD_RETENTION_DAYS");

const text = renderToStaticMarkup(<PrivacyPage />).replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/\s+/g, " ");
const from = text.indexOf("8. The Seazn Club phone app");
const section = text.slice(from, text.indexOf("9. Sub-processors"));

describe("privacy policy: the phone app (Google Play User Data policy)", () => {
  it("has its own section, between YouTube and Sub-processors", () => {
    expect(from, "section 8 exists").toBeGreaterThan(text.indexOf("7. YouTube live streaming"));
    expect(section.length, "the section has a body").toBeGreaterThan(400);
  });

  it("names the camera and the microphone and where the picture and sound go", () => {
    const owed = ["camera", "microphone", "YouTube channel", "Go live"];
    const missing = owed.filter((w) => !section.includes(w));
    expect(owed.length).toBe(4);
    expect(missing).toEqual([]);
  });

  it("states both retention periods as the sweep declares them", () => {
    expect(BEAT_HOURS).toBeGreaterThan(0);
    expect(RECORD_DAYS).toBeGreaterThan(0);
    expect(section).toContain(`deleted after ${BEAT_HOURS} hours`);
    expect(section).toContain(`deleted after ${RECORD_DAYS} days`);
  });

  it("says what the app does not collect, and how to reach us", () => {
    for (const w of ["no account", "location", "contacts", "advertising", "privacy@seazn.club"]) expect(section, w).toContain(w);
  });
});
