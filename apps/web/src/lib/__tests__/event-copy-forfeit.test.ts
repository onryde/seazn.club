// W2b Task 12 (spec §5.5 "Copy") — a forfeit says WHICH forfeit it was, on every surface that renders the ledger.
//
// Before W2b every core.forfeit read "Match forfeited" on the pad's ribbon and its activity rows, and "{name} forfeited
// — Walkover" (an English prettified reason: REASON_KEY had no forfeit reasons) in the event copy, whatever the reason.
// W2b's vocabulary (D3) makes the reason part of the fact — a walkover, a retirement, a disqualification and a
// withdrawal are four different things to the person reading the row — and adds a double walkover (by "both") and an
// expunge abandon (the withdrawal cascade's, D5). Each surface now says each with its own dictionary key.
//
// The kinds are the ENGINE's (`AWARD_REASONS` = `FORFEIT_REASONS` + "bye", plus a double walkover), never a list typed
// here. A bye is written with NO event (stages.ts, fixture-bye.ts, fed-seats.ts) and `CoreForfeit` refuses reason
// "bye", so no ledger surface can meet one today; its line exists because the vocabulary is total over the engine's
// award reasons (controller carry-in 7), not because a row renders it.
//
// Keys are observed through a RECORDING translator — the key the surface actually asked the dictionary for — and read
// back out of all four locales. Zero keys read is a failure.
import { describe, expect, it } from "vitest";
import { AWARD_REASONS, CoreForfeit, FORFEIT_REASONS } from "@seazn/engine/core";
import { describeEvent } from "../event-copy";
import { forfeitCopyKind } from "../forfeit-copy-kind";
import { buildRibbon } from "@/components/v2/scorepad/v3/ribbon";
import type { MessageKey } from "@/lib/messages";
import uiEn from "@/dictionaries/en/ui.json";
import uiEs from "@/dictionaries/es/ui.json";
import uiFr from "@/dictionaries/fr/ui.json";
import uiNl from "@/dictionaries/nl/ui.json";

const LOCALES: Record<string, Record<string, string>> = { en: uiEn, es: uiEs, fr: uiFr, nl: uiNl };
const NAMES = { e1: "Lions U12" };

type Payload = Record<string, unknown>;
/** Every forfeit the vocabulary speaks, keyed by kind, as the payload that records it. */
const KINDS: readonly [string, Payload][] = [
  ...AWARD_REASONS.map((reason): [string, Payload] => [reason, { by: "e1", reason }]),
  ["double_walkover", { by: "both", reason: "walkover" }],
];

/** A translator that records every key asked of it and answers from `locale`'s dictionary. */
function recorder(locale: string) {
  const asked: string[] = [];
  const dict = LOCALES[locale]!;
  const m = (key: MessageKey | string, vars?: Record<string, string | number>) => {
    asked.push(key);
    const raw = dict[key] ?? `«missing ${key}»`;
    return vars ? raw.replace(/\{(\w+)\}/g, (_, v: string) => String(vars[v] ?? `{${v}}`)) : raw;
  };
  return { m, asked };
}

/** The one key a surface asked for under `prefix` (the badge / unknown-person lookups are not the sentence). */
function sentenceKey(asked: readonly string[], prefix: string): string {
  const hits = asked.filter((k) => k.startsWith(prefix));
  expect(hits, `one ${prefix}* key per render, saw ${JSON.stringify(asked)}`).toHaveLength(1);
  return hits[0]!;
}

describe("forfeitCopyKind reads the engine's own payload", () => {
  it("each reason is its own kind, a forfeit by both is a double walkover, and a payload with no known reason has none", () => {
    // The payloads a ledger can actually carry are the ones CoreForfeit admits — parsed here, so a fixture the engine
    // would refuse cannot stand in for a real row. (A bye is the exception, and is named as one above.)
    let parsed = 0;
    for (const [kind, payload] of KINDS) {
      if (kind !== "bye") {
        expect(CoreForfeit.safeParse(payload).success, `${kind}: a payload the engine admits`).toBe(true);
        parsed++;
      }
      expect(forfeitCopyKind(payload), kind).toBe(kind);
    }
    expect(parsed).toBe(FORFEIT_REASONS.length + 1);
    expect(CoreForfeit.safeParse({ by: "e1", reason: "bye" }).success, "a bye is never a core.forfeit").toBe(false);
    // Empty and legacy cases: a pre-D3 row with no reason, or a reason the engine never declared, falls back.
    expect(forfeitCopyKind({})).toBeNull();
    expect(forfeitCopyKind({ by: "e1" })).toBeNull();
    expect(forfeitCopyKind({ by: "e1", reason: "injury" })).toBeNull();
  });
});

