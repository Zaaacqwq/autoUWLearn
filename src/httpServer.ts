#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import express from "express";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Request, Response } from "express";
import { BrowserSession } from "./browserSession.js";
import { config } from "./config.js";
import { createLearnMcpServer } from "./mcpServer.js";
import { getToolDocs, openApiSpec } from "./toolRegistry.js";
import {
  authorizationServerMetadata,
  handleAuthorize,
  handleToken,
  oauthChallenge,
  protectedResourceMetadata,
  registerOAuthClient,
  renderAuthorize,
  verifyAccessToken
} from "./oauth.js";

type AnyTransport = StreamableHTTPServerTransport | SSEServerTransport;

const host = process.env.LEARN_MCP_HOST ?? "127.0.0.1";
const port = Number(process.env.LEARN_MCP_PORT ?? 8787);
const allowedHosts = (process.env.LEARN_MCP_ALLOWED_HOSTS ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

const app = createMcpExpressApp({
  host,
  allowedHosts: allowedHosts.length > 0 ? allowedHosts : undefined
});
const sharedBrowser = new BrowserSession();
createLearnMcpServer(sharedBrowser);
const transports: Record<string, AnyTransport> = {};
const browsers = new Set<{ close(): Promise<void> }>();

function authorize(req: any, res: any): boolean {
  if (verifyAccessToken(String(req.headers.authorization ?? ""))) return true;
  res.setHeader("WWW-Authenticate", oauthChallenge());
  res.status(401).json({
    error: "Unauthorized"
  });
  return false;
}

app.use(express.urlencoded({ extended: false }));

app.get("/.well-known/oauth-protected-resource", (_req: Request, res: Response) => {
  res.json(protectedResourceMetadata());
});

app.get("/.well-known/oauth-protected-resource/mcp", (_req: Request, res: Response) => {
  res.json(protectedResourceMetadata());
});

app.get("/.well-known/oauth-authorization-server", (_req: Request, res: Response) => {
  res.json(authorizationServerMetadata());
});

app.get("/.well-known/openid-configuration", (_req: Request, res: Response) => {
  res.json(authorizationServerMetadata());
});

app.post("/oauth/register", registerOAuthClient);
app.get("/oauth/authorize", renderAuthorize);
app.post("/oauth/authorize", handleAuthorize);
app.post("/oauth/token", handleToken);

app.get("/health", (_req: Request, res: Response) => {
  res.json({
    ok: true,
    name: "autouwlearn",
    transports: ["/mcp", "/sse"]
  });
});

app.get("/tools.json", (req: Request, res: Response) => {
  if (!requireLocalAuthUi(req, res)) return;
  res.json(getToolDocs());
});

app.get("/openapi.json", (req: Request, res: Response) => {
  if (!requireLocalAuthUi(req, res)) return;
  res.json(openApiSpec());
});

app.get("/docs", (req: Request, res: Response) => {
  if (!requireLocalAuthUi(req, res)) return;
  res.status(200).type("html").send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>autoUWLearn MCP Docs</title>
    <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
    <script>
      window.ui = SwaggerUIBundle({
        url: '/openapi.json',
        dom_id: '#swagger-ui',
        deepLinking: true,
        presets: [SwaggerUIBundle.presets.apis],
        layout: 'BaseLayout'
      });
    </script>
  </body>
</html>`);
});

function isLocalAuthRequest(req: Request): boolean {
  const hostHeader = String(req.headers.host ?? "").toLowerCase();
  const hostname = hostHeader.split(":")[0];
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function requireLocalAuthUi(req: Request, res: Response): boolean {
  if (isLocalAuthRequest(req)) return true;
  res.status(403).json({
    ok: false,
    error: "LOCAL_ONLY",
    message:
      "The UW LEARN auth UI is local-only. Open http://127.0.0.1:8787/auth on the Mac mini, or use SSH port forwarding."
  });
  return false;
}

app.get("/auth", async (req: Request, res: Response) => {
  if (!requireLocalAuthUi(req, res)) return;
  const status = await sharedBrowser.authStatus({ navigate: false, force: true }).catch((error) => ({
    ok: false,
    authenticated: false,
    state: "UNKNOWN" as const,
    url: "about:blank",
    title: "",
    message: String(error),
    authUrl: config.authUrl
  }));
  res.status(200).type("html").send(renderAuthPage(status));
});

app.get("/auth/status", async (req: Request, res: Response) => {
  if (!requireLocalAuthUi(req, res)) return;
  res.json(await sharedBrowser.authStatus({ navigate: false, force: true }).catch((error) => ({
    ok: false,
    authenticated: false,
    state: "UNKNOWN",
    url: "about:blank",
    title: "",
    message: String(error),
    authUrl: config.authUrl
  })));
});

app.post("/auth/start", async (req: Request, res: Response) => {
  if (!requireLocalAuthUi(req, res)) return;
  try {
    res.json(await sharedBrowser.startManualLogin());
  } catch (error) {
    res.status(500).json({
      ok: false,
      authenticated: false,
      state: "AUTH_FAILED",
      url: "about:blank",
      title: "",
      message: error instanceof Error ? error.message : String(error),
      authUrl: config.authUrl
    });
  }
});

app.post("/auth/wait", async (req: Request, res: Response) => {
  if (!requireLocalAuthUi(req, res)) return;
  const deadline = Date.now() + 120_000;
  let status = await sharedBrowser.authStatus({ navigate: false, force: true });
  while (!status.authenticated && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    status = await sharedBrowser.authStatus({ navigate: false, force: true });
  }
  res.json(status);
});

app.post("/auth/save", async (req: Request, res: Response) => {
  if (!requireLocalAuthUi(req, res)) return;
  res.json(await sharedBrowser.saveSessionState());
});

app.post("/auth/save-and-close", async (req: Request, res: Response) => {
  if (!requireLocalAuthUi(req, res)) return;
  res.json(await sharedBrowser.saveSessionAndClose());
});

app.post("/auth/reset-session", async (req: Request, res: Response) => {
  if (!requireLocalAuthUi(req, res)) return;
  res.json(await sharedBrowser.resetSession());
});

async function handleMcpRequest(req: Request, res: Response) {
  if (!authorize(req, res)) return;

  try {
    const sessionId = req.headers["mcp-session-id"];
    let transport: StreamableHTTPServerTransport | undefined;

    if (sessionId && transports[String(sessionId)]) {
      const existingTransport = transports[String(sessionId)];
      if (!(existingTransport instanceof StreamableHTTPServerTransport)) {
        res.status(400).json({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Bad Request: Session exists but uses a different transport protocol"
          },
          id: null
        });
        return;
      }
      transport = existingTransport;
    } else if (!sessionId && req.method === "POST" && isInitializeRequest(req.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (newSessionId) => {
          if (transport) transports[newSessionId] = transport;
        }
      });

      transport.onclose = () => {
        const closedSessionId = transport?.sessionId;
        if (closedSessionId) delete transports[closedSessionId];
      };

      const { server, browser } = createLearnMcpServer(sharedBrowser);
      browsers.add(browser);
      await server.connect(transport);
    } else {
      res.status(400).json({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Bad Request: No valid session ID provided"
        },
        id: null
      });
      return;
    }

    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("Error handling /mcp request:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: "Internal server error"
        },
        id: null
      });
    }
  }
}

app.all("/mcp", handleMcpRequest);

app.get("/sse", async (req: Request, res: Response) => {
  if (!authorize(req, res)) return;

  const transport = new SSEServerTransport("/messages", res);
  transports[transport.sessionId] = transport;

  res.on("close", () => {
    delete transports[transport.sessionId];
  });

  const { server, browser } = createLearnMcpServer(sharedBrowser);
  browsers.add(browser);
  await server.connect(transport);
});

app.post("/messages", async (req: Request, res: Response) => {
  if (!authorize(req, res)) return;

  const sessionId = String(req.query.sessionId ?? "");
  const transport = transports[sessionId];
  if (!(transport instanceof SSEServerTransport)) {
    res.status(400).send("No SSE transport found for sessionId");
    return;
  }

  await transport.handlePostMessage(req, res, req.body);
});

const httpServer = app.listen(port, host, (error?: Error) => {
  if (error) {
    console.error("Failed to start autoUWLearn HTTP MCP server:", error);
    process.exit(1);
  }

  console.error(`autoUWLearn HTTP MCP server listening on http://${host}:${port}`);
  console.error(`Streamable HTTP endpoint: http://${host}:${port}/mcp`);
  console.error(`Legacy SSE endpoint:      http://${host}:${port}/sse`);
});

async function shutdown() {
  for (const sessionId of Object.keys(transports)) {
    await transports[sessionId].close().catch(() => undefined);
    delete transports[sessionId];
  }
  for (const browser of browsers) {
    await browser.close().catch(() => undefined);
  }
  await sharedBrowser.close().catch(() => undefined);
  httpServer.close(() => process.exit(0));
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

function renderAuthPage(status: unknown): string {
  const safeStatus = JSON.stringify(status, null, 2)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>UW LEARN MCP Auth</title>
    <style>
      body { color-scheme: light dark; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 760px; margin: 48px auto; padding: 0 20px; line-height: 1.45; }
      button { font: inherit; padding: 10px 14px; margin: 6px 8px 6px 0; cursor: pointer; }
      pre { border: 1px solid #8885; border-radius: 10px; padding: 14px; overflow: auto; white-space: pre-wrap; }
      .box { border: 1px solid #8885; border-radius: 12px; padding: 18px; }
      .muted { color: #777; }
    </style>
  </head>
  <body>
    <h1>UW LEARN MCP Auth</h1>
    <div class="box">
      <p>This page controls the local Playwright browser session. It does not store your UW password.</p>
      <p class="muted">Click Start login, complete Waterloo SSO/MFA in the opened browser window, then refresh status.</p>
      <button onclick="post('/auth/start')">Start login</button>
      <button onclick="refreshStatus()">Check status</button>
      <button onclick="post('/auth/wait')">Wait for login</button>
      <button onclick="post('/auth/save')">Save session</button>
      <button onclick="post('/auth/save-and-close')">Save session & close browser</button>
      <button onclick="resetSession()">Reset session</button>
    </div>
    <h2>Status</h2>
    <pre id="status">${safeStatus}</pre>
    <script>
      async function refreshStatus() {
        const res = await fetch('/auth/status');
        document.getElementById('status').textContent = JSON.stringify(await res.json(), null, 2);
      }
      async function post(path) {
        const res = await fetch(path, { method: 'POST' });
        document.getElementById('status').textContent = JSON.stringify(await res.json(), null, 2);
      }
      async function resetSession() {
        if (!confirm('Reset the saved UW LEARN browser session? You will need to log in again.')) return;
        await post('/auth/reset-session');
      }
      setInterval(refreshStatus, 5000);
    </script>
  </body>
</html>`;
}
