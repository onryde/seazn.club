// The kind harness (`_kind-harness.ts`) reads the transport's calls back from the test double the importing file installed
// (`vi.mock("@/server/email-outbox/transport", ...)`). Run in a file that installed none, it would be asking the REAL `deliver` what it
// was called with. It must refuse, by name, before it runs a single scenario: a harness that "passed" against the real transport would
// have checked nothing about what was sent.
//
// This file deliberately installs no mock. No database: the refusal comes first.
import { describe, expect, it } from "vitest";
import { OUTBOX_KINDS } from "../constants";
import { forEachOutboxKind, type KindFacts } from "./_kind-harness";

const FACTS = Object.fromEntries(OUTBOX_KINDS.map((k) => [k, ["literal", true] as const])) as unknown as KindFacts;

describe("the kind harness without a transport double", () => {
  it("refuses by name when the transport is the real one, even with nothing to sweep", async () => {
    await expect(forEachOutboxKind({}, { notYetMoved: OUTBOX_KINDS, specFacts: FACTS })).rejects.toThrow(/transport[\s\S]*not a (test double|mock)/i);
  });
});
