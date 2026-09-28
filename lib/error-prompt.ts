import type { NotificationDto } from "./notifications";
import { buildQuotedSelection } from "./quoted-selection";

export interface ErrorPromptLabels {
  /** e.g. "关于这条错误：" */
  intro: string;
  /** e.g. "我的问题是：" */
  question: string;
  /** Pre-formatted full timestamp of the last occurrence. */
  lastSeen: string;
}

/**
 * Build the prompt for asking about an error: metadata line, id, the quoted
 * full error body, then a question placeholder. The user sees the whole record
 * in the composer and can edit it before sending — what is sent is exactly
 * what was shown.
 */
export function buildErrorPrompt(item: NotificationDto, labels: ErrorPromptLabels): string {
  const meta = [
    `${item.title} · ${item.level} ×${item.count} · ${labels.lastSeen}`,
    `id: ${item.id}`,
  ].join("\n");
  return buildQuotedSelection(item.body, `${labels.intro}\n${meta}`, labels.question);
}
