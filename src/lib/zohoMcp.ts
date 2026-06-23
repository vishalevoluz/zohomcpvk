import type { McpConfig, McpTool, McpResponse } from "@/types/mcp";

const TIMEOUT_MS = 15_000;

function buildHeaders(config: McpConfig): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.authToken) {
    headers["Authorization"] = config.authToken.startsWith("Bearer ")
      ? config.authToken
      : `Bearer ${config.authToken}`;
  }
  if (config.apiKey) {
    headers["X-API-Key"] = config.apiKey;
  }
  return headers;
}

async function mcpRequest<T>(
  config: McpConfig,
  method: string,
  params: Record<string, unknown> = {}
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch("/api/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: config.url,
        headers: buildHeaders(config),
        body: { jsonrpc: "2.0", id: Date.now(), method, params },
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
    }

    const data: McpResponse<T> = await res.json();
    if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
    if (data.result === undefined) throw new Error("Empty response from MCP server");

    return data.result;
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error("Request timed out — MCP server did not respond within 15s");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function listTools(config: McpConfig): Promise<McpTool[]> {
  const result = await mcpRequest<{ tools: McpTool[] }>(config, "tools/list");
  return result.tools ?? [];
}

export async function executeTool(
  config: McpConfig,
  toolName: string,
  toolInput: Record<string, unknown> = {}
): Promise<unknown> {
  return mcpRequest(config, "tools/call", { name: toolName, arguments: toolInput });
}

export function buildExampleInput(tool: McpTool): Record<string, unknown> {
  if (!tool.inputSchema?.properties) return {};
  return Object.fromEntries(
    Object.entries(tool.inputSchema.properties).map(([key, val]) => {
      if (val.example !== undefined) return [key, val.example];
      if (val.type === "number" || val.type === "integer") return [key, 0];
      if (val.type === "boolean") return [key, false];
      if (val.type === "array") return [key, []];
      if (val.type === "object") return [key, {}];
      return [key, ""];
    })
  );
}
