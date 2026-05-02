/**
 * HTTP endpoint handlers for AI features — adapted for node:http.
 *
 * Vendored and adapted from Plannotator by backnotprop.
 * https://github.com/backnotprop/plannotator
 * License: MIT / Apache-2.0
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AIContext, AIMessage, CreateSessionOptions } from "./types";
import type { ProviderRegistry } from "./provider";
import type { SessionManager } from "./session-manager";

// ---------------------------------------------------------------------------
// Request/response types (same shape as original endpoints.ts)
// ---------------------------------------------------------------------------

export interface CreateSessionRequest {
  context: AIContext;
  providerId?: string;
  model?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
}

export interface QueryRequest {
  sessionId: string;
  prompt: string;
  contextUpdate?: string;
}

export interface AbortRequest {
  sessionId: string;
}

// ---------------------------------------------------------------------------
// Low-level helpers
// ---------------------------------------------------------------------------

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk: Buffer) => { data += chunk.toString(); });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
  res.end(payload);
}

// ---------------------------------------------------------------------------
// Deps + factory
// ---------------------------------------------------------------------------

export interface AIEndpointDeps {
  registry: ProviderRegistry;
  sessionManager: SessionManager;
  getCwd?: () => string;
  conversationContext?: string;
}

export type NodeHttpHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

export function createAIEndpoints(deps: AIEndpointDeps): Record<string, NodeHttpHandler> {
  const { registry, sessionManager, getCwd, conversationContext } = deps;

  return {
    "/api/ai/capabilities": async (_req, res) => {
      const defaultEntry = registry.getDefault();
      const providerDetails = registry.list().map(id => {
        const p = registry.get(id)!;
        return { id, name: p.name, capabilities: p.capabilities, models: p.models ?? [] };
      });
      sendJson(res, 200, {
        available: !!defaultEntry,
        providers: providerDetails,
        defaultProvider: defaultEntry?.id ?? null,
      });
    },

    "/api/ai/session": async (req, res) => {
      if (req.method !== "POST") { sendJson(res, 405, { error: "Method not allowed" }); return; }
      let body: CreateSessionRequest;
      try { body = JSON.parse(await readBody(req)) as CreateSessionRequest; }
      catch { sendJson(res, 400, { error: "Invalid JSON" }); return; }

      const { context, providerId, model, maxTurns, maxBudgetUsd, reasoningEffort } = body;
      if (!context?.mode) { sendJson(res, 400, { error: "Missing context.mode" }); return; }

      const provider = providerId ? registry.get(providerId) : registry.getDefault()?.provider;
      if (!provider) {
        sendJson(res, 503, { error: providerId ? `Provider "${providerId}" not found` : "No AI provider available" });
        return;
      }

      try {
        const options: CreateSessionOptions = { context, cwd: getCwd?.(), model, maxTurns, maxBudgetUsd, reasoningEffort };
        const shouldFork = context.parent && provider.capabilities.fork;
        const session = shouldFork ? await provider.forkSession(options) : await provider.createSession(options);
        const entry = sessionManager.track(session, context.mode);
        sendJson(res, 200, {
          sessionId: session.id,
          parentSessionId: session.parentSessionId,
          mode: context.mode,
          createdAt: entry.createdAt,
        });
      } catch (err) {
        sendJson(res, 500, { error: err instanceof Error ? err.message : "Failed to create session" });
      }
    },

    "/api/ai/query": async (req, res) => {
      if (req.method !== "POST") { sendJson(res, 405, { error: "Method not allowed" }); return; }
      let body: QueryRequest;
      try { body = JSON.parse(await readBody(req)) as QueryRequest; }
      catch { sendJson(res, 400, { error: "Invalid JSON" }); return; }

      const { sessionId, prompt, contextUpdate } = body;
      if (!sessionId || !prompt) { sendJson(res, 400, { error: "Missing sessionId or prompt" }); return; }

      const entry = sessionManager.get(sessionId);
      if (!entry) { sendJson(res, 404, { error: "Session not found" }); return; }

      sessionManager.touch(sessionId);
      if (!entry.label) entry.label = prompt.slice(0, 80);

      const effectivePrompt = contextUpdate
        ? `[Context update: the user has made changes since this conversation started]\n${contextUpdate}\n\n${prompt}`
        : prompt;

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      });

      try {
        for await (const message of entry.session.query(effectivePrompt)) {
          res.write(`data: ${JSON.stringify(message)}\n\n`);
        }
        res.write("data: [DONE]\n\n");
      } catch (err) {
        const errorMsg: AIMessage = {
          type: "error",
          error: err instanceof Error ? err.message : String(err),
          code: "stream_error",
        };
        res.write(`data: ${JSON.stringify(errorMsg)}\n\n`);
      } finally {
        res.end();
      }
    },

    "/api/ai/abort": async (req, res) => {
      if (req.method !== "POST") { sendJson(res, 405, { error: "Method not allowed" }); return; }
      let body: AbortRequest;
      try { body = JSON.parse(await readBody(req)) as AbortRequest; }
      catch { sendJson(res, 400, { error: "Invalid JSON" }); return; }
      const entry = sessionManager.get(body.sessionId);
      if (!entry) { sendJson(res, 404, { error: "Session not found" }); return; }
      entry.session.abort();
      sendJson(res, 200, { ok: true });
    },

    "/api/ai/permission": async (req, res) => {
      if (req.method !== "POST") { sendJson(res, 405, { error: "Method not allowed" }); return; }
      let body: { sessionId: string; requestId: string; allow: boolean; message?: string };
      try { body = JSON.parse(await readBody(req)); }
      catch { sendJson(res, 400, { error: "Invalid JSON" }); return; }
      if (!body.sessionId || !body.requestId) { sendJson(res, 400, { error: "Missing sessionId or requestId" }); return; }
      const entry = sessionManager.get(body.sessionId);
      if (!entry) { sendJson(res, 404, { error: "Session not found" }); return; }
      entry.session.respondToPermission?.(body.requestId, body.allow, body.message);
      sendJson(res, 200, { ok: true });
    },

    "/api/ai/sessions": async (_req, res) => {
      const entries = sessionManager.list();
      sendJson(res, 200, entries.map(e => ({
        sessionId: e.session.id,
        mode: e.mode,
        parentSessionId: e.parentSessionId,
        createdAt: e.createdAt,
        lastActiveAt: e.lastActiveAt,
        isActive: e.session.isActive,
        label: e.label,
      })));
    },
  };
}

export type AIEndpoints = ReturnType<typeof createAIEndpoints>;
