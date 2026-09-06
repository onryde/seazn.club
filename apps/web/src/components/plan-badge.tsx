// Tiny plan pill shown on any gated button/panel so users see the required
// tier before they click (doc 10 §3). Server- and client-safe (no hooks).
import { featurePlan, type PaidPlan } from "@/lib/feature-copy";

// Entitlements v18: `pro_plus` retired (V393); the above-Pro badge now reads
// "Enterprise" for the Contact-us conversation (design §4). Both are
// `Record<PaidPlan, …>`, so a third `PaidPlan` member with no style/label
// here is a compile error rather than a silently blank pill.
const STYLE: Record<PaidPlan, string> = {
  pro: "bg-purple-100 text-purple-700",
  enterprise: "bg-indigo-100 text-indigo-700",
};

const LABEL: Record<PaidPlan, string> = {
  pro: "Pro ✦",
  enterprise: "Enterprise ◆",
};

export function PlanBadge({ plan, feature }: { plan?: PaidPlan; feature?: string }) {
  const p = plan ?? featurePlan(feature ?? "");
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${STYLE[p]}`}
    >
      {LABEL[p]}
    </span>
  );
}
