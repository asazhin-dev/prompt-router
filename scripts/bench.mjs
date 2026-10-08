#!/usr/bin/env node
/**
 * Classification latency benchmark for prompt-router.
 *
 * Calls POST <url>/classify (classifier only, no upstream model call) for every
 * prompt in scripts/prompts.json, repeated --runs times, and reports:
 *   - server-side classify latency (measured inside the Worker around ai.run)
 *   - client round-trip latency (includes network + Worker overhead)
 *   - accuracy against the labels in prompts.json
 *
 * Usage:
 *   node scripts/bench.mjs --url https://prompt-router.<sub>.workers.dev
 *   node scripts/bench.mjs --url http://localhost:8787 --runs 5 --concurrency 4
 *   node scripts/bench.mjs --url ... --classifier llama-4-scout,my-new-classifier
 *
 * Results are also written to bench-results/<classifier>-<timestamp>.json so
 * runs can be compared later.
 */
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = { runs: 3, concurrency: 1, warmup: 2, classifier: "", prompts: join(here, "prompts.json") };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, "");
    const val = argv[i + 1];
    if (["url", "classifier", "prompts", "token"].includes(key)) { args[key] = val; i++; }
    else if (["runs", "concurrency", "warmup"].includes(key)) { args[key] = Number(val); i++; }
    else if (key === "help" || key === "h") { args.help = true; }
  }
  return args;
}

function percentile(sorted, p) {
  if (!sorted.length) return NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function stats(values) {
  const s = [...values].sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / (s.length || 1);
  return {
    n: s.length,
    min: s[0],
    p50: percentile(s, 50),
    p90: percentile(s, 90),
    p95: percentile(s, 95),
    p99: percentile(s, 99),
    max: s[s.length - 1],
    mean: Math.round(mean),
  };
}

async function classifyOnce(url, classifier, prompt, token) {
  const headers = { "Content-Type": "application/json" };
  if (classifier) headers["x-classifier"] = classifier;
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const start = performance.now();
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ model: "dynamic/route1", messages: [{ role: "user", content: prompt }] }),
  });
  const text = await res.text();
  const clientMs = Math.round(performance.now() - start);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  const json = JSON.parse(text);
  return { ...json, clientMs };
}

async function runPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, concurrency) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await worker(items[i], i);
      }
    }),
  );
  return results;
}

function fmtRow(name, s) {
  const c = (v) => String(v).padStart(6);
  return `${name.padEnd(22)}${c(s.n)}${c(s.min)}${c(s.p50)}${c(s.p90)}${c(s.p95)}${c(s.p99)}${c(s.max)}${c(s.mean)}`;
}

async function benchClassifier(args, endpoint, classifier, prompts) {
  const label = classifier || "(worker default)";
  console.log(`\n=== ${label} ===`);

  // Warm-up (not recorded): first calls can include cold-start / model-load time.
  for (let i = 0; i < args.warmup; i++) {
    await classifyOnce(endpoint, classifier, prompts[i % prompts.length].prompt, args.token).catch(() => {});
  }

  const jobs = [];
  for (let r = 0; r < args.runs; r++) for (const p of prompts) jobs.push({ ...p, run: r });

  let done = 0;
  const results = await runPool(jobs, args.concurrency, async (job) => {
    try {
      const out = await classifyOnce(endpoint, classifier, job.prompt, args.token);
      return { ...job, ...out, correct: out.task === job.label };
    } catch (err) {
      return { ...job, error: String(err.message ?? err) };
    } finally {
      done++;
      process.stdout.write(`\r  ${done}/${jobs.length} requests`);
    }
  });
  process.stdout.write("\n");

  const ok = results.filter((r) => !r.error);
  const errors = results.filter((r) => r.error);
  const server = stats(ok.map((r) => r.ms));
  const client = stats(ok.map((r) => r.clientMs));
  const accuracy = ok.length ? ok.filter((r) => r.correct).length / ok.length : 0;
  const model = ok[0]?.model ?? "?";

  console.log(`  model: ${model}`);
  console.log(`  ${"latency (ms)".padEnd(22)}${["n", "min", "p50", "p90", "p95", "p99", "max", "mean"].map((h) => h.padStart(6)).join("")}`);
  console.log("  " + fmtRow("server classify", server));
  console.log("  " + fmtRow("client round-trip", client));
  console.log(`  accuracy: ${(accuracy * 100).toFixed(1)}% (${ok.filter((r) => r.correct).length}/${ok.length})`);
  if (errors.length) console.log(`  errors: ${errors.length} — first: ${errors[0].error}`);

  const wrong = ok.filter((r) => !r.correct);
  const seen = new Set();
  for (const w of wrong) {
    if (seen.has(w.prompt)) continue;
    seen.add(w.prompt);
    console.log(`  ✗ expected ${w.label}, got ${w.task} (raw: ${JSON.stringify(w.raw?.slice(0, 30))}) — ${w.prompt.slice(0, 60).replace(/\n/g, " ")}`);
  }

  return { classifier: label, model, server, client, accuracy, errors: errors.length, results };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.url) {
    console.log("Usage: node scripts/bench.mjs --url <worker-url> [--runs 3] [--concurrency 1] [--warmup 2] [--classifier a,b] [--prompts file.json] [--token X]");
    process.exit(args.help ? 0 : 1);
  }
  const endpoint = args.url.replace(/\/+$/, "") + "/classify";
  const prompts = JSON.parse(await readFile(args.prompts, "utf8"));
  const classifiers = args.classifier ? args.classifier.split(",").map((s) => s.trim()) : [""];

  console.log(`Endpoint: ${endpoint}`);
  console.log(`Prompts: ${prompts.length} × ${args.runs} runs, concurrency ${args.concurrency}, warmup ${args.warmup}`);

  const outDir = join(here, "..", "bench-results");
  await mkdir(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");

  const summaries = [];
  for (const c of classifiers) {
    const r = await benchClassifier(args, endpoint, c, prompts);
    summaries.push(r);
    const file = join(outDir, `${(c || "default").replace(/[^\w.-]/g, "_")}-${stamp}.json`);
    await writeFile(file, JSON.stringify({ endpoint, runs: args.runs, concurrency: args.concurrency, ...r }, null, 2));
    console.log(`  saved → ${file}`);
  }

  if (summaries.length > 1) {
    console.log("\n=== comparison (server classify ms) ===");
    for (const s of summaries) {
      console.log(`  ${s.classifier.padEnd(24)} p50 ${String(s.server.p50).padStart(5)}  p95 ${String(s.server.p95).padStart(5)}  acc ${(s.accuracy * 100).toFixed(1)}%`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
