import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";

// Dedicated to the Zia Recommendations card's "Get remediation steps" action —
// a pure explain/reason task that doesn't need to touch live CRM data, so it
// talks to Claude directly instead of guessing at a connected MCP tool.
const MODEL = "claude-sonnet-5";

// Rendered as plain text (white-space: pre-wrap) in the card, so strip any
// markdown the model slips in despite the system prompt — headers, bold,
// italics, inline code — and normalize bullets to a plain "•".
function stripMarkdown(text: string): string {
  return text
    .split("\n")
    .map(line => {
      let l = line.replace(/^\s{0,3}#{1,6}\s*/, "");
      l = l.replace(/^(\s*)[-*+]\s+/, "$1• ");
      l = l.replace(/\*\*(.*?)\*\*/g, "$1");
      l = l.replace(/__(.*?)__/g, "$1");
      l = l.replace(/(?<!\w)\*(?!\s)(.*?)(?<!\s)\*(?!\w)/g, "$1");
      l = l.replace(/(?<!\w)_(?!\s)(.*?)(?<!\s)_(?!\w)/g, "$1");
      l = l.replace(/`([^`]*)`/g, "$1");
      return l;
    })
    .join("\n");
}

export async function POST(req: NextRequest) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "ANTHROPIC_API_KEY is not configured on the server" }, { status: 500 });
  }

  const { title, description, context } = await req.json() as {
    title: string;
    description: string;
    context?: string;
  };

  if (!title || !description) {
    return NextResponse.json({ error: "Missing title or description" }, { status: 400 });
  }

  const client = new Anthropic({ apiKey });

  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      thinking: { type: "disabled" },
      system:
        "You are a Zoho CRM administration expert helping a customer fix a specific audit finding. " +
        "Give concise, concrete remediation steps a CRM admin can follow directly in Zoho CRM, as a numbered list (1., 2., 3., ...) " +
        "or plain bullet points (using \"-\"). " +
        "Respond in plain text only — do not use markdown formatting of any kind: no headers (#), no bold (**) or italics (*, _), " +
        "no inline code (`), no tables. " +
        "Do not ask clarifying questions — work from the finding as given.",
      messages: [
        {
          role: "user",
          content: `Audit finding: "${title}"\n${description}${context ? `\n\nCRM context:\n${context}` : ""}\n\nGive concrete remediation steps.`,
        },
      ],
    });

    const rawText = response.content
      .filter(block => block.type === "text")
      .map(block => block.text)
      .join("\n")
      .trim();
    const text = stripMarkdown(rawText);

    return NextResponse.json({
      text: text || "No response received from Claude.",
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        model: MODEL,
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Claude request failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
