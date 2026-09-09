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
      throw new Error("Request timed out - MCP server did not respond within 15s");
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

// A tool can report a business-logic failure (e.g. a required query param
// missing) while the MCP transport call itself still succeeds - this
// server's convention is isError: false with the real verdict living in
// structuredContent.status / structuredContent.data.status instead, but a
// standard isError: true (with the message in the content text block) is
// checked too for servers that follow that convention instead. Detected
// centrally here, once, rather than requiring every one of the dozens of
// executeTool call sites across the app to separately guard against it - a
// caller that doesn't check this treats the failure's own error-message
// text as if it were real tool output (e.g. one fake "layout" or "rule"
// record with no real fields), silently miscounting a failed fetch as a
// confirmed zero instead of surfacing it as the error it actually is.
function toolCallFailureMessage(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const r = result as Record<string, unknown>;
  if (r.isError === true) {
    const content = Array.isArray(r.content) ? (r.content as Record<string, unknown>[]) : [];
    const text = content.find(c => c.type === "text" && typeof c.text === "string")?.text;
    return typeof text === "string" ? text : "Tool reported an error";
  }
  const sc = r.structuredContent as Record<string, unknown> | undefined;
  if (sc) {
    const dataStatus = (sc.data as Record<string, unknown> | undefined)?.status;
    if (sc.status === "failure" || dataStatus === "failure") {
      const message = (sc.data as Record<string, unknown> | undefined)?.message;
      return typeof message === "string" ? message : "Tool reported failure";
    }
  }
  return null;
}

export async function executeTool(
  config: McpConfig,
  toolName: string,
  toolInput: Record<string, unknown> = {}
): Promise<unknown> {
  const result = await mcpRequest(config, "tools/call", { name: toolName, arguments: toolInput });
  const failure = toolCallFailureMessage(result);
  if (failure) throw new Error(failure);
  return result;
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
// level down inside one of those groups - this locates either shape.
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
