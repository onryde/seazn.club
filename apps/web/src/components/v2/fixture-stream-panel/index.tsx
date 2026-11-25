"use client";

// The organiser's stream panel, one module per concern (Task 34s: a verbatim split of the former single file). This barrel
// re-exports that file's exact public surface, so importers keep `@/components/v2/fixture-stream-panel`. Read the ONE
// module you need:
//   panel.tsx           FixtureStreamPanel, the shell: the Phone | OBS overlay switch, the OBS tab (score style picker,
//                       overlay URL, stream link), the stored score preferences it hands down, the checkout return (G5, B2).
//   phone-tab.tsx       PhoneTab, the Phone tab's container: the destination list and pick, the stream-phone read model's
//                       poll, the stream code (ask, reissue, QR encode and its Retry), Go live (channel safety), the auto
//                       switch's save, the takeover dismissal. Also codeIsNewer and youtubeRefusalIsStale.
//   phone-tab-body.tsx  PhoneTabBody and its props: every Phone tab state drawn from props. Ready (destination picker, code
//                       card and its disclosure, court line, score card, Go live, YouTube refusal), waiting, live (Details,
//                       health chips), ended (Seazn replays, replay rows) and failed.
//   credits.tsx         The match-credit purchase: useCreditCheckout, the lazy checkout sheet and CheckoutSheetBoundary,
//                       StreamCredits and StreamCreditsBody (flag off), the chooser tiles, the balance and Buy more parts.
//   stop-probe.tsx      PhoneStopProbe: a running session's Stop or Cancel alone (G2, F1).
//   shared.tsx          Render helpers two modules share: the state pill, the stop error, the switched-off line.
//   types.ts            The page's context types (StreamPanelContext, StreamPanelFixture, StreamCreditSplit) and the Phone
//                       tab's shared shapes (CodeCard, TargetsState, PhoneScore, CreateError, CheckoutError).
export { FixtureStreamPanel } from "./panel";
export { PhoneTab, codeIsNewer, youtubeRefusalIsStale } from "./phone-tab";
export { PhoneTabBody, type PhoneTabBodyProps } from "./phone-tab-body";
export { CheckoutSheetBoundary, StreamCredits, StreamCreditsBody, type StreamCreditsBodyProps } from "./credits";
export { PhoneStopProbe } from "./stop-probe";
export type { CodeCard, PhoneScore, StreamCreditSplit, StreamPanelContext, StreamPanelFixture, TargetsState } from "./types";
