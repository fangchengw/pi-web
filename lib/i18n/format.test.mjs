import assert from "node:assert/strict";
import test from "node:test";

import { formatFullTimestamp, formatRelativeTime, formatUpdatedTime, interpolateMessage, translateMessage } from "./format.ts";

test("interpolates string and numeric parameters", () => {
  assert.equal(interpolateMessage("Hello, {name} ({count})", { name: "Pi", count: 2 }), "Hello, Pi (2)");
});

test("falls back to English and returns the key when both are missing", () => {
  assert.equal(translateMessage("zh-CN", "common.ok", { en: { "common.ok": "OK" }, "zh-CN": {} }), "OK");
  assert.equal(translateMessage("zh-CN", "missing.key", { en: {}, "zh-CN": {} }), "missing.key");
});

test("formats relative time using the selected locale", () => {
  const now = new Date("2026-01-01T00:00:00.000Z");
  assert.equal(formatRelativeTime(new Date("2026-01-01T00:05:00.000Z"), "en", now), "in 5 minutes");
  assert.equal(formatRelativeTime(new Date("2025-12-31T23:00:00.000Z"), "zh-CN", now), "1小时前");
  assert.equal(formatRelativeTime(new Date("2025-12-31T23:00:00.000Z"), "zh-TW", now), "1 小時前");
});

test("shows absolute 24-hour times — 今天/昨天/更早格式统一 (2026-09-27)", () => {
  const now = new Date(2026, 8, 22, 21, 18, 0);
  const today = new Date(2026, 8, 22, 9, 5, 0);
  const yesterday = new Date(2026, 8, 21, 22, 3, 0);
  const earlier = new Date(2026, 8, 19, 21, 18, 0);
  assert.equal(
    formatUpdatedTime(today.getTime(), "zh-CN", now),
    today.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }),
  );
  // en locale 默认 12 小时制，用户偏好要求固定 24 小时制。
  assert.equal(formatUpdatedTime(today.getTime(), "en", now), "09:05");
  assert.doesNotMatch(formatUpdatedTime(new Date(2026, 8, 22, 21, 5, 0).getTime(), "en", now), /AM|PM/);
  // 昨天：语言化的“昨天” + 时刻，不再是“23小时前”。
  assert.equal(formatUpdatedTime(yesterday.getTime(), "zh-CN", now), "昨天 22:03");
  assert.equal(formatUpdatedTime(yesterday.getTime(), "zh-TW", now), "昨天 22:03");
  assert.equal(formatUpdatedTime(yesterday.getTime(), "en", now), "Yesterday 22:03");
  // 更早：绝对日期 + 时刻，同一列表里不再混用相对时间。
  assert.equal(formatUpdatedTime(earlier.getTime(), "zh-CN", now), "9/19 21:18");
  assert.equal(formatUpdatedTime(earlier.getTime(), "en", now), "9/19 21:18");
  assert.equal(formatUpdatedTime(earlier.getTime(), "zh-TW", now), "9/19 21:18");
  assert.doesNotMatch(formatUpdatedTime(earlier.getTime(), "en", now), /ago/);
});

test("renders full timestamps in 24-hour time for tooltips", () => {
  const afternoon = new Date(2026, 8, 22, 21, 5, 30).getTime();
  const text = formatFullTimestamp(afternoon, "en");
  assert.match(text, /21:05:30/);
  assert.doesNotMatch(text, /AM|PM/);
  assert.equal(formatFullTimestamp(NaN, "en"), "");
});
