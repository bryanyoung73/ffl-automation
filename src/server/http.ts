import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { loadConfig } from "../config.js";
import { getLineupView, getWaiverView } from "./data.js";

const PUBLIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "public");

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
};

async function sendJson(res: ServerResponse, status: number, body: unknown): Promise<void> {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(text);
}

async function serveStatic(res: ServerResponse, requestPath: string): Promise<void> {
  const rel = requestPath === "/" ? "index.html" : requestPath.slice(1);
  // Resolve then re-check the prefix so "../../etc/passwd"-style paths can't escape PUBLIC_DIR.
  const filePath = normalize(join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  try {
    const body = await readFile(filePath);
    const type = CONTENT_TYPES[extname(filePath)] ?? "application/octet-stream";
    res.writeHead(200, { "Content-Type": type });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  try {
    if (url.pathname === "/api/lineup") {
      const view = await getLineupView(loadConfig());
      await sendJson(res, 200, view);
      return;
    }
    if (url.pathname === "/api/waivers") {
      const view = await getWaiverView(loadConfig());
      await sendJson(res, 200, view);
      return;
    }
    await serveStatic(res, url.pathname);
  } catch (err) {
    console.error(err);
    await sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

export function startServer(port: number, host: string): void {
  createServer((req, res) => {
    void handleRequest(req, res);
  }).listen(port, host);
}
