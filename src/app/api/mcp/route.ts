import { NextRequest, NextResponse } from "next/server";
import https from "https";
import http from "http";

// Agent that skips TLS cert verification — needed for MCP servers with self-signed certs
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

function proxyFetch(
  url: string,
  extraHeaders: Record<string, string>,
  body: string
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const isHttps = parsed.protocol === "https:";
    const defaultPort = isHttps ? 443 : 80;

    const options: https.RequestOptions = {
      hostname: parsed.hostname,
      port: parsed.port ? Number(parsed.port) : defaultPort,
      path: parsed.pathname + parsed.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        ...extraHeaders,
      },
      agent: isHttps ? httpsAgent : new http.Agent(),
    };

    const req = (isHttps ? https : http).request(options, res => {
      let text = "";
      res.on("data", chunk => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 500, text }));
    });

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

export async function POST(req: NextRequest) {
  const { url, headers: extraHeaders, body } = await req.json() as {
    url: string;
    headers: Record<string, string>;
    body: unknown;
  };

  if (!url || typeof url !== "string") {
    return NextResponse.json({ error: "Missing url" }, { status: 400 });
  }

  try {
    const { status, text } = await proxyFetch(url, extraHeaders, JSON.stringify(body));

    if (status < 200 || status >= 300) {
      return NextResponse.json(
        { error: `HTTP ${status}${text ? `: ${text.slice(0, 200)}` : ""}` },
        { status }
      );
    }

    return new NextResponse(text, {
      status,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Proxy error";
    const cause = err instanceof Error && err.cause ? String(err.cause) : undefined;
    return NextResponse.json({ error: message, cause }, { status: 502 });
  }
}
