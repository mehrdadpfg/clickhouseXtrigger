import { NextResponse } from "next/server";
import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";

// THROWAWAY: does the manual cacheControl marker actually produce cache tokens?
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const BIG_SYSTEM =
  "You are a meticulous data analyst. " +
  Array.from({ length: 400 }, (_, i) => `Rule ${i}: always be precise and cite the source of every number you report.`).join(" ");

async function once(mode: "system-msg" | "user-msg" | "none") {
  const cache = { anthropic: { cacheControl: { type: "ephemeral" as const } } };
  const common = {
    model: anthropic("claude-sonnet-5"),
    maxOutputTokens: 8,
  };
  let res;
  if (mode === "user-msg") {
    res = await generateText({
      ...common,
      system: BIG_SYSTEM,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "Reply: ok.", providerOptions: cache }],
        },
      ],
    });
  } else if (mode === "system-msg") {
    // cacheControl on the system prompt via a system-role message part.
    res = await generateText({
      ...common,
      messages: [
        { role: "system", content: BIG_SYSTEM, providerOptions: cache },
        { role: "user", content: "Reply: ok." },
      ],
    });
  } else {
    res = await generateText({ ...common, system: BIG_SYSTEM, messages: [{ role: "user", content: "Reply: ok." }] });
  }
  return { usage: res.usage, anthropic: res.providerMetadata?.["anthropic"] ?? null };
}

export async function GET(request: Request) {
  const mode = (new URL(request.url).searchParams.get("mode") ?? "user-msg") as
    | "system-msg"
    | "user-msg"
    | "none";
  try {
    const first = await once(mode);
    const second = await once(mode);
    return NextResponse.json({ ok: true, mode, first, second });
  } catch (cause) {
    return NextResponse.json(
      { ok: false, error: cause instanceof Error ? cause.message : String(cause) },
      { status: 500 },
    );
  }
}
