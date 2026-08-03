#!/usr/bin/env node
/** Cerebrate v5 Node.js CLI. */
import { BrainClient } from "./index.js";

const raw = process.argv.slice(2);
let cmd = "";
const pos: string[] = [];
let i = 0;
while (i < raw.length) {
  const a = raw[i];
  if (a.startsWith("--")) { i += 2; continue; } // skip --flag value
  if (!cmd) { cmd = a; } else { pos.push(a); }
  i++;
}

function flag(name: string, fallback = ""): string {
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === `--${name}` && i + 1 < raw.length) return raw[i + 1];
  }
  return fallback;
}

async function main() {
  const url = flag("url", "http://127.0.0.1:8765");
  const brain = new BrainClient({ baseUrl: url });

  switch (cmd) {
    case "sense": return await brain.sense();
    case "help": return await brain.help();
    case "doctrines": return await brain.doctrines();
    case "query": return await brain.query({ query: pos.join(" ") || flag("query"), user: flag("user","default"), agent_id: flag("agent","node-cli"), project_id: flag("project","") });
    case "propose": return await brain.propose({ title: flag("title",""), content: flag("content",""), category: flag("category","general"), tags: flag("tags",""), agent_id: flag("agent","node-cli"), problem: flag("problem",""), solution: flag("solution",""), project_id: flag("project",""), life_stage: (flag("life-stage","memory") as "nutrient"|"memory"), confidence: parseFloat(flag("confidence","1")), evidence: flag("evidence",""), validate: flag("no-validate") !== "true" });
    case "use-start": return await brain.useStart({ memory_id: flag("memory-id",""), agent_id: flag("agent",""), problem: flag("problem",""), project_id: flag("project","") });
    case "use-finish": return await brain.useFinish({ usage_id: flag("usage-id",""), outcome: flag("outcome","success") as "success"|"partial"|"failure", feedback: flag("feedback","") });
    case "vote": return await brain.vote({ memory_id: flag("memory-id",""), agent_id: flag("agent",""), vote: flag("vote","support") as "support"|"oppose"|"abstain", evidence: flag("evidence",""), confidence: parseFloat(flag("confidence","1")), project_id: flag("project","") });
    case "events": return await brain.getEvents(parseInt(flag("cursor","0")), parseInt(flag("limit","100")));
    case "memory-get": return await brain.getMemory(flag("memory-id",""));
    case "evolve": return await brain.evolve();
    case "register": return await brain.registerAgent({ agent_id: flag("id",""), agent_type: flag("type","node"), capabilities: flag("capabilities","").split(",").filter(Boolean), metadata:{ client:"cerebrate-node-cli" }, physical_user: flag("physical-user", process.env.USER ?? process.env.LOGNAME ?? "") });
    case "project-context": return await brain.projectContext({ project: flag("project",""), action: (flag("action","build") as "build"|"read"|"list"), limit: parseInt(flag("limit","50") || "50", 10) });
    default: return { status: "error", error: { code: 400, message: `unknown command: ${cmd || "(empty)"}` }, meta: { protocol: "v5" } };
  }
}
main().then(r => { process.stdout.write(JSON.stringify(r)+"\n"); process.exit(r.status==="ok"?0:1); }).catch(e => { process.stdout.write(JSON.stringify({ status:"error",error:{code:500,message:e.message??String(e)},meta:{protocol:"v5"}})+"\n"); process.exit(1); });
