/**
 * Prompt Router
 *
 * A Cloudflare Worker that classifies each incoming OpenAI-compatible chat
 * request and forwards it to AI Gateway with a `cf-aig-metadata` header.
 * AI Gateway's Dynamic Routes then dispatch to the appropriate upstream model
 * (e.g. Claude Sonnet for coding, a cheap Workers AI model for everything else).
 *
 * Latency instrumentation:
 *   - Every routed response carries a `Server-Timing` header
 *     (`classify;dur=…, upstream;dur=…`) plus `x-router-task` / `x-router-classifier`.
 *   - Every classification is logged as structured JSON (Workers Logs).
 *   - `POST /classify` runs only the classifier and returns JSON — no upstream
 *     call — so it can be benchmarked cheaply (see scripts/bench.mjs).
 *
 * See README.md for setup instructions.
 */

export interface Env {
  AI: Ai;
  GATEWAY_ACCOUNT_ID: string;
  GATEWAY_NAME: string;
  AI_GATEWAY_TOKEN: string;
  /** Optional: which classifier to use by default (key of CLASSIFIERS). */
  CLASSIFIER?: string;
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

type Task = "coding" | "simple";
type ClefResult = {
  answers?: {
    classify?: {
      choice: string;
      confidence: number;
    };
  };
};

interface ClassifierOutput {
  raw: string;
  confidence?: number;
}

interface Classifier {
  /** Model identifier, reported in logs and benchmark output. */
  model: string;
  /** Returns the raw model output; parsing to a Task happens in one place. */
  run(env: Env, prompt: string): Promise<ClassifierOutput>;
}

interface ClassifyResult {
  task: Task;
  raw: string;
  confidence?: number;
  fallback: boolean;
  classifier: string;
  model: string;
  ms: number;
}

const SYSTEM_PROMPT =
  "Classify the user prompt into exactly one word: 'coding' or 'simple'. " +
  "Reply with only that single word, nothing else.";

const CLEF_PROMPT = "Which model tier should handle this user request?";
const CLEF_CRITERIA = {
  coding: "Writing, debugging, reviewing or explaining code, scripts, SQL, regex, configs or developer tooling",
  simple: "General knowledge, writing, translation, advice and everything else",
};

const CONFIDENCE_THRESHOLD = 0.7;

/**
 * Registry of available classifiers. To add a new one (e.g. a different
 * model), add an entry here — then select it per request with the
 * `x-classifier` header or globally with the CLASSIFIER var.
 */
const CLASSIFIERS: Record<string, Classifier> = {
  "llama-4-scout": {
    model: "@cf/meta/llama-4-scout-17b-16e-instruct",
    async run(env, prompt) {
      const out = (await env.AI.run(this.model as never, {
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: prompt },
        ],
      })) as { response?: string };
      return { raw: out.response ?? "" };
    },
  },
  "clef": {
    model: "@cf/cloudflare/clef",
    async run(env, prompt) {
      const out = (await env.AI.run(this.model, {
        model: "clef",
        state: prompt,
        questions: {
          classify: {
            type: "choice",
            instructions: CLEF_PROMPT,
            criteria: CLEF_CRITERIA
          }
        }
      })) as ClefResult;

      return {
        raw: out.answers?.classify?.choice ?? "",
        confidence: out.answers?.classify?.confidence,
      };
      },
    },
    "clef-flash": {
      model: "@cf/cloudflare/clef-flash",
      async run(env, prompt) {
        const out = (await env.AI.run(this.model, {
          model: "clef-flash",
          state: prompt,
          questions: {
            classify: {
              type: "choice",
              instructions: CLEF_PROMPT,
              criteria: CLEF_CRITERIA
            }
          }
        })) as ClefResult;

        return {
          raw: out.answers?.classify?.choice ?? "",
          confidence: out.answers?.classify?.confidence,
        };
      },
    },
  // "my-new-classifier": {
  //   model: "...",
  //   async run(env, prompt) { ... return rawText; },
  // },
};

const DEFAULT_CLASSIFIER = "clef-flash";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const gatewayUrl =
      `https://gateway.ai.cloudflare.com/v1/${env.GATEWAY_ACCOUNT_ID}` +
      `/${env.GATEWAY_NAME}/compat/chat/completions`;

    if (request.method !== "POST") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { Allow: "POST" },
      });
    }

    // A POST without a parseable chat body gets a health-check response.
    let body: ChatCompletionsRequest = {};
    try {
      body = await request.json();
    } catch {
      return new Response("prompt-router is running");
    }

    if (!body.messages?.length) {
      return new Response("prompt-router is running");
    }

    const classifierName =
      request.headers.get("x-classifier") ?? env.CLASSIFIER ?? DEFAULT_CLASSIFIER;
    if (!CLASSIFIERS[classifierName]) {
      return Response.json(
        { error: `unknown classifier '${classifierName}'`, available: Object.keys(CLASSIFIERS) },
        { status: 400 },
      );
    }

    const prompt = extractLatestUserText(body.messages);
    let result: ClassifyResult;
    try {
      result = await classifyPrompt(env, classifierName, prompt);
    } catch (error) {
      console.error(JSON.stringify({ event: "classify_error", classifier: classifierName, error: String(error) }));
      return Response.json({ error: "classification failed", detail: String(error) }, { status: 502 });
    }


    // Benchmark endpoint: classification only, no upstream call.
    if (new URL(request.url).pathname === "/classify") {
      return Response.json(result, {
        headers: { "Server-Timing": `classify;dur=${result.ms}` },
      });
    }

    // Forward to AI Gateway with explicit auth + routing metadata.
    // We intentionally do NOT spread `request.headers` — that would leak the
    // caller's Authorization header onward and confuse AI Gateway's auth layer.
    const upstreamStart = performance.now();
    const upstream = await fetch(gatewayUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "cf-aig-authorization": `Bearer ${env.AI_GATEWAY_TOKEN}`,
        "cf-aig-metadata": JSON.stringify({ task: result.task }),
      },
      body: JSON.stringify(body),
    });
    // Time to upstream response headers (TTFB); streaming bodies continue after this.
    const upstreamMs = Math.round(performance.now() - upstreamStart);

    const response = new Response(upstream.body, upstream);
    response.headers.append(
      "Server-Timing",
      `classify;dur=${result.ms}, upstream;dur=${upstreamMs};desc="ttfb"`,
    );
    response.headers.set("x-router-task", result.task);
    response.headers.set("x-router-classifier", result.classifier);
    return response;
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
 * Classify a prompt as "coding" or "simple" with the chosen classifier and
 * measure how long it took.
 *
 * Note: in Workers, timers only advance across I/O, so this measures the
 * model call itself (which is exactly the latency we care about).
 */
async function classifyPrompt(env: Env, name: string, prompt: string): Promise<ClassifyResult> {
  const classifier = CLASSIFIERS[name];
  const start = performance.now();
  const { raw, confidence } = await classifier.run(env, prompt);
  const ms = Math.round(performance.now() - start);

  const lowConfidence = confidence !== undefined && confidence < CONFIDENCE_THRESHOLD;
  const task: Task = !lowConfidence && raw.trim().toLowerCase() === "simple" ? "simple" : "coding";

  console.log(
    JSON.stringify({
      event: "classify",
      classifier: name,
      model: classifier.model,
      task,
      raw: raw.slice(0, 50),
      ms,
      confidence: confidence,
      promptChars: prompt.length,
    }),
  );

  return { task, raw, confidence, fallback: lowConfidence, classifier: name, model: classifier.model, ms };
}
