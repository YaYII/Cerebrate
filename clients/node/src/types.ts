/** v5 Protocol response envelope. */
export interface CerebrateResponse<T = unknown> {
  status: "ok" | "error";
  data?: T;
  error?: {
    code: number;
    message: string;
    exception?: string;
  };
  meta: { protocol: "v5" };
}

/** GET /v1/sense */
export interface SenseData {
  health: "ok" | "degraded";
  warnings: string[];
  total_memories: number;
  total_agents: number;
  latest_event_id: number;
  server_role: string;
}

/** POST /v1/query — params sent in request body */
export interface QueryParams {
  query: string;
  user?: string;
  agent_id?: string;
  project_id?: string;
}

/** Executable next step returned inside query.task */
export interface NextCommand {
  command: string;
  method: "GET" | "POST";
  path: string;
  params: Record<string, unknown>;
}

/** Task action describing what the AI agent should do next */
export interface TaskAction {
  action: "reuse_memory" | "verify_reference" | "solve_fresh" | "cite_policy";
  description: string;
  memory_id?: string;
  instructions: string[];
  next_commands: NextCommand[];
  policy?: unknown;
}

/** POST /v1/query response data */
export interface QueryData {
  query: string;
  found: boolean;
  swarm_result: unknown;
  policy_result: unknown;
  personal: Record<string, unknown>;
  recommendation: "reuse" | "verify" | "new_experience" | "cite_policy";
  task: TaskAction;
}

/** POST /v1/memories/propose — params sent in request body */
export interface ProposeParams {
  title: string;
  content: string;
  category?: string;
  tags?: string[] | string;
  agent_id?: string;
  problem?: string;
  solution?: string;
  project_id?: string;
  life_stage?: "nutrient" | "memory";
  confidence?: number;
  evidence?: string;
  validate?: boolean;
  physical_user?: string;
}

export interface ProposeData {
  memory_id: string;
  requested_life_stage: string;
  life_stage: string;
  agent: string;
  validation: unknown;
  authority: string;
}

/** POST /v1/usages/start */
export interface UseStartParams {
  memory_id: string;
  agent_id: string;
  problem: string;
  project_id?: string;
}

export interface UseStartData {
  usage_id: string;
}

/** POST /v1/usages/finish */
export interface UseFinishParams {
  usage_id: string;
  outcome: "success" | "partial" | "failure";
  feedback?: string;
}

export interface UseFinishData {
  usage_id: string;
  outcome: string;
}

/** POST /v1/consensus/vote */
export interface VoteParams {
  memory_id: string;
  agent_id: string;
  vote: "support" | "oppose" | "abstain";
  evidence?: string;
  confidence?: number;
  project_id?: string;
}

export interface VoteData {
  event_id: number;
}

/** POST /v1/agents/register */
export interface RegisterParams {
  agent_id: string;
  agent_type?: string;
  capabilities?: string[];
  metadata?: Record<string, unknown>;
  physical_user?: string;
}

export interface RegisterData {
  agent_id: string;
}

/** GET /v1/doctrines */
export interface DoctrinesData {
  doctrines: unknown[];
  count: number;
}

/** GET /v1/help */
export interface HelpCommand {
  command: string;
  method: "GET" | "POST";
  path: string;
  description: string;
  params: Record<string, unknown>;
  returns: Record<string, unknown>;
}

export interface HelpData {
  server: string;
  description: string;
  protocol: string;
  session_lifecycle: Record<string, string[]>;
  decision_matrix: Record<string, string>;
  commands: HelpCommand[];
}

/** GET /v1/events */
export interface EventsData {
  events: unknown[];
}

/** POST /v1/evolve */
export interface EvolveData {
  actions: unknown[];
  summary: string;
}

/** Client configuration */
export interface BrainClientOptions {
  baseUrl?: string;
  timeout?: number;
  maxResponseBytes?: number;
}
