import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Runtime } from "./runtime.js";
import type { CadmusEvent } from "./types.js";

export interface WorkspaceAgent {
  name: string;
  path: string;
  active: boolean;
}

export interface WorkspaceInfo {
  activeAgent: string;
  agents: WorkspaceAgent[];
  /** Called when the user requests a switch. Implementer typically writes
   *  the new active agent to config.json and signals the parent CLI to
   *  restart the kernel. */
  onSwitch?: (name: string) => Promise<void> | void;
}

export interface ServerOptions {
  port?: number;
  host?: string;
  workspace?: WorkspaceInfo;
}

interface ParsedBody {
  text?: unknown;
  channel?: unknown;
  kind?: unknown;
  type?: unknown;
  data?: unknown;
}

async function readJsonBody(req: IncomingMessage): Promise<ParsedBody> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk as Buffer));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function setCors(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function json(res: ServerResponse, status: number, body: unknown): void {
  setCors(res);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

export function startServer(runtime: Runtime, options: ServerOptions = {}) {
  const port = options.port ?? 4000;
  const host = options.host ?? "127.0.0.1";

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${host}:${port}`);

    if (req.method === "OPTIONS") {
      setCors(res);
      res.statusCode = 204;
      return res.end();
    }

    // GET /api/workspace — list of installed agents in the global workspace
    if (req.method === "GET" && url.pathname === "/api/workspace") {
      if (!options.workspace) {
        return json(res, 200, { agents: [], activeAgent: runtime.agentId });
      }
      return json(res, 200, {
        agents: options.workspace.agents,
        activeAgent: options.workspace.activeAgent,
      });
    }

    // POST /api/workspace/active-agent { name } — request a switch
    if (req.method === "POST" && url.pathname === "/api/workspace/active-agent") {
      try {
        const body = await readJsonBody(req);
        const name = body.type === undefined && typeof (body as { name?: unknown }).name === "string"
          ? ((body as { name: string }).name)
          : null;
        if (!name) return json(res, 400, { error: "expected { name }" });
        if (!options.workspace?.onSwitch) {
          return json(res, 501, { error: "kernel not configured for hot switch" });
        }
        await options.workspace.onSwitch(name);
        return json(res, 200, {
          ok: true,
          message: "active agent set; restart cadmus to load it",
        });
      } catch (err) {
        return json(res, 500, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // GET /api/status — runtime + provider config health
    if (req.method === "GET" && url.pathname === "/api/status") {
      const modelsInUse = new Set<string>();
      for (const p of runtime.processors) {
        const m = p.templateConfig?.model;
        if (m) modelsInUse.add(m);
      }
      const providersNeeded = new Set<"google" | "anthropic">();
      for (const m of modelsInUse) {
        if (m.startsWith("gemini-") || m.startsWith("models/gemini-")) {
          providersNeeded.add("google");
        } else if (m.startsWith("claude-")) {
          providersNeeded.add("anthropic");
        }
      }
      return json(res, 200, {
        agent: { id: runtime.agentId, name: runtime.agentName },
        events: runtime.timeline.count(),
        modelsInUse: [...modelsInUse],
        providers: {
          google: {
            configured: !!process.env.GOOGLE_API_KEY,
            needed: providersNeeded.has("google"),
          },
          anthropic: {
            configured: !!process.env.ANTHROPIC_API_KEY,
            needed: providersNeeded.has("anthropic"),
          },
        },
      });
    }

    // GET /api/agent — agent metadata
    if (req.method === "GET" && url.pathname === "/api/agent") {
      return json(res, 200, {
        id: runtime.agentId,
        name: runtime.agentName,
        processors: runtime.processors.map((p) => ({
          name: p.name,
          template: p.template,
          filter: p.filter,
          outputEvents: p.outputEvents ?? [],
          tools: p.tools ?? [],
          inputSchema: p.inputSchema,
          outputSchema: p.outputSchema,
          templateConfig: p.template === "llm"
            ? {
                model: p.templateConfig?.model,
                systemPrompt: p.templateConfig?.systemPrompt,
                contextEvents: p.templateConfig?.contextEvents,
                temperature: p.templateConfig?.temperature,
              }
            : undefined,
          config: p.config,
        })),
        tools: Object.entries(runtime.tools).map(([name, t]) => ({
          name,
          description: t.description,
          input_schema: t.input_schema,
        })),
        channels: runtime.channels.map((c) => ({
          name: c.name,
          inboundEvents: c.inboundEvents ?? [],
          outboundEvents: c.outboundEvents ?? [],
        })),
      });
    }

    // GET /api/events?since=<seq>&limit=<n>
    if (req.method === "GET" && url.pathname === "/api/events") {
      const since = Number(url.searchParams.get("since") ?? "0");
      const limit = Number(url.searchParams.get("limit") ?? "500");
      const events = runtime.timeline.since(since, limit);
      return json(res, 200, { events });
    }

    // GET /api/events/all
    if (req.method === "GET" && url.pathname === "/api/events/all") {
      return json(res, 200, { events: runtime.timeline.all() });
    }

    // GET /api/stream — SSE
    if (req.method === "GET" && url.pathname === "/api/stream") {
      setCors(res);
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders?.();

      // Send a comment line to open the stream.
      res.write(": connected\n\n");

      // Replay current timeline first.
      for (const ev of runtime.timeline.all()) {
        res.write(`event: append\ndata: ${JSON.stringify(ev)}\n\n`);
      }

      const send = (event: CadmusEvent) => {
        res.write(`event: append\ndata: ${JSON.stringify(event)}\n\n`);
      };
      const unsub = runtime.timeline.subscribe(send);
      const heartbeat = setInterval(() => {
        res.write(`: ping\n\n`);
      }, 15000);

      const onClose = () => {
        unsub();
        clearInterval(heartbeat);
      };
      req.on("close", onClose);
      req.on("error", onClose);
      return;
    }

    // POST /api/inject — { text, channel?, kind? } or { type, data }
    if (req.method === "POST" && url.pathname === "/api/inject") {
      try {
        const body = await readJsonBody(req);
        let event: CadmusEvent;
        if (typeof body.text === "string") {
          const channel = typeof body.channel === "string" ? body.channel : "app";
          const kind = typeof body.kind === "string" ? body.kind : "text";
          event = await runtime.inject(body.text, channel, kind);
        } else if (typeof body.type === "string") {
          event = await runtime.appendEvent({
            type: body.type,
            data: (body.data as Record<string, unknown>) ?? {},
          });
        } else {
          return json(res, 400, { error: "expected { text, channel?, kind? } or { type, data }" });
        }
        return json(res, 200, { event });
      } catch (err) {
        return json(res, 500, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // GET / — tiny HTML index so people who hit the port directly aren't lost
    if (req.method === "GET" && url.pathname === "/") {
      setCors(res);
      res.setHeader("Content-Type", "text/html");
      res.statusCode = 200;
      return res.end(
        `<!doctype html><html><body style="font-family:Geist,system-ui;padding:2rem;color:#0c0a09">
<h1>Cadmus runtime</h1>
<p>Agent <strong>${runtime.agentName}</strong> is running.</p>
<p>Open the Studio UI at <a href="http://localhost:3001">http://localhost:3001</a> for the live timeline.</p>
<ul>
  <li><code>GET /api/agent</code></li>
  <li><code>GET /api/events</code></li>
  <li><code>GET /api/stream</code> (SSE)</li>
  <li><code>POST /api/inject</code> { text, channel?, kind? }</li>
</ul>
</body></html>`,
      );
    }

    json(res, 404, { error: "not found" });
  });

  server.listen(port, host, () => {
    console.log(`[cadmus] api on http://${host}:${port}`);
  });

  return {
    server,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
