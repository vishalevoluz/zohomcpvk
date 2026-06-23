import { NextRequest, NextResponse } from "next/server";

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
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...extraHeaders },
      body: JSON.stringify(body),
    });

    const text = await res.text();

    if (!res.ok) {
      return NextResponse.json(
        { error: `HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}` },
        { status: res.status }
      );
    }

    return new NextResponse(text, {
      status: res.status,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Proxy error";
    const cause = err instanceof Error && err.cause ? String(err.cause) : undefined;
    return NextResponse.json({ error: message, cause }, { status: 502 });
  }
}
