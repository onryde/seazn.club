// The player's own camera as a small state machine, free of React so its
// transitions are testable in node (camera-session.test.ts). `use-own-camera`
// is the hook over it; `camera-loader` is the real RealtimeKit join, injected.
//
//   idle → joining → live ⇄ off      (the camera dropped or was turned off)
//            └──→ failed             (no permission, no device, no meeting)
// A second start while joining or joined is a no-op; nothing starts after
// stop, and a join that lands after stop is left at once.
import type { JoinOwnCamera, OwnCamera } from "./camera-loader";

export type CameraStatus = "idle" | "joining" | "live" | "off" | "failed";
export type CameraView = { status: CameraStatus; track: MediaStreamTrack | null };

export function cameraSession(join: JoinOwnCamera, emit: (v: CameraView) => void) {
  let cam: OwnCamera | null = null;
  let unsubscribe: (() => void) | null = null;
  let busy = false;
  let stopped = false;
  return {
    async start(authToken: string): Promise<void> {
      if (stopped || busy || cam !== null) return;
      busy = true;
      emit({ status: "joining", track: null });
      try {
        const joined = await join(authToken);
        if (stopped) {
          await joined.leave().catch(() => undefined);
          return;
        }
        cam = joined;
        unsubscribe = joined.onChange((enabled, track) => {
          if (!stopped) emit({ status: enabled && track ? "live" : "off", track: enabled ? track : null });
        });
        const track = joined.track();
        emit({ status: track ? "live" : "off", track });
      } catch {
        if (!stopped) emit({ status: "failed", track: null });
      } finally {
        busy = false;
      }
    },
    /** "Turn camera on" (card 9). The change arrives through onChange. */
    async enable(): Promise<void> {
      if (stopped || cam === null) return;
      try {
        await cam.enable();
      } catch {
        if (!stopped) emit({ status: "failed", track: null });
      }
    },
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      unsubscribe?.();
      const c = cam;
      cam = null;
      await c?.leave().catch(() => undefined);
    },
  };
}
