// W2a ruling D-R8: `SETTLE_NOT_APPLICABLE` has emitters that mean different things. The kernel's own precondition (the
// match is not level, or is already settled) and the not-a-bracket refusal keep the code's copy. A settle or a decider
// naming a WITHDRAWN winner (rulings C17, D-R7; `server/engine-db/append-event.ts`) is a different refusal, and the
// code's copy ("it isn't level, or it's already settled") is false for it. Its reason rides
// `EngineError.data.reason`; `server/api-v1/http.ts` forwards it on the wire, the pad's transport carries it, and the
// copy branches on it (`lib/scoring-vocab.ts` `ENGINE_ERROR_REASON_KEY`). No `server-only`: the pad and the console
// read it too.
export const SETTLE_REFUSAL_REASON = {
  /** The named winner has withdrawn — the settle or the decider goes to the remaining entrant. */
  withdrawn: "withdrawn",
} as const;
export type SettleRefusalReason = (typeof SETTLE_REFUSAL_REASON)[keyof typeof SETTLE_REFUSAL_REASON];
const REASONS: ReadonlySet<string> = new Set(Object.values(SETTLE_REFUSAL_REASON));
export const isSettleRefusalReason = (x: unknown): x is SettleRefusalReason => typeof x === "string" && REASONS.has(x);
