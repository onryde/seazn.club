import type { MessageKey } from "@/lib/messages";

/**
 * A fixture status in the viewer's words (`score.status.<status>`); a status with no key falls back to the raw token
 * with its underscore spaced. The one reader of that family — the console, the device pad and the official's lane each
 * kept their own copy until W2a Task 13 found the lane printing the raw token ("needs_decision") instead.
 */
export function scoreStatusLabel(msg: (key: MessageKey) => string, status: string): string {
  const key = `score.status.${status}` as MessageKey;
  const label = msg(key);
  return label === key ? status.replace("_", " ") : label;
}
