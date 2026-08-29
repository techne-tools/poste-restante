/**
 * Poste Restante — the house as an MCP server (stdio entry point).
 *
 *   npm run serve:mcp
 *
 * Builds the house (postgres + qdrant + ollama) and speaks the MCP protocol
 * over stdio. An agent (Hermes, opencode, any MCP client) becomes a resident:
 * deliver letters, read mailboxes, walk the archive, check the whisper.
 *
 * The house is headless: this is a protocol face, not a UI. Pull by default —
 * nothing pushes.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildHouse } from "../index.js";
import { createMcpHouse } from "./server.js";

const house = await buildHouse();
const server = createMcpHouse(house);
const transport = new StdioServerTransport();

await server.connect(transport);
house.log.info("mcp:listening", { transport: "stdio" });

// The house holds; it never interrupts. On shutdown it closes the archive
// cleanly so nothing is left half-written.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    house.log.info("mcp:shutdown", { signal });
    await server.close();
    await house.close();
    process.exit(0);
  });
}
