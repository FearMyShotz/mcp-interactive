#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { parseArgs } from "util";

const { values } = parseArgs({
  options: {
    url: { type: "string" },
    token: { type: "string" },
    message: { type: "string", default: "Ping from test client" }
  },
  allowPositionals: true
});

if (!values.url || !values.token) {
  console.error("Usage: node test_remote_client.js --url <url> --token <token> [--message <text>]");
  process.exit(1);
}

const transport = new StreamableHTTPClientTransport(new URL(values.url), {
  requestInit: {
    headers: {
      Authorization: `Bearer ${values.token}`
    }
  }
});

const client = new Client({ name: "interactive-test", version: "0.0.1" });

async function main() {
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    console.log("Tools:", tools);
    const response = await client.callTool({
      name: "ask_user",
      arguments: {
        projectName: "Client test",
        message: values.message,
        predefinedOptions: ["OK"]
      }
    });
    console.log("ask_user response:", response);
  } catch (error) {
    console.error("Error:", error);
    process.exitCode = 1;
  } finally {
    await client.close();
  }
}

main();
