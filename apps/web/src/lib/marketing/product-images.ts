/**
 * The product pages' picture ledger. Every entry is a real product screen: phone captures from the Seazn app (9:16,
 * status bar cropped) and web captures at 2x. Sizes are the files' own (parts.test.tsx re-measures them), so an image
 * never shifts the layout while it loads.
 */
export type ProductImage = { src: string; width: number; height: number; kind: "phone" | "web" };

export const PRODUCT_IMAGES = {
  hubM: { src: "/marketing/product/hub-m.png", width: 780, height: 1387, kind: "phone" },
  hubD: { src: "/marketing/product/hub-d.png", width: 1400, height: 811, kind: "web" },
  mcM: { src: "/marketing/product/mc-m.png", width: 780, height: 1387, kind: "phone" },
  mcD: { src: "/marketing/product/mc-d.png", width: 1400, height: 839, kind: "web" },
  destM: { src: "/marketing/product/dest-m.png", width: 780, height: 1387, kind: "phone" },
  panelM: { src: "/marketing/product/panel-m.png", width: 780, height: 1387, kind: "phone" },
  remotePanelM: { src: "/marketing/product/remote-panel-m.png", width: 780, height: 1326, kind: "phone" },
  formatWizardM: { src: "/marketing/product/format-wizard-m.png", width: 780, height: 1386, kind: "phone" },
  formatDrawM: { src: "/marketing/product/format-draw-m.png", width: 780, height: 1386, kind: "phone" },
  schedTrayM: { src: "/marketing/product/sched-tray-m.png", width: 780, height: 1386, kind: "phone" },
  schedRepairM: { src: "/marketing/product/sched-repair-m.png", width: 780, height: 1386, kind: "phone" },
  appPad2: { src: "/marketing/product/app-pad2.png", width: 720, height: 1280, kind: "phone" },
  appOut: { src: "/marketing/product/app-out.png", width: 720, height: 1280, kind: "phone" },
  appWide: { src: "/marketing/product/app-wide.png", width: 720, height: 1280, kind: "phone" },
  appMore: { src: "/marketing/product/app-more.png", width: 720, height: 1280, kind: "phone" },
  appOffline: { src: "/marketing/product/app-offline.png", width: 720, height: 1280, kind: "phone" },
  appOfflineHistory: { src: "/marketing/product/app-offline-history.png", width: 720, height: 1280, kind: "phone" },
  appStreamArmed: { src: "/marketing/product/app-stream-armed.png", width: 2230, height: 970, kind: "web" },
  appStreamSettings: { src: "/marketing/product/app-stream-settings.png", width: 2230, height: 940, kind: "web" },
} as const satisfies Record<string, ProductImage>;

export type ProductImageKey = keyof typeof PRODUCT_IMAGES;
