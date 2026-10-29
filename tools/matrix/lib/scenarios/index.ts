import { denied } from "./denied.ts";
import { f1OddField } from "./f1-odd-field.ts";
import { lifecycle } from "./lifecycle.ts";
import { m1Walkover } from "./m1-walkover.ts";
import { padProof } from "./pad-proof.ts";
import { r4Withdrawal } from "./r4-withdrawal.ts";
import type { Scenario, ScenarioKey } from "./types.ts";
import { voidProof } from "./void-proof.ts";
import { w2aScenarios } from "./w2a-bracket-finish.ts";
import { w2bScenarios } from "./w2b-forfeit-credit.ts";
import { w2eScenarios } from "./w2e-deciding-paths.ts";

export const SCENARIOS: Readonly<Record<ScenarioKey, Scenario>> = Object.freeze({ LIFECYCLE: lifecycle, M1: m1Walkover, R4: r4Withdrawal, F1: f1OddField, DENIED: denied, PADPROOF: padProof, VOIDPROOF: voidProof, ...w2aScenarios, ...w2bScenarios, ...w2eScenarios });
