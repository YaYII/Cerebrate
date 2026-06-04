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
import { request as httpRequest } from "node:http";

export type * from "./types.js";

const DEFAULT_BASE_URL = "http://127.0.0.1:8765";
const DEFAULT_TIMEOUT_MS = 30_000;

function parseUrl(raw: string) {
  const u = new URL(raw);
  return { hostname: u.hostname, port: parseInt(u.port || "8765", 10), protocol: u.protocol };
}

function jsonReq<T>(baseUrl: string, method: string, path: string, body?: Record<string, unknown>, timeout?: number): Promise<CerebrateResponse<T>> {
  return new Promise((resolve) => {
    const { hostname, port } = parseUrl(baseUrl);
    const bodyText = body ? JSON.stringify(body) : undefined;
    const opts: Record<string, unknown> = {
      hostname, port, path, method,
      timeout: timeout ?? DEFAULT_TIMEOUT_MS,
      headers: { Accept: "application/json" },
    };
    if (bodyText) {
      (opts.headers as Record<string,string>)["Content-Type"] = "application/json; charset=utf-8";
      // timeout set on req.setTimeout below
    }
    const req = httpRequest(opts, (res) => {
    req.setTimeout(timeout ?? DEFAULT_TIMEOUT_MS);
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf-8");
        try { resolve(JSON.parse(raw) as CerebrateResponse<T>); } catch {
          resolve({ status: "error", error: { code: 502, message: "non-JSON response" }, meta: { protocol: "v5" } });
        }
      });
    });
    req.on("timeout", () => { req.destroy(); resolve({ status: "error", error: { code: 504, message: "timeout" }, meta: { protocol: "v5" } } as CerebrateResponse<T>); });
    req.on("error", (e: Error) => { resolve({ status: "error", error: { code: 503, message: `unavailable: ${e.message}` }, meta: { protocol: "v5" } } as CerebrateResponse<T>); });
    if (bodyText) req.write(bodyText);
    req.end();
  });
}

function getQSParams(params?: Record<string, string | number>): string {
  if (!params || Object.keys(params).length === 0) return "";
  return "?" + Object.entries(params).map(([k,v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join("&");
}

export class BrainClient {
  readonly baseUrl: string;
  readonly timeout: number;
  constructor(options: BrainClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
  }

  private get<T>(path: string, params?: Record<string, string | number>) {
    return jsonReq<T>(this.baseUrl, "GET", path + getQSParams(params), undefined, this.timeout);
  }
  private post<T>(path: string, payload: Record<string, unknown> = {}) {
    return jsonReq<T>(this.baseUrl, "POST", path, payload, this.timeout);
  }

  sense() { return this.get<SenseData>("/v1/sense"); }
  help() { return this.get<HelpData>("/v1/help"); }
  doctrines() { return this.get<DoctrinesData>("/v1/doctrines"); }
  query(params: QueryParams) { return this.post<QueryData>("/v1/query", params as unknown as Record<string, unknown>); }
  propose(params: ProposeParams) {
    const body: Record<string, unknown> = { ...params };
    if (Array.isArray(body.tags)) body.tags = (body.tags as string[]).join(",");
    return this.post<ProposeData>("/v1/memories/propose", body);
  }
  useStart(params: UseStartParams) { return this.post<UseStartData>("/v1/usages/start", params as unknown as Record<string, unknown>); }
  useFinish(params: UseFinishParams) { return this.post<UseFinishData>("/v1/usages/finish", params as unknown as Record<string, unknown>); }
  vote(params: VoteParams) { return this.post<VoteData>("/v1/consensus/vote", params as unknown as Record<string, unknown>); }
  registerAgent(params: RegisterParams) { return this.post<RegisterData>("/v1/agents/register", { agent_id: params.agent_id, agent_type: params.agent_type ?? "http", capabilities: params.capabilities ?? [], metadata: params.metadata ?? {} }); }
  getMemory(memoryId: string) { return this.get<unknown>(`/v1/memories/${encodeURIComponent(memoryId)}`); }
  getEvents(cursor = 0, limit = 100) { return this.get<EventsData>("/v1/events", { cursor, limit }); }
  getPersonal() { return this.get<unknown>("/v1/personal"); }
  setPersonal(params: { user: string; key: string; value: string; project_id?: string }) { return this.post<{ stored: boolean }>("/v1/personal", params as unknown as Record<string, unknown>); }
  batchProcess(params: { limit?: number; dry_run?: boolean }) { return this.post<{ processed: number }>("/v1/batch/process", params as unknown as Record<string, unknown>); }
  evolve() { return this.post<EvolveData>("/v1/evolve", {}); }
}
