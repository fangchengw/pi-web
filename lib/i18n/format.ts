import type { Locale, TranslationParams } from "./types";

type MessagesByLocale = Record<string, Record<string, string>>;

/**
 * 替换翻译消息中的简单插值占位符。
 * @param message 原始翻译消息
 * @param params 插值参数
 * @returns 完成参数替换后的消息
 */
export function interpolateMessage(message: string, params: TranslationParams = {}): string {
  return message.replace(/\{([\w.-]+)\}/g, (token, name: string) => {
    const value = params[name];
    return value === undefined ? token : String(value);
  });
}

/**
 * 从当前语言和英语语言包中解析消息。
 * @param locale 当前语言
 * @param key 翻译 key
 * @param messages 各语言的消息字典
 * @param params 可选的插值参数
 * @returns 翻译结果，缺失时返回 key
 */
export function translateMessage(
  locale: Locale,
  key: string,
  messages: MessagesByLocale,
  params: TranslationParams = {},
): string {
  const message = messages[locale]?.[key] ?? messages.en?.[key];
  if (message === undefined) {
    if (process.env.NODE_ENV !== "production") console.warn(`[i18n] Missing translation: ${key}`);
    return key;
  }
  return interpolateMessage(message, params);
}

/**
 * 按当前语言格式化相对时间。
 * @param date 要格式化的时间
 * @param locale 当前语言
 * @param now 用于测试或特殊场景的当前时间
 * @returns locale-aware 的相对时间文本
 */
export function formatRelativeTime(date: Date | string, locale: Locale, now = new Date()): string {
  const target = date instanceof Date ? date : new Date(date);
  const diffMs = target.getTime() - now.getTime();
  const absMs = Math.abs(diffMs);
  const [unit, divisor] = absMs < 60_000
    ? ["second", 1_000]
    : absMs < 3_600_000
      ? ["minute", 60_000]
      : absMs < 86_400_000
        ? ["hour", 3_600_000]
        : ["day", 86_400_000];
  const value = Math.round(diffMs / divisor);
  return new Intl.RelativeTimeFormat(locale, { numeric: "always" }).format(value, unit as Intl.RelativeTimeFormatUnit);
}

/**
 * 统一的绝对时间（24 小时制），列表里不再混用「00:57」和「21 小时前」：
 * 今天 → `00:57`；昨天 → `昨天 22:03`（en: `Yesterday 22:03`）；
 * 更早 → `9/25 22:03`。完整日期时间放 tooltip（{@link formatFullTimestamp}）。
 * @param timestamp 毫秒时间戳
 * @param locale 当前语言
 * @param now 用于测试或特殊场景的当前时间
 * @returns 绝对日期时间文本（今天的只有时刻）
 */
export function formatUpdatedTime(timestamp: number, locale: Locale, now = new Date()): string {
  const target = new Date(timestamp);
  if (Number.isNaN(target.getTime())) return "";
  // 用户偏好 24 小时制：locale 默认可能是 12 小时制（如 en），这里显式固定。
  const clock = target.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  // 用「日历日之差」而不是 24h 取整，避免夏令时那天算错一天。
  const dayDiff = Math.round((startOfDay(now) - startOfDay(target)) / 86_400_000);
  if (dayDiff <= 0) return clock;
  if (dayDiff === 1) {
    const label = new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(-1, "day");
    return `${label.charAt(0).toUpperCase()}${label.slice(1)} ${clock}`;
  }
  return `${target.toLocaleDateString(locale, { month: "numeric", day: "numeric" })} ${clock}`;
}

/**
 * 带日期的完整时间戳（24 小时制），用于 title/tooltip。
 * @param timestamp 毫秒时间戳
 * @param locale 当前语言
 * @returns locale-aware 的日期时间文本；非法时间戳返回空串
 */
export function formatFullTimestamp(timestamp: number, locale: Locale): string {
  const target = new Date(timestamp);
  if (Number.isNaN(target.getTime())) return "";
  return target.toLocaleString(locale, { hourCycle: "h23" });
}
