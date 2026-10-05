import { denied } from "./denied.ts";
import { f1OddField } from "./f1-odd-field.ts";
import { lifecycle } from "./lifecycle.ts";
import { m1Walkover } from "./m1-walkover.ts";
import { padProof } from "./pad-proof.ts";
import { r4Withdrawal } from "./r4-withdrawal.ts";
import type { Scenario, ScenarioKey } from "./types.ts";
import { voidProof } from "./void-proof.ts";

export const SCENARIOS: Readonly<Record<ScenarioKey, Scenario>> = Object.freeze({ LIFECYCLE: lifecycle, M1: m1Walkover, R4: r4Withdrawal, F1: f1OddField, DENIED: denied, PADPROOF: padProof, VOIDPROOF: voidProof });
