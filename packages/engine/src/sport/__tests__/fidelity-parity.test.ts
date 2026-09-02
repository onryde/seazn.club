// TEMPORARY (W1 Task 1): proves PadSpec.fidelity enumerates every event type the
// legacy fidelityTiers arrays name, per shipped module, so the golden/conformance
// readers can move to padSpec.fidelity without shrinking coverage. Dies in Task 2.
//
// Config source: each module's committed golden corpus (`<key>.golden.json`,
// read via `readCorpus`) carries a `configs: Record<string, unknown>` map, and
// `streams[0].config` is documented as "Key into GoldenCorpus.configs" — i.e. an
// entry that has actually been used to record a real replay for this module.
// A hardcoded `"default"` key does not work here: `generic`'s corpus has no
// `default` entry (its bare `{}` config does not parse — `resultMode` and
// `allowDraws` have no zod defaults) and instead keys its configs `win_loss`,
// `score`, `drawable`, so the config must be read off the corpus itself.
import { describe, expect, it } from "vitest";
import { builtinModules } from "../../sports/index.ts";
import { readCorpus } from "../../testkit/golden.ts";

describe("fidelityTiers → padSpec.fidelity parity (W1 Task 1 precondition)", () => {
  for (const module of builtinModules) {
    it(`${module.key}: padSpec.fidelity ⊇ fidelityTiers event types`, () => {
      const corpus = readCorpus(module.key);
      const rawCfg = corpus.configs[corpus.streams[0]!.config];
      const cfg = module.configSchema.parse(rawCfg);
      const spec = module.padSpec?.(cfg);
      expect(spec, `${module.key} has no padSpec`).toBeDefined();
      const tierTypes = new Set(module.fidelityTiers.flatMap((t) => t.eventTypes));
      const padTypes = new Set(Object.keys(spec!.fidelity));
      const missing = [...tierTypes].filter((t) => !padTypes.has(t));
      expect(missing, `${module.key}: in fidelityTiers but not in padSpec.fidelity`).toEqual([]);
    });
  }
});
