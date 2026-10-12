// The ONE import site for Cloudflare RealtimeKit's browser SDK (Apache-2.0),
// loaded on demand so a room with camera policy `off` — and every page that
// is not a room — never downloads it.
//
// What the player's browser does with it, and nothing more (design §5): join
// the fixture's meeting with the caller's OWN participant token, audio off,
// and publish their camera. Nothing here reads, renders or subscribes to any
// other participant — players never see each other (D7); the server's preset
// is what enforces that, and this module never asks.
export type OwnCamera = {
  /** The local camera track while publishing, else null. */
  track(): MediaStreamTrack | null;
  /** Called on every change of the published camera (enabled + track). */
  onChange(cb: (enabled: boolean, track: MediaStreamTrack | null) => void): () => void;
  /** Turn the camera back on after it was turned off or dropped. */
  enable(): Promise<void>;
  leave(): Promise<void>;
};

export type JoinOwnCamera = (authToken: string) => Promise<OwnCamera>;

export const joinOwnCamera: JoinOwnCamera = async (authToken) => {
  const { default: RealtimeKitClient } = await import("@cloudflare/realtimekit");
  const meeting = await RealtimeKitClient.init({ authToken, defaults: { audio: false, video: true } });
  await meeting.join();
  const self = meeting.self;
  const current = () => (self.videoEnabled && self.videoTrack ? self.videoTrack : null);
  return {
    track: current,
    onChange(cb) {
      let live = true;
      const handler = (p: { videoEnabled: boolean; videoTrack: MediaStreamTrack }) => {
        if (live) cb(p.videoEnabled, p.videoEnabled ? p.videoTrack : null);
      };
      self.on("videoUpdate", handler);
      return () => {
        live = false;
        self.removeListener("videoUpdate", handler);
      };
    },
    async enable() {
      await self.enableVideo();
    },
    async leave() {
      await meeting.leave();
    },
  };
};
