/**
 * Smoke test for the Cadmus brain pipeline end-to-end.
 *
 * Five processors: hippocampus → thalamus → PFC → executor, plus the
 * pfc itself uses memory_write tool calls.
 */

import { resolve } from "node:path";
import { homedir } from "node:os";
import { readFileSync, existsSync } from "node:fs";
import { Runtime, type AgentConfig } from "@cadmus/kernel";

async function main() {
  if (!process.env.GOOGLE_API_KEY && !process.env.ANTHROPIC_API_KEY) {
    const configPath = resolve(homedir(), ".cadmus", "config.json");
    if (existsSync(configPath)) {
      const cfg = JSON.parse(readFileSync(configPath, "utf8")) as {
        apiKeys?: { GOOGLE_API_KEY?: string; ANTHROPIC_API_KEY?: string };
      };
      if (cfg.apiKeys?.GOOGLE_API_KEY) process.env.GOOGLE_API_KEY = cfg.apiKeys.GOOGLE_API_KEY;
      if (cfg.apiKeys?.ANTHROPIC_API_KEY) process.env.ANTHROPIC_API_KEY = cfg.apiKeys.ANTHROPIC_API_KEY;
    }
  }

  const configMod = (await import(
    resolve(process.cwd(), "examples/cadmus/cadmus.config.ts")
  )) as { default: AgentConfig };
  const config = configMod.default;
  config.storage = { timelinePath: ":memory:" };

  const runtime = new Runtime(config, { verbose: false });
  await runtime.start();
  console.log(`runtime started: ${config.name} (${config.agentId})`);
  console.log(`processors: ${config.processors.map((p) => p.name).join(" → ")}`);
  console.log("");

  console.log("→ injecting: 'who are you?'");
  await runtime.inject("who are you?", "smoke-test", "text");

  // The brain pipeline does multiple LLM round-trips. Wait longer + longer settle.
  const deadline = Date.now() + 90_000;
  let lastCount = 0;
  let lastChange = Date.now();
  let settled = false;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    const count = runtime.timeline.count();
    if (count !== lastCount) {
      lastCount = count;
      lastChange = Date.now();
    } else if (Date.now() - lastChange > 5000 && count > 1) {
      settled = true;
      break;
    }
  }

  console.log(`\npipeline ${settled ? "settled" : "timed out"} — ${runtime.timeline.count()} events:\n`);
  const events = runtime.timeline.all();
  for (const e of events) {
    const dataPreview = JSON.stringify(e.data).slice(0, 180);
    console.log(`  [${String(e.seq).padStart(2)}] ${e.type.padEnd(28)} ${dataPreview}${dataPreview.length >= 180 ? "…" : ""}`);
  }

  const output = events.find((e) => e.type === "output");
  console.log("");
  if (output) {
    console.log("✓ output:");
    console.log(`  ${(output.data as { text?: string }).text}`);
  } else {
    console.log("✗ no output event");
  }

  const errors = events.filter((e) => e.type === "error");
  if (errors.length > 0) {
    console.log("");
    console.log(`✗ ${errors.length} error(s):`);
    for (const err of errors) {
      const d = err.data as { source?: string; name?: string; message?: string };
      console.log(`  - ${d.source}:${d.name} — ${d.message}`);
    }
  }

  await runtime.stop();
  process.exit(0);
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
