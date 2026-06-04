#!/usr/bin/env node
/**
 * Cerebrate v5 Node.js CLI.
 *
 * Zero-dependency client. Every command is an HTTP request to the Brain Server.
 *
 * Usage:
 *   node clients/node/dist/cli.js sense
 *   node clients/node/dist/cli.js query "how to deploy" --user yangying --agent claude-code
 */

import { BrainClient } from "./index.js";

const args = process.argv.slice(2);
const cmd = args[0];

function flag(name: string, fallback = ""): string {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] ?? fallback : fallback;
}

async function main() {
  const url = flag("url", "http://127.0.0.1:8765");
  const brain = new BrainClient({ baseUrl: url });

  switch (cmd) {
    case "sense":
      return await brain.sense();
    case "help":
      return await brain.help();
    case "doctrines":
      return await brain.doctrines();
    case "query": {
      const q = args.slice(1).filter(a => !a.startsWith("--")).join(" ") || flag("query");
      return await brain.query({
        query: q,
        user: flag("user", "default"),
        agent_id: flag("agent", "node-cli"),
        project_id: flag("project", ""),
      });
    }
    case "propose":
      return await brain.propose({
        title: flag("title", ""),
        content: flag("content", ""),
        category: flag("category", "general"),
        tags: flag("tags", ""),
        agent_id: flag("agent", "node-cli"),
        problem: flag("problem", ""),
        solution: flag("solution", ""),
        project_id: flag("project", ""),
        life_stage: (flag("life-stage", "memory") as "nutrient" | "memory"),
        confidence: parseFloat(flag("confidence", "1")),
        evidence: flag("evidence", ""),
        validate: flag("no-validate") !== "true",
      });
    case "use-start":
      return await brain.useStart({
        memory_id: flag("memory-id", ""),
        agent_id: flag("agent", ""),
        problem: flag("problem", ""),
        project_id: flag("project", ""),
      });
    case "use-finish":
      return await brain.useFinish({
        usage_id: flag("usage-id", ""),
        outcome: flag("outcome", "success") as "success" | "partial" | "failure",
        feedback: flag("feedback", ""),
      });
    case "vote":
      return await brain.vote({
        memory_id: flag("memory-id", ""),
        agent_id: flag("agent", ""),
        vote: flag("vote", "support") as "support" | "oppose" | "abstain",
        evidence: flag("evidence", ""),
        confidence: parseFloat(flag("confidence", "1")),
        project_id: flag("project", ""),
      });
    case "events":
      return await brain.getEvents(
        parseInt(flag("cursor", "0")),
        parseInt(flag("limit", "100")),
      );
    case "memory-get":
      return await brain.getMemory(flag("memory-id", ""));
    case "evolve":
      return await brain.evolve();
    case "register":
      return await brain.registerAgent({
        agent_id: flag("id", ""),
        agent_type: flag("type", "node"),
        capabilities: flag("capabilities", "").split(",").filter(Boolean),
        metadata: { client: "cerebrate-node-cli" },
      });
    default:
      return {
        status: "error",
        error: { code: 400, message: `unknown command: ${cmd}` },
        meta: { protocol: "v5" },
      };
  }
}

main()
  .then(r => {
    process.stdout.write(JSON.stringify(r) + "\n");
    process.exit(r.status === "ok" ? 0 : 1);
  })
  .catch(e => {
    process.stdout.write(JSON.stringify({
      status: "error",
      error: { code: 500, message: e.message ?? String(e) },
      meta: { protocol: "v5" },
    }) + "\n");
    process.exit(1);
  });
