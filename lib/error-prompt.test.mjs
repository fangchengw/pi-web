import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

// jiti 解析 error-prompt.ts 里无扩展名的相对导入（./quoted-selection），
// 与应用打包器行为一致。
async function loadSubject() {
  return createJiti(import.meta.url).import("./error-prompt.ts");
}

const ITEM = {
  id: "watchdog:OV server.log/Query扩展失败:1790558783",
  namespace: "watchdog",
  source: "OV server.log/Query扩展失败",
  origin: "OV server.log",
  kind: "Query扩展失败",
  level: "error",
  title: "OV server.log · Query扩展失败",
  body: "2026-09-27 18:26:23 Query expansion failed; using original query:\nsecond line of the error",
  createdAt: 1790558783000,
  updatedAt: 1790558783000,
  count: 33,
  dismissed: false,
  alertOff: false,
};

test("prompt carries metadata, id, quoted body and question placeholder", async () => {
  const { buildErrorPrompt } = await loadSubject();
  const prompt = buildErrorPrompt(ITEM, {
    intro: "关于这条错误：",
    question: "我的问题是：",
    lastSeen: "2026-09-27 18:26:23",
  });

  assert.ok(prompt.startsWith("关于这条错误：\n"));
  assert.ok(prompt.includes("OV server.log · Query扩展失败 · error ×33 · 2026-09-27 18:26:23"));
  assert.ok(prompt.includes(`id: ${ITEM.id}`));
  assert.ok(prompt.includes("> 2026-09-27 18:26:23 Query expansion failed"));
  assert.ok(prompt.includes("> second line of the error"));
  assert.ok(prompt.endsWith("我的问题是："));
  // 完整正文进入提示 —— 没有任何隐藏/截断。
  assert.ok(prompt.includes(ITEM.body.split("\n")[1]));
});

test("contains no hidden marker — everything is plain visible markdown", async () => {
  const { buildErrorPrompt } = await loadSubject();
  const prompt = buildErrorPrompt(ITEM, { intro: "i:", question: "q:", lastSeen: "t" });
  assert.doesNotMatch(prompt, /<!--|pi-error-context|<pi-/);
});
