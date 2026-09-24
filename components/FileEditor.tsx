"use client";

import { useCallback, useEffect, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { EditorView } from "@codemirror/view";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { yaml } from "@codemirror/lang-yaml";
import type { Extension } from "@codemirror/state";
import { getFileName } from "@/lib/file-paths";
import { useI18n } from "@/hooks/useI18n";
import { useTheme } from "@/hooks/useTheme";

interface Props {
  filePath: string;
  readUrl: string;
  saveUrl: string;
  language: string;
  onSaved: () => void;
  onCancel: () => void;
}

function languageExtension(language: string): Extension | null {
  switch (language) {
    case "json":
      return json();
    case "markdown":
      return markdown();
    case "typescript":
      return javascript({ typescript: true });
    case "javascript":
      return javascript();
    case "python":
      return python();
    case "html":
      return html();
    case "css":
      return css();
    case "yaml":
      return yaml();
    default:
      return null;
  }
}

/**
 * Full-file editor shown in place of the read-only source view. The content
 * comes from the `full=1` read endpoint and is saved back with a PUT; the
 * surrounding viewer refreshes itself from the file watcher after onSaved.
 */
export function FileEditor({ filePath, readUrl, saveUrl, language, onSaved, onCancel }: Props) {
  const { t } = useI18n();
  const { isDark } = useTheme();
  const [content, setContent] = useState<string | null>(null);
  const [original, setOriginal] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    setContent(null);
    setLoadError(null);
    fetch(readUrl)
      .then((response) => response.json())
      .then((data: { content?: string; error?: string }) => {
        if (!active) return;
        if (typeof data.content !== "string") {
          setLoadError(data.error ?? "Failed to load file");
          return;
        }
        setContent(data.content);
        setOriginal(data.content);
      })
      .catch((error) => {
        if (active) setLoadError(String(error));
      });
    return () => {
      active = false;
    };
  }, [readUrl]);

  const dirty = content !== null && content !== original;

  const save = useCallback(() => {
    if (saving || content === null) return;
    setSaving(true);
    setSaveError(null);
    fetch(saveUrl, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content }),
    })
      .then(async (response) => {
        const data = (await response.json().catch(() => null)) as { error?: string } | null;
        if (!response.ok || data?.error) {
          setSaveError(data?.error ?? `Save failed (HTTP ${response.status})`);
          setSaving(false);
          return;
        }
        setOriginal(content);
        setSaving(false);
        onSaved();
      })
      .catch((error) => {
        setSaveError(String(error));
        setSaving(false);
      });
  }, [content, onSaved, saveUrl, saving]);

  const cancel = useCallback(() => {
    if (dirty && !window.confirm(t("files.discardChanges"))) return;
    onCancel();
  }, [dirty, onCancel, t]);

  const extensions = useMemo(() => {
    const list: Extension[] = [EditorView.lineWrapping];
    const languageExtensionResult = languageExtension(language);
    if (languageExtensionResult) list.push(languageExtensionResult);
    return list;
  }, [language]);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      save();
    } else if (event.key === "Escape") {
      event.preventDefault();
      cancel();
    }
  };

  return (
    <div
      className="file-editor"
      data-testid="file-editor"
      onKeyDown={handleKeyDown}
      style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, background: "var(--bg)" }}
    >
      <div
        className="file-editor-bar"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "5px 12px",
          borderBottom: "1px solid var(--border)",
          fontSize: 11,
          color: "var(--text-dim)",
          background: "var(--bg-panel)",
          flexShrink: 0,
        }}
      >
        <span
          style={{ fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "40%" }}
          title={filePath}
        >
          {getFileName(filePath)}
        </span>
        {dirty && (
          <span data-testid="file-editor-dirty" style={{ color: "#fbbf24", flexShrink: 0 }}>
            &#9679; {t("files.unsavedChanges")}
          </span>
        )}
        <span style={{ flex: 1 }} />
        {saveError && (
          <span data-testid="file-editor-error" style={{ color: "#f87171", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "45%" }} title={saveError}>
            {saveError}
          </span>
        )}
        <button
          type="button"
          className="file-viewer-mode-button"
          onClick={cancel}
          disabled={saving}
        >
          {t("files.cancel")}
        </button>
        <button
          type="button"
          className="file-viewer-mode-button"
          data-testid="file-editor-save"
          onClick={save}
          disabled={saving || content === null || !dirty}
          style={{
            background: dirty && !saving ? "var(--bg-selected)" : "transparent",
            color: dirty && !saving ? "var(--text)" : "var(--text-muted)",
          }}
        >
          {saving ? t("files.saving") : t("files.save")}
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
        {loadError ? (
          <div data-testid="file-editor-load-error" style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "#f87171", fontSize: 13 }}>
            {loadError}
          </div>
        ) : content === null ? (
          <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: 13 }}>
            {t("i18n.loading")}
          </div>
        ) : (
          <CodeMirror
            value={content}
            height="100%"
            theme={isDark ? "dark" : "light"}
            extensions={extensions}
            onChange={setContent}
            style={{ height: "100%" }}
          />
        )}
      </div>
    </div>
  );
}
