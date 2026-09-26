import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  const { createJiti } = await import("jiti");
  return createJiti(import.meta.url).import("./token-audit.ts");
}

const { capDetailRows, filterRowsByRange, isRowInRange, parseRangeBound, totalsForRows, maxValue, sortedEntries } =
  await loadSubject();

function row(overrides = {}) {
  return {
    date: "2026-09-25",
    hour: 14,
    source: "pi",
    channel: "sessions",
    provider: "xiaomi-token-plan-sgp",
    model: "mimo-v2.6-flash",
    input: 10,
    cacheRead: 20,
    cacheWrite: 0,
    output: 5,
    total: 35,
    ...overrides,
  };
}

test("parseRangeBound: empty means unbounded, date-only keeps whole-day semantics", () => {
  assert.equal(parseRangeBound("", "start"), null);
  assert.equal(parseRangeBound("", "end"), null);
  const dayStart = parseRangeBound("2026-09-25", "start");
  const dayEnd = parseRangeBound("2026-09-25", "end");
  assert.ok(dayStart !== null && dayEnd !== null);
  assert.equal(dayEnd - dayStart, 86_400_000 - 1);
  // datetime-local values resolve as local time (no NaN).
  assert.ok(parseRangeBound("2026-09-25T14:30", "start") !== null);
  assert.equal(parseRangeBound("not-a-date", "start"), null);
});

test("hourly buckets intersect the closed range [start, end]", () => {
  const bucket = row({ hour: 14 }); // 14:00–15:00 local
  // 最近1小时：start=14:32 → 本桶(14:00-15:00)命中，上一桶不命中
  assert.equal(isRowInRange(bucket, "2026-09-25T14:32", ""), true);
  assert.equal(isRowInRange(row({ hour: 13 }), "2026-09-25T14:32", ""), false);
  // end 闭区间：end=14:30 → 14:00 桶命中，15:00 桶不命中
  assert.equal(isRowInRange(bucket, "", "2026-09-25T14:30"), true);
  assert.equal(isRowInRange(row({ hour: 15 }), "", "2026-09-25T14:30"), false);
  // 两端都空 = 全部
  assert.equal(isRowInRange(bucket, "", ""), true);
  // 旧 date-only 值：整天语义不变
  assert.equal(isRowInRange(row({ date: "2026-09-24", hour: 23 }), "2026-09-25", ""), false);
  assert.equal(isRowInRange(row({ date: "2026-09-25", hour: 0 }), "", "2026-09-25"), true);
  assert.equal(isRowInRange(row({ date: "2026-09-25", hour: 23 }), "", "2026-09-25"), true);
});

test("filterRowsByRange keeps buckets touching either bound", () => {
  const rows = [
    row({ date: "2026-09-25", hour: 13 }),
    row({ date: "2026-09-25", hour: 14 }),
    row({ date: "2026-09-25", hour: 15 }),
    row({ date: "2026-09-26", hour: 0 }),
  ];
  const filtered = filterRowsByRange(rows, "2026-09-25T14:30", "2026-09-25T15:10");
  assert.deepEqual(
    filtered.map((r) => r.hour),
    [14, 15],
  );
  assert.equal(filterRowsByRange(rows, "", "").length, 4);
  // 空起点：(-∞, end]
  assert.equal(filterRowsByRange(rows, "", "2026-09-25T14:00").length, 2);
});

test("totalsForRows aggregates by source, day, source-day and model", () => {
  const rows = [
    row({ total: 100 }),
    row({ total: 50, date: "2026-09-24" }),
    row({ total: 25, source: "openviking", model: "qwen/qwen3.8-27b", date: "2026-09-25" }),
    row({ total: 5, provider: "commandcode", date: "2026-09-25" }),
  ];
  const totals = totalsForRows(rows);
  assert.equal(totals.all, 180);
  assert.equal(totals.bySource.pi, 155);
  assert.equal(totals.bySource.openviking, 25);
  assert.equal(totals.byDay["2026-09-25"], 130);
  assert.equal(totals.byModel["mimo-v2.6-flash"], 155);
  assert.equal(totals.bySourceDay["pi|2026-09-25"], 105);
  assert.equal(totals.bySourceDay["openviking|2026-09-25"], 25);
});

test("totalsForRows on an empty set stays zeroed", () => {
  const totals = totalsForRows([]);
  assert.equal(totals.all, 0);
  assert.deepEqual(totals.bySource, {});
  assert.deepEqual(totals.byModel, {});
});

test("capDetailRows keeps the newest rows and flags truncation", () => {
  const rows = Array.from({ length: 620 }, (_, i) => row({ total: i }));
  const capped = capDetailRows(rows, 500);
  assert.equal(capped.truncated, true);
  assert.equal(capped.rows.length, 500);
  // 保留的是尾部（最新）500 行，顺序不变
  assert.equal(capped.rows[0].total, 120);
  assert.equal(capped.rows.at(-1).total, 619);
  // 未超上限时原样返回
  const small = capDetailRows(rows.slice(0, 500), 500);
  assert.equal(small.truncated, false);
  assert.equal(small.rows.length, 500);
});

test("maxValue and sortedEntries prepare bar rendering", () => {
  assert.equal(maxValue({ a: 3, b: 9, c: 0 }), 9);
  assert.equal(maxValue({}), 0);
  assert.deepEqual(
    sortedEntries({ a: 1, b: 4, c: 2 }),
    [
      ["b", 4],
      ["c", 2],
      ["a", 1],
    ],
  );
});
