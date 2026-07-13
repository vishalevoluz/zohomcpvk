import type { McpConfig, McpTool, McpResponse, McpSchemaProperty } from "@/types/mcp";

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

function buildExampleValue(schema: McpSchemaProperty): unknown {
  if (schema.example !== undefined) return schema.example;
  if (schema.type === "object" && schema.properties) {
    return Object.fromEntries(
      Object.entries(schema.properties).map(([key, val]) => [key, buildExampleValue(val)])
    );
  }
  if (schema.type === "number" || schema.type === "integer") return 0;
  if (schema.type === "boolean") return false;
  if (schema.type === "array") return [];
  if (schema.type === "object") return {};
  return "";
}

// Some MCP servers (e.g. Zoho's) group arguments by request location
// (path_variables / query_params / body / headers) instead of a flat property
// bag. A param can live directly under inputSchema.properties (flat) or one
// level down inside one of those groups — this locates either shape.
export interface ParamLocation { group: string | null; key: string }

export function findParamLocations(tool: McpTool | undefined): ParamLocation[] {
  const props = tool?.inputSchema?.properties ?? {};
  const locations: ParamLocation[] = [];
  for (const [key, schema] of Object.entries(props)) {
    if (schema.type === "object" && schema.properties) {
      for (const nestedKey of Object.keys(schema.properties)) {
        locations.push({ group: key, key: nestedKey });
      }
    } else {
      locations.push({ group: null, key });
    }
  }
  return locations;
}

export function findParam(locations: ParamLocation[], matcher: RegExp): ParamLocation | null {
  return locations.find(l => matcher.test(l.key)) ?? null;
}

export function setParam(input: Record<string, unknown>, loc: ParamLocation, value: unknown) {
  if (loc.group === null) {
    input[loc.key] = value;
    return;
  }
  const group = (input[loc.group] as Record<string, unknown> | undefined) ?? {};
  group[loc.key] = value;
  input[loc.group] = group;
}

export function buildExampleInput(tool: McpTool): Record<string, unknown> {
  if (!tool.inputSchema?.properties) return {};
  return Object.fromEntries(
    Object.entries(tool.inputSchema.properties).map(([key, val]) => [key, buildExampleValue(val)])
  );
}
