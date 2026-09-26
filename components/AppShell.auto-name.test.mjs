import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const shellSource = fs.readFileSync(new URL("./AppShell.tsx", import.meta.url), "utf8");
const sidebarSource = fs.readFileSync(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");

test("压缩后的会话仍可根据持久化消息数生成标题", () => {
  // #381: 压缩后当前视图可能一条 user 消息都不剩，判据只能用会话文件里的消息总数。
  assert.match(
    sidebarSource,
    /const titleGenBlocked = !session\.detailsPending && session\.messageCount === 0/,
  );
  // 摘要列表尚未解析 transcript 时不拦截，交由服务端判断。
  assert.match(
    sidebarSource,
    /setTitleGen\(\{ kind: "success" \}\);\s*onRenamed\?\.\(\);/,
  );
});

test("尚未落盘的会话不会触发依赖 JSONL 的自动命名", () => {
  // #455: transient 会话没有 JSONL —— 按钮组不渲染，处理器里再挡一次。
  assert.match(sidebarSource, /\{hovered && !session\.transient && \(/);
  assert.match(
    sidebarSource,
    /if \(session\.transient \|\| titleGenBlocked \|\| titleGen\.kind === "naming"\) return;/,
  );
});

test("生成标题入口挂在会话行，顶栏不再承载它", () => {
  assert.doesNotMatch(shellSource, /auto-name/);
  assert.doesNotMatch(shellSource, /handleAutoName/);
  assert.match(sidebarSource, /onClick=\{handleGenerateTitle\}/);
});

test("会话落盘后会用服务端记录清除临时状态", () => {
  assert.match(shellSource, /\{ \.\.\.prev, \.\.\.full, transient: full\.transient \?\? false \}/);
  assert.match(shellSource, /if \(selectedSession\) hydrateSelectedSession\(selectedSession\.id\)/);
});
