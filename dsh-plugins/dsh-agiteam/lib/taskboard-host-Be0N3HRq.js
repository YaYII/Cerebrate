import { n as Service, r as Schema } from "./lib--7yKgOXA.js";
import { i as brandString, l as Remote, n as ReasoningEffortId, r as createUserMessage, u as TypertRemoteService } from "./lib--NywRvM5.js";
import { t as defineTool } from "./lib-BNNK1uDf.js";
import { a as boolean, d as string$1, i as array, l as object, n as domainTable, o as discriminatedUnion, s as literal, t as defineDomain } from "./lib-Bj8I1VnZ.js";
import "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { closeSync, createReadStream, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { pipeline } from "node:stream/promises";
//#region lib/taskboard-host/domain/error.js
/** Stable domain error returned across CLI, tool, and RPC boundaries. */
var TaskboardError = class extends Error {
	code;
	details;
	constructor(message, code, details) {
		super(message);
		this.code = code;
		this.details = details;
		this.name = "TaskboardError";
	}
};
//#endregion
//#region lib/taskboard-host/domain/ids.js
function nonEmpty(value, label) {
	if (typeof value !== "string" || value.trim().length === 0) throw new TypeError(`${label} must be a non-empty string`);
	return value;
}
const ProjectId = (value) => nonEmpty(value, "project id");
const TaskId = (value) => nonEmpty(value, "task id");
const CommentId = (value) => nonEmpty(value, "comment id");
const RelationId = (value) => nonEmpty(value, "relation id");
const ClaimId = (value) => nonEmpty(value, "claim id");
const ActivityId = (value) => nonEmpty(value, "activity id");
const AttachmentId = (value) => nonEmpty(value, "attachment id");
const WorkflowId = (value) => nonEmpty(value, "workflow id");
const AutomationId = (value) => nonEmpty(value, "automation id");
//#endregion
//#region lib/taskboard-host/domain/types.js
const TASK_STATUSES = [
	"backlog",
	"todo",
	"in_progress",
	"in_review",
	"blocked",
	"done",
	"canceled"
];
//#endregion
//#region lib/taskboard-host/domain/policy.js
/** Parse a UI/CLI status token into the closed Taskboard vocabulary. */
function parseTaskStatus(value) {
	if (!TASK_STATUSES.includes(value)) throw new TaskboardError(`unknown task status ${value}`, "TASK_INVALID_INPUT", { status: value });
	return value;
}
/** Assert that an operation carries direct human authority. */
function requireHuman(actor, operation) {
	if (actor.kind !== "human") throw new TaskboardError(`${operation} requires human authority`, "TASK_HUMAN_AUTHORITY_REQUIRED", { operation });
}
/** Validate a source status for one intent-specific transition. */
function requireStatus(current, allowed, operation) {
	if (!allowed.includes(current)) throw new TaskboardError(`${operation} cannot move a task from ${current}`, "TASK_INVALID_TRANSITION", {
		operation,
		current,
		allowed
	});
}
/** Per-parent lookup indexes. Without these, task detail alone drives three full table scans. */
const LOOKUP_INDEXES = [
	{
		table: "comments",
		sql: "CREATE INDEX IF NOT EXISTS comments_task_time ON comments(task_id, created_at)"
	},
	{
		table: "attachments",
		sql: "CREATE INDEX IF NOT EXISTS attachments_task_time ON attachments(task_id, created_at)"
	},
	{
		table: "attachments",
		sql: "CREATE INDEX IF NOT EXISTS attachments_comment ON attachments(comment_id)"
	},
	{
		table: "task_relations",
		sql: "CREATE INDEX IF NOT EXISTS relations_source_time ON task_relations(source_task_id, created_at)"
	},
	{
		table: "task_relations",
		sql: "CREATE INDEX IF NOT EXISTS relations_target_time ON task_relations(target_task_id, created_at)"
	},
	{
		table: "task_claims",
		sql: "CREATE INDEX IF NOT EXISTS claims_state_time ON task_claims(state, claimed_at)"
	},
	{
		table: "automation_runs",
		sql: "CREATE INDEX IF NOT EXISTS automation_runs_rule_time ON automation_runs(rule_id, created_at)"
	},
	{
		table: "tasks",
		sql: "CREATE INDEX IF NOT EXISTS tasks_workflow ON tasks(workflow_id) WHERE workflow_id IS NOT NULL"
	}
];
const ALL_LOOKUP_INDEX_DDL = LOOKUP_INDEXES.map((index) => `${index.sql};`).join("\n");
/** Skip indexes whose table is absent so one partially-created database cannot block the upgrade. */
function lookupIndexDdl(db) {
	const present = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
	return LOOKUP_INDEXES.filter((index) => present.has(index.table)).map((index) => `${index.sql};`).join("\n");
}
/** Open and initialize the authoritative Taskboard database. */
function openTaskboardDatabase(path) {
	if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
	const db = new DatabaseSync(path);
	db.exec("PRAGMA foreign_keys = ON");
	if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
	const row = db.prepare("PRAGMA user_version").get();
	if (row.user_version > 4 || row.user_version < 0) {
		db.close();
		throw new TaskboardError(`taskboard schema ${row.user_version} is unsupported; expected 4`, "STORAGE_SCHEMA_UNSUPPORTED", {
			onDisk: row.user_version,
			supported: 4
		});
	}
	if (row.user_version === 0) initialize(db);
	else if (row.user_version === 1) migrateV1ToV2(db);
	if (row.user_version === 1 || row.user_version === 2) migrateV2ToV3(db);
	if (row.user_version >= 1 && row.user_version <= 3) migrateV3ToV4(db);
	return db;
}
function migrateV3ToV4(db) {
	db.exec(`
    BEGIN IMMEDIATE;
    ${lookupIndexDdl(db)}
    PRAGMA user_version = 4;
    COMMIT;
  `);
}
function migrateV1ToV2(db) {
	db.exec(`
    BEGIN IMMEDIATE;
    CREATE TABLE attachment_cleanup (
      storage_key TEXT PRIMARY KEY,
      reason TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT;
    PRAGMA user_version = 2;
    COMMIT;
  `);
}
function migrateV2ToV3(db) {
	db.exec(`
    BEGIN IMMEDIATE;
    ALTER TABLE task_claims ADD COLUMN automation_id TEXT;
    PRAGMA user_version = 3;
    COMMIT;
  `);
}
function initialize(db) {
	db.exec(`
    BEGIN IMMEDIATE;
    CREATE TABLE taskboard_meta (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      global_revision INTEGER NOT NULL
    ) STRICT;
    INSERT INTO taskboard_meta(singleton, global_revision) VALUES (1, 0);

    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      key TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      workspace_id TEXT,
      labels_json TEXT NOT NULL,
      next_issue_number INTEGER NOT NULL,
      version INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      identifier TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('backlog','todo','in_progress','in_review','blocked','done','canceled')),
      priority TEXT NOT NULL CHECK (priority IN ('urgent','high','medium','low','none')),
      labels_json TEXT NOT NULL,
      sort_order REAL NOT NULL,
      assignee TEXT,
      creator TEXT NOT NULL,
      start_date TEXT,
      due_date TEXT,
      recurrence_json TEXT,
      workflow_id TEXT,
      development_context_json TEXT,
      source_json TEXT,
      archived_at INTEGER,
      version INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX tasks_project_status_order ON tasks(project_id, status, sort_order, created_at);

    CREATE TABLE task_claims (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      automation_id TEXT,
      expected_task_version INTEGER NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('active','orphaned','released','submitted','reclaimed')),
      development_context_json TEXT,
      claimed_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT;
    CREATE UNIQUE INDEX task_one_active_claim ON task_claims(task_id) WHERE state IN ('active','orphaned');

    CREATE TABLE task_relations (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      source_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      target_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('parent','blocks','related')),
      actor_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(source_task_id, target_task_id, kind),
      CHECK(source_task_id <> target_task_id)
    ) STRICT;
    CREATE UNIQUE INDEX task_one_parent ON task_relations(source_task_id) WHERE kind = 'parent';

    CREATE TABLE comments (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      body TEXT NOT NULL,
      author_id TEXT NOT NULL,
      session_id TEXT,
      version INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE task_activities (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      actor_kind TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      before_json TEXT,
      after_json TEXT,
      created_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX task_activity_time ON task_activities(task_id, created_at, id);

    CREATE TABLE attachments (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      comment_id TEXT REFERENCES comments(id) ON DELETE CASCADE,
      storage_key TEXT NOT NULL UNIQUE,
      filename TEXT NOT NULL,
      content_type TEXT NOT NULL,
      byte_size INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE attachment_cleanup (
      storage_key TEXT PRIMARY KEY,
      reason TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE workflow_workspaces (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      document_json TEXT NOT NULL,
      version INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE automation_rules (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      config_json TEXT NOT NULL,
      state TEXT NOT NULL,
      version INTEGER NOT NULL,
      last_decision_json TEXT,
      next_eligible_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE automation_runs (
      id TEXT PRIMARY KEY,
      rule_id TEXT NOT NULL REFERENCES automation_rules(id) ON DELETE CASCADE,
      decision_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    ) STRICT;
    ${ALL_LOOKUP_INDEX_DDL}
    PRAGMA user_version = 4;
    COMMIT;
  `);
}
//#endregion
//#region lib/taskboard-host/sqlite/provider.js
const DEFAULT_ATTACHMENT_OPTIONS = {
	root: ".dsh/taskboard-attachments",
	maxAttachmentBytes: 25 * 1024 * 1024,
	maxTaskAttachmentBytes: 100 * 1024 * 1024,
	allowedContentTypes: [
		"application/json",
		"application/octet-stream",
		"application/pdf",
		"application/zip",
		"image/gif",
		"image/jpeg",
		"image/png",
		"image/webp",
		"text/markdown",
		"text/plain"
	],
	allowSharedWorktrees: false
};
const INLINE_CONTENT_TYPES = new Set([
	"image/gif",
	"image/jpeg",
	"image/png",
	"image/webp"
]);
function id(prefix) {
	return `${prefix}-${randomUUID()}`;
}
function now() {
	return Date.now();
}
function requiredText(value, label) {
	if (typeof value !== "string" || value.trim().length === 0) throw new TaskboardError(`${label} must be a non-empty string`, "TASK_INVALID_INPUT", { label });
	return value.trim();
}
function rewriteLabels(labels, from, to) {
	const next = [];
	const seen = /* @__PURE__ */ new Set();
	for (const label of labels) {
		const mapped = label === from ? to : label;
		if (mapped === void 0 || mapped === "" || seen.has(mapped)) continue;
		seen.add(mapped);
		next.push(mapped);
	}
	return next;
}
function projectKey(value) {
	const key = requiredText(value, "project key").toUpperCase();
	if (!/^[A-Z][A-Z0-9]{1,9}$/.test(key)) throw new TaskboardError("project key must contain 2-10 uppercase letters or digits and begin with a letter", "TASK_INVALID_INPUT");
	return key;
}
function json(value) {
	return JSON.stringify(value);
}
function parseJson(value, label) {
	if (typeof value !== "string") throw new TaskboardError(`${label} is not stored as JSON`, "TASK_INVALID_INPUT");
	try {
		return JSON.parse(value);
	} catch (cause) {
		throw new TaskboardError(`${label} contains invalid JSON`, "TASK_INVALID_INPUT", { cause: String(cause) });
	}
}
function optionalJson(value, label) {
	return value === null ? void 0 : parseJson(value, label);
}
function optionalString(value) {
	return typeof value === "string" ? value : void 0;
}
function optionalNumber(value) {
	return typeof value === "number" ? value : void 0;
}
function mapProject(row) {
	const workspaceId = optionalString(row["workspace_id"]);
	return {
		id: ProjectId(String(row["id"])),
		key: String(row["key"]),
		name: String(row["name"]),
		...workspaceId === void 0 ? {} : { workspaceId },
		labels: parseJson(row["labels_json"], "project labels"),
		nextIssueNumber: Number(row["next_issue_number"]),
		version: Number(row["version"]),
		createdAt: Number(row["created_at"]),
		updatedAt: Number(row["updated_at"])
	};
}
function mapTask(row) {
	const assignee = optionalString(row["assignee"]);
	const startDate = optionalString(row["start_date"]);
	const dueDate = optionalString(row["due_date"]);
	const recurrence = optionalJson(row["recurrence_json"], "task recurrence");
	const workflowId = optionalString(row["workflow_id"]);
	const developmentContext = optionalJson(row["development_context_json"], "development context");
	const source = optionalJson(row["source_json"], "task source");
	const archivedAt = optionalNumber(row["archived_at"]);
	return {
		id: TaskId(String(row["id"])),
		projectId: ProjectId(String(row["project_id"])),
		identifier: String(row["identifier"]),
		title: String(row["title"]),
		description: String(row["description"]),
		status: row["status"],
		priority: row["priority"],
		labels: parseJson(row["labels_json"], "task labels"),
		sortOrder: Number(row["sort_order"]),
		...assignee === void 0 ? {} : { assignee },
		creator: String(row["creator"]),
		...startDate === void 0 ? {} : { startDate },
		...dueDate === void 0 ? {} : { dueDate },
		...recurrence === void 0 ? {} : { recurrence },
		...workflowId === void 0 ? {} : { workflowId },
		...developmentContext === void 0 ? {} : { developmentContext },
		...source === void 0 ? {} : { source },
		...archivedAt === void 0 ? {} : { archivedAt },
		version: Number(row["version"]),
		createdAt: Number(row["created_at"]),
		updatedAt: Number(row["updated_at"])
	};
}
function mapComment(row) {
	const sessionId = optionalString(row["session_id"]);
	return {
		id: CommentId(String(row["id"])),
		taskId: TaskId(String(row["task_id"])),
		body: String(row["body"]),
		authorId: String(row["author_id"]),
		...sessionId === void 0 ? {} : { sessionId },
		version: Number(row["version"]),
		createdAt: Number(row["created_at"]),
		updatedAt: Number(row["updated_at"])
	};
}
function mapRelation(row) {
	return {
		id: RelationId(String(row["id"])),
		projectId: ProjectId(String(row["project_id"])),
		sourceTaskId: TaskId(String(row["source_task_id"])),
		targetTaskId: TaskId(String(row["target_task_id"])),
		kind: row["kind"],
		actorId: String(row["actor_id"]),
		createdAt: Number(row["created_at"])
	};
}
function mapClaim(row) {
	const developmentContext = optionalJson(row["development_context_json"], "claim development context");
	const automationId = optionalString(row["automation_id"]);
	return {
		id: ClaimId(String(row["id"])),
		taskId: TaskId(String(row["task_id"])),
		sessionId: String(row["session_id"]),
		agentId: String(row["agent_id"]),
		...automationId === void 0 ? {} : { automationId },
		expectedTaskVersion: Number(row["expected_task_version"]),
		state: row["state"],
		...developmentContext === void 0 ? {} : { developmentContext },
		claimedAt: Number(row["claimed_at"]),
		updatedAt: Number(row["updated_at"])
	};
}
function mapActivity(row) {
	const before = optionalJson(row["before_json"], "activity before value");
	const after = optionalJson(row["after_json"], "activity after value");
	return {
		id: ActivityId(String(row["id"])),
		taskId: TaskId(String(row["task_id"])),
		kind: String(row["kind"]),
		actorKind: row["actor_kind"],
		actorId: String(row["actor_id"]),
		...before === void 0 ? {} : { before },
		...after === void 0 ? {} : { after },
		createdAt: Number(row["created_at"])
	};
}
function mapAttachment(row) {
	const commentId = optionalString(row["comment_id"]);
	return {
		id: AttachmentId(String(row["id"])),
		taskId: TaskId(String(row["task_id"])),
		...commentId === void 0 ? {} : { commentId: CommentId(commentId) },
		filename: String(row["filename"]),
		contentType: String(row["content_type"]),
		byteSize: Number(row["byte_size"]),
		createdAt: Number(row["created_at"])
	};
}
function mapWorkflow(row) {
	return {
		id: WorkflowId(String(row["id"])),
		projectId: ProjectId(String(row["project_id"])),
		name: String(row["name"]),
		document: parseJson(row["document_json"], "workflow document"),
		version: Number(row["version"]),
		createdAt: Number(row["created_at"]),
		updatedAt: Number(row["updated_at"])
	};
}
function mapAutomation(row) {
	const lastDecision = optionalJson(row["last_decision_json"], "automation decision");
	const nextEligibleAt = optionalNumber(row["next_eligible_at"]);
	return {
		id: AutomationId(String(row["id"])),
		projectId: ProjectId(String(row["project_id"])),
		config: parseJson(row["config_json"], "automation config"),
		state: row["state"],
		version: Number(row["version"]),
		...lastDecision === void 0 ? {} : { lastDecision },
		...nextEligibleAt === void 0 ? {} : { nextEligibleAt },
		createdAt: Number(row["created_at"]),
		updatedAt: Number(row["updated_at"])
	};
}
function mapAutomationRun(row) {
	return {
		id: String(row["id"]),
		ruleId: AutomationId(String(row["rule_id"])),
		decision: parseJson(row["decision_json"], "automation run"),
		createdAt: Number(row["created_at"])
	};
}
/** Response headers shared by the buffered and streamed download paths. */
function attachmentHeaders(attachment, disposition) {
	const effective = disposition === "inline" && INLINE_CONTENT_TYPES.has(attachment.contentType) ? "inline" : "attachment";
	return {
		"content-type": attachment.contentType,
		"content-length": String(attachment.byteSize),
		"content-disposition": `${effective}; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`,
		"x-content-type-options": "nosniff",
		"content-security-policy": "default-src 'none'; sandbox"
	};
}
const AUTOMATION_RUN_KEEP = 80;
const STATEMENT_CACHE_LIMIT = 256;
/** Hard ceiling for one task page; callers ask for less and learn the total from countTasks. */
const TASK_PAGE_LIMIT = 2e3;
/** Local transactional Taskboard authority backed by one SQLite database. */
var SqliteTaskboardProvider = class {
	db;
	attachmentOptions;
	changeListeners = /* @__PURE__ */ new Set();
	integrity = "unknown";
	integrityCheckedAt = 0;
	statements = /* @__PURE__ */ new Map();
	transactionActivities;
	constructor(path, attachmentOptions) {
		this.db = openTaskboardDatabase(path);
		this.attachmentOptions = {
			...DEFAULT_ATTACHMENT_OPTIONS,
			...attachmentOptions,
			root: resolve(attachmentOptions?.root ?? DEFAULT_ATTACHMENT_OPTIONS.root),
			allowedContentTypes: [...attachmentOptions?.allowedContentTypes ?? DEFAULT_ATTACHMENT_OPTIONS.allowedContentTypes]
		};
		this.validateAttachmentOptions();
		this.refreshIntegrity();
		this.retryAttachmentCleanup();
	}
	close() {
		this.changeListeners.clear();
		this.statements.clear();
		this.db.close();
	}
	/** Compile once and reuse; every statement here is fully materialized before it is reused. */
	sql(text) {
		const cached = this.statements.get(text);
		if (cached !== void 0) return cached;
		const statement = this.db.prepare(text);
		if (this.statements.size >= STATEMENT_CACHE_LIMIT) this.statements.clear();
		this.statements.set(text, statement);
		return statement;
	}
	/** Subscribe to detached invalidations published only after an authoritative commit. */
	subscribe(listener) {
		this.changeListeners.add(listener);
		return () => {
			this.changeListeners.delete(listener);
		};
	}
	globalRevision() {
		const row = this.sql("SELECT global_revision FROM taskboard_meta WHERE singleton = 1").get();
		return Number(row["global_revision"]);
	}
	createProject(request, actor) {
		requireHuman(actor, "create project");
		const key = projectKey(request.key);
		const name = requiredText(request.name, "project name");
		const timestamp = now();
		const projectId = ProjectId(id("project"));
		this.transaction(() => {
			this.sql(`
        INSERT INTO projects(id, key, name, workspace_id, labels_json, next_issue_number, version, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?)
      `).run(projectId, key, name, request.workspaceId ?? null, json(request.labels ?? []), timestamp, timestamp);
			this.bumpRevision();
		});
		return this.getProject(projectId);
	}
	getProject(projectId) {
		const row = this.sql("SELECT * FROM projects WHERE id = ?").get(projectId);
		if (row === void 0) throw new TaskboardError(`project ${projectId} was not found`, "PROJECT_NOT_FOUND", { projectId });
		return mapProject(row);
	}
	listProjects() {
		return this.sql("SELECT * FROM projects ORDER BY created_at, id").all().map(mapProject);
	}
	updateProject(projectId, expectedVersion, request, actor) {
		requireHuman(actor, "update project");
		return this.transaction(() => {
			const current = this.getProject(projectId);
			this.expectVersion(current.version, expectedVersion, "project");
			const sets = [];
			const values = [];
			if (request.name !== void 0) {
				sets.push("name = ?");
				values.push(requiredText(request.name, "project name"));
			}
			if (request.workspaceId !== void 0) {
				sets.push("workspace_id = ?");
				values.push(request.workspaceId === null ? null : requiredText(request.workspaceId, "workspace id"));
			}
			if (request.labels !== void 0) {
				sets.push("labels_json = ?");
				values.push(json(request.labels));
			}
			if (sets.length === 0) throw new TaskboardError("project update contains no fields", "TASK_INVALID_INPUT");
			const timestamp = now();
			this.sql(`UPDATE projects SET ${sets.join(", ")}, version = version + 1, updated_at = ? WHERE id = ? AND version = ?`).run(...values, timestamp, projectId, expectedVersion);
			this.bumpRevision();
			return this.getProject(projectId);
		});
	}
	deleteProject(projectId, expectedVersion, actor) {
		requireHuman(actor, "delete project");
		this.transaction(() => {
			const project = this.getProject(projectId);
			this.expectVersion(project.version, expectedVersion, "project");
			const row = this.sql("SELECT COUNT(*) AS count FROM tasks WHERE project_id = ?").get(projectId);
			if (Number(row["count"]) !== 0) throw new TaskboardError("project deletion requires an empty project", "PROJECT_NOT_EMPTY", { projectId });
			this.sql("DELETE FROM projects WHERE id = ?").run(projectId);
			this.bumpRevision();
		});
	}
	createTask(request, actor) {
		const title = requiredText(request.title, "task title");
		const creator = requiredText(request.creator, "task creator");
		const status = request.status ?? "backlog";
		if (status !== "backlog" && status !== "todo") throw new TaskboardError(`task creation cannot start at ${String(status)}`, "TASK_INVALID_INPUT", { status });
		if (status === "todo") requireHuman(actor, "approve task at creation");
		this.validateDevelopmentContext(request.developmentContext);
		this.validateTaskFields(request);
		const taskId = TaskId(id("task"));
		this.transaction(() => {
			const project = this.getProject(request.projectId);
			const identifier = `${project.key}-${project.nextIssueNumber}`;
			const timestamp = now();
			this.sql(`
        INSERT INTO tasks(
          id, project_id, identifier, title, description, status, priority, labels_json, sort_order,
          assignee, creator, start_date, due_date, recurrence_json, workflow_id,
          development_context_json, source_json, archived_at, version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, ?, ?)
      `).run(taskId, request.projectId, identifier, title, request.description ?? "", status, request.priority ?? "none", json(request.labels ?? []), request.sortOrder ?? project.nextIssueNumber * 1e3, request.assignee ?? null, creator, request.startDate ?? null, request.dueDate ?? null, request.recurrence === void 0 ? null : json(request.recurrence), request.workflowId ?? null, request.developmentContext === void 0 ? null : json(request.developmentContext), request.source === void 0 ? null : json(request.source), timestamp, timestamp);
			this.sql("UPDATE projects SET next_issue_number = next_issue_number + 1, version = version + 1, updated_at = ? WHERE id = ?").run(timestamp, request.projectId);
			this.activity(taskId, "task.created", actor, void 0, {
				identifier,
				status
			}, timestamp);
			this.bumpRevision();
		});
		return this.getTask(taskId);
	}
	getTask(taskIdOrIdentifier) {
		const row = this.sql("SELECT * FROM tasks WHERE id = ? OR identifier = ?").get(taskIdOrIdentifier, taskIdOrIdentifier);
		if (row === void 0) throw new TaskboardError(`task ${taskIdOrIdentifier} was not found`, "TASK_NOT_FOUND", { taskId: taskIdOrIdentifier });
		return mapTask(row);
	}
	/** `activityLimit` bounds the oldest-first activity log, which grows without limit per task.
	*  Pass 0 to omit it entirely; callers that do not render or read history should. */
	getTaskDetail(taskId, options = {}) {
		const task = this.getTask(taskId);
		const comments = this.sql("SELECT * FROM comments WHERE task_id = ? ORDER BY created_at, rowid").all(taskId).map(mapComment);
		const activityLimit = Math.max(0, Math.trunc(options.activityLimit ?? 50));
		const activityTotal = Number(this.sql("SELECT COUNT(*) AS count FROM task_activities WHERE task_id = ?").get(taskId)["count"]);
		const activities = activityLimit === 0 ? [] : this.sql("SELECT * FROM task_activities WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?").all(taskId, activityLimit).map(mapActivity).reverse();
		const relations = this.sql("SELECT * FROM task_relations WHERE source_task_id = ? OR target_task_id = ? ORDER BY created_at, rowid").all(taskId, taskId).map(mapRelation);
		const attachments = this.sql("SELECT * FROM attachments WHERE task_id = ? ORDER BY created_at, rowid").all(taskId).map(mapAttachment);
		const active = this.activeClaimRow(taskId);
		const claims = this.sql("SELECT * FROM task_claims WHERE task_id = ? ORDER BY claimed_at, rowid").all(taskId).map(mapClaim);
		return {
			task,
			comments,
			activities,
			activityTotal,
			relations,
			attachments,
			...active === void 0 ? {} : { activeClaim: mapClaim(active) },
			claims,
			globalRevision: this.globalRevision()
		};
	}
	taskFilterSql(filter) {
		this.getProject(filter.projectId);
		const clauses = ["project_id = ?"];
		const values = [filter.projectId];
		if (filter.archivedOnly === true) clauses.push("archived_at IS NOT NULL");
		else if (filter.includeArchived !== true) clauses.push("archived_at IS NULL");
		if (filter.statuses !== void 0 && filter.statuses.length > 0) {
			clauses.push(`status IN (${filter.statuses.map(() => "?").join(",")})`);
			values.push(...filter.statuses);
		}
		if (filter.search !== void 0 && filter.search.trim().length > 0) {
			clauses.push("(identifier LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')");
			const escaped = filter.search.trim().replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
			values.push(`%${escaped}%`, `%${escaped}%`, `%${escaped}%`);
		}
		return {
			where: clauses.join(" AND "),
			values
		};
	}
	/** Total tasks matching a filter, so a bounded page can report what it left out. */
	countTasks(filter) {
		const { where, values } = this.taskFilterSql(filter);
		const row = this.sql(`SELECT COUNT(*) AS count FROM tasks WHERE ${where}`).get(...values);
		return Number(row["count"]);
	}
	listTasks(filter) {
		const { where, values } = this.taskFilterSql(filter);
		const limit = Math.min(Math.max(filter.limit ?? 100, 1), TASK_PAGE_LIMIT);
		const offset = Math.max(filter.offset ?? 0, 0);
		return this.sql(`
      SELECT * FROM tasks WHERE ${where}
      ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END,
      sort_order, created_at, id LIMIT ? OFFSET ?
    `).all(...values, limit, offset).map(mapTask);
	}
	updateTask(taskId, expectedVersion, request, actor) {
		this.validateDevelopmentContext(request.developmentContext ?? void 0);
		return this.transaction(() => {
			const current = this.mutableTask(taskId, expectedVersion);
			this.validateTaskFields(request, current.projectId);
			const sets = [];
			const values = [];
			const fields = [
				[
					"title",
					"title",
					(value) => requiredText(String(value), "task title")
				],
				[
					"description",
					"description",
					(value) => String(value)
				],
				[
					"priority",
					"priority",
					(value) => String(value)
				],
				[
					"labels",
					"labels_json",
					(value) => json(value)
				],
				[
					"sortOrder",
					"sort_order",
					(value) => Number(value)
				],
				[
					"assignee",
					"assignee",
					(value) => value === null ? null : String(value)
				],
				[
					"startDate",
					"start_date",
					(value) => value === null ? null : String(value)
				],
				[
					"dueDate",
					"due_date",
					(value) => value === null ? null : String(value)
				],
				[
					"recurrence",
					"recurrence_json",
					(value) => value === null ? null : json(value)
				],
				[
					"workflowId",
					"workflow_id",
					(value) => value === null ? null : String(value)
				],
				[
					"developmentContext",
					"development_context_json",
					(value) => value === null ? null : json(value)
				]
			];
			for (const [key, column, encode] of fields) if (request[key] !== void 0) {
				sets.push(`${column} = ?`);
				values.push(encode(request[key]));
			}
			if (sets.length === 0) throw new TaskboardError("task update contains no fields", "TASK_INVALID_INPUT");
			const timestamp = now();
			this.sql(`UPDATE tasks SET ${sets.join(", ")}, version = version + 1, updated_at = ? WHERE id = ? AND version = ?`).run(...values, timestamp, taskId, expectedVersion);
			const updated = this.getTask(taskId);
			this.activity(taskId, "task.updated", actor, current, updated, timestamp);
			this.bumpRevision();
			return updated;
		});
	}
	approve(taskId, expectedVersion, actor) {
		requireHuman(actor, "approve");
		return this.transition(taskId, expectedVersion, ["backlog"], "todo", "task.approved", actor);
	}
	claim(taskId, request, actor) {
		if (actor.kind === "human") throw new TaskboardError("a task claim requires an Agent or automation owner", "TASK_INVALID_INPUT");
		if (actor.sessionId !== request.sessionId || actor.agentId !== request.agentId) throw new TaskboardError("claim owner does not match the acting Agent", "TASK_FOREIGN_CLAIM");
		return this.transaction(() => {
			const current = this.mutableTask(taskId, request.expectedVersion);
			requireStatus(current.status, ["todo"], "claim");
			if (this.activeClaimRow(taskId) !== void 0) throw new TaskboardError("task already has an active claim", "TASK_ALREADY_CLAIMED", { taskId });
			this.assertDevelopmentContextFree(taskId, current.developmentContext);
			const dependency = this.sql(`
        SELECT dependency.identifier, dependency.status
        FROM task_relations relation
        JOIN tasks dependency ON dependency.id = relation.source_task_id
        WHERE relation.kind = 'blocks' AND relation.target_task_id = ? AND dependency.status <> 'done'
        ORDER BY dependency.identifier LIMIT 1
      `).get(taskId);
			if (dependency !== void 0) throw new TaskboardError(`task is blocked by unfinished dependency ${String(dependency["identifier"])}`, "TASK_DEPENDENCY_INCOMPLETE", {
				dependency: dependency["identifier"],
				status: dependency["status"]
			});
			const timestamp = now();
			const claimId = ClaimId(id("claim"));
			this.sql(`
        INSERT INTO task_claims(id, task_id, session_id, agent_id, automation_id, expected_task_version, state, development_context_json, claimed_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
      `).run(claimId, taskId, request.sessionId, request.agentId, actor.kind === "automation" ? actor.automationId : null, request.expectedVersion, current.developmentContext === void 0 ? null : json(current.developmentContext), timestamp, timestamp);
			this.writeStatus(taskId, request.expectedVersion, "in_progress", timestamp);
			const task = this.getTask(taskId);
			this.activity(taskId, "task.claimed", actor, { status: current.status }, {
				status: task.status,
				claimId
			}, timestamp);
			this.bumpRevision();
			return {
				task,
				claim: mapClaim(this.claimById(claimId))
			};
		});
	}
	/** Bind a human-created native Session to a task before the Session starts working.
	*
	* The browser is allowed to initiate this association, but the resulting claim is owned by the
	* Session's Agent id. That keeps model tools and Goal lifecycle events subject to the same
	* ownership checks as an automation-created worker. */
	bindHumanSession(taskId, expectedVersion, request, actor) {
		requireHuman(actor, "bind native Session");
		return this.transaction(() => {
			const current = this.mutableTask(taskId, expectedVersion);
			requireStatus(current.status, ["todo", "in_progress"], "bind native Session");
			const timestamp = now();
			const claimId = this.insertFreshClaim(taskId, expectedVersion, current.developmentContext, request, timestamp);
			if (current.status === "todo") this.writeStatus(taskId, expectedVersion, "in_progress", timestamp);
			else this.bumpTaskVersion(taskId, expectedVersion, timestamp);
			const task = this.getTask(taskId);
			this.activity(taskId, "task.session-bound", actor, { status: current.status }, {
				status: task.status,
				claimId,
				sessionId: request.sessionId
			}, timestamp);
			this.bumpRevision();
			return {
				task,
				claim: mapClaim(this.claimById(claimId))
			};
		});
	}
	submitReview(taskId, expectedVersion, verification, resultComment, actor) {
		if (actor.kind === "human") throw new TaskboardError("review submission requires the owning Agent", "TASK_FOREIGN_CLAIM");
		const verificationText = requiredText(verification, "verification");
		const commentText = requiredText(resultComment, "result comment");
		return this.transaction(() => {
			const current = this.mutableTask(taskId, expectedVersion);
			requireStatus(current.status, ["in_progress"], "submit for review");
			const claim = this.assertOwningClaim(taskId, actor);
			const timestamp = now();
			this.insertComment(taskId, verificationText === "Completed" ? commentText : `${commentText}\n\nVerification: ${verificationText}`, actor, timestamp);
			this.sql("UPDATE task_claims SET state = 'submitted', updated_at = ? WHERE id = ?").run(timestamp, claim.id);
			this.writeStatus(taskId, expectedVersion, "in_review", timestamp);
			this.activity(taskId, "task.review-submitted", actor, { status: current.status }, {
				status: "in_review",
				claimId: claim.id
			}, timestamp);
			this.bumpRevision();
			return this.getTask(taskId);
		});
	}
	returnForRework(taskId, expectedVersion, target, comment, actor, freshClaim) {
		requireHuman(actor, "return for rework");
		const body = requiredText(comment, "changed requirement comment");
		return this.transaction(() => {
			const current = this.mutableTask(taskId, expectedVersion);
			requireStatus(current.status, ["in_review"], "return for rework");
			if (target === "in_progress" && freshClaim === void 0) throw new TaskboardError("direct in-progress rework requires a fresh Agent claim", "TASK_INVALID_INPUT");
			const timestamp = now();
			this.insertComment(taskId, body, actor, timestamp);
			this.writeStatus(taskId, expectedVersion, target, timestamp);
			const claimId = freshClaim === void 0 ? void 0 : this.insertFreshClaim(taskId, expectedVersion, current.developmentContext, freshClaim, timestamp);
			this.activity(taskId, "task.returned", actor, { status: current.status }, {
				status: target,
				...claimId === void 0 ? {} : { claimId }
			}, timestamp);
			this.bumpRevision();
			return this.getTask(taskId);
		});
	}
	accept(taskId, expectedVersion, actor) {
		requireHuman(actor, "accept");
		return this.transition(taskId, expectedVersion, ["in_review"], "done", "task.accepted", actor);
	}
	/** Human board/detail status move; releases an in-progress claim when leaving that column. */
	moveStatus(taskId, expectedVersion, status, actor, sortOrder) {
		requireHuman(actor, "move status");
		const target = parseTaskStatus(status);
		if (sortOrder !== void 0 && !Number.isFinite(sortOrder)) throw new TaskboardError("sort order must be a finite number", "TASK_INVALID_INPUT");
		return this.transaction(() => {
			const current = this.mutableTask(taskId, expectedVersion);
			if (current.status === target && sortOrder === void 0) throw new TaskboardError("task update contains no fields", "TASK_INVALID_INPUT");
			if (target === "in_progress" && current.status !== "in_progress") this.assertDevelopmentContextFree(taskId, current.developmentContext);
			const timestamp = now();
			if (current.status === "in_progress" && target !== "in_progress") this.sql("UPDATE task_claims SET state = 'released', updated_at = ? WHERE task_id = ? AND state IN ('active','orphaned')").run(timestamp, taskId);
			if ((sortOrder === void 0 ? this.sql("UPDATE tasks SET status = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?").run(target, timestamp, taskId, expectedVersion) : this.sql("UPDATE tasks SET status = ?, sort_order = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?").run(target, sortOrder, timestamp, taskId, expectedVersion)).changes !== 1) throw new TaskboardError("task version changed during transition", "TASK_STALE_VERSION");
			this.activity(taskId, "task.status-moved", actor, { status: current.status }, { status: target }, timestamp);
			this.bumpRevision();
			return this.getTask(taskId);
		});
	}
	block(taskId, expectedVersion, reason, actor) {
		const body = requiredText(reason, "blocker reason");
		return this.transaction(() => {
			const current = this.mutableTask(taskId, expectedVersion);
			requireStatus(current.status, ["todo", "in_progress"], "block");
			if (actor.kind !== "human") {
				requireStatus(current.status, ["in_progress"], "Agent block");
				this.assertOwningClaim(taskId, actor);
			}
			const timestamp = now();
			this.insertComment(taskId, `Blocked: ${body}`, actor, timestamp);
			this.writeStatus(taskId, expectedVersion, "blocked", timestamp);
			this.activity(taskId, "task.blocked", actor, { status: current.status }, {
				status: "blocked",
				reason: body
			}, timestamp);
			this.bumpRevision();
			return this.getTask(taskId);
		});
	}
	resume(taskId, expectedVersion, actor, target = "todo", freshClaim) {
		requireHuman(actor, "resume");
		return this.transaction(() => {
			const current = this.mutableTask(taskId, expectedVersion);
			requireStatus(current.status, ["blocked"], "resume");
			if (target === "in_progress" && freshClaim === void 0) throw new TaskboardError("direct in-progress resume requires a fresh Agent claim", "TASK_INVALID_INPUT");
			const timestamp = now();
			this.sql("UPDATE task_claims SET state = 'released', updated_at = ? WHERE task_id = ? AND state IN ('active','orphaned')").run(timestamp, taskId);
			this.writeStatus(taskId, expectedVersion, target, timestamp);
			const claimId = freshClaim === void 0 ? void 0 : this.insertFreshClaim(taskId, expectedVersion, current.developmentContext, freshClaim, timestamp);
			this.activity(taskId, "task.resumed", actor, { status: current.status }, {
				status: target,
				...claimId === void 0 ? {} : { claimId }
			}, timestamp);
			this.bumpRevision();
			return this.getTask(taskId);
		});
	}
	cancel(taskId, expectedVersion, actor) {
		requireHuman(actor, "cancel");
		return this.transition(taskId, expectedVersion, [
			"backlog",
			"todo",
			"in_progress",
			"in_review",
			"blocked"
		], "canceled", "task.canceled", actor, true);
	}
	reopen(taskId, expectedVersion, reason, actor) {
		requireHuman(actor, "reopen");
		const body = requiredText(reason, "reopen reason");
		return this.transaction(() => {
			const current = this.mutableTask(taskId, expectedVersion);
			requireStatus(current.status, ["done", "canceled"], "reopen");
			const timestamp = now();
			this.insertComment(taskId, `Reopened: ${body}`, actor, timestamp);
			this.writeStatus(taskId, expectedVersion, "todo", timestamp);
			this.activity(taskId, "task.reopened", actor, { status: current.status }, {
				status: "todo",
				reason: body
			}, timestamp);
			this.bumpRevision();
			return this.getTask(taskId);
		});
	}
	releaseClaim(taskId, expectedVersion, reason, actor) {
		const body = requiredText(reason, "release reason");
		return this.transaction(() => {
			const current = this.mutableTask(taskId, expectedVersion);
			requireStatus(current.status, ["in_progress", "blocked"], "release claim");
			const claim = actor.kind === "human" ? this.activeClaim(taskId) : this.assertOwningClaim(taskId, actor);
			if (claim === void 0) throw new TaskboardError("task has no active claim", "TASK_FOREIGN_CLAIM");
			const timestamp = now();
			this.sql("UPDATE task_claims SET state = 'released', updated_at = ? WHERE id = ?").run(timestamp, claim.id);
			this.insertComment(taskId, `Claim released: ${body}`, actor, timestamp);
			if (current.status === "in_progress") this.writeStatus(taskId, expectedVersion, "todo", timestamp);
			else this.bumpTaskVersion(taskId, expectedVersion, timestamp);
			this.activity(taskId, "task.claim-released", actor, { claimId: claim.id }, { reason: body }, timestamp);
			this.bumpRevision();
			return this.getTask(taskId);
		});
	}
	/** Human-only explicit takeover releases an existing active/orphaned owner back to todo. */
	forceTakeover(taskId, expectedVersion, reason, actor) {
		requireHuman(actor, "force takeover");
		return this.releaseClaim(taskId, expectedVersion, `Force takeover by ${actor.actorId}: ${requiredText(reason, "takeover reason")}`, actor);
	}
	archive(taskId, expectedVersion, actor) {
		requireHuman(actor, "archive");
		return this.transaction(() => {
			const current = this.mutableTask(taskId, expectedVersion);
			if (this.activeClaimRow(taskId) !== void 0) throw new TaskboardError("cannot archive a task with an active claim", "TASK_ACTIVE_CLAIM");
			const timestamp = now();
			this.sql("UPDATE tasks SET archived_at = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?").run(timestamp, timestamp, taskId, expectedVersion);
			this.activity(taskId, "task.archived", actor, current.archivedAt, timestamp, timestamp);
			this.bumpRevision();
			return this.getTask(taskId);
		});
	}
	restore(taskId, expectedVersion, actor) {
		requireHuman(actor, "restore");
		return this.transaction(() => {
			const current = this.getTask(taskId);
			this.expectVersion(current.version, expectedVersion, "task");
			if (current.archivedAt === void 0) throw new TaskboardError("task is not archived", "TASK_NOT_ARCHIVED");
			const timestamp = now();
			this.sql("UPDATE tasks SET archived_at = NULL, version = version + 1, updated_at = ? WHERE id = ? AND version = ?").run(timestamp, taskId, expectedVersion);
			this.activity(taskId, "task.restored", actor, current.archivedAt, void 0, timestamp);
			this.bumpRevision();
			return this.getTask(taskId);
		});
	}
	/** Persist attachment bytes before publishing their authoritative database row. */
	createAttachment(taskId, expectedVersion, request, actor) {
		this.mutableTask(taskId, expectedVersion);
		const filename = this.safeFilename(request.filename);
		const contentType = this.contentType(request.contentType);
		const bytes = request.bytes;
		if (!(bytes instanceof Uint8Array)) throw new TaskboardError("attachment bytes must be a Uint8Array", "TASK_INVALID_INPUT");
		if (bytes.byteLength > this.attachmentOptions.maxAttachmentBytes) throw new TaskboardError("attachment exceeds the configured per-file limit", "ATTACHMENT_SIZE_EXCEEDED", {
			actual: bytes.byteLength,
			limit: this.attachmentOptions.maxAttachmentBytes
		});
		const attachmentId = AttachmentId(id("attachment"));
		const storageKey = this.newStorageKey();
		this.persistAttachmentBytes(storageKey, bytes);
		try {
			return this.transaction(() => {
				this.mutableTask(taskId, expectedVersion);
				if (request.commentId !== void 0) {
					const comment = this.sql("SELECT task_id FROM comments WHERE id = ?").get(request.commentId);
					if (comment === void 0 || String(comment["task_id"]) !== taskId) throw new TaskboardError("attachment comment must belong to the same task", "TASK_INVALID_INPUT");
				}
				const total = this.sql("SELECT COALESCE(SUM(byte_size), 0) AS total FROM attachments WHERE task_id = ?").get(taskId);
				if (Number(total["total"]) + bytes.byteLength > this.attachmentOptions.maxTaskAttachmentBytes) throw new TaskboardError("attachment exceeds the configured per-task total limit", "ATTACHMENT_SIZE_EXCEEDED", {
					actual: Number(total["total"]) + bytes.byteLength,
					limit: this.attachmentOptions.maxTaskAttachmentBytes
				});
				const timestamp = now();
				this.sql(`
          INSERT INTO attachments(id, task_id, comment_id, storage_key, filename, content_type, byte_size, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(attachmentId, taskId, request.commentId ?? null, storageKey, filename, contentType, bytes.byteLength, timestamp);
				this.bumpTaskVersion(taskId, expectedVersion, timestamp);
				this.activity(taskId, "attachment.created", actor, void 0, {
					attachmentId,
					filename,
					contentType,
					byteSize: bytes.byteLength
				}, timestamp);
				this.bumpRevision();
				return {
					attachment: this.getAttachment(attachmentId),
					task: this.getTask(taskId)
				};
			});
		} catch (error) {
			this.queueAttachmentCleanup(storageKey, "attachment row publication failed");
			this.retryAttachmentCleanup();
			throw error;
		}
	}
	listAttachments(taskId) {
		this.getTask(taskId);
		return this.sql("SELECT * FROM attachments WHERE task_id = ? ORDER BY created_at, rowid").all(taskId).map(mapAttachment);
	}
	getAttachment(attachmentId) {
		const row = this.sql("SELECT * FROM attachments WHERE id = ?").get(attachmentId);
		if (row === void 0) throw new TaskboardError(`attachment ${attachmentId} was not found`, "ATTACHMENT_NOT_FOUND");
		return mapAttachment(row);
	}
	/** Read bytes with headers that prevent MIME sniffing and active-content inline rendering. */
	readAttachment(attachmentId, disposition = "attachment") {
		const row = this.sql("SELECT * FROM attachments WHERE id = ?").get(attachmentId);
		if (row === void 0) throw new TaskboardError(`attachment ${attachmentId} was not found`, "ATTACHMENT_NOT_FOUND");
		const attachment = mapAttachment(row);
		try {
			const bytes = readFileSync(this.storagePath(String(row["storage_key"])));
			if (bytes.byteLength !== attachment.byteSize) throw new Error("stored byte length does not match authority row");
			return {
				attachment,
				bytes,
				headers: attachmentHeaders(attachment, disposition)
			};
		} catch (cause) {
			throw new TaskboardError("attachment bytes are unavailable", "ATTACHMENT_STORAGE_FAILURE", { cause: String(cause) });
		}
	}
	/** Host-internal resolution for streaming a download without loading the file into memory.
	*  The path never crosses the Client boundary; only the route handler consumes it. */
	openAttachment(attachmentId, disposition = "attachment") {
		const row = this.sql("SELECT * FROM attachments WHERE id = ?").get(attachmentId);
		if (row === void 0) throw new TaskboardError(`attachment ${attachmentId} was not found`, "ATTACHMENT_NOT_FOUND");
		const attachment = mapAttachment(row);
		const path = this.storagePath(String(row["storage_key"]));
		let size;
		try {
			size = statSync(path).size;
		} catch (cause) {
			throw new TaskboardError("attachment bytes are unavailable", "ATTACHMENT_STORAGE_FAILURE", { cause: String(cause) });
		}
		if (size !== attachment.byteSize) throw new TaskboardError("attachment bytes are unavailable", "ATTACHMENT_STORAGE_FAILURE", { cause: "stored byte length does not match authority row" });
		return {
			attachment,
			path,
			headers: attachmentHeaders(attachment, disposition)
		};
	}
	deleteAttachment(taskId, attachmentId, expectedVersion, actor) {
		requireHuman(actor, "delete attachment");
		const task = this.transaction(() => {
			this.mutableTask(taskId, expectedVersion);
			const row = this.sql("SELECT * FROM attachments WHERE id = ? AND task_id = ?").get(attachmentId, taskId);
			if (row === void 0) throw new TaskboardError(`attachment ${attachmentId} was not found`, "ATTACHMENT_NOT_FOUND");
			const timestamp = now();
			this.queueAttachmentCleanup(String(row["storage_key"]), "attachment deleted", timestamp);
			this.sql("DELETE FROM attachments WHERE id = ?").run(attachmentId);
			this.bumpTaskVersion(taskId, expectedVersion, timestamp);
			this.activity(taskId, "attachment.deleted", actor, {
				attachmentId,
				filename: row["filename"]
			}, void 0, timestamp);
			this.bumpRevision();
			return this.getTask(taskId);
		});
		this.retryAttachmentCleanup();
		return task;
	}
	deleteTask(taskId, expectedVersion, actor) {
		requireHuman(actor, "delete");
		this.transaction(() => {
			const current = this.getTask(taskId);
			this.expectVersion(current.version, expectedVersion, "task");
			if (current.archivedAt === void 0) throw new TaskboardError("only archived tasks can be permanently deleted", "TASK_NOT_ARCHIVED");
			if (this.activeClaimRow(taskId) !== void 0) throw new TaskboardError("cannot delete a task with an active claim", "TASK_ACTIVE_CLAIM");
			const timestamp = now();
			const attachments = this.sql("SELECT storage_key FROM attachments WHERE task_id = ?").all(taskId);
			for (const attachment of attachments) this.queueAttachmentCleanup(String(attachment["storage_key"]), "owning task deleted", timestamp);
			this.sql("DELETE FROM tasks WHERE id = ? AND version = ?").run(taskId, expectedVersion);
			this.bumpRevision();
		});
		this.retryAttachmentCleanup();
	}
	comment(taskId, expectedVersion, body, actor) {
		const content = requiredText(body, "comment");
		return this.transaction(() => {
			this.mutableTask(taskId, expectedVersion);
			const timestamp = now();
			const comment = this.insertComment(taskId, content, actor, timestamp);
			this.bumpTaskVersion(taskId, expectedVersion, timestamp);
			this.activity(taskId, "comment.created", actor, void 0, { commentId: comment.id }, timestamp);
			this.bumpRevision();
			return comment;
		});
	}
	updateComment(taskId, expectedVersion, commentId, body, actor) {
		requireHuman(actor, "update comment");
		const content = requiredText(body, "comment");
		return this.transaction(() => {
			this.mutableTask(taskId, expectedVersion);
			const current = this.getComment(commentId);
			if (current.taskId !== taskId) throw new TaskboardError("comment must belong to the same task", "TASK_INVALID_INPUT", {
				commentId,
				taskId
			});
			const timestamp = now();
			if (this.sql("UPDATE comments SET body = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?").run(content, timestamp, commentId, current.version).changes !== 1) throw new TaskboardError("comment version changed during mutation", "TASK_STALE_VERSION");
			this.bumpTaskVersion(taskId, expectedVersion, timestamp);
			this.activity(taskId, "comment.updated", actor, {
				commentId,
				body: current.body
			}, {
				commentId,
				body: content
			}, timestamp);
			this.bumpRevision();
			return this.getComment(commentId);
		});
	}
	deleteComment(taskId, expectedVersion, commentId, actor) {
		requireHuman(actor, "delete comment");
		const task = this.transaction(() => {
			this.mutableTask(taskId, expectedVersion);
			const current = this.getComment(commentId);
			if (current.taskId !== taskId) throw new TaskboardError("comment must belong to the same task", "TASK_INVALID_INPUT", {
				commentId,
				taskId
			});
			const timestamp = now();
			const attachments = this.sql("SELECT id, storage_key, filename FROM attachments WHERE comment_id = ?").all(commentId);
			for (const attachment of attachments) {
				this.queueAttachmentCleanup(String(attachment["storage_key"]), "owning comment deleted", timestamp);
				this.sql("DELETE FROM attachments WHERE id = ?").run(String(attachment["id"]));
			}
			this.sql("DELETE FROM comments WHERE id = ?").run(commentId);
			this.bumpTaskVersion(taskId, expectedVersion, timestamp);
			this.activity(taskId, "comment.deleted", actor, {
				commentId,
				body: current.body
			}, void 0, timestamp);
			this.bumpRevision();
			return this.getTask(taskId);
		});
		this.retryAttachmentCleanup();
		return task;
	}
	renameProjectLabel(projectId, expectedVersion, from, to, actor) {
		requireHuman(actor, "rename project label");
		const source = requiredText(from, "label");
		const target = requiredText(to, "label");
		if (source === target) throw new TaskboardError("renamed label must change", "TASK_INVALID_INPUT");
		return this.transaction(() => {
			const project = this.getProject(projectId);
			this.expectVersion(project.version, expectedVersion, "project");
			const timestamp = now();
			this.replaceProjectLabel(project, source, target, actor, timestamp);
			return this.getProject(projectId);
		});
	}
	removeProjectLabel(projectId, expectedVersion, label, actor) {
		requireHuman(actor, "remove project label");
		const name = requiredText(label, "label");
		return this.transaction(() => {
			const project = this.getProject(projectId);
			this.expectVersion(project.version, expectedVersion, "project");
			const timestamp = now();
			this.replaceProjectLabel(project, name, void 0, actor, timestamp);
			return this.getProject(projectId);
		});
	}
	addRelation(sourceTaskId, expectedSourceVersion, targetTaskId, kind, actor) {
		if (sourceTaskId === targetTaskId) throw new TaskboardError("a task cannot relate to itself", "TASK_RELATION_INVALID");
		return this.transaction(() => {
			const source = this.mutableTask(sourceTaskId, expectedSourceVersion);
			const target = this.getTask(targetTaskId);
			if (source.projectId !== target.projectId) throw new TaskboardError("relations require tasks in the same project", "TASK_RELATION_INVALID");
			let storedSource = sourceTaskId;
			let storedTarget = targetTaskId;
			if (kind === "related" && storedSource > storedTarget) [storedSource, storedTarget] = [storedTarget, storedSource];
			if (kind === "parent" && this.wouldCreateParentCycle(storedSource, storedTarget)) throw new TaskboardError("parent relation would create a cycle", "TASK_PARENT_CYCLE");
			if (this.sql("SELECT id FROM task_relations WHERE source_task_id = ? AND target_task_id = ? AND kind = ?").get(storedSource, storedTarget, kind) !== void 0) throw new TaskboardError("relation already exists", "TASK_RELATION_INVALID");
			const relationId = RelationId(id("relation"));
			const timestamp = now();
			try {
				this.sql(`
          INSERT INTO task_relations(id, project_id, source_task_id, target_task_id, kind, actor_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(relationId, source.projectId, storedSource, storedTarget, kind, actor.actorId, timestamp);
			} catch (cause) {
				throw new TaskboardError("relation violates project relation rules", "TASK_RELATION_INVALID", { cause: String(cause) });
			}
			this.activity(sourceTaskId, "relation.created", actor, void 0, {
				relationId,
				kind,
				targetTaskId
			}, timestamp);
			this.bumpTaskVersion(sourceTaskId, expectedSourceVersion, timestamp);
			this.bumpRevision();
			return mapRelation(this.sql("SELECT * FROM task_relations WHERE id = ?").get(relationId));
		});
	}
	removeRelation(relationId, expectedSourceVersion, actor) {
		return this.transaction(() => {
			const row = this.sql("SELECT * FROM task_relations WHERE id = ?").get(relationId);
			if (row === void 0) throw new TaskboardError("relation was not found", "TASK_RELATION_INVALID");
			const sourceTaskId = TaskId(String(row["source_task_id"]));
			this.mutableTask(sourceTaskId, expectedSourceVersion);
			const timestamp = now();
			this.sql("DELETE FROM task_relations WHERE id = ?").run(relationId);
			this.bumpTaskVersion(sourceTaskId, expectedSourceVersion, timestamp);
			this.activity(sourceTaskId, "relation.deleted", actor, {
				relationId,
				kind: row["kind"],
				targetTaskId: row["target_task_id"]
			}, void 0, timestamp);
			this.bumpRevision();
			return this.getTask(sourceTaskId);
		});
	}
	markOrphanedClaims(liveSessionIds) {
		return this.transaction(() => {
			const active = this.sql("SELECT * FROM task_claims WHERE state = 'active'").all();
			let changed = 0;
			const timestamp = now();
			for (const row of active) {
				if (liveSessionIds.has(String(row["session_id"]))) continue;
				this.sql("UPDATE task_claims SET state = 'orphaned', updated_at = ? WHERE id = ?").run(timestamp, row["id"]);
				changed += 1;
			}
			if (changed > 0) this.bumpRevision();
			return changed;
		});
	}
	listClaims(states) {
		if (states === void 0 || states.length === 0) return this.sql("SELECT * FROM task_claims ORDER BY claimed_at, rowid").all().map(mapClaim);
		return this.sql(`SELECT * FROM task_claims WHERE state IN (${states.map(() => "?").join(",")}) ORDER BY claimed_at, rowid`).all(...states).map(mapClaim);
	}
	reclaimOrphanedClaim(taskId, expectedVersion, actor) {
		return this.transaction(() => {
			requireStatus(this.mutableTask(taskId, expectedVersion).status, ["in_progress", "blocked"], "reclaim orphaned task");
			const row = this.sql("SELECT * FROM task_claims WHERE task_id = ? AND state = 'orphaned' ORDER BY claimed_at DESC LIMIT 1").get(taskId);
			if (row === void 0 || String(row["session_id"]) !== actor.sessionId || String(row["agent_id"]) !== actor.agentId || String(row["automation_id"]) !== actor.automationId) throw new TaskboardError("orphaned claim does not belong to this automation worker", "TASK_FOREIGN_CLAIM");
			const timestamp = now();
			this.sql("UPDATE task_claims SET state = 'active', updated_at = ? WHERE id = ? AND state = 'orphaned'").run(timestamp, row["id"]);
			this.bumpTaskVersion(taskId, expectedVersion, timestamp);
			this.activity(taskId, "task.claim-reclaimed", actor, { claimId: row["id"] }, { state: "active" }, timestamp);
			this.bumpRevision();
			return {
				task: this.getTask(taskId),
				claim: mapClaim(this.claimById(String(row["id"])))
			};
		});
	}
	createWorkflow(projectId, name, document, actor) {
		requireHuman(actor, "create workflow");
		const workflowName = requiredText(name, "workflow name");
		return this.transaction(() => {
			this.getProject(projectId);
			const workflowId = WorkflowId(id("workflow"));
			const timestamp = now();
			this.sql(`
        INSERT INTO workflow_workspaces(id, project_id, name, document_json, version, created_at, updated_at)
        VALUES (?, ?, ?, ?, 1, ?, ?)
      `).run(workflowId, projectId, workflowName, json(document), timestamp, timestamp);
			this.bumpRevision();
			return this.getWorkflow(workflowId);
		});
	}
	getWorkflow(workflowId) {
		const row = this.sql("SELECT * FROM workflow_workspaces WHERE id = ?").get(workflowId);
		if (row === void 0) throw new TaskboardError(`workflow ${workflowId} was not found`, "TASK_INVALID_INPUT");
		return mapWorkflow(row);
	}
	listWorkflows(projectId) {
		this.getProject(projectId);
		return this.sql("SELECT * FROM workflow_workspaces WHERE project_id = ? ORDER BY created_at, rowid").all(projectId).map(mapWorkflow);
	}
	updateWorkflow(workflowId, expectedVersion, name, document, actor) {
		requireHuman(actor, "update workflow");
		return this.transaction(() => {
			const current = this.getWorkflow(workflowId);
			this.expectVersion(current.version, expectedVersion, "workflow");
			const timestamp = now();
			this.sql(`
        UPDATE workflow_workspaces SET name = ?, document_json = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND version = ?
      `).run(requiredText(name, "workflow name"), json(document), timestamp, workflowId, expectedVersion);
			this.bumpRevision();
			return this.getWorkflow(workflowId);
		});
	}
	deleteWorkflow(workflowId, expectedVersion, actor) {
		requireHuman(actor, "delete workflow");
		this.transaction(() => {
			const current = this.getWorkflow(workflowId);
			this.expectVersion(current.version, expectedVersion, "workflow");
			const linked = this.sql("SELECT COUNT(*) AS count FROM tasks WHERE workflow_id = ?").get(workflowId);
			if (Number(linked["count"]) > 0) throw new TaskboardError("workflow is still linked to tasks", "TASK_INVALID_INPUT");
			this.sql("DELETE FROM workflow_workspaces WHERE id = ? AND version = ?").run(workflowId, expectedVersion);
			this.bumpRevision();
		});
	}
	createAutomation(projectId, config, actor) {
		requireHuman(actor, "create automation");
		this.validateAutomationConfig(config);
		return this.transaction(() => {
			this.getProject(projectId);
			const automationId = AutomationId(id("automation"));
			const timestamp = now();
			this.sql(`
        INSERT INTO automation_rules(id, project_id, config_json, state, version, last_decision_json, next_eligible_at, created_at, updated_at)
        VALUES (?, ?, ?, 'paused', 1, NULL, NULL, ?, ?)
      `).run(automationId, projectId, json(config), timestamp, timestamp);
			this.bumpRevision();
			return this.getAutomation(automationId);
		});
	}
	getAutomation(automationId) {
		const row = this.sql("SELECT * FROM automation_rules WHERE id = ?").get(automationId);
		if (row === void 0) throw new TaskboardError(`automation ${automationId} was not found`, "TASK_INVALID_INPUT");
		return mapAutomation(row);
	}
	listAutomations(projectId) {
		return (projectId === void 0 ? this.sql("SELECT * FROM automation_rules ORDER BY created_at, rowid").all() : this.sql("SELECT * FROM automation_rules WHERE project_id = ? ORDER BY created_at, rowid").all(projectId)).map(mapAutomation);
	}
	listAutomationRuns(projectId, limit = 50) {
		return this.sql(`
      SELECT r.id, r.rule_id, r.decision_json, r.created_at
      FROM automation_runs r
      INNER JOIN automation_rules a ON a.id = r.rule_id
      WHERE a.project_id = ?
      ORDER BY r.created_at DESC, r.rowid DESC
      LIMIT ?
    `).all(projectId, limit).map(mapAutomationRun);
	}
	updateAutomation(automationId, expectedVersion, update, actor) {
		requireHuman(actor, "update automation");
		return this.transaction(() => {
			const current = this.getAutomation(automationId);
			this.expectVersion(current.version, expectedVersion, "automation");
			const config = update.config ?? current.config;
			const state = update.state ?? current.state;
			this.validateAutomationConfig(config);
			const timestamp = now();
			const nextEligible = state === "enabled" ? timestamp : null;
			this.sql(`
        UPDATE automation_rules SET config_json = ?, state = ?, next_eligible_at = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND version = ?
      `).run(json(config), state, nextEligible, timestamp, automationId, expectedVersion);
			this.bumpRevision();
			return this.getAutomation(automationId);
		});
	}
	recordAutomationDecision(automationId, expectedVersion, decision, nextEligibleAt, state) {
		return this.transaction(() => {
			const current = this.getAutomation(automationId);
			this.expectVersion(current.version, expectedVersion, "automation");
			const timestamp = now();
			this.sql(`
        UPDATE automation_rules SET last_decision_json = ?, next_eligible_at = ?, state = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND version = ?
      `).run(json(decision), nextEligibleAt ?? null, state ?? current.state, timestamp, automationId, expectedVersion);
			this.sql("INSERT INTO automation_runs(id, rule_id, decision_json, created_at) VALUES (?, ?, ?, ?)").run(id("automation-run"), automationId, json(decision), timestamp);
			const keep = this.sql("SELECT id FROM automation_runs WHERE rule_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?").all(automationId, AUTOMATION_RUN_KEEP);
			if (keep.length >= AUTOMATION_RUN_KEEP) this.sql(`DELETE FROM automation_runs WHERE rule_id = ? AND id NOT IN (${keep.map(() => "?").join(",")})`).run(automationId, ...keep.map((row) => row.id));
			this.bumpRevision();
			return this.getAutomation(automationId);
		});
	}
	transition(taskId, expectedVersion, allowed, target, activity, actor, retireClaim = false) {
		return this.transaction(() => {
			const current = this.mutableTask(taskId, expectedVersion);
			requireStatus(current.status, allowed, activity);
			const timestamp = now();
			if (retireClaim) this.sql("UPDATE task_claims SET state = 'released', updated_at = ? WHERE task_id = ? AND state IN ('active','orphaned')").run(timestamp, taskId);
			this.writeStatus(taskId, expectedVersion, target, timestamp);
			this.activity(taskId, activity, actor, { status: current.status }, { status: target }, timestamp);
			this.bumpRevision();
			return this.getTask(taskId);
		});
	}
	mutableTask(taskId, expectedVersion) {
		const task = this.getTask(taskId);
		this.expectVersion(task.version, expectedVersion, "task");
		if (task.archivedAt !== void 0) throw new TaskboardError("archived tasks are read-only", "TASK_ARCHIVED");
		return task;
	}
	expectVersion(actual, expected, subject) {
		if (!Number.isSafeInteger(expected) || expected < 1 || actual !== expected) throw new TaskboardError(`${subject} version is stale: expected ${expected}, current ${actual}`, "TASK_STALE_VERSION", {
			expected,
			actual,
			subject
		});
	}
	writeStatus(taskId, expectedVersion, status, timestamp) {
		if (this.sql("UPDATE tasks SET status = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?").run(status, timestamp, taskId, expectedVersion).changes !== 1) throw new TaskboardError("task version changed during transition", "TASK_STALE_VERSION");
	}
	bumpTaskVersion(taskId, expectedVersion, timestamp) {
		if (this.sql("UPDATE tasks SET version = version + 1, updated_at = ? WHERE id = ? AND version = ?").run(timestamp, taskId, expectedVersion).changes !== 1) throw new TaskboardError("task version changed during mutation", "TASK_STALE_VERSION");
	}
	activeClaimRow(taskId) {
		return this.sql("SELECT * FROM task_claims WHERE task_id = ? AND state IN ('active','orphaned') ORDER BY claimed_at DESC LIMIT 1").get(taskId);
	}
	activeClaim(taskId) {
		const row = this.activeClaimRow(taskId);
		return row === void 0 ? void 0 : mapClaim(row);
	}
	claimById(claimId) {
		const row = this.sql("SELECT * FROM task_claims WHERE id = ?").get(claimId);
		if (row === void 0) throw new TaskboardError("claim was not found after creation", "TASK_FOREIGN_CLAIM");
		return row;
	}
	insertFreshClaim(taskId, expectedTaskVersion, developmentContext, request, timestamp) {
		const sessionId = requiredText(request.sessionId, "fresh claim Session id");
		const agentId = requiredText(request.agentId, "fresh claim Agent id");
		if (this.activeClaimRow(taskId) !== void 0) throw new TaskboardError("task already has an active claim", "TASK_ALREADY_CLAIMED", { taskId });
		this.assertDevelopmentContextFree(taskId, developmentContext);
		const claimId = ClaimId(id("claim"));
		this.sql(`
      INSERT INTO task_claims(id, task_id, session_id, agent_id, automation_id, expected_task_version, state, development_context_json, claimed_at, updated_at)
      VALUES (?, ?, ?, ?, NULL, ?, 'active', ?, ?, ?)
    `).run(claimId, taskId, sessionId, agentId, expectedTaskVersion, developmentContext === void 0 ? null : json(developmentContext), timestamp, timestamp);
		return claimId;
	}
	assertOwningClaim(taskId, actor) {
		const claim = this.activeClaim(taskId);
		if (claim === void 0 || claim.state !== "active" || claim.sessionId !== actor.sessionId || claim.agentId !== actor.agentId) throw new TaskboardError("task is claimed by another Session or has no active owner", "TASK_FOREIGN_CLAIM", { taskId });
		return claim;
	}
	getComment(commentId) {
		const row = this.sql("SELECT * FROM comments WHERE id = ?").get(commentId);
		if (row === void 0) throw new TaskboardError(`comment ${commentId} was not found`, "COMMENT_NOT_FOUND", { commentId });
		return mapComment(row);
	}
	replaceProjectLabel(project, from, to, actor, timestamp) {
		const nextProjectLabels = rewriteLabels(project.labels, from, to);
		this.sql("UPDATE projects SET labels_json = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?").run(json(nextProjectLabels), timestamp, project.id, project.version);
		const rows = this.sql("SELECT id, labels_json FROM tasks WHERE project_id = ?").all(project.id);
		for (const row of rows) {
			const labels = parseJson(row["labels_json"], "task labels");
			const next = rewriteLabels(labels, from, to);
			if (labels.length === next.length && labels.every((label, index) => label === next[index])) continue;
			const taskId = TaskId(String(row["id"]));
			this.sql("UPDATE tasks SET labels_json = ?, version = version + 1, updated_at = ? WHERE id = ?").run(json(next), timestamp, taskId);
			this.activity(taskId, "task.updated", actor, { labels }, { labels: next }, timestamp);
		}
		this.bumpRevision();
	}
	insertComment(taskId, body, actor, timestamp) {
		const commentId = CommentId(id("comment"));
		const sessionId = actor.kind === "human" ? null : actor.sessionId;
		this.sql(`
      INSERT INTO comments(id, task_id, body, author_id, session_id, version, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?)
    `).run(commentId, taskId, body, actor.actorId, sessionId, timestamp, timestamp);
		return mapComment(this.sql("SELECT * FROM comments WHERE id = ?").get(commentId));
	}
	activity(taskId, kind, actor, before, after, timestamp) {
		this.sql(`
      INSERT INTO task_activities(id, task_id, kind, actor_kind, actor_id, before_json, after_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(ActivityId(id("activity")), taskId, kind, actor.kind, actor.actorId, before === void 0 ? null : json(before), after === void 0 ? null : json(after), timestamp);
		this.transactionActivities?.push({
			taskId,
			activityKind: kind,
			actorKind: actor.kind,
			actorId: actor.actorId
		});
	}
	bumpRevision() {
		this.sql("UPDATE taskboard_meta SET global_revision = global_revision + 1 WHERE singleton = 1").run();
	}
	wouldCreateParentCycle(child, parent) {
		let cursor = parent;
		const visited = /* @__PURE__ */ new Set();
		while (cursor !== void 0) {
			if (cursor === child) return true;
			if (visited.has(cursor)) return true;
			visited.add(cursor);
			const row = this.sql("SELECT target_task_id FROM task_relations WHERE source_task_id = ? AND kind = 'parent'").get(cursor);
			cursor = row === void 0 ? void 0 : TaskId(String(row["target_task_id"]));
		}
		return false;
	}
	/** Reject a second owner on an exclusive branch or worktree.
	*  Two rows can hold one context: a live claim, and a task a human moved into `in_progress`
	*  without any claim at all. Both used to be invisible to every path except `claim()`. */
	assertDevelopmentContextFree(taskId, context) {
		if (context === void 0) return;
		if (context.kind === "worktree" && this.attachmentOptions.allowSharedWorktrees) return;
		const encoded = json(context);
		const conflict = this.sql(`
      SELECT tasks.identifier
      FROM tasks
      WHERE tasks.id <> ?
        AND (
          (tasks.status = 'in_progress' AND tasks.development_context_json = ?)
          OR EXISTS (
            SELECT 1 FROM task_claims claims
            WHERE claims.task_id = tasks.id AND claims.state IN ('active','orphaned')
              AND claims.development_context_json = ?
          )
        )
      ORDER BY tasks.identifier LIMIT 1
    `).get(taskId, encoded, encoded);
		if (conflict !== void 0) throw new TaskboardError(`development context is already owned by ${String(conflict["identifier"])}`, "TASK_DEVELOPMENT_CONTEXT_BUSY", { task: conflict["identifier"] });
	}
	validateDevelopmentContext(context) {
		if (context === void 0 || context === null) return;
		if (context.kind !== "branch" && context.kind !== "worktree") throw new TaskboardError("development context kind must be branch or worktree", "TASK_INVALID_INPUT");
		requiredText(context.branch, "development branch");
		if (context.kind === "worktree") requiredText(context.path, "worktree path");
	}
	validateTaskFields(request, projectId) {
		const priorities = new Set([
			"urgent",
			"high",
			"medium",
			"low",
			"none"
		]);
		if (request.priority !== void 0 && !priorities.has(request.priority)) throw new TaskboardError(`unknown task priority ${String(request.priority)}`, "TASK_INVALID_INPUT");
		if (request.labels !== void 0 && request.labels.some((label) => typeof label !== "string" || label.trim().length === 0)) throw new TaskboardError("task labels must be non-empty strings", "TASK_INVALID_INPUT");
		if (request.sortOrder !== void 0 && !Number.isFinite(request.sortOrder)) throw new TaskboardError("task sortOrder must be finite", "TASK_INVALID_INPUT");
		for (const [label, value] of [["start date", request.startDate], ["due date", request.dueDate]]) if (value !== void 0 && value !== null) this.validateDate(value, label);
		if (request.recurrence !== void 0 && request.recurrence !== null) {
			if (![
				"daily",
				"weekly",
				"monthly"
			].includes(request.recurrence.frequency) || !Number.isSafeInteger(request.recurrence.interval) || request.recurrence.interval < 1) throw new TaskboardError("task recurrence frequency or interval is invalid", "TASK_INVALID_INPUT");
			if (request.recurrence.until !== void 0) this.validateDate(request.recurrence.until, "recurrence until");
		}
		if (request.workflowId !== void 0 && request.workflowId !== null) {
			const workflow = this.getWorkflow(String(request.workflowId));
			const expectedProject = projectId ?? ("projectId" in request ? request.projectId : void 0);
			if (expectedProject !== void 0 && workflow.projectId !== expectedProject) throw new TaskboardError("task workflow must belong to the same project", "TASK_INVALID_INPUT");
		}
	}
	validateDate(value, label) {
		if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new TaskboardError(`${label} must use YYYY-MM-DD`, "TASK_INVALID_INPUT");
		const date = /* @__PURE__ */ new Date(`${value}T00:00:00Z`);
		if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new TaskboardError(`${label} is not a calendar date`, "TASK_INVALID_INPUT");
	}
	validateAutomationConfig(config) {
		if (!Number.isSafeInteger(config.intervalMs) || config.intervalMs < 1e3 || !Number.isSafeInteger(config.concurrencyLimit) || config.concurrencyLimit < 1 || config.agentPreset.trim().length === 0) throw new TaskboardError("automation interval, concurrency, or Agent preset is invalid", "TASK_INVALID_INPUT");
	}
	validateAttachmentOptions() {
		const options = this.attachmentOptions;
		if (!isAbsolute(options.root) || !Number.isSafeInteger(options.maxAttachmentBytes) || options.maxAttachmentBytes < 1 || !Number.isSafeInteger(options.maxTaskAttachmentBytes) || options.maxTaskAttachmentBytes < options.maxAttachmentBytes || options.allowedContentTypes.length === 0) throw new TaskboardError("attachment storage configuration is invalid", "TASK_INVALID_INPUT");
		for (const value of options.allowedContentTypes) this.contentType(value, false);
	}
	safeFilename(value) {
		const filename = requiredText(value, "attachment filename").replace(/[\\/\u0000-\u001f\u007f]/g, "_").slice(0, 255);
		if (filename === "." || filename === "..") throw new TaskboardError("attachment filename is invalid", "TASK_INVALID_INPUT");
		return filename;
	}
	contentType(value, enforceAllowlist = true) {
		const contentType = requiredText(value, "attachment content type").toLowerCase();
		if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(contentType)) throw new TaskboardError("attachment content type must be a bare MIME type", "TASK_INVALID_INPUT");
		if (enforceAllowlist && !this.attachmentOptions.allowedContentTypes.includes(contentType)) throw new TaskboardError(`attachment content type ${contentType} is not allowed`, "ATTACHMENT_TYPE_NOT_ALLOWED", { contentType });
		return contentType;
	}
	newStorageKey() {
		const value = randomUUID();
		return `${value.slice(0, 2)}/${value}.blob`;
	}
	storagePath(storageKey) {
		if (!/^[a-f0-9]{2}\/[a-f0-9-]{36}\.blob$/.test(storageKey)) throw new TaskboardError("attachment storage key is invalid", "ATTACHMENT_STORAGE_FAILURE");
		const path = resolve(this.attachmentOptions.root, storageKey);
		const fromRoot = relative(this.attachmentOptions.root, path);
		if (fromRoot.startsWith("..") || isAbsolute(fromRoot)) throw new TaskboardError("attachment storage path escaped its root", "ATTACHMENT_STORAGE_FAILURE");
		return path;
	}
	persistAttachmentBytes(storageKey, bytes) {
		const path = this.storagePath(storageKey);
		const temporary = `${path}.${randomUUID()}.pending`;
		mkdirSync(dirname(path), { recursive: true });
		let descriptor;
		try {
			descriptor = openSync(temporary, "wx", 384);
			let offset = 0;
			while (offset < bytes.byteLength) offset += writeSync(descriptor, bytes, offset, bytes.byteLength - offset);
			fsyncSync(descriptor);
			closeSync(descriptor);
			descriptor = void 0;
			renameSync(temporary, path);
		} catch (cause) {
			if (descriptor !== void 0) closeSync(descriptor);
			try {
				unlinkSync(temporary);
			} catch (_missingTemporary) {}
			throw new TaskboardError("could not persist attachment bytes", "ATTACHMENT_STORAGE_FAILURE", { cause: String(cause) });
		}
	}
	queueAttachmentCleanup(storageKey, reason, timestamp = now()) {
		this.sql(`
      INSERT INTO attachment_cleanup(storage_key, reason, attempts, created_at, updated_at)
      VALUES (?, ?, 0, ?, ?)
      ON CONFLICT(storage_key) DO UPDATE SET reason = excluded.reason, attempts = 0, updated_at = excluded.updated_at
    `).run(storageKey, reason, timestamp, timestamp);
	}
	/** Retry bounded, durable deletion work left by row publication or authoritative deletion.
	*  Entries that keep failing stop being retried past ATTACHMENT_CLEANUP_MAX_ATTEMPTS; they stay
	*  in the table for inspection but no longer hold storage health at 'degraded' forever. */
	retryAttachmentCleanup(limit = 100) {
		const bounded = Math.min(Math.max(Math.trunc(limit), 1), 1e3);
		const rows = this.sql("SELECT storage_key FROM attachment_cleanup WHERE attempts < ? ORDER BY created_at, storage_key LIMIT ?").all(10, bounded);
		let removed = 0;
		for (const row of rows) {
			const storageKey = String(row["storage_key"]);
			try {
				const path = this.storagePath(storageKey);
				if (existsSync(path)) unlinkSync(path);
				this.sql("DELETE FROM attachment_cleanup WHERE storage_key = ?").run(storageKey);
				removed += 1;
			} catch (_cause) {
				this.sql("UPDATE attachment_cleanup SET attempts = attempts + 1, updated_at = ? WHERE storage_key = ?").run(now(), storageKey);
			}
		}
		const counts = this.sql(`
      SELECT
        (SELECT COUNT(*) FROM attachment_cleanup WHERE attempts < ?) AS pending,
        (SELECT COUNT(*) FROM attachment_cleanup WHERE attempts >= ?) AS stalled
    `).get(10, 10);
		return {
			removed,
			pending: Number(counts["pending"]),
			stalled: Number(counts["stalled"])
		};
	}
	/** Run the full-database integrity scan. It reads every page, so it never runs on the snapshot path. */
	refreshIntegrity() {
		const row = this.db.prepare("PRAGMA quick_check(1)").get();
		this.integrity = String(row?.["quick_check"] ?? "unknown");
		this.integrityCheckedAt = now();
		return this.integrity;
	}
	/** Bounded, path-free health projection. `integrity` is the last scan result, not a fresh scan. */
	storageHealth() {
		const integrity = this.integrity;
		const counts = this.sql(`
      SELECT
        (SELECT COUNT(*) FROM projects) AS project_count,
        (SELECT COUNT(*) FROM tasks) AS task_count,
        (SELECT COUNT(*) FROM attachments) AS attachment_count,
        (SELECT COALESCE(SUM(byte_size), 0) FROM attachments) AS attachment_bytes,
        (SELECT COUNT(*) FROM attachment_cleanup WHERE attempts < 10) AS cleanup_pending,
        (SELECT COUNT(*) FROM attachment_cleanup WHERE attempts >= 10) AS cleanup_stalled,
        (SELECT COUNT(*) FROM task_claims WHERE state = 'orphaned') AS orphaned_claims
    `).get();
		const cleanupPending = Number(counts["cleanup_pending"]);
		const cleanupStalled = Number(counts["cleanup_stalled"]);
		return {
			status: integrity === "ok" && cleanupPending === 0 && cleanupStalled === 0 ? "ok" : "degraded",
			integrity,
			integrityCheckedAt: this.integrityCheckedAt,
			schemaVersion: 4,
			globalRevision: this.globalRevision(),
			projectCount: Number(counts["project_count"]),
			taskCount: Number(counts["task_count"]),
			attachmentCount: Number(counts["attachment_count"]),
			attachmentBytes: Number(counts["attachment_bytes"]),
			cleanupPending,
			cleanupStalled,
			orphanedClaims: Number(counts["orphaned_claims"])
		};
	}
	transaction(operation) {
		const revisionBefore = this.globalRevision();
		const activities = [];
		this.transactionActivities = activities;
		this.db.exec("BEGIN IMMEDIATE");
		let result;
		try {
			result = operation();
			this.db.exec("COMMIT");
		} catch (error) {
			this.transactionActivities = void 0;
			this.rollback();
			throw error;
		}
		this.transactionActivities = void 0;
		const globalRevision = this.globalRevision();
		if (globalRevision !== revisionBefore) {
			const events = activities.length === 0 ? [{
				type: "taskboard/changed",
				globalRevision
			}] : activities.map((activity) => {
				let taskVersion;
				try {
					taskVersion = this.getTask(activity.taskId).version;
				} catch (_deletedTask) {}
				return {
					type: "taskboard/changed",
					globalRevision,
					taskId: activity.taskId,
					...taskVersion === void 0 ? {} : { taskVersion },
					activityKind: activity.activityKind,
					actorKind: activity.actorKind,
					actorId: activity.actorId
				};
			});
			for (const event of events) this.publish(event);
		}
		return result;
	}
	publish(event) {
		for (const listener of [...this.changeListeners]) try {
			listener(event);
		} catch (_subscriberFailure) {}
	}
	rollback() {
		try {
			this.db.exec("ROLLBACK");
		} catch (_transactionAlreadyClosed) {}
	}
};
//#endregion
//#region lib/taskboard-host/workflow/index.js
const TRIGGER_KINDS = new Set([
	"issue-trigger",
	"rss-trigger",
	"pull-request-trigger",
	"repository-issue-trigger",
	"git-status-trigger"
]);
const WORKFLOW_PARITY_CATALOG = [
	{
		kind: "issue-trigger",
		category: "trigger"
	},
	{
		kind: "rss-trigger",
		category: "trigger"
	},
	{
		kind: "pull-request-trigger",
		category: "trigger"
	},
	{
		kind: "repository-issue-trigger",
		category: "trigger"
	},
	{
		kind: "git-status-trigger",
		category: "trigger"
	},
	{
		kind: "condition",
		category: "control"
	},
	{
		kind: "skill",
		category: "capability"
	},
	{
		kind: "mcp",
		category: "capability"
	},
	{
		kind: "api",
		category: "integration"
	},
	{
		kind: "third-party",
		category: "integration"
	},
	{
		kind: "git",
		category: "development"
	},
	{
		kind: "custom-code",
		category: "development"
	},
	{
		kind: "tests",
		category: "development"
	},
	{
		kind: "planning",
		category: "development"
	},
	{
		kind: "issue-mutation",
		category: "taskboard"
	},
	{
		kind: "review",
		category: "taskboard"
	},
	{
		kind: "deployment",
		category: "delivery"
	},
	{
		kind: "result",
		category: "delivery"
	}
];
/** Provider registry separating editable catalog nodes from executable capabilities. */
var WorkflowNodeRegistry = class {
	providers = /* @__PURE__ */ new Map();
	register(provider) {
		if (this.providers.has(provider.kind)) throw new Error(`workflow node provider ${provider.kind} is already registered`);
		this.providers.set(provider.kind, provider);
		return () => {
			this.providers.delete(provider.kind);
		};
	}
	get(kind) {
		return this.providers.get(kind);
	}
	catalog() {
		return WORKFLOW_PARITY_CATALOG.map((entry) => ({
			...entry,
			execution: this.providers.get(entry.kind)?.execute === void 0 ? "design-only" : "executable"
		}));
	}
	validate(document) {
		if (!Array.isArray(document.tabs) || document.tabs.length === 0) throw new TaskboardError("workflow requires at least one tab", "TASK_INVALID_INPUT");
		const ids = /* @__PURE__ */ new Set();
		for (const tab of document.tabs) {
			this.unique(ids, tab.id, "workflow tab");
			if (!TRIGGER_KINDS.has(tab.trigger.kind)) throw new TaskboardError(`tab ${tab.id} root must be one trigger`, "TASK_INVALID_INPUT");
			this.validateNode(tab.trigger, ids);
			for (const node of tab.steps) this.validateNode(node, ids);
		}
	}
	validateNode(node, ids) {
		this.unique(ids, node.id, "workflow node");
		const provider = this.providers.get(node.kind);
		const expected = provider?.execute === void 0 ? "design-only" : "executable";
		if (node.execution !== expected) throw new TaskboardError(`node ${node.id} execution marker must be ${expected}`, "TASK_INVALID_INPUT");
		const errors = provider?.validate(node.config) ?? [];
		if (errors.length > 0) throw new TaskboardError(`node ${node.id} is invalid: ${errors.join("; ")}`, "TASK_INVALID_INPUT");
		for (const child of node.steps ?? []) this.validateNode(child, ids);
		for (const child of node.trueBranch ?? []) this.validateNode(child, ids);
		for (const child of node.falseBranch ?? []) this.validateNode(child, ids);
	}
	unique(ids, id, subject) {
		if (id.trim().length === 0 || ids.has(id)) throw new TaskboardError(`${subject} id is empty or duplicated: ${id}`, "TASK_INVALID_INPUT");
		ids.add(id);
	}
};
//#endregion
//#region lib/taskboard-host/service/attachments.js
/** Dedicated byte transport guarded by short-lived capabilities minted over authenticated RPC. */
var TaskboardAttachmentRoutes = class {
	provider;
	ttlMs;
	tickets = /* @__PURE__ */ new Map();
	mounted = false;
	constructor(provider, ttlMs = 6e4) {
		this.provider = provider;
		this.ttlMs = ttlMs;
	}
	mount(webServer) {
		this.mounted = true;
		const dispose = webServer.register({
			kind: "prefix",
			path: "/taskboard/attachments",
			handler: (request, response) => this.handle(request, response)
		});
		return () => {
			this.mounted = false;
			this.tickets.clear();
			dispose();
		};
	}
	issueUpload(input, actor) {
		this.assertMounted();
		const token = randomUUID();
		const expiresAt = Date.now() + this.ttlMs;
		this.sweep();
		this.tickets.set(token, {
			kind: "upload",
			...input,
			actor,
			expiresAt
		});
		return {
			url: `/taskboard/attachments/upload/${token}`,
			method: "PUT",
			expiresAt
		};
	}
	issueDownload(attachmentId, disposition) {
		this.assertMounted();
		this.provider.getAttachment(attachmentId);
		const token = randomUUID();
		const expiresAt = Date.now() + this.ttlMs;
		this.sweep();
		this.tickets.set(token, {
			kind: "download",
			attachmentId,
			disposition,
			expiresAt
		});
		return {
			url: `/taskboard/attachments/download/${token}`,
			expiresAt
		};
	}
	async handle(request, response) {
		const path = new URL(request.url ?? "/", "http://taskboard.invalid").pathname.split("/").filter(Boolean);
		const operation = path[2];
		const token = path[3];
		if (token === void 0 || operation !== "upload" && operation !== "download") {
			this.reply(response, 404, { error: "not found" });
			return;
		}
		const method = operation === "upload" ? "PUT" : "GET";
		if (request.method !== method) {
			this.reply(response, 405, { error: `method must be ${method}` });
			return;
		}
		const ticket = this.consume(token);
		if (ticket === void 0 || ticket.kind !== operation) {
			this.reply(response, 404, { error: "ticket is invalid or expired" });
			return;
		}
		try {
			if (ticket.kind === "upload") await this.upload(request, response, ticket);
			else await this.download(request, response, ticket);
		} catch (error) {
			const status = error instanceof TaskboardError && error.code === "ATTACHMENT_SIZE_EXCEEDED" ? 413 : 400;
			this.reply(response, status, { error: error instanceof TaskboardError ? {
				code: error.code,
				message: error.message,
				details: error.details ?? {}
			} : {
				code: "ATTACHMENT_STORAGE_FAILURE",
				message: error instanceof Error ? error.message : String(error)
			} });
		}
	}
	async upload(request, response, ticket) {
		const declared = Number(request.headers["content-length"] ?? 0);
		const limit = this.provider.attachmentOptions.maxAttachmentBytes;
		if (Number.isFinite(declared) && declared > limit) throw new TaskboardError("attachment exceeds the configured per-file limit", "ATTACHMENT_SIZE_EXCEEDED", {
			actual: declared,
			limit
		});
		const chunks = [];
		let total = 0;
		for await (const raw of request) {
			const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
			total += chunk.byteLength;
			if (total > limit) throw new TaskboardError("attachment exceeds the configured per-file limit", "ATTACHMENT_SIZE_EXCEEDED", {
				actual: total,
				limit
			});
			chunks.push(chunk);
		}
		const created = this.provider.createAttachment(TaskId(ticket.taskId), ticket.expectedVersion, {
			filename: ticket.filename,
			contentType: ticket.contentType,
			bytes: Buffer.concat(chunks, total),
			...ticket.commentId === void 0 ? {} : { commentId: CommentId(ticket.commentId) }
		}, ticket.actor);
		this.reply(response, 201, created);
	}
	async download(_request, response, ticket) {
		const opened = this.provider.openAttachment(ticket.attachmentId, ticket.disposition);
		response.writeHead(200, {
			...opened.headers,
			"cache-control": "private, no-store"
		});
		const stream = createReadStream(opened.path);
		try {
			await pipeline(stream, response);
		} catch (cause) {
			response.destroy(cause instanceof Error ? cause : new Error(String(cause)));
		}
	}
	consume(token) {
		const ticket = this.tickets.get(token);
		this.tickets.delete(token);
		return ticket === void 0 || ticket.expiresAt < Date.now() ? void 0 : ticket;
	}
	sweep() {
		const timestamp = Date.now();
		for (const [token, ticket] of this.tickets) if (ticket.expiresAt < timestamp) this.tickets.delete(token);
	}
	assertMounted() {
		if (!this.mounted) throw new TaskboardError("attachment byte route is unavailable", "ATTACHMENT_STORAGE_FAILURE");
	}
	reply(response, status, value) {
		if (response.headersSent) return;
		response.writeHead(status, {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store"
		});
		response.end(JSON.stringify(value));
	}
};
//#endregion
//#region lib/taskboard-host/service/index.js
var __runInitializers = function(thisArg, initializers, value) {
	var useValue = arguments.length > 2;
	for (var i = 0; i < initializers.length; i++) value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
	return useValue ? value : void 0;
};
var __esDecorate = function(ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
	function accept(f) {
		if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected");
		return f;
	}
	var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
	var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
	var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
	var _, done = false;
	for (var i = decorators.length - 1; i >= 0; i--) {
		var context = {};
		for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
		for (var p in contextIn.access) context.access[p] = contextIn.access[p];
		context.addInitializer = function(f) {
			if (done) throw new TypeError("Cannot add initializers after decoration has completed");
			extraInitializers.push(accept(f || null));
		};
		var result = (0, decorators[i])(kind === "accessor" ? {
			get: descriptor.get,
			set: descriptor.set
		} : descriptor[key], context);
		if (kind === "accessor") {
			if (result === void 0) continue;
			if (result === null || typeof result !== "object") throw new TypeError("Object expected");
			if (_ = accept(result.get)) descriptor.get = _;
			if (_ = accept(result.set)) descriptor.set = _;
			if (_ = accept(result.init)) initializers.unshift(_);
		} else if (_ = accept(result)) if (kind === "field") initializers.unshift(_);
		else descriptor[key] = _;
	}
	if (target) Object.defineProperty(target, contextIn.name, descriptor);
	done = true;
};
/** Archived rows a snapshot carries for the dashboard's history section, budgeted separately from
*  the live board so one cannot starve the other. */
const ARCHIVED_SNAPSHOT_LIMIT = 200;
/** Keep the domain code intact so a version conflict, a validation error, and a real fault stay
*  distinguishable. The Host's own `RpcError.code` union is closed and has no Taskboard member, so
*  only the Typert protocol below can report the code as a code. */
function taskboardFailure(error) {
	if (error instanceof TaskboardError) return {
		code: error.code,
		message: error.message,
		details: error.details ?? {}
	};
	return {
		code: "internal",
		message: error instanceof Error ? error.message : String(error),
		details: {}
	};
}
function record(value, label) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TaskboardError(`${label} must be an object`, "TASK_INVALID_INPUT");
	return value;
}
function string(value, label) {
	if (typeof value !== "string" || value.trim().length === 0) throw new TaskboardError(`${label} must be a non-empty string`, "TASK_INVALID_INPUT");
	return value;
}
function integer(value, label) {
	if (!Number.isSafeInteger(value) || value < 1) throw new TaskboardError(`${label} must be a positive integer`, "TASK_INVALID_INPUT");
	return value;
}
function finiteNumber(value, label) {
	if (typeof value !== "number" || !Number.isFinite(value)) throw new TaskboardError(`${label} must be a finite number`, "TASK_INVALID_INPUT");
	return value;
}
function nonNegativeInteger(value, label) {
	if (!Number.isSafeInteger(value) || value < 0) throw new TaskboardError(`${label} must be a non-negative integer`, "TASK_INVALID_INPUT");
	return value;
}
function human(actorId) {
	return {
		kind: "human",
		actorId
	};
}
/** Read the Host's current model/reasoning so automation forms can prefill them. */
function hostAutomationDefaults(ctx) {
	try {
		const current = ctx.get("agentDefaultModel")?.currentSelection();
		const provider = typeof current?.provider === "string" ? current.provider.trim() : "";
		const model = typeof current?.model === "string" ? current.model.trim() : "";
		const reasoning = current?.reasoningEffort;
		return {
			...provider.length > 0 && model.length > 0 ? { modelRoute: `${provider}:${model}` } : {},
			...typeof reasoning === "string" && reasoning.trim() !== "" ? { reasoning: reasoning.trim() } : {}
		};
	} catch {
		return {};
	}
}
function resolveAutomationDefaults(config, host) {
	const modelRoute = config.defaultModelRoute ?? host.modelRoute;
	return {
		agentPreset: config.defaultAgentPreset,
		minIntervalMs: config.minAutomationIntervalMs,
		...modelRoute === void 0 ? {} : { modelRoute },
		...host.reasoning === void 0 ? {} : { reasoning: host.reasoning }
	};
}
function resolved(config) {
	const databasePath = config.databasePath === ":memory:" ? ":memory:" : resolve(config.databasePath);
	const attachmentRoot = resolve(config.attachmentRoot);
	const maxAttachmentBytes = config.maxAttachmentBytes ?? 25 * 1024 * 1024;
	const maxTaskAttachmentBytes = config.maxTaskAttachmentBytes ?? 100 * 1024 * 1024;
	if (maxTaskAttachmentBytes < maxAttachmentBytes) throw new Error("taskboard maxTaskAttachmentBytes must be at least maxAttachmentBytes");
	const defaultAgentPreset = (config.defaultAgentPreset ?? "standard").trim();
	if (defaultAgentPreset.length === 0) throw new Error("taskboard defaultAgentPreset must be non-empty");
	if (config.defaultModelRoute !== void 0 && !/^[^:/\s]+[:/][^:/\s]+$/.test(config.defaultModelRoute)) throw new Error("taskboard defaultModelRoute must be provider:model or provider/model");
	return {
		databasePath,
		attachmentRoot,
		pageSize: config.pageSize ?? 100,
		snapshotTaskLimit: config.snapshotTaskLimit ?? 1e3,
		maxAttachmentBytes,
		maxTaskAttachmentBytes,
		allowedAttachmentTypes: config.allowedAttachmentTypes ?? [
			"application/json",
			"application/octet-stream",
			"application/pdf",
			"application/zip",
			"image/gif",
			"image/jpeg",
			"image/png",
			"image/webp",
			"text/markdown",
			"text/plain"
		],
		minAutomationIntervalMs: config.minAutomationIntervalMs ?? 3e4,
		maxProjectWorkers: config.maxProjectWorkers ?? 2,
		maxGlobalWorkers: config.maxGlobalWorkers ?? 4,
		allowSharedWorktrees: config.allowSharedWorktrees ?? false,
		clientRefreshIntervalMs: config.clientRefreshIntervalMs ?? 15e3,
		maxChangeWaiters: config.maxChangeWaiters ?? 128,
		maxChangeWatchMs: config.maxChangeWatchMs ?? 3e4,
		defaultAgentPreset,
		...config.defaultModelRoute === void 0 ? {} : { defaultModelRoute: config.defaultModelRoute }
	};
}
/** Harness service facade around the SQLite provider and local Client RPC. */
let TaskboardService = (() => {
	let _classSuper = TypertRemoteService;
	let _instanceExtraInitializers = [];
	let _remoteSnapshot_decorators;
	let _remoteTaskDetail_decorators;
	let _remoteMutate_decorators;
	return class TaskboardService extends _classSuper {
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_remoteSnapshot_decorators = [Remote("snapshot")];
			_remoteTaskDetail_decorators = [Remote("taskDetail")];
			_remoteMutate_decorators = [Remote("mutate")];
			__esDecorate(this, null, _remoteSnapshot_decorators, {
				kind: "method",
				name: "remoteSnapshot",
				static: false,
				private: false,
				access: {
					has: (obj) => "remoteSnapshot" in obj,
					get: (obj) => obj.remoteSnapshot
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _remoteTaskDetail_decorators, {
				kind: "method",
				name: "remoteTaskDetail",
				static: false,
				private: false,
				access: {
					has: (obj) => "remoteTaskDetail" in obj,
					get: (obj) => obj.remoteTaskDetail
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _remoteMutate_decorators, {
				kind: "method",
				name: "remoteMutate",
				static: false,
				private: false,
				access: {
					has: (obj) => "remoteMutate" in obj,
					get: (obj) => obj.remoteMutate
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			if (_metadata) Object.defineProperty(this, Symbol.metadata, {
				enumerable: true,
				configurable: true,
				writable: true,
				value: _metadata
			});
		}
		hostCtx = __runInitializers(this, _instanceExtraInitializers);
		config;
		provider;
		workflowNodes = new WorkflowNodeRegistry();
		attachmentRoutes;
		workflowSkills = [];
		workflowMcpTools = [];
		skillDiscoveryComplete = false;
		changeWaiters = /* @__PURE__ */ new Set();
		lastRevision = 0;
		acceptingChangeWatches = true;
		automationHost;
		constructor(ctx, config) {
			super(ctx, "taskboard");
			this.hostCtx = ctx;
			this.config = resolved(config);
			this.provider = new SqliteTaskboardProvider(this.config.databasePath, {
				root: this.config.attachmentRoot,
				maxAttachmentBytes: this.config.maxAttachmentBytes,
				maxTaskAttachmentBytes: this.config.maxTaskAttachmentBytes,
				allowedContentTypes: this.config.allowedAttachmentTypes,
				allowSharedWorktrees: this.config.allowSharedWorktrees
			});
			this.lastRevision = this.provider.globalRevision();
			this.attachmentRoutes = new TaskboardAttachmentRoutes(this.provider);
			ctx.effect(() => () => {
				this.provider.close();
			}, "taskboard: close SQLite authority");
			ctx.effect(() => {
				const dispose = this.provider.subscribe((event) => {
					this.lastRevision = event.globalRevision;
					this.settleChangeWaiters(event.globalRevision, true);
				});
				return () => {
					this.acceptingChangeWatches = false;
					dispose();
					this.settleChangeWaiters(this.lastRevision, false);
				};
			}, "taskboard: revision long-poll lifecycle");
			ctx.inject(["connection"], (connectionCtx) => {
				const handler = (endpoint, payload) => endpoint === "automation.run-now" ? this.dispatchAutomationRunNow(payload) : Promise.resolve(this.dispatchHumanRpc(endpoint, payload, human("human:web-client")));
				const rpc = connectionCtx.connection.rpc;
				connectionCtx.effect(() => rpc.handle("/taskboard", handler), "taskboard: Client RPC");
			});
			ctx.inject(["webServer"], (webCtx) => {
				webCtx.effect(() => this.attachmentRoutes.mount(webCtx.webServer), "taskboard: attachment byte route");
			});
			ctx.inject(["skills"], (skillCtx) => {
				const skills = skillCtx.skills;
				const refresh = () => {
					skills.snapshot().then((result) => {
						this.workflowSkills = result.skills.map((skill) => ({
							name: skill.name,
							description: skill.description
						}));
						this.skillDiscoveryComplete = result.complete;
					}, () => {
						this.skillDiscoveryComplete = false;
					});
				};
				refresh();
				skillCtx.on("skills/change", refresh);
			});
			ctx.inject(["tools"], (toolCtx) => {
				const refresh = () => {
					this.workflowMcpTools = toolCtx.tools.schemas().filter((schema) => schema.name.startsWith("mcp__")).map((schema) => ({
						name: schema.name,
						description: schema.description
					}));
				};
				refresh();
				toolCtx.on("tools/change", refresh);
			});
		}
		bindAutomation(host) {
			this.automationHost = host;
		}
		async runAutomationNow(automationId) {
			this.provider.getAutomation(automationId);
			if (this.automationHost === void 0) throw new TaskboardError("automation coordinator is not running", "TASK_INVALID_INPUT");
			await this.automationHost.runImmediate(automationId);
			return this.provider.getAutomation(automationId);
		}
		taskDetail(taskId) {
			const detail = this.provider.getTaskDetail(taskId, { activityLimit: 0 });
			const agents = this.hostCtx.get("agents");
			const sessionRuntime = detail.claims.map((claim) => {
				const agent = agents?.get(claim.sessionId);
				const todoEvent = agent?.session.snapshotEvents().findLast((event) => event.type === "todo/write");
				const todos = todoEvent === void 0 ? [] : todoEvent.data.todos ?? [];
				const status = agent?.status ?? "offline";
				return {
					sessionId: claim.sessionId,
					status,
					current: detail.activeClaim?.id === claim.id,
					todos
				};
			});
			return {
				...detail,
				sessionRuntime
			};
		}
		snapshot(projectId) {
			const projects = this.provider.listProjects();
			const selected = (projectId !== void 0 && projects.some((project) => project.id === projectId) ? projectId : void 0) ?? projects[0]?.id;
			const live = selected === void 0 ? [] : this.provider.listTasks({
				projectId: selected,
				limit: this.config.snapshotTaskLimit
			});
			const archived = selected === void 0 ? [] : this.provider.listTasks({
				projectId: selected,
				archivedOnly: true,
				limit: ARCHIVED_SNAPSHOT_LIMIT
			});
			const liveTotal = selected === void 0 ? 0 : this.provider.countTasks({ projectId: selected });
			const archivedTotal = selected === void 0 ? 0 : this.provider.countTasks({
				projectId: selected,
				archivedOnly: true
			});
			const tasks = [...live, ...archived];
			return {
				schemaVersion: 1,
				globalRevision: this.provider.globalRevision(),
				projects,
				tasks,
				taskTotal: liveTotal + archivedTotal,
				tasksTruncated: live.length < liveTotal || archived.length < archivedTotal,
				workflows: selected === void 0 ? [] : this.provider.listWorkflows(selected),
				automations: selected === void 0 ? [] : this.provider.listAutomations(selected),
				automationRuns: selected === void 0 ? [] : this.provider.listAutomationRuns(selected),
				workflowCatalog: this.workflowNodes.catalog(),
				workflowCapabilities: {
					skills: this.workflowSkills,
					mcpTools: this.workflowMcpTools,
					skillDiscoveryComplete: this.skillDiscoveryComplete
				},
				refreshIntervalMs: this.config.clientRefreshIntervalMs,
				automationDefaults: resolveAutomationDefaults(this.config, hostAutomationDefaults(this.hostCtx)),
				storageHealth: this.provider.storageHealth()
			};
		}
		remoteSnapshot(projectId) {
			return JSON.stringify(this.snapshot(projectId === void 0 ? void 0 : ProjectId(projectId)));
		}
		remoteTaskDetail(taskId) {
			return JSON.stringify(this.taskDetail(TaskId(taskId)));
		}
		async remoteMutate(request) {
			let payload;
			try {
				payload = JSON.parse(request.payloadJson);
			} catch (_invalidJson) {
				return {
					ok: false,
					errorCode: "invalid-json",
					errorMessage: "payloadJson must contain one JSON object"
				};
			}
			if (request.endpoint === "changes.watch") try {
				const input = record(payload, "RPC payload");
				const result = await this.watchChanges(nonNegativeInteger(input["afterRevision"], "afterRevision"), integer(input["timeoutMs"], "timeoutMs"), input["watcherId"] === void 0 ? void 0 : string(input["watcherId"], "watcherId"));
				return {
					ok: true,
					valueJson: JSON.stringify(result)
				};
			} catch (error) {
				const message = error instanceof TaskboardError ? error.message : error instanceof Error ? error.message : String(error);
				return {
					ok: false,
					errorCode: error instanceof TaskboardError ? error.code : "internal",
					errorMessage: message
				};
			}
			return {
				ok: false,
				errorCode: "loopback-required",
				errorMessage: `Taskboard endpoint ${request.endpoint} requires a loopback connection`
			};
		}
		/** Wait for a committed revision change without requiring a Harness event extension.
		*  `watcherId` identifies one long-poll loop. A client abort cannot reach the Host, so the
		*  abandoned waiter used to hold its slot for the full timeout; a fresh watch from the same
		*  watcher now settles the one it replaces. */
		watchChanges(afterRevision, timeoutMs, watcherId) {
			const boundedTimeout = Math.min(Math.max(timeoutMs, 1), this.config.maxChangeWatchMs);
			const current = this.provider.globalRevision();
			this.lastRevision = current;
			if (watcherId !== void 0) this.settleReplacedWatcher(watcherId, current);
			if (!this.acceptingChangeWatches || current !== afterRevision) return Promise.resolve({
				globalRevision: current,
				changed: current !== afterRevision
			});
			if (this.changeWaiters.size >= this.config.maxChangeWaiters) throw new TaskboardError("too many concurrent Taskboard change watches", "TASK_INVALID_INPUT");
			return new Promise((resolve) => {
				const waiter = {
					afterRevision,
					timer: setTimeout(() => {
						this.changeWaiters.delete(waiter);
						const globalRevision = this.provider.globalRevision();
						this.lastRevision = globalRevision;
						resolve({
							globalRevision,
							changed: globalRevision !== afterRevision
						});
					}, boundedTimeout),
					resolve,
					...watcherId === void 0 ? {} : { watcherId }
				};
				this.changeWaiters.add(waiter);
			});
		}
		settleReplacedWatcher(watcherId, globalRevision) {
			for (const waiter of [...this.changeWaiters]) {
				if (waiter.watcherId !== watcherId) continue;
				this.changeWaiters.delete(waiter);
				clearTimeout(waiter.timer);
				waiter.resolve({
					globalRevision,
					changed: false
				});
			}
		}
		/** Dispatch a loopback-authenticated direct UI intent.
		*  The Host error union cannot name a Taskboard code, so it rides in the message on this path. */
		dispatchHumanRpc(endpoint, payload, actor) {
			const result = this.dispatchHumanFailable(endpoint, payload, actor);
			if (result.ok) return {
				ok: true,
				value: result.value
			};
			return {
				ok: false,
				error: {
					code: "internal",
					message: `${result.failure.code}: ${result.failure.message}`,
					details: {}
				}
			};
		}
		dispatchHumanFailable(endpoint, payload, actor) {
			try {
				const input = record(payload, "RPC payload");
				return {
					ok: true,
					value: this.dispatchHuman(endpoint, input, actor)
				};
			} catch (error) {
				return {
					ok: false,
					failure: taskboardFailure(error)
				};
			}
		}
		async dispatchAutomationRunNow(payload) {
			const result = await this.dispatchAutomationRunNowFailable(payload);
			if (result.ok) return {
				ok: true,
				value: result.value
			};
			return {
				ok: false,
				error: {
					code: "internal",
					message: `${result.failure.code}: ${result.failure.message}`,
					details: {}
				}
			};
		}
		async dispatchAutomationRunNowFailable(payload) {
			try {
				const input = record(payload, "RPC payload");
				return {
					ok: true,
					value: await this.runAutomationNow(string(input["automationId"], "automationId"))
				};
			} catch (error) {
				return {
					ok: false,
					failure: taskboardFailure(error)
				};
			}
		}
		dispatchHuman(endpoint, input, actor) {
			switch (endpoint) {
				case "snapshot": return this.snapshot(input["projectId"] === void 0 ? void 0 : ProjectId(string(input["projectId"], "projectId")));
				case "project.create": return this.provider.createProject(record(input["request"], "request"), actor);
				case "project.update": return this.provider.updateProject(ProjectId(string(input["projectId"], "projectId")), this.version(input), record(input["request"], "request"), actor);
				case "project.delete": return this.provider.deleteProject(ProjectId(string(input["projectId"], "projectId")), integer(input["expectedVersion"], "expectedVersion"), actor);
				case "task.create": return this.provider.createTask(record(input["request"], "request"), actor);
				case "task.detail": return this.taskDetail(this.taskId(input));
				case "task.search": return this.provider.listTasks({
					projectId: ProjectId(string(input["projectId"], "projectId")),
					search: string(input["search"], "search"),
					includeArchived: true,
					limit: this.config.snapshotTaskLimit
				});
				case "task.update": return this.provider.updateTask(TaskId(string(input["taskId"], "taskId")), integer(input["expectedVersion"], "expectedVersion"), record(input["request"], "request"), actor);
				case "task.approve": return this.provider.approve(this.taskId(input), this.version(input), actor);
				case "task.bind-session": return this.provider.bindHumanSession(this.taskId(input), this.version(input), {
					sessionId: string(input["sessionId"], "sessionId"),
					agentId: string(input["agentId"], "agentId")
				}, actor);
				case "task.accept": return this.provider.accept(this.taskId(input), this.version(input), actor);
				case "task.move": return this.provider.moveStatus(this.taskId(input), this.version(input), parseTaskStatus(string(input["status"], "status")), actor, input["sortOrder"] === void 0 ? void 0 : finiteNumber(input["sortOrder"], "sortOrder"));
				case "task.return": return this.provider.returnForRework(this.taskId(input), this.version(input), this.workTarget(input), string(input["comment"], "comment"), actor, this.freshClaim(input));
				case "task.block": return this.provider.block(this.taskId(input), this.version(input), string(input["reason"], "reason"), actor);
				case "task.resume": return this.provider.resume(this.taskId(input), this.version(input), actor, this.workTarget(input), this.freshClaim(input));
				case "task.cancel": return this.provider.cancel(this.taskId(input), this.version(input), actor);
				case "task.reopen": return this.provider.reopen(this.taskId(input), this.version(input), string(input["reason"], "reason"), actor);
				case "task.archive": return this.provider.archive(this.taskId(input), this.version(input), actor);
				case "task.restore": return this.provider.restore(this.taskId(input), this.version(input), actor);
				case "task.force-takeover": return this.provider.forceTakeover(this.taskId(input), this.version(input), string(input["reason"], "reason"), actor);
				case "task.delete": return this.provider.deleteTask(this.taskId(input), this.version(input), actor);
				case "task.comment": return this.provider.comment(this.taskId(input), this.version(input), string(input["body"], "body"), actor);
				case "comment.update": return this.provider.updateComment(this.taskId(input), this.version(input), string(input["commentId"], "commentId"), string(input["body"], "body"), actor);
				case "comment.delete": return this.provider.deleteComment(this.taskId(input), this.version(input), string(input["commentId"], "commentId"), actor);
				case "project.rename-label": return this.provider.renameProjectLabel(ProjectId(string(input["projectId"], "projectId")), this.version(input), string(input["from"], "from"), string(input["to"], "to"), actor);
				case "project.remove-label": return this.provider.removeProjectLabel(ProjectId(string(input["projectId"], "projectId")), this.version(input), string(input["label"], "label"), actor);
				case "task.relation": return this.provider.addRelation(this.taskId(input), this.version(input), TaskId(string(input["targetTaskId"], "targetTaskId")), string(input["kind"], "kind"), actor);
				case "relation.delete": return this.provider.removeRelation(string(input["relationId"], "relationId"), this.version(input), actor);
				case "attachment.delete": return this.provider.deleteAttachment(this.taskId(input), string(input["attachmentId"], "attachmentId"), this.version(input), actor);
				case "attachment.upload-ticket": return this.attachmentRoutes.issueUpload({
					taskId: string(input["taskId"], "taskId"),
					expectedVersion: integer(input["expectedVersion"], "expectedVersion"),
					filename: string(input["filename"], "filename"),
					contentType: string(input["contentType"], "contentType"),
					...input["commentId"] === void 0 ? {} : { commentId: string(input["commentId"], "commentId") }
				}, actor);
				case "attachment.download-ticket": {
					const disposition = input["disposition"] === "inline" ? "inline" : "attachment";
					return this.attachmentRoutes.issueDownload(string(input["attachmentId"], "attachmentId"), disposition);
				}
				case "workflow.create": {
					const document = record(input["document"], "document");
					this.workflowNodes.validate(document);
					return this.provider.createWorkflow(ProjectId(string(input["projectId"], "projectId")), string(input["name"], "name"), document, actor);
				}
				case "workflow.update": {
					const document = record(input["document"], "document");
					this.workflowNodes.validate(document);
					return this.provider.updateWorkflow(string(input["workflowId"], "workflowId"), this.version(input), string(input["name"], "name"), document, actor);
				}
				case "workflow.delete": return this.provider.deleteWorkflow(string(input["workflowId"], "workflowId"), this.version(input), actor);
				case "automation.create": {
					const config = record(input["config"], "config");
					this.validateAutomation(config);
					return this.provider.createAutomation(ProjectId(string(input["projectId"], "projectId")), config, actor);
				}
				case "storage.check-integrity":
					this.provider.refreshIntegrity();
					return this.provider.storageHealth();
				case "automation.update": {
					const update = record(input["update"], "update");
					if (update.config !== void 0) this.validateAutomation(update.config);
					return this.provider.updateAutomation(AutomationId(string(input["automationId"], "automationId")), this.version(input), update, actor);
				}
				default: throw new TaskboardError(`unknown Taskboard endpoint ${endpoint}`, "TASK_INVALID_INPUT");
			}
		}
		taskId(input) {
			return TaskId(string(input["taskId"], "taskId"));
		}
		version(input) {
			return integer(input["expectedVersion"], "expectedVersion");
		}
		workTarget(input) {
			const target = input["target"] ?? "todo";
			if (target !== "todo" && target !== "in_progress") throw new TaskboardError("target must be todo or in_progress", "TASK_INVALID_INPUT");
			return target;
		}
		freshClaim(input) {
			if (input["freshClaim"] === void 0) return void 0;
			const claim = record(input["freshClaim"], "freshClaim");
			return {
				sessionId: string(claim["sessionId"], "freshClaim.sessionId"),
				agentId: string(claim["agentId"], "freshClaim.agentId")
			};
		}
		validateAutomation(config) {
			if (config.intervalMs < this.config.minAutomationIntervalMs) throw new TaskboardError(`automation interval must be at least ${this.config.minAutomationIntervalMs}ms`, "TASK_INVALID_INPUT");
		}
		settleChangeWaiters(globalRevision, changed) {
			for (const waiter of [...this.changeWaiters]) {
				if (changed && waiter.afterRevision === globalRevision) continue;
				this.changeWaiters.delete(waiter);
				clearTimeout(waiter.timer);
				waiter.resolve({
					globalRevision,
					changed: changed && waiter.afterRevision !== globalRevision
				});
			}
		}
	};
})();
//#endregion
//#region lib/taskboard-host/tool/index.js
const JSON_OUTPUT = {
	schema: { type: "json" },
	render: (_args, value) => [{
		type: "text",
		text: JSON.stringify(value)
	}]
};
function actor$1(exec) {
	const agent = exec.agent;
	if (agent === void 0) throw new TaskboardError("Taskboard tools require a live root Agent", "TASK_FOREIGN_CLAIM");
	const owner = String(agent.id);
	return {
		kind: "agent",
		actorId: owner,
		sessionId: owner,
		agentId: owner
	};
}
function present(title, rawInput) {
	return {
		card: "generic",
		title,
		kind: "other",
		...rawInput === void 0 ? {} : { rawInput }
	};
}
function asJson(value) {
	return JSON.parse(JSON.stringify(value));
}
/** Build the narrow model-facing tool set. It intentionally contains no accept or generic status mutation. */
function taskboardToolDefinitions(service) {
	return [
		defineTool({
			name: "taskboard_list",
			description: "List bounded current tasks for one exact project. Read before selecting or mutating work. The result reports the matching total; pass offset to read past one page.",
			parameters: {
				project_id: {
					type: "string",
					required: true
				},
				statuses: {
					type: "array",
					items: {
						type: "string",
						enum: [
							"backlog",
							"todo",
							"in_progress",
							"in_review",
							"blocked",
							"done",
							"canceled"
						]
					}
				},
				include_archived: { type: "boolean" },
				search: { type: "string" },
				offset: { type: "integer" }
			},
			output: JSON_OUTPUT,
			execute(args) {
				const filter = {
					projectId: ProjectId(args.project_id),
					...args.statuses === void 0 ? {} : { statuses: args.statuses },
					...args.include_archived === void 0 ? {} : { includeArchived: args.include_archived },
					...args.search === void 0 ? {} : { search: args.search }
				};
				const offset = Math.max(0, args.offset ?? 0);
				const tasks = service.provider.listTasks({
					...filter,
					limit: service.config.pageSize,
					offset
				});
				return Promise.resolve(asJson({
					tasks,
					offset,
					total: service.provider.countTasks(filter)
				}));
			},
			presentCall: (args) => present("List Taskboard issues", args.project_id)
		}),
		defineTool({
			name: "taskboard_get",
			description: "Read the current task, exact optimistic version, comments, activity, relations, dependencies, and active claim before any write.",
			parameters: { task_id: {
				type: "string",
				required: true
			} },
			output: JSON_OUTPUT,
			execute(args) {
				return Promise.resolve(asJson(service.provider.getTaskDetail(service.provider.getTask(args.task_id).id)));
			},
			presentCall: (args) => present("Read Taskboard issue", args.task_id)
		}),
		defineTool({
			name: "taskboard_claim",
			description: "Atomically claim one eligible todo after reading it. Pass the exact current version. The service rechecks dependencies and exclusive ownership in the same transaction.",
			parameters: {
				task_id: {
					type: "string",
					required: true
				},
				expected_version: {
					type: "integer",
					required: true
				}
			},
			output: JSON_OUTPUT,
			execute(args, exec) {
				const owner = actor$1(exec);
				return Promise.resolve(asJson(service.provider.claim(TaskId(args.task_id), {
					expectedVersion: args.expected_version,
					sessionId: owner.sessionId,
					agentId: owner.agentId
				}, owner)));
			},
			presentCall: (args) => present("Claim Taskboard issue", args.task_id)
		}),
		defineTool({
			name: "taskboard_comment",
			description: "Append a durable Markdown comment after rereading the task. Pass its exact current version; the write increments that version.",
			parameters: {
				task_id: {
					type: "string",
					required: true
				},
				expected_version: {
					type: "integer",
					required: true
				},
				body: {
					type: "string",
					required: true
				}
			},
			output: JSON_OUTPUT,
			execute(args, exec) {
				return Promise.resolve(asJson(service.provider.comment(TaskId(args.task_id), args.expected_version, args.body, actor$1(exec))));
			},
			presentCall: (args) => present("Comment on Taskboard issue", args.task_id)
		}),
		defineTool({
			name: "taskboard_submit_review",
			description: "Submit the owning in-progress claim for human review only after verification. Requires a result comment, verification evidence, and the exact current task version. This never accepts the task as done.",
			parameters: {
				task_id: {
					type: "string",
					required: true
				},
				expected_version: {
					type: "integer",
					required: true
				},
				verification: {
					type: "string",
					required: true
				},
				result_comment: {
					type: "string",
					required: true
				}
			},
			output: JSON_OUTPUT,
			execute(args, exec) {
				return Promise.resolve(asJson(service.provider.submitReview(TaskId(args.task_id), args.expected_version, args.verification, args.result_comment, actor$1(exec))));
			},
			presentCall: (args) => present("Submit Taskboard issue for review", args.task_id)
		}),
		defineTool({
			name: "taskboard_block",
			description: "Block the in-progress task this Session owns, with a concrete non-empty reason and exact current version. A todo you have not claimed can only be blocked by a human.",
			parameters: {
				task_id: {
					type: "string",
					required: true
				},
				expected_version: {
					type: "integer",
					required: true
				},
				reason: {
					type: "string",
					required: true
				}
			},
			output: JSON_OUTPUT,
			execute(args, exec) {
				return Promise.resolve(asJson(service.provider.block(TaskId(args.task_id), args.expected_version, args.reason, actor$1(exec))));
			},
			presentCall: (args) => present("Block Taskboard issue", args.task_id)
		}),
		defineTool({
			name: "taskboard_release_claim",
			description: "Release only the current Agent Session claim, recording a reason. Read the task first and pass its exact current version.",
			parameters: {
				task_id: {
					type: "string",
					required: true
				},
				expected_version: {
					type: "integer",
					required: true
				},
				reason: {
					type: "string",
					required: true
				}
			},
			output: JSON_OUTPUT,
			execute(args, exec) {
				return Promise.resolve(asJson(service.provider.releaseClaim(TaskId(args.task_id), args.expected_version, args.reason, actor$1(exec))));
			},
			presentCall: (args) => present("Release Taskboard claim", args.task_id)
		}),
		defineTool({
			name: "taskboard_relate",
			description: "Add one validated same-project parent, blocks, or related relation after reading both tasks. Pass the exact current source-task version.",
			parameters: {
				source_task_id: {
					type: "string",
					required: true
				},
				expected_source_version: {
					type: "integer",
					required: true
				},
				target_task_id: {
					type: "string",
					required: true
				},
				kind: {
					type: "string",
					required: true,
					enum: [
						"parent",
						"blocks",
						"related"
					]
				}
			},
			output: JSON_OUTPUT,
			execute(args, exec) {
				return Promise.resolve(asJson(service.provider.addRelation(TaskId(args.source_task_id), args.expected_source_version, TaskId(args.target_task_id), args.kind, actor$1(exec))));
			},
			presentCall: (args) => present("Relate Taskboard issues", args.source_task_id)
		})
	];
}
/** Register Taskboard tools into the active Harness tool runtime. */
function registerTaskboardTools(ctx, service) {
	for (const definition of taskboardToolDefinitions(service)) ctx.tools.register(definition);
}
//#endregion
//#region lib/taskboard-host/automation/index.js
const DEFAULT_QUOTA = { state: () => Promise.resolve("uncertain") };
/** Claim failures that only mean "this candidate is taken", so the drain must try the next one.
*  Treating them as fatal used to abandon the rest of the queue for the whole round. */
const CONTENDED_CLAIM_CODES = new Set([
	"TASK_INVALID_TRANSITION",
	"TASK_ALREADY_CLAIMED",
	"TASK_STALE_VERSION",
	"TASK_DEVELOPMENT_CONTEXT_BUSY"
]);
/** Host-owned durable scheduler that starts work but never steals an existing claim. */
var TaskboardAutomationCoordinator = class {
	taskboard;
	worker;
	quota;
	timers = /* @__PURE__ */ new Map();
	inFlight = /* @__PURE__ */ new Set();
	inFlightByRule = /* @__PURE__ */ new Map();
	draining = /* @__PURE__ */ new Set();
	runningByProject = /* @__PURE__ */ new Map();
	running = false;
	rescanQueued = false;
	unsubscribe;
	constructor(taskboard, worker, quota = DEFAULT_QUOTA) {
		this.taskboard = taskboard;
		this.worker = worker;
		this.quota = quota;
	}
	start() {
		if (this.running) return;
		this.running = true;
		this.unsubscribe = this.taskboard.provider.subscribe((event) => {
			if (event.taskId === void 0) this.queueRescan();
		});
		this.rescan();
	}
	refresh(rule) {
		this.cancelTimer(rule.id);
		if (this.running) this.schedule(rule);
	}
	async runNow(ruleId) {
		await this.tick(ruleId);
	}
	/** Extra drain that starts eligible work now without moving the durable schedule. */
	async runImmediate(ruleId) {
		if (this.draining.has(ruleId)) return;
		const scheduledAt = this.taskboard.provider.getAutomation(ruleId).nextEligibleAt;
		this.draining.add(ruleId);
		try {
			await this.drain(ruleId, this.running, {
				preserveSchedule: true,
				...scheduledAt === void 0 ? {} : { scheduledAt }
			});
		} finally {
			this.draining.delete(ruleId);
			if (this.running) {
				const latest = this.taskboard.provider.getAutomation(ruleId);
				this.schedule(scheduledAt === void 0 ? latest : {
					...latest,
					nextEligibleAt: scheduledAt
				});
			}
		}
	}
	async stop() {
		this.running = false;
		this.unsubscribe?.();
		this.unsubscribe = void 0;
		this.rescanQueued = false;
		this.draining.clear();
		for (const timer of this.timers.values()) clearTimeout(timer);
		this.timers.clear();
		await Promise.allSettled([...this.inFlight]);
	}
	schedule(rule) {
		if (!this.running || rule.state !== "enabled" || this.draining.has(rule.id)) return;
		const at = rule.nextEligibleAt ?? Date.now();
		const delay = Math.min(Math.max(0, at - Date.now()), 2147483647);
		const timer = setTimeout(() => {
			this.timers.delete(rule.id);
			this.tick(rule.id);
		}, delay);
		this.timers.set(rule.id, timer);
	}
	queueRescan() {
		if (!this.running || this.rescanQueued) return;
		this.rescanQueued = true;
		queueMicrotask(() => {
			this.rescanQueued = false;
			if (this.running) this.rescan();
		});
	}
	rescan() {
		const rules = this.taskboard.provider.listAutomations();
		const activeIds = new Set(rules.filter((rule) => rule.state === "enabled").map((rule) => String(rule.id)));
		for (const id of this.timers.keys()) if (!activeIds.has(id)) this.cancelTimer(id);
		for (const rule of rules) this.refresh(rule);
	}
	async tick(ruleId) {
		if (this.draining.has(ruleId)) return;
		this.draining.add(ruleId);
		this.cancelTimer(ruleId);
		const coordinatorActive = this.running;
		let failure;
		try {
			await this.drain(ruleId, coordinatorActive);
		} catch (error) {
			failure = error;
		} finally {
			this.draining.delete(ruleId);
		}
		if (failure !== void 0) this.reschedule(ruleId, failure);
	}
	reschedule(ruleId, failure) {
		if (!this.running) return;
		try {
			const latest = this.taskboard.provider.getAutomation(ruleId);
			if (latest.state !== "enabled") return;
			this.schedule(this.record(ruleId, {
				kind: "error",
				message: failure instanceof Error ? failure.message : String(failure),
				at: Date.now()
			}, Date.now() + latest.config.intervalMs));
		} catch (_ruleUnavailable) {}
	}
	async drain(ruleId, coordinatorActive, options = {}) {
		const preserve = options.preserveSchedule === true;
		const kept = options.scheduledAt;
		while (this.draining.has(ruleId)) {
			if (coordinatorActive && !this.running) return;
			let rule = this.taskboard.provider.getAutomation(ruleId);
			if (!preserve && rule.state !== "enabled") return;
			if (await this.quota.state(rule) === "uncertain" && rule.config.quotaPolicy === "pause-on-uncertain") {
				rule = this.record(ruleId, {
					kind: "quota-paused",
					message: "quota state is uncertain; no new claims started",
					at: Date.now()
				}, preserve ? kept : void 0, preserve ? void 0 : "paused");
				if (!preserve) this.refresh(rule);
				return;
			}
			const inFlight = this.ruleInFlight(ruleId);
			const slots = this.availableSlots(rule);
			if (slots === 0) {
				if (inFlight.size === 0) {
					rule = this.record(ruleId, {
						kind: "empty",
						message: "worker concurrency is currently full",
						at: Date.now()
					}, preserve ? kept : Date.now() + rule.config.intervalMs);
					if (!preserve) this.schedule(rule);
					return;
				}
				await Promise.race(inFlight);
				continue;
			}
			let candidateOffset = 0;
			let candidates = this.taskboard.provider.listTasks({
				projectId: rule.projectId,
				statuses: ["todo"],
				limit: 500,
				offset: candidateOffset
			});
			if (candidates.length === 0) {
				if (inFlight.size > 0) {
					await Promise.allSettled([...inFlight]);
					continue;
				}
				const pause = !preserve && rule.config.autoPauseOnEmpty;
				rule = this.record(ruleId, {
					kind: "empty",
					message: "no eligible todo tasks",
					at: Date.now()
				}, preserve ? kept : pause ? void 0 : Date.now() + rule.config.intervalMs, pause ? "paused" : preserve ? void 0 : "enabled");
				if (!preserve) this.schedule(rule);
				return;
			}
			let started = 0;
			let dependencyBlocked = 0;
			let contended = 0;
			while (candidates.length > 0 && started === 0) {
				for (const task of candidates) {
					if (started >= slots) break;
					try {
						this.startWorker(rule, task);
						started += 1;
						rule = this.record(ruleId, {
							kind: "claimed",
							taskId: task.id,
							message: `worker started for ${task.identifier}`,
							at: Date.now()
						}, preserve ? kept : void 0);
					} catch (error) {
						if (!(error instanceof TaskboardError)) throw error;
						if (error.code === "TASK_DEPENDENCY_INCOMPLETE") dependencyBlocked += 1;
						else if (CONTENDED_CLAIM_CODES.has(error.code)) contended += 1;
						else throw error;
					}
				}
				if (started > 0 || candidates.length < 500) break;
				candidateOffset += candidates.length;
				candidates = this.taskboard.provider.listTasks({
					projectId: rule.projectId,
					statuses: ["todo"],
					limit: 500,
					offset: candidateOffset
				});
			}
			if (started > 0) continue;
			if (inFlight.size > 0) {
				await Promise.race(inFlight);
				continue;
			}
			rule = this.record(ruleId, {
				kind: dependencyBlocked > 0 ? "dependency-blocked" : "empty",
				message: dependencyBlocked > 0 ? "todo tasks are waiting for dependencies" : contended > 0 ? "every eligible todo is already owned elsewhere" : "no worker started",
				at: Date.now()
			}, preserve ? kept : Date.now() + rule.config.intervalMs);
			if (!preserve) this.schedule(rule);
			return;
		}
	}
	availableSlots(rule) {
		const globalAvailable = Math.max(0, this.taskboard.config.maxGlobalWorkers - this.inFlight.size);
		const projectRunning = this.runningByProject.get(rule.projectId) ?? 0;
		const projectAvailable = Math.max(0, this.taskboard.config.maxProjectWorkers - projectRunning);
		const ruleAvailable = Math.max(0, rule.config.concurrencyLimit - this.ruleInFlight(String(rule.id)).size);
		return Math.min(globalAvailable, projectAvailable, ruleAvailable);
	}
	ruleInFlight(ruleId) {
		const existing = this.inFlightByRule.get(ruleId);
		if (existing !== void 0) return existing;
		const created = /* @__PURE__ */ new Set();
		this.inFlightByRule.set(ruleId, created);
		return created;
	}
	startWorker(rule, task) {
		const projectId = String(rule.projectId);
		const ruleId = String(rule.id);
		this.runningByProject.set(projectId, (this.runningByProject.get(projectId) ?? 0) + 1);
		let run;
		try {
			run = this.worker.start(rule, task);
		} catch (error) {
			this.decrement(projectId);
			throw error;
		}
		const ruleTracking = this.ruleInFlight(ruleId);
		const tracked = run.catch((error) => {
			try {
				const latest = this.taskboard.provider.getAutomation(rule.id);
				if (latest.state === "enabled") this.record(ruleId, {
					kind: "error",
					taskId: task.id,
					message: error instanceof Error ? error.message : String(error),
					at: Date.now()
				}, latest.nextEligibleAt);
			} catch (_bookkeepingFailed) {}
		}).finally(() => {
			this.inFlight.delete(tracked);
			ruleTracking.delete(tracked);
			if (ruleTracking.size === 0) this.inFlightByRule.delete(ruleId);
			this.decrement(projectId);
		});
		this.inFlight.add(tracked);
		ruleTracking.add(tracked);
	}
	/** Record a decision against the row's current version.
	*  Workers settle while `drain()` awaits, so the version it read before an await is routinely
	*  stale by the time it writes; a compare-and-set on that stale value threw out of the round. */
	record(ruleId, decision, nextEligibleAt, state) {
		const latest = this.taskboard.provider.getAutomation(ruleId);
		return this.taskboard.provider.recordAutomationDecision(latest.id, latest.version, decision, nextEligibleAt, state);
	}
	decrement(projectId) {
		const next = Math.max(0, (this.runningByProject.get(projectId) ?? 1) - 1);
		if (next === 0) this.runningByProject.delete(projectId);
		else this.runningByProject.set(projectId, next);
	}
	cancelTimer(ruleId) {
		const timer = this.timers.get(ruleId);
		if (timer !== void 0) clearTimeout(timer);
		this.timers.delete(ruleId);
	}
};
//#endregion
//#region ../../../deepseek-harness/packages/core/agent/lib/index.js
/**
* Agent-scoped model selection shared by runtime entry points.
* @module @deepseek-ai/dsh-agent/model-selection
*/
/**
* Couple one mutable selection to Agent-scoped prompt assembly and request routing.
* Prompt assembly snapshots the selected model before delegating, then applies
* its provider/model pair and effort to request config so a
* concurrent switch takes effect on a later step instead of splitting the two
* surfaces. An absent selected effort clears any inherited effort, restoring
* the selected model's provider/default behavior.
*
* @param agentCtx - The selected Agent's scoped context.
* @param selection - Mutable selection owned by the calling entry point.
* @returns Disposer for both scoped waterfall listeners.
*/
function installModelSelection(agentCtx, selection) {
	const disposeAssembly = agentCtx.on("system-prompt/assemble", async (_assembly, _context, next) => {
		const selected = selection.current;
		const assembled = await next();
		selection.assembled = selected;
		if (selected === void 0) return assembled;
		return {
			...assembled,
			variables: {
				...assembled.variables,
				provider: selected.provider,
				model: selected.model
			}
		};
	});
	const disposeRequest = agentCtx.on("agent/request", async (_payload, next) => {
		const resolved = await next();
		const selected = selection.assembled;
		if (selected === void 0) return resolved;
		const { reasoningEffort: _inheritedEffort, ...withoutInheritedEffort } = resolved;
		return {
			...withoutInheritedEffort,
			provider: selected.provider,
			model: selected.model,
			...selected.reasoningEffort === void 0 ? {} : { reasoningEffort: selected.reasoningEffort }
		};
	});
	return () => {
		disposeAssembly();
		disposeRequest();
	};
}
//#endregion
//#region ../../../deepseek-harness/packages/core/session/lib/index.js
/**
* Brand a string as a {@link SessionId}.
* @param id - the raw session id string.
* @returns the same string with the session-id brand.
*/
function SessionId(id) {
	return brandString(id);
}
/**
* The workspace domain declaration: record schema and the `defineDomain` spec
* the registry opens. The zod schema validates the shipped format at the
* durability boundary and is the direct source of a future RPC wire projection.
* @module @deepseek-ai/dsh-workspace/src/spec
*/
/** Workspace id schema at the durable boundary; branding has no runtime representation. */
const workspaceId = string$1().transform((value) => value);
/**
* Durable shape of one workspace record. `path` is the `fs.realpath` canon
* stamped at create; `sessionIds` is the ordered ownership account (array
* order is display order); timestamps are ISO-8601 strings.
*/
const workspaceRecord = object({
	path: string$1(),
	title: string$1(),
	sessionIds: array(string$1().transform((value) => brandString(value))),
	createdAt: string$1(),
	updatedAt: string$1()
});
/**
* Recoverable two-write mutation marker. The marker is persisted before the
* record/order pair can diverge, so startup can distinguish an interrupted
* registry operation from unexplained medium corruption.
*/
const workspacePendingMutation = discriminatedUnion("operation", [object({
	operation: literal("create"),
	workspaceId
}), object({
	operation: literal("delete"),
	workspaceId
})]);
defineDomain({
	name: "workspace",
	version: 2,
	global: {
		schema: object({
			initialized: boolean(),
			workspaceIds: array(workspaceId),
			archivedSessionIds: array(string$1().transform((value) => brandString(value))).default([]),
			pendingMutation: workspacePendingMutation.optional()
		}),
		initial: {
			initialized: false,
			workspaceIds: [],
			archivedSessionIds: []
		}
	},
	tables: { workspaces: domainTable(workspaceRecord) }
});
/**
* Workspace entity registry (`ctx.workspaceRegistry`): durable workspace records,
* stable registry order, and header-validated session membership over the
* domain data form.
* @module @deepseek-ai/dsh-workspace
*/
/**
* Brand a string as a {@link WorkspaceId}.
* @param id - Raw workspace id string.
* @returns the same string, branded at compile time.
*/
function WorkspaceId(id) {
	return id;
}
Service.init;
//#endregion
//#region lib/taskboard-host/execution/index.js
function route(value) {
	if (value === void 0) return void 0;
	const at = value.includes(":") ? value.indexOf(":") : value.indexOf("/");
	if (at < 1 || at === value.length - 1) throw new TaskboardError("automation modelRoute must be provider:model or provider/model", "TASK_INVALID_INPUT");
	return {
		provider: value.slice(0, at),
		model: value.slice(at + 1)
	};
}
/** Human edits that a working Session must re-read. These are the activity kinds the provider
*  actually writes: the listener used to test for a `task.commented` kind that nothing emits, so
*  every human comment on an in-progress task was dropped. */
const FOLLOWUP_ACTIVITY_KINDS = new Set([
	"task.updated",
	"comment.created",
	"comment.updated",
	"comment.deleted"
]);
function withReasoning(selection, reasoning) {
	if (reasoning === void 0) return selection;
	return {
		...selection,
		reasoningEffort: ReasoningEffortId(reasoning)
	};
}
/** Resolve the model an automation worker must install before prompt assembly. */
function resolveAutomationModel(ctx, rule) {
	const explicit = route(rule.config.modelRoute);
	if (explicit !== void 0) return withReasoning(explicit, rule.config.reasoning);
	const selected = ctx.get("agentDefaultModel")?.currentSelection();
	if (selected === void 0 || selected.provider.length === 0 || selected.model.length === 0) throw new TaskboardError("automation modelRoute is empty and the Host default model is unavailable", "TASK_INVALID_INPUT");
	return withReasoning(selected, rule.config.reasoning);
}
function actor(rule, claim) {
	return {
		kind: "automation",
		actorId: `automation:${rule.id}`,
		automationId: rule.id,
		sessionId: claim.sessionId,
		agentId: claim.agentId
	};
}
/** Prefer a short review marker when a result comment already exists. */
function completionResultComment(comments) {
	return comments.some((item) => item.body.trim() !== "") ? "Ready for review." : "Work completed.";
}
function renderWorkflowNode(node, depth, branch) {
	const config = Object.keys(node.config).length === 0 ? "" : `; config=${JSON.stringify(node.config)}`;
	const lines = [`${"  ".repeat(depth)}- ${branch}: ${node.kind} [${node.execution}]${config}`];
	for (const child of node.steps ?? []) lines.push(...renderWorkflowNode(child, depth + 1, "step"));
	for (const child of node.trueBranch ?? []) lines.push(...renderWorkflowNode(child, depth + 1, "true"));
	for (const child of node.falseBranch ?? []) lines.push(...renderWorkflowNode(child, depth + 1, "false"));
	return lines;
}
/** Assigned workflows are durable execution guidance. The editor's executable/design-only marker
*  describes registered capabilities; it does not make the scheduler an implicit workflow engine. */
function renderWorkflowGuidance(service, task) {
	if (task.workflowId === void 0) return "- None";
	const workflow = service.provider.getWorkflow(task.workflowId);
	const lines = [`Workflow: ${workflow.name} (guidance-only; nodes are not run automatically)`];
	for (const tab of workflow.document.tabs) {
		lines.push(`Tab: ${tab.name}`);
		lines.push(...renderWorkflowNode(tab.trigger, 1, "trigger"));
		for (const node of tab.steps) lines.push(...renderWorkflowNode(node, 1, "step"));
	}
	return lines.join("\n");
}
/** Render the complete durable task instruction admitted to a worker Session. */
function renderTaskInstruction(service, taskId, claim) {
	const detail = service.provider.getTaskDetail(TaskId(taskId));
	const dependencyLines = [];
	for (const relation of detail.relations) {
		const otherId = relation.sourceTaskId === detail.task.id ? relation.targetTaskId : relation.sourceTaskId;
		const other = service.provider.getTask(otherId);
		const direction = relation.sourceTaskId === detail.task.id ? "outgoing" : "incoming";
		dependencyLines.push(`- ${relation.kind} (${direction}): ${other.identifier} [${other.status}] ${other.title}`);
	}
	const comments = detail.comments.length === 0 ? "- None" : detail.comments.map((item) => `- ${item.authorId}: ${item.body}`).join("\n");
	const attachments = detail.attachments.length === 0 ? "- None" : detail.attachments.map((item) => `- ${item.id}: ${item.filename} (${item.contentType}, ${item.byteSize} bytes)`).join("\n");
	const development = detail.task.developmentContext === void 0 ? "Project workspace" : detail.task.developmentContext.kind === "branch" ? `Branch ${detail.task.developmentContext.branch}` : `Worktree ${detail.task.developmentContext.path}, branch ${detail.task.developmentContext.branch}`;
	return [
		`Task ${detail.task.identifier}`,
		`Opaque task id: ${detail.task.id}`,
		`Claim id: ${claim.id}`,
		`Claimed task revision: ${claim.expectedTaskVersion}`,
		`Current task revision: ${detail.task.version}`,
		"",
		`Title: ${detail.task.title}`,
		"",
		"Description and acceptance details:",
		detail.task.description || "(No description supplied.)",
		"",
		"Current comments:",
		comments,
		"",
		"Relations and dependency state:",
		dependencyLines.length === 0 ? "- None" : dependencyLines.join("\n"),
		"",
		"Assigned workflow guidance:",
		renderWorkflowGuidance(service, detail.task),
		"",
		`Development context: ${development}`,
		"",
		"Attachment references:",
		attachments,
		"",
		"Read the task again before every write. Complete and verify the work, then record the final result with taskboard_comment or taskboard_submit_review. Never modify the task description. Only a human may accept it as done."
	].join("\n");
}
/** Native Agent/Session worker used by durable project automation. */
var HarnessTaskboardWorker = class {
	ctx;
	taskboard;
	handles = /* @__PURE__ */ new Map();
	constructor(ctx, taskboard) {
		this.ctx = ctx;
		this.taskboard = taskboard;
		ctx.on("goal/changed", ({ agent: changedAgent, change }) => {
			if (change.goal !== void 0) this.onGoalChanged(changedAgent, change.goal);
		});
		ctx.effect(() => taskboard.provider.subscribe((event) => {
			this.onTaskChanged(event);
		}), "taskboard: append committed requirement changes to owning Sessions");
	}
	/** Claim synchronously so the scheduler never counts work that lost the transaction race. */
	start(rule, task) {
		const sessionId = SessionId(`taskboard-${randomUUID()}`);
		const owner = {
			kind: "automation",
			actorId: `automation:${rule.id}`,
			automationId: rule.id,
			sessionId,
			agentId: sessionId
		};
		const claimed = this.taskboard.provider.claim(task.id, {
			expectedVersion: task.version,
			sessionId,
			agentId: sessionId
		}, owner);
		return this.launch(rule, claimed.task, claimed.claim, false);
	}
	/** Mark dead owners explicitly, then resume only claims owned by a still-enabled automation rule. */
	async reconcile() {
		const live = new Set(this.ctx.agents.list().map((item) => String(item.id)));
		this.taskboard.provider.markOrphanedClaims(live);
		for (const claim of this.taskboard.provider.listClaims(["orphaned"])) {
			if (claim.automationId === void 0) continue;
			let rule;
			try {
				rule = this.taskboard.provider.getAutomation(claim.automationId);
			} catch (_deletedRule) {
				continue;
			}
			if (rule.state !== "enabled") continue;
			const task = this.taskboard.provider.getTask(claim.taskId);
			try {
				await this.launch(rule, task, claim, true);
			} catch (_boundedResumeFailure) {}
		}
	}
	async stop() {
		const handles = [...this.handles.values()];
		this.handles.clear();
		await Promise.allSettled(handles.map((handle) => handle.dispose()));
	}
	/** Drop and dispose one tracked Agent handle; safe to call for a session already released. */
	async release(sessionId) {
		const handle = this.handles.get(sessionId);
		if (handle === void 0) return;
		this.handles.delete(sessionId);
		await handle.dispose().catch(() => void 0);
	}
	/** Release a handle only once its Session no longer owns an active claim. */
	async releaseUnclaimed(sessionId) {
		if (!this.taskboard.provider.listClaims(["active", "orphaned"]).some((claim) => claim.sessionId === sessionId)) await this.release(sessionId);
	}
	async launch(rule, task, initialClaim, resume) {
		const owner = actor(rule, initialClaim);
		let handle;
		try {
			const project = this.taskboard.provider.getProject(task.projectId);
			const workspace = project.workspaceId === void 0 ? void 0 : this.ctx.workspaceRegistry.get(WorkspaceId(project.workspaceId));
			const cwd = task.developmentContext?.kind === "worktree" ? task.developmentContext.path : workspace?.path;
			const selection = resolveAutomationModel(this.ctx, rule);
			const agentOptions = {
				provider: selection.provider,
				model: selection.model
			};
			const setup = async (agentCtx) => {
				const selected = {
					current: selection,
					assembled: void 0
				};
				agentCtx.effect(() => installModelSelection(agentCtx, selected), "taskboard: automation model route");
				await this.ctx.agentPresets.mount(agentCtx, rule.config.agentPreset);
			};
			handle = resume ? await this.ctx.agents.resume({
				resumeSessionId: SessionId(initialClaim.sessionId),
				agentOptions,
				setup
			}) : await this.ctx.agents.create({
				sessionId: SessionId(initialClaim.sessionId),
				meta: {
					...cwd === void 0 ? {} : { cwd },
					agentPreset: rule.config.agentPreset
				},
				agentOptions,
				setup
			});
			this.handles.set(initialClaim.sessionId, handle);
			if (workspace !== void 0) await workspace.attachSession(SessionId(initialClaim.sessionId));
			const claim = resume ? this.taskboard.provider.reclaimOrphanedClaim(task.id, this.taskboard.provider.getTask(task.id).version, owner).claim : initialClaim;
			if (this.ctx.goals.get(handle.agent) === void 0) this.ctx.goals.create(handle.agent, { objective: `Complete and verify ${task.identifier}: ${task.title}` });
			const current = this.taskboard.provider.getTask(task.id);
			handle.agent.followup(createUserMessage({
				content: [{
					type: "text",
					text: renderTaskInstruction(this.taskboard, task.id, claim)
				}],
				source: {
					kind: "taskboard",
					taskId: task.id,
					claimId: claim.id,
					claimedRevision: current.version
				}
			}));
			await handle.agent.whenIdle();
			await this.releaseUnclaimed(initialClaim.sessionId);
		} catch (error) {
			if (handle !== void 0) await this.release(initialClaim.sessionId);
			const latest = this.taskboard.provider.getTask(task.id);
			if (latest.status === "in_progress") try {
				this.taskboard.provider.releaseClaim(latest.id, latest.version, `worker startup failed: ${String(error)}`, owner);
			} catch (_preserveOriginal) {}
			throw error;
		}
	}
	onGoalChanged(changedAgent, goal) {
		const claim = this.taskboard.provider.listClaims(["active"]).find((item) => item.sessionId === changedAgent.id && item.agentId === changedAgent.id);
		if (claim === void 0) return;
		const task = this.taskboard.provider.getTask(claim.taskId);
		if (task.status !== "in_progress") return;
		let rule;
		const owner = claim.automationId === void 0 ? {
			kind: "agent",
			actorId: claim.agentId,
			sessionId: claim.sessionId,
			agentId: claim.agentId
		} : actor(rule = this.taskboard.provider.getAutomation(claim.automationId), claim);
		if (goal.phase !== "complete" && goal.phase !== "blocked") return;
		try {
			if (goal.phase === "complete") this.taskboard.provider.submitReview(task.id, task.version, "Completed", completionResultComment(this.taskboard.provider.getTaskDetail(task.id).comments), owner);
			else {
				const reason = goal.blockedReason?.message?.trim() ?? "";
				this.taskboard.provider.block(task.id, task.version, reason === "" ? "Harness Goal blocked" : reason, owner);
			}
		} catch (error) {
			if (rule !== void 0) this.recordGoalFailure(rule, task, error);
		}
		this.releaseUnclaimed(claim.sessionId);
	}
	recordGoalFailure(rule, task, error) {
		try {
			const latest = this.taskboard.provider.getAutomation(rule.id);
			this.taskboard.provider.recordAutomationDecision(latest.id, latest.version, {
				kind: "error",
				taskId: task.id,
				message: `Goal handoff failed: ${error instanceof Error ? error.message : String(error)}`,
				at: Date.now()
			}, latest.nextEligibleAt);
		} catch (_ruleUnavailable) {}
	}
	onTaskChanged(event) {
		if (event.actorKind !== "human" || event.taskId === void 0 || event.activityKind === void 0 || !FOLLOWUP_ACTIVITY_KINDS.has(event.activityKind)) return;
		const claim = this.taskboard.provider.listClaims(["active"]).find((item) => item.taskId === event.taskId);
		if (claim === void 0) return;
		const handle = this.handles.get(claim.sessionId);
		if (handle === void 0) return;
		const task = this.taskboard.provider.getTask(event.taskId);
		if (task.status !== "in_progress") return;
		handle.agent.steer(createUserMessage({
			content: [{
				type: "text",
				text: [
					`Task ${task.identifier} changed after your claim. Re-read this durable update before continuing.`,
					"",
					renderTaskInstruction(this.taskboard, task.id, claim)
				].join("\n")
			}],
			source: {
				kind: "taskboard",
				taskId: task.id,
				claimId: claim.id,
				claimedRevision: event.taskVersion ?? task.version
			}
		}));
	}
};
Schema.object({
	databasePath: Schema.string().required(),
	attachmentRoot: Schema.string().required(),
	pageSize: Schema.natural().min(1).max(2e3).default(100),
	snapshotTaskLimit: Schema.natural().min(1).max(2e3).default(1e3),
	maxAttachmentBytes: Schema.natural().min(1).default(25 * 1024 * 1024),
	maxTaskAttachmentBytes: Schema.natural().min(1).default(100 * 1024 * 1024),
	allowedAttachmentTypes: Schema.array(Schema.string()).default([
		"application/json",
		"application/octet-stream",
		"application/pdf",
		"application/zip",
		"image/gif",
		"image/jpeg",
		"image/png",
		"image/webp",
		"text/markdown",
		"text/plain"
	]),
	minAutomationIntervalMs: Schema.natural().min(1e3).default(3e4),
	maxProjectWorkers: Schema.natural().min(1).default(2),
	maxGlobalWorkers: Schema.natural().min(1).default(4),
	allowSharedWorktrees: Schema.boolean().default(false),
	clientRefreshIntervalMs: Schema.natural().min(1e3).max(3e5).default(15e3),
	maxChangeWaiters: Schema.natural().min(1).max(1024).default(128),
	maxChangeWatchMs: Schema.natural().min(1e3).max(6e4).default(3e4),
	defaultAgentPreset: Schema.string().default("standard"),
	defaultModelRoute: Schema.string()
});
/** Mount the Taskboard service and optional loopback Web RPC adapter. */
function apply(ctx, config) {
	const service = new TaskboardService(ctx, config);
	ctx.inject(["tools"], (toolCtx) => {
		registerTaskboardTools(toolCtx, service);
	});
	ctx.inject([
		"agents",
		"goals",
		"workspaceRegistry",
		"agentPresets",
		"agentDefaultModel"
	], (nativeCtx) => {
		const worker = new HarnessTaskboardWorker(nativeCtx, service);
		const automation = new TaskboardAutomationCoordinator(service, worker);
		service.bindAutomation(automation);
		nativeCtx.effect(() => {
			let stopping = false;
			worker.reconcile().then(() => {
				if (!stopping) automation.start();
			}, (error) => {
				nativeCtx.logger.warn(`taskboard startup reconciliation failed: ${String(error)}`);
				if (!stopping) automation.start();
			});
			return async () => {
				stopping = true;
				await automation.stop();
				await worker.stop();
			};
		}, "taskboard: Agent execution and automation lifecycle");
	});
}
//#endregion
export { apply };
