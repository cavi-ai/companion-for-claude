// Provider/endpoint/embed HTTP stubs, hosted inside the daemon process.
// Reply/fail rules are declarative (substring or /regex/flags → reply text or
// status) because they are set over the control API, from a separate process.

import { createServer, type Server } from "node:http";
import type { FailRule, ReplyRule } from "./types.ts";
import { deterministicVector } from "./seed.ts";

function toRegExp(match: string, flags?: string): RegExp {
  // A "/pattern/flags" literal is used as-is; anything else is a plain substring match.
  const literal = /^\/(.*)\/([a-z]*)$/.exec(match);
  if (literal) return new RegExp(literal[1]!, literal[2]);
  return new RegExp(match.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
}

class RuleCursor {
  private index = new Map<ReplyRule, number>();
  reply(rules: ReplyRule[], body: string): string | null {
    for (const rule of rules) {
      if (!toRegExp(rule.match, rule.flags).test(body)) continue;
      const at = this.index.get(rule) ?? 0;
      const reply = rule.replies[Math.min(at, rule.replies.length - 1)] ?? "";
      this.index.set(rule, at + 1);
      return reply;
    }
    return null;
  }
}

export interface StubState {
  requests: number;
  replyRules: ReplyRule[];
  failRules: FailRule[];
  delayMs: number;
  endpointModels: string[];
  endpointReply: string;
  cursor: RuleCursor;
}

export function freshStubState(): StubState {
  return { requests: 0, replyRules: [], failRules: [], delayMs: 0, endpointModels: [], endpointReply: "Answered locally by the endpoint stub.", cursor: new RuleCursor() };
}

function failStatus(state: StubState, body: string): number | null {
  for (const rule of state.failRules) if (toRegExp(rule.match, rule.flags).test(body)) return rule.status;
  return null;
}

/** The Anthropic-shaped provider stub: chat completions + rewrite/utility prompts. */
export function startProviderStub(state: StubState): Promise<{ server: Server; port: number }> {
  const defaultReply = JSON.stringify({ markdown: "Grounded prose [@study].", support: [], claimPreservation: [], changes: [], gaps: [] });
  const server = createServer((request, response) => {
    state.requests += 1;
    let body = "";
    request.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
    request.on("end", () => {
      const status = failStatus(state, body);
      if (status !== null) {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify({ type: "error", error: { type: "api_error", message: `stubbed ${status}` } }));
        return;
      }
      const text = state.cursor.reply(state.replyRules, body) ?? defaultReply;
      const respond = () => {
        if (/"stream"\s*:\s*true/.test(body)) {
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.write(`data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })}\n\n`);
          response.write(`data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } })}\n\n`);
          response.end(`data: ${JSON.stringify({ type: "message_stop" })}\n\n`);
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ content: [{ type: "text", text }] }));
      };
      if (state.delayMs) setTimeout(respond, state.delayMs); else respond();
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") { reject(new Error("Provider stub did not bind")); return; }
      resolve({ server, port: address.port });
    });
  });
}

/** OpenAI-compatible endpoint stub: /v1/models for the pickers, /v1/chat/completions (stream + non-stream). */
export function startEndpointStub(state: StubState): Promise<{ server: Server; port: number }> {
  const server = createServer((request, response) => {
    // stream() (unlike listModels()/complete(), which go through Obsidian's
    // requestUrl) calls the real browser fetch(), so a JSON POST triggers a
    // CORS preflight — answer it, and mark every response CORS-open.
    response.setHeader("Access-Control-Allow-Origin", "*");
    if (request.method === "OPTIONS") {
      request.resume();
      response.writeHead(204, { "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "content-type, authorization" });
      response.end();
      return;
    }
    if (request.url?.endsWith("/models")) {
      request.resume();
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ object: "list", data: state.endpointModels.map((id) => ({ id, object: "model" })) }));
      return;
    }
    if (request.method === "POST" && request.url?.endsWith("/chat/completions")) {
      let body = "";
      request.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
      request.on("end", () => {
        const streaming = /"stream"\s*:\s*true/.test(body);
        if (streaming) {
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: state.endpointReply } }] })}\n\n`);
          response.write("data: [DONE]\n\n");
          response.end();
        } else {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ choices: [{ message: { content: state.endpointReply } }] }));
        }
      });
      return;
    }
    request.resume();
    response.writeHead(404, { "content-type": "application/json" });
    response.end("{}");
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") { reject(new Error("Endpoint stub did not bind")); return; }
      resolve({ server, port: address.port });
    });
  });
}

/** Ollama-compatible embed stub: /api/embed (deterministic vectors) and /api/tags. */
export function startEmbedStub(): Promise<{ server: Server; port: number }> {
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url?.endsWith("/api/tags")) {
      request.resume();
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ models: [{ name: "stub-embed" }] }));
      return;
    }
    if (request.method === "POST" && request.url?.endsWith("/api/embed")) {
      let body = "";
      request.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
      request.on("end", () => {
        const { input } = JSON.parse(body || "{}") as { input?: string[] };
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ embeddings: (input ?? []).map(deterministicVector) }));
      });
      return;
    }
    request.resume();
    response.writeHead(404, { "content-type": "application/json" });
    response.end("{}");
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") { reject(new Error("Embed stub did not bind")); return; }
      resolve({ server, port: address.port });
    });
  });
}

export async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
