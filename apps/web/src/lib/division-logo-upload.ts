// The two browser-side steps of a division logo upload (`uploadLogo` in components/v2/division-settings.tsx), pulled out so
// they can be driven without a DOM and so the three failures they own are said in the organiser's language.
//
// Each failure throws a bare `Error` whose message is already the localised sentence. That is deliberate: `run()` shows a
// thrown Error through `settingsSaveErrorText`, which keeps the message of every Error that is not a fetch rejection
// (`isUnreachable`), so these read as themselves. A request that really never leaves - the PUT's own `fetch` rejecting with
// its TypeError - is NOT caught here and still says "couldn't reach Seazn".
import type { MessageKey } from "@/lib/messages";

type Msg = (key: MessageKey) => string;

/** Reads `file`, decodes it, and re-encodes it as a WebP no longer than `max` px on its long side (never upscaled). */
export async function fileToWebp(file: File, max: number, msg: Msg): Promise<Blob> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    // The browser's own message here is English ("The object can not be found here."); to the organiser it is one thing:
    // the file they picked is not usable.
    reader.onerror = () => reject(new Error(msg("divset.logo.badImage")));
    reader.readAsDataURL(file);
  });
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error(msg("divset.logo.badImage")));
    el.src = dataUrl;
  });
  const scale = Math.min(1, max / Math.max(img.width, img.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(img.width * scale));
  canvas.height = Math.max(1, Math.round(img.height * scale));
  canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", 0.88));
  if (!blob) throw new Error(msg("divset.logo.convertFailed"));
  return blob;
}

/** PUTs the converted logo to the signed storage URL. A refusal (any non-2xx) says so; a request that never leaves rejects
 *  with fetch's own TypeError and is left to say "couldn't reach Seazn". */
export async function putLogo(uploadUrl: string, blob: Blob, msg: Msg): Promise<void> {
  const put = await fetch(uploadUrl, { method: "PUT", headers: { "Content-Type": "image/webp" }, body: blob });
  if (!put.ok) throw new Error(msg("divset.logo.uploadFailed"));
}
