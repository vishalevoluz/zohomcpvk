// Some MCP servers (e.g. Zoho's) don't expose a flat property bag — they group
// arguments by request location (path_variables / query_params / body / headers),
// each itself a nested object schema. `properties`/`required` model that recursively.
export interface McpSchemaProperty {
  type: string;
  description?: string;
  example?: unknown;
  enum?: unknown[];
  properties?: Record<string, McpSchemaProperty>;
  required?: string[];
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: {
    type: string;
    properties?: Record<string, McpSchemaProperty>;
    required?: string[];
  };
}

export interface McpConfig {
  url: string;
  authToken?: string;
  apiKey?: string;
  crmBaseUrl?: string; // e.g. https://crm.zoho.com/crm/org123456
}

export interface ExecutionLog {
  id: string;
  tool: string;
  input: Record<string, unknown>;
  output: unknown;
  status: "success" | "error";
  errorMessage?: string;
  durationMs: number;
  timestamp: Date;
}

export interface McpResponse<T = unknown> {
  jsonrpc: "2.0";
  id: number;
  result?: T;
  error?: { code: number; message: string };
}
