#!/usr/bin/env node
import express from "express";
import { randomUUID } from "crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { initialTools } from "./initial_tools.js";
import electronExecutablePath from "electron";
import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { parseArgs } from "util";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const { values } = parseArgs({
  options: {
    timeout: { type: "string", short: "t", default: "0" },
    port: { type: "string", short: "p", default: "8788" },
    host: { type: "string", short: "h", default: "0.0.0.0" },
    path: { type: "string", default: "/mcp" },
    token: { type: "string" }
  },
  allowPositionals: true
});

const parsedTimeout = Number.parseInt(values.timeout, 10);
const dialogTimeout = Number.isFinite(parsedTimeout) ? parsedTimeout : 0;
const port = parseInt(values.port, 10) || 8788;
const host = values.host || "0.0.0.0";
const basePath = values.path.startsWith("/") ? values.path : `/${values.path}`;
const authToken = values.token || process.env.COPILOT_MCP_INTERACTIVE_TOKEN || process.env.MCP_INTERACTIVE_TOKEN || "";

let electronProcess = null;
const pendingRequests = new Map();

function startElectronGUIWithData(projectName, message, predefinedOptions = [], timeoutOverride = null, textAreaHeight = null) {
  if (electronProcess) {
    electronProcess.kill();
    electronProcess = null;
  }

  const mainPath = path.join(__dirname, "electron-main.cjs");
  const timeoutToUse = timeoutOverride != null ? timeoutOverride : dialogTimeout;
  const textAreaHeightValue = textAreaHeight != null ? String(textAreaHeight) : "";

  const env = {
    ...process.env,
    DIALOG_PROJECT_NAME: projectName,
    DIALOG_MESSAGE: message,
    DIALOG_PREDEFINED_OPTIONS: JSON.stringify(predefinedOptions),
    DIALOG_TIMEOUT: String(timeoutToUse),
    VSCODE_PID: undefined,
    VSCODE_CWD: undefined,
    CURSOR_PID: undefined,
    CURSOR_CWD: undefined,
    ELECTRON_RUN_AS_NODE: undefined,
    ELECTRON_IS_DEV: "0",
    NODE_ENV: "production",
    DIALOG_TEXTAREA_HEIGHT: textAreaHeightValue
  };

  const cacheDir = path.join(os.tmpdir(), "mcp-interactive-cache");
  const userDataDir = path.join(os.tmpdir(), "mcp-interactive-userdata");
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }
  if (!fs.existsSync(userDataDir)) {
    fs.mkdirSync(userDataDir, { recursive: true });
  }

  const electronArgs = [
    mainPath,
    `--user-data-dir=${userDataDir}`,
    `--disk-cache-dir=${cacheDir}`
  ];

  electronProcess = spawn(electronExecutablePath, electronArgs, {
    stdio: ["pipe", "pipe", "pipe"],
    detached: false,
    cwd: __dirname,
    env: env
  });

  electronProcess.stdout.on("data", data => {
    const messageValue = data.toString().trim();
    const lines = messageValue.split("\n");
    for (const line of lines) {
      const trimmedLine = line.trim();
      if (trimmedLine.startsWith("TEXT_FROM_RENDERER:")) {
        const userResponse = trimmedLine.substring("TEXT_FROM_RENDERER:".length).trim();
        handleUserResponse(userResponse);
      } else if (trimmedLine === "DIALOG_TIMEOUT") {
        handleUserResponse("TIMEOUT");
      }
    }
  });

  electronProcess.stderr.on("data", data => {
    const messageValue = data.toString().trim();
    console.error("Electron stderr:", messageValue);
  });

  electronProcess.on("close", code => {
    console.error("Electron process closed with code:", code);
    electronProcess = null;
  });

  electronProcess.on("error", err => {
    console.error("Failed to start Electron GUI:", err.message);
    console.error("Error stack:", err.stack);
  });
}

