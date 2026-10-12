// The camera notice under the controls (and above Check in): the owner's
// wording (2026-10-11), `onlineChess.camera.playerNotice`. Shown only when
// the division has cameras (policy optional or required).
import type { RoomT } from "./room-copy";

export function CameraNotice({ t }: { t: RoomT }) {
  return (
    <p data-testid="room-camera-notice" className="m-0 text-xs leading-[1.45] text-[#6b5b8a]">
      {t("onlineChess.camera.playerNotice")}
    </p>
  );
}
