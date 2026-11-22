import Anthropic from "@anthropic-ai/sdk";
import { STEPS, isStepId } from "@/lib/agents";
import { getClientIp, jsonError, rateLimit, sameOrigin } from "@/lib/security";

export const runtime = "nodejs";
export const maxDuration = 120;

const MODEL = "claude-sonnet-5-5";
const MAX_INPUT_CHARS = 60000; // page text is already capped at 15k; the rest is earlier agents' output

let client: Anthropic | null = null;
function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("NO_KEY");
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 110_000, maxRetries: 1 });
  return client;
}

function extractJson(text: string): any {
  const cleaned = text.replace(/```(?:json)?/gi, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("no json");
  return JSON.parse(cleaned.slice(start, end + 1));
}

type Msg = Anthropic.MessageParam;

async function callClaude(system: string, messages: Msg[], maxTokens: number, webSearch: boolean) {
  const anthropic = getClient();
  const sources: { url: string; title: string }[] = [];
  let convo = [...messages];
  let finalText = "";
  // Server tools can pause a long turn; continue up to 2 times.
  for (let i = 0; i < 3; i++) {
    const res = await anthropic.messages.create({
      model: MODEL,
      max_tokens: maxTokens,
      system,
      messages: convo,
      ...(webSearch ? { tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 } as any] } : {}),
    });
    // Only keep text written after the last search result (that's the final answer).
    let text = "";
    for (const block of res.content as any[]) {
      if (block.type === "web_search_tool_result") {
        text = "";
        if (Array.isArray(block.content)) {
          for (const r of block.content) if (r?.url) sources.push({ url: r.url, title: r.title || r.url });
        }
      } else if (block.type === "text") {
        text += block.text;
      }
    }
    finalText += text;
    if (res.stop_reason === "pause_turn") {
      convo = [...convo, { role: "assistant", content: res.content as any }];
      finalText = "";
      continue;
    }
    break;
  }
  return { text: finalText, sources };
}

export async function POST(req: Request) {
  if (!sameOrigin(req)) return jsonError("Not allowed.", 403);
  const ip = getClientIp(req);
  // One full run is about 10-12 agent calls. 120/hour ≈ 10 runs per person per hour.
  if (!rateLimit(`agent:${ip}`, 120, 60 * 60 * 1000)) return jsonError("Too many runs from your network. Please try again later.", 429);
  if (!rateLimit("agent:global", 1500, 60 * 60 * 1000)) return jsonError("The app is busy. Please try again later.", 429);

  const raw = await req.text();
  if (raw.length > MAX_INPUT_CHARS) return jsonError("Input is too large.", 413);
  let body: { agentId?: unknown; input?: unknown };
  try {
    body = JSON.parse(raw);
  } catch {
    return jsonError("Bad request.", 400);
  }
  if (!isStepId(body.agentId)) return jsonError("Unknown agent.", 400);
  if (!body.input || typeof body.input !== "object") return jsonError("Missing input.", 400);

  const step = STEPS[body.agentId];
  const userMsg = `<data>\n${JSON.stringify(body.input, null, 1)}\n</data>\n\nDo your job using the data above. Reply with the JSON object only.`;
  const messages: Msg[] = [{ role: "user", content: userMsg }];

  try {
    let webSearchUsed = !!step.webSearch;
    let result;
    try {
      result = await callClaude(step.system, messages, step.maxTokens, webSearchUsed);
    } catch (e) {
      if (!webSearchUsed || (e as any)?.message === "NO_KEY") throw e;
      // Web search may be switched off for this API account: carry on without it.
      webSearchUsed = false;
      result = await callClaude(step.system, messages, step.maxTokens, false);
    }

    let output: any;
    let problems: string[] = [];
    try {
      output = extractJson(result.text);
      problems = step.validate ? step.validate(output, body.input) : [];
    } catch {
      problems = ["Your reply was not valid JSON."];
    }

    // Enforce the rules in code: if anything is off, ask once more with the exact problems.
    if (problems.length) {
      const retry = await callClaude(
        step.system,
        [
          ...messages,
          { role: "assistant", content: result.text.slice(0, 20000) || "{}" },
          { role: "user", content: `Fix these problems and reply again with the full corrected JSON only:\n- ${problems.join("\n- ")}` },
        ],
        step.maxTokens,
        false
      );
      try {
        const second = extractJson(retry.text);
        output = second;
        problems = step.validate ? step.validate(second, body.input) : [];
      } catch {
        if (!output) return jsonError("The agent's answer couldn't be read. Please retry this step.", 502);
      }
    }

    return Response.json({
      output,
      warnings: problems,
      meta: {
        webSearchUsed,
        sources: result.sources.filter((s, i, a) => a.findIndex((x) => x.url === s.url) === i).slice(0, 8),
      },
    });
  } catch (e: any) {
    if (e?.message === "NO_KEY") return jsonError("Server is missing the ANTHROPIC_API_KEY setting.", 500);
    const status = e?.status;
    if (status === 401) return jsonError("The Claude API key is invalid.", 500);
    if (status === 429) return jsonError("Claude is rate-limiting us. Wait a few seconds and retry.", 429);
    if (status === 529 || status === 503) return jsonError("Claude is overloaded right now. Please retry.", 503);
    if (status === 400 && /credit/i.test(e?.message || "")) return jsonError("The Claude API account is out of credits.", 500);
    console.error("agent error", body.agentId, status, e?.message);
    return jsonError("This step failed. Please retry.", 500);
  }
}
