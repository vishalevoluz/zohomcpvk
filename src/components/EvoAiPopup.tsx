"use client";

import React, { useState, useEffect, useRef } from "react";
import type { McpConfig, McpTool } from "@/types/mcp";
import { executeTool } from "@/lib/zohoMcp";

interface ChatMessage {
  role: "bot" | "user";
  text: string;
  isLoading?: boolean;
}

export interface EvoAiTarget {
  data: Record<string, unknown>;
  name: string;
  type: "module" | "workflow" | "blueprint";
}

interface Props {
  config: McpConfig;
  tools: McpTool[];
  target: EvoAiTarget;
  onClose: () => void;
}

// Matches ZohoCRM_createZiaRecommendation and similar Zoho MCP tool names
const ZIA_PATTERNS = [
  /createzia/i,
  /ziarecommend/i,
  /zia_recommend/i,
  /getzia/i,
  /zia_insight/i,
];
const ZIA_KEYWORDS = ["zia", "recommend", "insight", "suggest", "predict", "ai_recommendation"];

function scoreZiaTool(t: McpTool): number {
  const hay = `${t.name} ${t.description ?? ""}`.toLowerCase();
  // Exact known tool name gets highest priority
  if (t.name === "ZohoCRM_createZiaRecommendation") return 100;
  if (ZIA_PATTERNS.some(p => p.test(t.name))) return 80;
  if (ZIA_PATTERNS.some(p => p.test(hay))) return 60;
  if (ZIA_KEYWORDS.some(kw => hay.includes(kw))) return 40;
  return 0;
}

