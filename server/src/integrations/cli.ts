/**
 * Poste Restante — the integration CLI. The operator registers external
 * MCP servers and grants tools to named agents (SPEC §17, direction B).
 *
 *   npm run integration:add -- web-search npx-mcp-server-name --version 1.2.3 --tool search --tool extract
 *   npm run integration:list
 *   npm run integration:grant -- grantwatch@house web-search search --budget 100
 *   npm run integration:revoke -- grantwatch@house web-search
 *
 * Registration is an operator act, like installing a sidecar — agents
 * never talk to arbitrary URLs, and the house never fetches one. The
 * tool catalog is what the operator declares (enumerated, not
 * discoverable); the grant whitelists which of those the named
 * instrument may call, with a per-frame budget.
 */
import { connectDbAndMigrate } from "../db/index.js";
import { IntegrationService } from "./service.js";
import { loadConfig } from "../config.js";
import { createLogger } from "../pipeline/logger.js";

const USAGE = `usage:
  npm run integration:add -- <id> <npx-url> [--version <v>] [--tool <name>]...
  npm run integration:list
  npm run integration:grant -- <agent> <integration> <tool>... [--budget <n>]
  npm run integration:revoke -- <agent> <integration> [<tool>...]`;

function toolSpecs(args: string[], version: string): { name: string; description: string; verbs: string[] }[] {
  const names = args.filter((a, i) => args[i - 1] === "--tool" && a !== "--version");
  return names.map((name) => ({ name, description: `operator-registered tool on ${version}`, verbs: ["read"] }));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  const config = loadConfig(process.env);
  const db = await connectDbAndMigrate(config.databaseUrl);
  // The CLI speaks directly to the service (the operator's own act) —
  // integration code never runs in-process; the service is pure DB.
  const svc = new IntegrationService(db.pool, {} as never, createLogger());

  try {
    if (command === "add") {
      const id = args[1];
      const url = args[2];
      if (!id || !url) throw new Error(USAGE);
      const versionIdx = args.indexOf("--version");
      const version = versionIdx >= 0 ? args[versionIdx + 1] ?? "latest" : "latest";
      const tools = toolSpecs(args, version);
      await svc.register(id, url, version, tools);
      process.stdout.write(`registered ${id} (${version}) — ${tools.length} tools\n`);
      return;
    }

    if (command === "list") {
      const { rows } = await db.pool.query(
        `SELECT id, url, version, enabled, jsonb_array_length(tools) AS tools,
                (SELECT COUNT(*) FROM agent_integrations WHERE integration_id = i.id) AS grants
         FROM integrations i ORDER BY id`,
      );
      if (rows.length === 0) {
        process.stdout.write("no integrations registered\n");
        return;
      }
      for (const r of rows) {
        process.stdout.write(
          `${r.id}\t${r.url}\t${r.version}${r.enabled ? "" : "\tdisabled"}\t${r.tools} tools\t${r.grants} grants\n`,
        );
      }
      return;
    }

    if (command === "grant") {
      const agent = args[1];
      const integrationId = args[2];
      // Tools are everything after the integration, before --budget.
      const budgetIdx = args.indexOf("--budget");
      const tools = budgetIdx >= 0 ? args.slice(3, budgetIdx).filter(Boolean) : args.slice(3);
      const budget = budgetIdx >= 0 ? Number.parseInt(args[budgetIdx + 1] ?? "100", 10) : 100;
      if (!agent || !integrationId || tools.length === 0) throw new Error(USAGE);
      if (Number.isNaN(budget) || budget < 1) throw new Error("budget must be a positive integer");
      await svc.grant(agent, integrationId, tools, budget);
      process.stdout.write(`granted ${agent} → ${integrationId}: ${tools.join(", ")} (budget ${budget})\n`);
      return;
    }

    if (command === "revoke") {
      const agent = args[1];
      const integrationId = args[2];
      if (!agent || !integrationId) throw new Error(USAGE);
      await db.pool.query(
        `DELETE FROM agent_integrations WHERE agent_address = $1 AND integration_id = $2`,
        [agent, integrationId],
      );
      process.stdout.write(`revoked ${agent} → ${integrationId}\n`);
      return;
    }

    throw new Error(USAGE);
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  process.stderr.write(`integration: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
