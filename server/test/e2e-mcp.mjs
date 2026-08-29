/**
 * E2E driver — spawn the built MCP server over stdio and drive it with a
 * real SDK client. Verifies the house is addressable by an agent process.
 *
 *   node server/test/e2e-mcp.mjs
 */
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const serverPath = new URL("../dist/mcp/main.js", import.meta.url).pathname;

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  env: {
    ...process.env,
    DATABASE_URL: "postgres://localhost:5433/poste_restante_test",
    QDRANT_COLLECTION: "letters_test",
  },
});

const client = new Client({ name: "e2e-driver", version: "0.0.0" });
await client.connect(transport);

const tools = await client.listTools();
console.log(`tools: ${tools.tools.length}`);

// Deliver a letter.
const delivered = await client.callTool({
  name: "deliver_letter",
  arguments: {
    letter: {
      envelope: {
        from: "hermes@house",
        to: ["you@house"],
        cc: [],
        thread: "th_e2e",
        kind: "letter",
        lang: "en-AU",
        subject: "the house, addressed",
      },
      time: {
        gregorian: "2026-08-29T17:00:00+04:00",
        frames: [{ frame: "season", value: "autumn" }],
      },
      body: {
        format: "markdown",
        content: "## The house, addressed\n\nAn agent wrote to the house and the house kept it.",
      },
    },
  },
});
const deliveredText = delivered.content
  .filter((c) => c.type === "text")
  .map((c) => c.text)
  .join("\n");
console.log(`deliver: ${deliveredText}`);

// Read the mailbox.
const inbox = await client.callTool({
  name: "read_mailbox",
  arguments: { address: "you@house", limit: 5 },
});
const inboxText = inbox.content
  .filter((c) => c.type === "text")
  .map((c) => c.text)
  .join("\n");
const inboxJson = JSON.parse(inboxText);
console.log(`mailbox: ${inboxJson.letters.length} letters`);

// Search semantically.
const search = await client.callTool({
  name: "search_letters",
  arguments: { text: "agent wrote to the house" },
});
const searchText = search.content
  .filter((c) => c.type === "text")
  .map((c) => c.text)
  .join("\n");
const searchJson = JSON.parse(searchText);
console.log(`search: ${searchJson.letters.length} hits`);

// List frames.
const frames = await client.callTool({ name: "list_frames", arguments: {} });
const framesText = frames.content
  .filter((c) => c.type === "text")
  .map((c) => c.text)
  .join("\n");
console.log(`frames: ${JSON.parse(framesText).frames.length}`);

await client.close();
console.log("E2E OK");
