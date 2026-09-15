import { describe, expect, it } from "vitest";
import { externalPlayReadyTemplate } from "../external-play-ready";
import enEmails from "@/dictionaries/en/emails.json";
import esEmails from "@/dictionaries/es/emails.json";
import frEmails from "@/dictionaries/fr/emails.json";
import nlEmails from "@/dictionaries/nl/emails.json";

const ARGS = {
  orgName: "Chess Club",
  opponentName: "Alice",
  scheduledLabel: "Wed 1 Oct, 12:10 (UTC)",
  fixtureUrl: "https://example.test/shared/org/comp/div/fixtures/abc",
};

describe("externalPlayReadyTemplate", () => {
  it("embeds the Seazn fixture URL, not a Lichess host", () => {
    for (const dict of [enEmails, esEmails, frEmails, nlEmails]) {
      const out = externalPlayReadyTemplate(ARGS, dict as Record<string, string>);
      expect(out.html).toContain(ARGS.fixtureUrl);
      expect(out.text).toContain(ARGS.fixtureUrl);
      expect(out.html).not.toContain("lichess.org");
      expect(out.subject.length).toBeGreaterThan(0);
    }
  });
});
