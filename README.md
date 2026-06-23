# Zoho MCP Dashboard

A Next.js 15 web app to connect, browse, and execute tools on a Zoho MCP server.

## Project structure

```
src/
├── app/
│   ├── layout.tsx          # Root layout
│   ├── globals.css         # All styles
│   ├── page.tsx            # Redirects → /dashboard
│   └── dashboard/
│       └── page.tsx        # Main dashboard page
├── components/
│   ├── ConnectionForm.tsx  # MCP URL + auth inputs
│   ├── ToolsList.tsx       # Browse available tools
│   ├── ExecuteTool.tsx     # Run a tool with JSON input
│   └── AuditLogs.tsx       # Execution history
├── lib/
│   └── zohoMcp.ts          # MCP client (listTools, executeTool)
└── types/
    └── mcp.ts              # TypeScript types
```

## Setup

```bash
npm install
cp .env.example .env.local   # optional — URL can be entered in the UI
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Usage

1. Paste your Zoho MCP URL in the connection field
2. Add a Bearer token or API key if your server requires auth
3. Click **Connect** — all available tools load automatically
4. Browse tools in the **Tools** tab, click any to jump to **Execute**
5. Fill in the JSON input and click **Run tool**
6. Every execution is logged in the **Audit logs** tab with timing and output

## Environment variables (optional)

| Variable | Description |
|---|---|
| `NEXT_PUBLIC_ZOHO_MCP_URL` | Pre-fill the MCP URL |
| `NEXT_PUBLIC_ZOHO_TOKEN` | Pre-fill Bearer token |
| `NEXT_PUBLIC_ZOHO_API_KEY` | Pre-fill API key |

## Tech stack

- Next.js 15 (App Router)
- React 19
- TypeScript
- Pure CSS (no UI library)
