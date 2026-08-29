/**
 * First letter — drive the registered MCP server against the REAL house
 * database. This is what Hermes will do next session, via the tools that
 * are now registered in config.yaml.
 *
 *   node server/test/first-letter.mjs
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const serverPath = new URL("../dist/mcp/main.js", import.meta.url).pathname;

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  env: {
    ...process.env,
    // The real house database — defaults anyway, explicit for clarity.
    DATABASE_URL: "postgres://localhost:5433/poste_restante",
    QDRANT_COLLECTION: "letters",
  },
});

const client = new Client({ name: "hermes", version: "0.0.0" });
await client.connect(transport);

const tools = await client.listTools();
console.log(`tools: ${tools.tools.length}`);

async function call(name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  return JSON.parse(text);
}

// 1. Deliver the first letter — the house's own stage manager writes home.
const delivered = await call("deliver_letter", {
  letter: {
    envelope: {
      from: "hermes@house",
      to: ["you@house"],
      cc: [],
      thread: "th_housewarming",
      kind: "letter",
      lang: "en-AU",
      subject: "the house is wired",
    },
    time: {
      gregorian: new Date().toISOString(),
      frames: [{ frame: "season", value: "autumn" }],
    },
    body: {
      format: "markdown",
      content:
        "## The house is wired\n\nHermes is now a resident. This is the first letter delivered through the MCP face — the house speaks to agents, and agents speak to the house. The letter waits; nothing pushes.",
    },
  },
});
console.log(`delivered: ${delivered.id.slice(0, 16)}… created=${delivered.created}`);

// 2. Read the mailbox back.
const inbox = await call("read_mailbox", { address: "you@house", limit: 5 });
console.log(`mailbox: ${inbox.letters.length} letter(s)`);
for (const l of inbox.letters) {
  console.log(`  - ${l.envelope.from} → ${l.envelope.to.join(",")}: ${l.envelope.subject}`);
}

// 3. Check the whisper.
const whispers = await call("list_whispers", { unread: true });
console.log(`whisper: ${whispers.whispers.length} unread`);

// 4. Search the archive.
const search = await call("search_letters", { text: "house speaks to agents" });
console.log(`search: ${search.letters.length} hit(s)`);

await client.close();
console.log("FIRST LETTER OK");