function findZiaTools(tools: McpTool[]): McpTool[] {
  return tools
    .map(t => ({ t, score: scoreZiaTool(t) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .map(({ t }) => t);
}

// Resolve module api_name from any item type (module/workflow/blueprint row)
function resolveModule(item: Record<string, unknown>): string {
  if (typeof item.api_name === "string" && item.api_name) return item.api_name;
  if (typeof item.module_name === "string" && item.module_name) return item.module_name;
  if (typeof item.module === "string" && item.module) return item.module;
  if (item.module && typeof item.module === "object") {
    const m = item.module as Record<string, unknown>;
    return String(m.api_name ?? m.plural_label ?? m.name ?? "");
  }
  return "";
}

function buildParams(tool: McpTool, item: Record<string, unknown>): Record<string, unknown> {
  const props = tool.inputSchema?.properties ?? {};
  const required: string[] = tool.inputSchema?.required ?? [];
  const params: Record<string, unknown> = {};

  const moduleVal = resolveModule(item);
  const idVal = String(item.id ?? "");
  const nameVal = String(item.name ?? item.workflow_name ?? item.blueprint_name ?? "");

  const allKeys = [...new Set([...required, ...Object.keys(props)])];
  for (const key of allKeys) {
    const lk = key.toLowerCase();
    const propType = props[key]?.type ?? "string";

    if (lk === "recommendations" || (propType === "array" && lk.includes("recommend"))) {
      params[key] = idVal ? [{ id: idVal }] : [];
    } else if (lk.includes("module") || lk === "module_api_name" || lk === "module_name") {
      params[key] = moduleVal;
    } else if (lk === "id" || lk === "record_id" || lk === "entity_id" || lk.endsWith("_id")) {
      params[key] = idVal;
    } else if (lk.includes("name") && !lk.includes("api")) {
      params[key] = nameVal;
    } else if (propType === "array") {
      params[key] = [];
    } else if (propType === "object") {
      params[key] = {};
    }
  }
  return params;
}

function extractText(output: unknown): string {
  if (!output) return "No response received.";
  if (typeof output === "string") return output;
  if (typeof output === "object" && !Array.isArray(output)) {
    const r = output as Record<string, unknown>;
    if (Array.isArray(r.content)) {
      const texts = (r.content as Record<string, unknown>[])
        .filter(c => c.type === "text" && typeof c.text === "string")
        .map(c => String(c.text));
      if (texts.length > 0) return texts.join("\n\n");
    }
    if (typeof r.message === "string") return r.message;
    if (typeof r.result === "string") return r.result;
    if (typeof r.text === "string") return r.text;
  }
  return JSON.stringify(output, null, 2);
}

const TYPE_ICON: Record<EvoAiTarget["type"], string> = {
  module: "⊞",
  workflow: "⟳",
  blueprint: "◈",
};

export default function EvoAiPopup({ config, tools, target, onClose }: Props) {
  const ziaTools = findZiaTools(tools);
  const available = ziaTools.length > 0 ? ziaTools : tools;

  const [selectedTool, setSelectedTool] = useState<McpTool | null>(available[0] ?? null);
  const [params, setParams] = useState<Record<string, unknown>>(() =>
    available[0] ? buildParams(available[0], target.data) : {}
  );
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Close on Escape
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Scroll to bottom on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Auto-call on mount
  useEffect(() => {
    if (!selectedTool) {
      setMessages([{
        role: "bot",
        text: "No Zia tools found.\n\nMake sure your MCP server is connected and the ZohoCRM_createZiaRecommendation scope is authorised.",
      }]);
      return;
    }
    callZia(selectedTool, params, true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reset params when tool changes
  function handleToolChange(toolName: string) {
    const t = available.find(t => t.name === toolName) ?? null;
    setSelectedTool(t);
    if (t) setParams(buildParams(t, target.data));
  }

  async function callZia(tool: McpTool, callParams: Record<string, unknown>, isInitial = false) {
    setLoading(true);
    setMessages(prev => [...prev, { role: "bot", text: "", isLoading: true }]);
    try {
      const output = await executeTool(config, tool.name, callParams);
      const text = extractText(output);
      setMessages(prev => [
        ...prev.slice(0, -1),
        {
          role: "bot",
          text: isInitial
            ? `Zia recommendations for ${target.name} [via ${tool.name}]:\n\n${text}`
            : text,
        },
      ]);
    } catch (e: unknown) {
      const err = e instanceof Error ? e.message : "Tool call failed";
      setMessages(prev => [...prev.slice(0, -1), { role: "bot", text: `⚠ ${err}` }]);
    } finally {
      setLoading(false);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }

  async function handleSend() {
    const q = input.trim();
    if (!q || loading || !selectedTool) return;
    setInput("");
    setMessages(prev => [...prev, { role: "user", text: q }]);

    // Try to find a query/prompt param in the tool schema
    const schemaProps = selectedTool.inputSchema?.properties ?? {};
    const queryKey = Object.keys(schemaProps).find(k =>
      ["query", "question", "prompt", "text", "message", "input", "search"].includes(k.toLowerCase())
    );
    const callParams = { ...params };
    if (queryKey) callParams[queryKey] = q;

    await callZia(selectedTool, callParams);
  }

  const schemaProps = selectedTool?.inputSchema?.properties ?? {};
  const requiredKeys = selectedTool?.inputSchema?.required ?? [];

  return (
    <div className="evoai-overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="evoai-popup">

        {/* Header */}
        <div className="evoai-header">
          <div className="evoai-header-left">
            <span className="evoai-logo">⚡</span>
            <span className="evoai-title">EvoAi</span>
            <span className="evoai-item-badge">
              <span>{TYPE_ICON[target.type]}</span>
              <span>{target.name}</span>
            </span>
            {ziaTools.length === 0 && tools.length > 0 && (
              <span className="evoai-warn-badge" title="Expected: ZohoCRM_createZiaRecommendation">No Zia tools detected — showing all tools</span>
            )}
          </div>
          <button className="evoai-close" onClick={onClose} title="Close (Esc)">✕</button>
        </div>

        {/* Tool selector + param overrides */}
        {available.length > 0 && (
          <div className="evoai-tool-bar">
            <span className="evoai-tool-label">Tool</span>
            <select
              className="evoai-tool-select"
              value={selectedTool?.name ?? ""}
              onChange={e => handleToolChange(e.target.value)}
            >
              {available.map(t => (
                <option key={t.name} value={t.name}>{t.name}</option>
              ))}
            </select>
            {/* Editable string params; complex params (arrays/objects) are auto-built */}
            {requiredKeys.map(key => {
              const propType = schemaProps[key]?.type ?? "string";
              const val = params[key];
              if (propType === "array" || propType === "object" || typeof val === "object") {
                return (
                  <span key={key} className="evoai-param-badge" title={`${key} (auto-built)`}>
                    {key}: auto
                  </span>
                );
              }
              return (
                <input
                  key={key}
                  className="module-input"
                  type="text"
                  value={String(val ?? "")}
                  onChange={e => setParams(p => ({ ...p, [key]: e.target.value }))}
                  placeholder={schemaProps[key]?.description?.slice(0, 24) ?? key}
                  title={schemaProps[key]?.description ?? key}
                  style={{ width: 130 }}
                />
              );
            })}
            <button
              className="btn-secondary"
              onClick={() => selectedTool && callZia(selectedTool, params, true)}
              disabled={loading || !selectedTool}
            >
              {loading ? <span className="spinner" /> : "↺ Run"}
            </button>
          </div>
        )}

        {/* Messages */}
        <div className="evoai-messages">
          {messages.length === 0 && (
            <div className="evoai-empty">
              <span className="evoai-empty-icon">⚡</span>
              <p>Fetching Zia recommendations…</p>
            </div>
          )}
          {messages.map((msg, i) => (
            <div key={i} className={`evoai-msg evoai-msg-${msg.role}`}>
              {msg.role === "bot" && <span className="evoai-avatar">⚡</span>}
              <div className="evoai-bubble">
                {msg.isLoading ? (
                  <span className="evoai-typing"><span /><span /><span /></span>
                ) : (
                  <pre className="evoai-text">{msg.text}</pre>
                )}
              </div>
            </div>
          ))}
          <div ref={bottomRef} />
        </div>

        {/* Input */}
        <div className="evoai-input-bar">
          <input
            ref={inputRef}
            className="evoai-input"
            type="text"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === "Enter" && handleSend()}
            placeholder="Ask a follow-up question…"
            disabled={loading || !selectedTool}
          />
          <button
            className="btn-connect"
            onClick={handleSend}
            disabled={loading || !input.trim() || !selectedTool}
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
