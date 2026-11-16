import { openingChase, tap, undo, type ChaseKey, type ChaseState } from "./cricket-chase";

/**
 * The Remote scoring page's demo: a phone scoring with and without signal. A small model of what the Seazn app does
 * (verified on a device 2026-11-16: taps queue on the phone and send themselves, in order, when signal returns), NOT
 * the app's queue. `phone` is what the scorer sees; `server` is what everyone else sees. Pure and immutable.
 */
export type SignalState = {
  phone: ChaseState;
  server: ChaseState;
  signal: boolean;
  /** What is waiting on the phone, oldest first. */
  pending: ("tap" | "undo")[];
  /** How many waiting actions the last return of signal sent; 0 once anything else happens. */
  sent: number;
};

export function openingSignal(): SignalState {
  const phone = openingChase();
  return { phone, server: phone, signal: true, pending: [], sent: 0 };
}

export function signalTap(s: SignalState, key: ChaseKey, ballsPerOver: number): SignalState {
  const phone = tap(s.phone, key, ballsPerOver);
  if (phone === s.phone) return s;
  return s.signal ? { ...s, phone, server: phone, sent: 0 } : { ...s, phone, pending: [...s.pending, "tap"], sent: 0 };
}

export function signalUndo(s: SignalState): SignalState {
  const phone = undo(s.phone);
  if (phone === s.phone) return s;
  if (s.signal) return { ...s, phone, server: phone, sent: 0 };
  // A tap that never left the phone is simply dropped; one everyone already saw needs a correction sent.
  const waitingTap = s.pending[s.pending.length - 1] === "tap";
  return { ...s, phone, pending: waitingTap ? s.pending.slice(0, -1) : [...s.pending, "undo"], sent: 0 };
}

export function setSignal(s: SignalState, on: boolean): SignalState {
  if (on === s.signal) return s;
  return on ? { ...s, signal: true, server: s.phone, sent: s.pending.length, pending: [] } : { ...s, signal: false, sent: 0 };
}
