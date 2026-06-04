import type {
  BrainClientOptions,
  CerebrateResponse,
  DoctrinesData,
  EventsData,
  EvolveData,
  HelpData,
  ProposeData,
  ProposeParams,
  QueryData,
  QueryParams,
  RegisterData,
  RegisterParams,
  SenseData,
  UseFinishData,
  UseFinishParams,
  UseStartData,
  UseStartParams,
  VoteData,
  VoteParams,
} from "./types.js";

export type * from "./types.js";

const DEFAULT_BASE_URL = "http://127.0.0.1:8765";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024; // 10 MB

/**
 * Zero-dependency HTTP client for Cerebrate Brain Server v5.
 *
 * ```ts
 * const brain = new BrainClient({ baseUrl: "http://localhost:8765" });
 *
 * // Step 1: discover available commands
 * const { data: h } = await brain.help();
 *
 * // Step 2: search swarm memory
 * const { data: q } = await brain.query({
 *   query: "how to deploy",
 *   user: "yangying",
 *   agent_id: "my-agent",
 * });
 *
 * // Step 3: follow task instructions
 * for (const step of q.task.instructions) console.log(step);
 * for (const cmd of q.task.next_commands) {
 *   // execute cmd.method cmd.path with cmd.params
 * }
 * ```
 */
export class BrainClient {
  readonly baseUrl: string;
  readonly timeout: number;
  readonly maxResponseBytes: number;

  constructor(options: BrainClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_BYTES;
  }

  // ── low-level HTTP ──────────────────────────────────────────

  async get<T = unknown>(
    path: string,
    params?: Record<string, string | number>,
  ): Promise<CerebrateResponse<T>> {
    let url = `${this.baseUrl}${path}`;
    if (params && Object.keys(params).length > 0) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) qs.set(k, String(v));
      url += `?${qs}`;
    }
    return this._request<T>("GET", url);
  }

  async post<T = unknown>(
    path: string,
    payload: Record<string, unknown> = {},
  ): Promise<CerebrateResponse<T>> {
    return this._request<T>("POST", `${this.baseUrl}${path}`, payload);
  }

  // ── high-level API (mirrors Brain Server endpoints) ─────────

  /** GET /v1/sense — health check & brain state */
  sense() { return this.get<SenseData>("/v1/sense"); }

  /** GET /v1/help — API discovery document for AI agents */
  help() { return this.get<HelpData>("/v1/help"); }

  /** GET /v1/doctrines — read authoritative doctrines */
  doctrines() { return this.get<DoctrinesData>("/v1/doctrines"); }

  /** POST /v1/query — search swarm memory (returns task field with instructions) */
  query(params: QueryParams) {
    return this.post<QueryData>("/v1/query", params as unknown as Record<string, unknown>);
  }

  /** POST /v1/memories/propose — submit candidate memory */
  propose(params: ProposeParams) {
    const body: Record<string, unknown> = { ...params };
    if (Array.isArray(body.tags)) body.tags = (body.tags as string[]).join(",");
    return this.post<ProposeData>("/v1/memories/propose", body);
  }

  /** POST /v1/usages/start — begin tracking memory reuse */
  useStart(params: UseStartParams) {
    return this.post<UseStartData>("/v1/usages/start", params as unknown as Record<string, unknown>);
  }

  /** POST /v1/usages/finish — complete memory reuse tracking */
  useFinish(params: UseFinishParams) {
    return this.post<UseFinishData>("/v1/usages/finish", params as unknown as Record<string, unknown>);
  }

  /** POST /v1/consensus/vote — submit consensus vote */
  vote(params: VoteParams) {
    return this.post<VoteData>("/v1/consensus/vote", params as unknown as Record<string, unknown>);
  }

  /** POST /v1/agents/register — register an AI agent */
  registerAgent(params: RegisterParams) {
    return this.post<RegisterData>("/v1/agents/register", {
      agent_id: params.agent_id,
      agent_type: params.agent_type ?? "http",
      capabilities: params.capabilities ?? [],
      metadata: params.metadata ?? {},
    });
  }

  /** GET /v1/memories/{id} — read a specific memory */
  getMemory(memoryId: string) {
    return this.get<unknown>(`/v1/memories/${encodeURIComponent(memoryId)}`);
  }

  /** GET /v1/events — read durable event log */
  getEvents(cursor = 0, limit = 100) {
    return this.get<EventsData>("/v1/events", { cursor, limit });
  }

  /** POST /v1/evolve — trigger brain evolution */
  evolve() { return this.post<EvolveData>("/v1/evolve", {}); }

  // ── internal ────────────────────────────────────────────────

  private async _request<T>(
    method: string,
    url: string,
    body?: Record<string, unknown>,
  ): Promise<CerebrateResponse<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    const headers: Record<string, string> = { Accept: "application/json" };
    let bodyText: string | undefined;

    if (body !== undefined) {
      bodyText = JSON.stringify(body);
      headers["Content-Type"] = "application/json; charset=utf-8";
    }

    try {
      const resp = await fetch(url, {
        method,
        headers,
        body: bodyText,
        signal: controller.signal,
      });

      const raw = await readLimitedText(resp, this.maxResponseBytes);

      if (!resp.ok) {
        return (tryParse(raw) ?? err(`HTTP ${resp.status} ${resp.statusText}`, resp.status)) as CerebrateResponse<T>;
      }

      return (tryParse(raw) ?? err(`server returned non-JSON response: ${raw.slice(0, 200)}`, 502)) as CerebrateResponse<T>;
    } catch (e: unknown) {
      const errObj = e as Error;
      if (errObj.name === "AbortError") {
        return err(`request timed out after ${this.timeout}ms`, 504) as CerebrateResponse<T>;
      }
      return err(
        `Brain Server unavailable: ${errObj.message ?? String(e)}`,
        503,
      ) as CerebrateResponse<T>;
    } finally {
      clearTimeout(timer);
    }
  }
}

// ── helpers ───────────────────────────────────────────────────

/** Read response body as text, enforcing a byte limit. */
async function readLimitedText(resp: Response, maxBytes: number): Promise<string> {
  const reader = resp.body?.getReader();
  if (!reader) return "";

  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      reader.cancel();
      throw new Error("response body exceeds size limit");
    }
    chunks.push(value);
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.length;
  }
  return new TextDecoder().decode(merged);
}

function tryParse(raw: string): CerebrateResponse | null {
  try {
    return JSON.parse(raw) as CerebrateResponse;
  } catch {
    return null;
  }
}

function err(message: string, code: number): CerebrateResponse {
  return {
    status: "error",
    error: { code, message },
    meta: { protocol: "v5" },
  };
}