function handleUserResponse(userResponse) {
  const requestId = Array.from(pendingRequests.keys())[0];
  if (requestId) {
    const { resolve } = pendingRequests.get(requestId);
    pendingRequests.delete(requestId);

    if (userResponse === "TIMEOUT") {
      resolve({
        content: [
          {
            text: "User did not reply: Timeout occurred. Retry calling the function.",
            type: "text"
          }
        ]
      });
    } else if (!userResponse || userResponse.trim() === "") {
      resolve({
        content: [
          {
            text: "User replied with empty input. Retry calling the function.",
            type: "text"
          }
        ]
      });
    } else {
      resolve({
        content: [
          {
            text: `User replied: ${userResponse}`,
            type: "text"
          }
        ]
      });
    }
  }
}

function showDialog(projectName, message, predefinedOptions = []) {
  return new Promise((resolve, reject) => {
    const requestId = Date.now().toString();
    pendingRequests.set(requestId, { resolve, reject });
    startElectronGUIWithData(projectName, message, predefinedOptions, 0);
  });
}

function buildServer() {
  const server = new Server(
    {
      name: "mcp-interactive",
      version: "0.0.1"
    },
    {
      capabilities: {
        tools: {}
      }
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: initialTools
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async request => {
    const { name, arguments: args } = request.params;

    if (name === "ask_user") {
      const { projectName, message, predefinedOptions } = args;
      const result = await showDialog(projectName, message, predefinedOptions);
      return result;
    }

    if (name === "request_user_confirmation") {
      const { projectName, summary } = args;

      return new Promise((resolve, reject) => {
        const requestId = Date.now().toString();
        pendingRequests.set(requestId, { resolve, reject });
        startElectronGUIWithData(projectName, summary, [], 0, 300);
      });
    }

    throw new Error(`Unknown tool: ${name}`);
  });

  return server;
}

function ensureAuthorized(req, res) {
  if (!authToken) {
    return true;
  }
  const headerValue = req.headers["authorization"];
  if (headerValue === `Bearer ${authToken}`) {
    return true;
  }
  res.status(401).json({
    jsonrpc: "2.0",
    error: {
      code: -32001,
      message: "Unauthorized"
    },
    id: null
  });
  return false;
}

const app = express();
app.use(express.json({ limit: "1mb" }));

const sessions = new Map();

async function createSession() {
  const server = buildServer();
  let sessionKey = null;
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: sessionId => {
      sessionKey = sessionId;
      sessions.set(sessionId, { transport, server });
    }
  });
  transport.onclose = () => {
    if (sessionKey && sessions.has(sessionKey)) {
      sessions.delete(sessionKey);
    }
    server.close();
  };
  await server.connect(transport);
  return transport;
}

app.post(basePath, async (req, res) => {
  if (!ensureAuthorized(req, res)) {
    return;
  }
  const sessionId = req.headers["mcp-session-id"];
  let transportEntry = sessionId ? sessions.get(sessionId) : undefined;
  let transport = transportEntry ? transportEntry.transport : undefined;

  try {
    if (!transport) {
      if (!isInitializeRequest(req.body)) {
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
      transport = await createSession();
    }

    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("Error handling MCP request:", error);
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
});

const handleSessionRequest = async (req, res) => {
  if (!ensureAuthorized(req, res)) {
    return;
  }
  const sessionId = req.headers["mcp-session-id"];
  if (!sessionId || !sessions.has(sessionId)) {
    res.status(400).send("Invalid or missing session ID");
    return;
  }
  const { transport } = sessions.get(sessionId);
  try {
    await transport.handleRequest(req, res);
  } catch (error) {
    console.error("Error handling session request:", error);
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
};

app.get(basePath, handleSessionRequest);
app.delete(basePath, handleSessionRequest);

const httpServer = app.listen(port, host, () => {
  console.error(`MCP Interactive HTTP server started on http://${host}:${port}${basePath}`);
});
httpServer.headersTimeout = 0;
httpServer.keepAliveTimeout = 0;
httpServer.requestTimeout = 0;

process.on("SIGINT", () => {
  console.error("Received SIGINT, shutting down gracefully...");
  if (electronProcess) {
    electronProcess.kill();
  }
  httpServer.close(() => {
    process.exit(0);
  });
});

process.on("SIGTERM", () => {
  console.error("Received SIGTERM, shutting down gracefully...");
  if (electronProcess) {
    electronProcess.kill();
  }
  httpServer.close(() => {
    process.exit(0);
  });
});