describe("every surface says each forfeit with its own key, in all four locales", () => {
  const SURFACES: readonly {
    name: string;
    prefix: string;
    fallback: string;
    render: (type: string, payload: Payload, m: ReturnType<typeof recorder>["m"]) => void;
  }[] = [
    {
      name: "event copy (describeEvent)",
      prefix: "eventCopy.",
      fallback: "eventCopy.forfeited",
      render: (type, payload, m) => void describeEvent(type, payload, NAMES, m),
    },
    {
      name: "pad ribbon and activity rows (buildRibbon)",
      prefix: "pad.ribbon.",
      fallback: "pad.ribbon.core.forfeit",
      render: (type, payload, m) => void buildRibbon(type, payload, () => "", m),
    },
  ];

  for (const surface of SURFACES) {
    it(`${surface.name}: a DISTINCT key per kind, none the reason-free line, each present in en/es/fr/nl`, () => {
      const keys = new Map<string, string>();
      let read = 0;
      for (const [kind, payload] of KINDS) {
        const sentences = new Set<string>();
        for (const locale of Object.keys(LOCALES)) {
          const { m, asked } = recorder(locale);
          surface.render("core.forfeit", payload, m);
          const key = sentenceKey(asked, surface.prefix);
          if (locale === "en") keys.set(kind, key);
          else expect(key, `${kind}: same key in every locale`).toBe(keys.get(kind));
          const text = LOCALES[locale]![key];
          expect(typeof text === "string" && text.length > 0, `${locale}:${key}`).toBe(true);
          sentences.add(text!);
          read++;
        }
        // Translated, not four copies of the English (a key added to en alone and copied across reads as present).
        expect(sentences.size, `${kind}: translated per locale`).toBeGreaterThan(1);
      }
      const distinct = new Set(keys.values());
      expect(distinct.size, `${surface.name}: ${JSON.stringify(Object.fromEntries(keys))}`).toBe(KINDS.length);
      expect([...distinct], "the reason-free line is the legacy fallback, not a kind's").not.toContain(surface.fallback);
      expect(read, `keys read: ${read}`).toBe(KINDS.length * Object.keys(LOCALES).length);
    });

    it(`${surface.name}: a legacy row with no reason keeps the reason-free line (the positive pair of the above)`, () => {
      const { m, asked } = recorder("en");
      surface.render("core.forfeit", { by: "e1" }, m);
      expect(sentenceKey(asked, surface.prefix)).toBe(surface.fallback);
    });

    it(`${surface.name}: an expunge abandon is not a plain abandon — its own key, in all four locales`, () => {
      let read = 0;
      const seen = new Map<string, string>();
      for (const [name, payload] of [
        ["plain", { reason: "rain" }],
        ["expunge", { reason: "withdrew", expunge: true }],
      ] as const) {
        for (const locale of Object.keys(LOCALES)) {
          const { m, asked } = recorder(locale);
          surface.render("core.abandon", payload, m);
          const key = sentenceKey(asked, surface.prefix);
          expect(typeof LOCALES[locale]![key], `${locale}:${key}`).toBe("string");
          seen.set(name, key);
          read++;
        }
      }
      expect(seen.get("expunge")).not.toBe(seen.get("plain"));
      expect(read).toBe(2 * Object.keys(LOCALES).length);
    });
  }

  it("event copy names the side that forfeited, and a double walkover names nobody — no placeholder survives, in every locale", () => {
    let checked = 0;
    for (const [kind, payload] of KINDS) {
      for (const locale of Object.keys(LOCALES)) {
        const { m } = recorder(locale);
        const text = describeEvent("core.forfeit", payload, NAMES, m).text;
        expect(text, `${locale}/${kind}`).not.toMatch(/[{}«]/);
        if (kind === "double_walkover") expect(text, `${locale}/${kind}`).not.toContain(NAMES.e1);
        else expect(text, `${locale}/${kind}`).toContain(NAMES.e1);
        checked++;
      }
    }
    expect(checked).toBe(KINDS.length * Object.keys(LOCALES).length);
  });
});
