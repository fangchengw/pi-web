import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function load() {
  const modal = await readFile(new URL("./ErrorDetailsModal.tsx", import.meta.url), "utf8");
  const shell = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
  const chat = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
  const session = await readFile(new URL("../hooks/useAgentSession.ts", import.meta.url), "utf8");
  return { modal, shell, chat, session };
}

test("expanded error rows carry fixed ask buttons next to Copy", async () => {
  const { modal } = await load();

  assert.match(modal, /data-testid="error-details-ask-here"/);
  assert.match(modal, /data-testid="error-details-ask-new-chat"/);
  assert.match(modal, /data-testid="error-details-item-copy"/);
  // 固定按钮:不是选中触发、不弹浮窗。
  assert.doesNotMatch(modal, /createPortal/);
  assert.doesNotMatch(modal, /captureAskSelection/);
  assert.doesNotMatch(modal, /onPointerUp/);
  assert.doesNotMatch(modal, /window\.getSelection/);
  // 错误(无输入框/无工作目录)就地显示在按钮行内。
  assert.match(modal, /askError\?\.itemId === item\.id/);
});

test("the copied prompt is plain visible markdown built by buildErrorPrompt", async () => {
  const { modal, shell, session } = await load();

  assert.match(modal, /import \{ buildErrorPrompt \} from "@\/lib\/error-prompt"/);
  assert.match(modal, /buildErrorPrompt\(item, \{/);
  assert.match(modal, /intro: t\("errorDetails\.quoteIntro"\)/);
  assert.match(modal, /question: t\("chat\.quoteQuestion"\)/);
  assert.match(modal, /lastSeen: formatFullTimestamp\(item\.updatedAt, locale\)/);
  // 无隐藏上下文机制:AppShell 不武装、发送链路不注入。
  assert.doesNotMatch(shell, /PromptContext|DebugContext|PROMPT_CONTEXT/);
  assert.doesNotMatch(session, /DebugContext|appendErrorContext/);
  assert.match(shell, /input\.insertText\(prompt\)/);
});

test("new-chat flow pastes the prompt into the fresh draft composer, nothing auto-sends", async () => {
  const { shell, chat } = await load();

  assert.match(shell, /setPendingComposerText\(prompt\)/);
  assert.match(shell, /initialComposerText=\{pendingComposerText \?\? undefined\}/);
  assert.match(chat, /initialComposerText\?: string;/);
  assert.match(chat, /input\.insertText\(initialComposerText\)/);
  assert.match(chat, /onInitialComposerTextConsumed\?\.\(\)/);
  // 草稿输入框就绪前不粘贴(loading/error 守卫),粘贴不自动发送。
  assert.match(chat, /if \(loading \|\| error \|\| composerTextPastedRef\.current\) return;/);
  assert.doesNotMatch(chat, /handleSend\(initialComposerText/);
});
