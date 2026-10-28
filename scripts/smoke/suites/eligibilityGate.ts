import { eligibilityGateOnPlanSuite } from "./eligibilityGateOnPlan.ts";

export async function eligibilityGateSuite(): Promise<void> {
  await eligibilityGateOnPlanSuite("pro");
  await eligibilityGateOnPlanSuite("community");
}
