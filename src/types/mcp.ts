export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: {
    type: string;
    properties?: Record<string, { type: string; description?: string; example?: unknown }>;
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
