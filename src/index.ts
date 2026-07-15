/**
 * Prompt Router
 *
 * A Cloudflare Worker that classifies each incoming OpenAI-compatible chat
 * request and forwards it to AI Gateway with a `cf-aig-metadata` header.
 * AI Gateway's Dynamic Routes then dispatch to the appropriate upstream model
 * (e.g. Claude Sonnet for coding, a cheap Workers AI model for everything else).
 *
 * See README.md for setup instructions.
 */

export interface Env {
  AI: Ai;
  GATEWAY_ACCOUNT_ID: string;
  GATEWAY_NAME: string;
  AI_GATEWAY_TOKEN: string;
}

interface ChatMessage {
  role: string;
  content: string | Array<{ type: string; text?: string }>;
}

interface ChatCompletionsRequest {
  model?: string;
  messages?: ChatMessage[];
  [key: string]: unknown;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const gatewayUrl =
      `https://gateway.ai.cloudflare.com/v1/${env.GATEWAY_ACCOUNT_ID}` +
      `/${env.GATEWAY_NAME}/compat/chat/completions`;

    // Anything that isn't a POST with a chat body gets a health-check response.
    let body: ChatCompletionsRequest = {};
    try {
      body = await request.json();
    } catch {
      return new Response("prompt-router is running");
    }

    if (!body.messages?.length) {
      return new Response("prompt-router is running");
    }

    const prompt = extractLatestUserText(body.messages);

    const task = await classifyPrompt(env.AI, prompt);

    // Forward to AI Gateway with explicit auth + routing metadata.
    // We intentionally do NOT spread `request.headers` — that would leak the
    // caller's Authorization header onward and confuse AI Gateway's auth layer.
    return fetch(gatewayUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "cf-aig-authorization": `Bearer ${env.AI_GATEWAY_TOKEN}`,
        "cf-aig-metadata": JSON.stringify({ task }),
      },
      body: JSON.stringify(body),
    });
  },
} satisfies ExportedHandler<Env>;

/**
 * Extract the raw text of the most recent user message. Handles both the
 * simple `content: string` shape and the multi-part `content: [...]` shape
 * used by some clients.
 */
function extractLatestUserText(messages: ChatMessage[]): string {
  const last = messages.at(-1);
  if (!last) return "";
  if (typeof last.content === "string") return last.content;
  if (Array.isArray(last.content)) {
    return last.content.find((c) => c.type === "text")?.text ?? "";
  }
  return "";
}

/**
 * Classify a prompt as "coding" or "simple" using a small, cheap Workers AI
 * model. Extend this function to add more categories.
 */
async function classifyPrompt(ai: Ai, prompt: string): Promise<"coding" | "simple"> {
  const classification = await ai.run(
    "@cf/meta/llama-4-scout-17b-16e-instruct" as never,
    {
      messages: [
        {
          role: "system",
          content:
            "Classify the user prompt into exactly one word: 'coding' or 'simple'. " +
            "Reply with only that single word, nothing else.",
        },
        { role: "user", content: prompt },
      ],
    },
  ) as { response?: string };

  return classification.response?.trim().toLowerCase() === "coding"
    ? "coding"
    : "simple";
}
