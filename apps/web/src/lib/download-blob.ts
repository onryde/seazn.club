// Save a fetched file in the browser. The console fetches its downloads
// (rather than linking to them) so a refusal stays on the page as localised
// copy instead of navigating to a JSON body — which means the file then has to
// be handed to the browser by hand. One routine for every such download: the
// documents menu and the scorer-sheets print control.

export interface DownloadEnv {
  createElement: () => HTMLAnchorElement;
  append: (a: HTMLAnchorElement) => void;
  createObjectURL: (b: Blob) => string;
  revokeObjectURL: (u: string) => void;
}

// Injected, because vitest here has no DOM to click an anchor in.
const browserEnv = (): DownloadEnv => ({
  createElement: () => document.createElement("a"),
  append: (a) => document.body.append(a),
  createObjectURL: (b) => URL.createObjectURL(b),
  revokeObjectURL: (u) => URL.revokeObjectURL(u),
});

/** Save `blob` as `filename`: an attached anchor with `download`, clicked
 *  once, removed, then the object URL released. */
export function downloadBlob(blob: Blob, filename: string, env: DownloadEnv = browserEnv()): void {
  const url = env.createObjectURL(blob);
  const a = env.createElement();
  a.href = url;
  a.download = filename;
  env.append(a);
  a.click();
  a.remove();
  env.revokeObjectURL(url);
}
