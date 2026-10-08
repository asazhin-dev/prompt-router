# prompt-router

A tiny Cloudflare Worker that classifies each incoming LLM prompt and routes it
to a different upstream model via [AI Gateway Dynamic Routes](https://developers.cloudflare.com/ai-gateway/features/dynamic-routing/).

- **Coding questions** → Anthropic Claude Sonnet (best-in-class for code)
- **Everything else** → a cheap, fast open model on Workers AI

The client speaks the OpenAI Chat Completions API and only sees one endpoint.
Routing is invisible to it.

```
┌─────────┐    ┌──────────────────┐    ┌──────────────┐    ┌─────────────────┐
│  Your   │───▶│  Classifier      │───▶│  AI Gateway  │───▶│  Claude Sonnet  │
│  App    │    │  Worker          │    │  Dynamic     │    │  (coding)       │
└─────────┘    │  (Workers AI     │    │  Routes      │    ├─────────────────┤
               │   Llama 4 Scout) │    │              │───▶│  Workers AI     │
               └──────────────────┘    └──────────────┘    │  Kimi-K2 (rest) │
                                                            └─────────────────┘
```

## Why

Frontier models like Claude Sonnet are expensive but strong on complex tasks;
smaller open models are cheap but weaker. Picking one means overpaying on easy
prompts or underdelivering on hard ones. Classifying prompts on the fly and
routing them to the right model gets you both.

## Prerequisites

- A Cloudflare account (free tier works)
- An Anthropic API key ([get one here](https://console.anthropic.com/))
- Node.js 20+ and [Wrangler](https://developers.cloudflare.com/workers/wrangler/install-and-update/)

## Setup

### 1. Create an AI Gateway

In the Cloudflare Dashboard → **AI** → **AI Gateway** → **Create Gateway**.
Give it a name (e.g. `smart-router`).

Add your Anthropic key: gateway → **Provider Keys** → **Add** → Anthropic.

### 2. Configure the Dynamic Route

Gateway → **Dynamic Routes** → **Add Route** → **Start from scratch**.
Name it `route1`.

Build this logic in the visual editor:

- **If** `metadata.task == "coding"` → **Anthropic** → `claude-sonnet-4-5-20250929`
- **Else** → **Workers AI** → `@cf/moonshotai/kimi-k2-instruct` (or any cheap
  model available in your account)

Save.

### 3. Enable Authenticated Gateway

Gateway → **Settings** → **Create authentication token**. Copy it —
Cloudflare won't show it again. Then toggle **Authenticated Gateway** on.

### 4. Clone and configure this Worker

```bash
git clone https://github.com/palermo-777/prompt-router.git
cd prompt-router
npm install
```

Edit `wrangler.jsonc` and replace the two placeholders:

```jsonc
"vars": {
  "GATEWAY_ACCOUNT_ID": "your-cloudflare-account-id",
  "GATEWAY_NAME": "smart-router"
}
```

Store the gateway token as a secret (never commit it):

```bash
wrangler secret put AI_GATEWAY_TOKEN
# paste the token when prompted
```

For local development, copy `.dev.vars.example` to `.dev.vars` and paste the
same token there — `.dev.vars` is gitignored.

### 5. Deploy

```bash
npm run deploy
```

Your Worker is now live at
`https://prompt-router.<your-subdomain>.workers.dev`.

For production, uncomment the `routes` section in `wrangler.jsonc` and point a
custom domain at the Worker. This avoids `workers.dev` rate limits and works
more reliably with OpenAI-compatible clients like Open WebUI.

## Test

```bash
# Simple prompt — should route to Workers AI (Kimi-K2)
curl -X POST https://prompt-router.<your-subdomain>.workers.dev \
  -H "Content-Type: application/json" \
  -d '{
    "model": "dynamic/route1",
    "messages": [{"role": "user", "content": "What is the capital of Portugal?"}]
  }'

# Coding prompt — should route to Claude Sonnet
curl -X POST https://prompt-router.<your-subdomain>.workers.dev \
  -H "Content-Type: application/json" \
  -d '{
    "model": "dynamic/route1",
    "messages": [{"role": "user", "content": "Write a Python function that reverses a linked list in place."}]
  }'
```

Check **AI Gateway → Logs** in the dashboard — you should see the first request
served by Kimi-K2 and the second by Claude Sonnet.

Check **Workers → prompt-router → Logs** for the classifier's decision on each
request.

## Measuring classification latency

Every routed response carries timing headers:

```
Server-Timing: classify;dur=412, upstream;dur=980;desc="ttfb"
x-router-task: coding
x-router-classifier: llama-4-scout
```

Each classification is also logged as JSON (`event: "classify"`, `ms`, `task`,
`raw`, `promptChars`). Query it in **Workers → prompt-router → Logs**.

To benchmark only the classifier (no upstream model call, no Anthropic cost),
use the `/classify` endpoint via the bench script:

```bash
npm run bench -- --url https://prompt-router.<your-subdomain>.workers.dev
# options: --runs 3 --concurrency 1 --warmup 2 --classifier a,b --prompts file.json
```

It sends every labeled prompt in `scripts/prompts.json` and prints p50/p90/p95/p99
for server-side classify time and client round-trip time, plus accuracy against
the labels. Raw results go to `bench-results/` (gitignored).

To compare classifiers, add an entry to `CLASSIFIERS` in `src/index.ts`, deploy,
and pass both names: `--classifier llama-4-scout,my-new-classifier`. Select one
per request with the `x-classifier` header, or set the `CLASSIFIER` var
globally.

## Point your existing app at it

Anything that speaks the OpenAI Chat Completions API works:

- **[Open WebUI](https://openwebui.com/)** and **[LibreChat](https://www.librechat.ai/)** — self-hosted chat UIs
- **[Continue.dev](https://continue.dev/)** — VS Code / JetBrains coding assistant
- **[Cursor](https://cursor.com/)**, **[Zed](https://zed.dev/)** — AI-native editors
- **OpenAI SDK** — set `baseURL` to your Worker URL

Configuration is always the same:

| Field | Value |
|---|---|
| Base URL | `https://prompt-router.<your-subdomain>.workers.dev` |
| Model | `dynamic/route1` |
| API Key | *(anything — the Worker doesn't check client auth by default)* |

## Security note

This Worker authenticates itself to AI Gateway using `AI_GATEWAY_TOKEN`. It
does **not** authenticate clients calling the Worker — it's publicly reachable
by default. For production use, put [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/)
in front of the Worker's custom domain, or add a bearer-token check at the top
of `fetch()`.

## Extend

The classifier is deliberately minimal. Common extensions:

- **More categories.** Add `reasoning`, `creative`, `summarization`, etc.
  Edit the system prompt in `classifyPrompt()` and add corresponding branches
  to your Dynamic Route.
- **Per-user or per-tier routing.** Read a header/JWT claim and inject it
  alongside `task` in the `cf-aig-metadata` header.
- **Confidence-based fallback.** Ask the classifier for a confidence score
  and default to the strong model when uncertain.

## License

MIT — see [LICENSE](./LICENSE).

## Related

- [AI Gateway Dynamic Routes docs](https://developers.cloudflare.com/ai-gateway/features/dynamic-routing/)
- [Workers AI docs](https://developers.cloudflare.com/workers-ai/)
- [Authenticated AI Gateway](https://developers.cloudflare.com/ai-gateway/configuration/authentication/)
