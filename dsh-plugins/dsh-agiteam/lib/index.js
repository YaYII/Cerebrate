import { n as Service, r as Schema, t as Context } from "./lib--7yKgOXA.js";
import { a as ReasoningEffortId, c as assertNever, d as snapshotJsonValue, i as HarnessError, l as deepFreeze, n as ROLE_PRESET, o as createUserMessage, r as STAGE_ROLE, s as brandString, t as ROLE_NAMES, u as isJsonValue } from "./roles-CiXzf-WJ.js";
import { i as reviewBackTo, r as nextStage, t as STAGE_NAMES } from "./stage-6kxWDxZR.js";
import { a as verifyAuditChain, i as sha256Hex, n as makeAuditEntry, r as parseAuditLog } from "./audit-CJNju73G.js";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
//#region ../../../deepseek-harness/packages/core/scope/lib/index.js
/**
* Shared insertion-ordered storage and effect ownership for scope-aware registries.
*
* @module @deepseek-ai/dsh-scope
*/
/**
* Insertion-ordered named entries with caller-owned duplicate diagnostics.
*
* Values are borrowed. Iterators are live within one nonempty table
* generation; draining the table detaches them from later insertions. Each
* successful insertion returns an idempotent undo for that exact entry.
*/
var NamedEntries = class {
	duplicateError;
	data = /* @__PURE__ */ new Map();
	constructor(duplicateError) {
		this.duplicateError = duplicateError;
	}
	/**
	* Insert one unique name.
	* @param name - name unique within this table.
	* @param value - borrowed value to retain.
	* @returns an idempotent undo that removes only this insertion.
	*/
	insert(name, value) {
		const data = this.data;
		if (data.has(name)) throw this.duplicateError(name);
		data.set(name, value);
		let active = true;
		return () => {
			if (!active) return;
			active = false;
			data.delete(name);
			if (data.size === 0 && this.data === data) this.data = /* @__PURE__ */ new Map();
		};
	}
	/**
	* Read one named value.
	* @param name - name to resolve.
	* @returns the retained value, or `undefined` when absent.
	*/
	get(name) {
		return this.data.get(name);
	}
	/**
	* Test one name for membership.
	* @param name - name to test.
	* @returns whether the table contains that name.
	*/
	has(name) {
		return this.data.has(name);
	}
	/**
	* Iterate live names in insertion order.
	* @returns the native live key iterator.
	*/
	keys() {
		return this.data.keys();
	}
	/**
	* Iterate live entries in insertion order.
	* @returns the native live entry iterator.
	*/
	entries() {
		return this.data.entries();
	}
	/**
	* Iterate live values in insertion order.
	* @returns the native live value iterator.
	*/
	values() {
		return this.data.values();
	}
	/**
	* Test whether this table has no entries.
	* @returns whether the table is empty.
	*/
	isEmpty() {
		return this.data.size === 0;
	}
};
/**
* Insertion-ordered anonymous entries with independent registration identity.
*
* Equal values remain separate registrations. Values are borrowed, and
* iterators are live within one nonempty table generation; draining the table
* detaches them from later appends.
*/
var AnonymousEntries = class {
	data = /* @__PURE__ */ new Map();
	/**
	* Append one independently owned value.
	* @param value - borrowed value to retain.
	* @returns an idempotent undo for this exact append.
	*/
	append(value) {
		const data = this.data;
		const key = Symbol();
		data.set(key, value);
		let active = true;
		return () => {
			if (!active) return;
			active = false;
			data.delete(key);
			if (data.size === 0 && this.data === data) this.data = /* @__PURE__ */ new Map();
		};
	}
	/**
	* Iterate live values in insertion order.
	* @returns the native live value iterator.
	*/
	values() {
		return this.data.values();
	}
	/**
	* Test whether this table has no entries.
	* @returns whether the table is empty.
	*/
	isEmpty() {
		return this.data.size === 0;
	}
};
/**
* Own the global and exact-scope layers for one registry.
*
* Reads never create scoped layers. Registrations derive both visibility and
* effect ownership from the supplied Cordis context, collect undo before
* notification, and reclaim only a completely empty aggregate layer.
*/
var ScopedLayers = class {
	createLayer;
	onChange;
	/** The eagerly constructed context-global layer. */
	global;
	scoped = /* @__PURE__ */ new Map();
	constructor(createLayer, onChange) {
		this.createLayer = createLayer;
		this.onChange = onChange;
		this.global = createLayer(void 0);
	}
	/**
	* Read an existing exact-scope overlay. Deliberately chain-blind: callers
	* addressing one scope's OWN contributions (its restrictions, its guards)
	* must not silently pick up an ancestor's — use {@link chainLayers} where
	* inheritance is the point.
	* @param scope - exact scope key; `undefined` denotes no overlay.
	* @returns the existing scoped layer, or `undefined` without creating one.
	*/
	peek(scope) {
		if (scope === void 0) return void 0;
		return this.scoped.get(scope);
	}
	/**
	* Existing overlays along the scope's parent chain ({@link scopeChainOf}),
	* farthest ancestor first and the exact scope last, so a caller layering
	* them in order gives the nearest scope the final word.
	* @param scope - viewing scope, or `undefined` for no overlays.
	* @returns the existing layers, nearest last; absent overlays are skipped.
	*/
	chainLayers(scope) {
		const layers = [];
		for (const key of scopeChainOf(scope).reverse()) {
			const layer = this.scoped.get(key);
			if (layer !== void 0) layers.push(layer);
		}
		return layers;
	}
	/**
	* Materialize global named entries followed by scope-chain shadows,
	* farthest ancestor first, so the nearest scope's entry wins a name.
	* @param scope - viewing scope, or `undefined` for the global view.
	* @param pick - select the named table from a layer.
	* @returns an insertion-ordered effective map.
	*/
	merge(scope, pick) {
		const merged = new Map(pick(this.global).entries());
		for (const layer of this.chainLayers(scope)) for (const [name, value] of pick(layer).entries()) merged.set(name, value);
		return merged;
	}
	/**
	* Attach one synchronous layer mutation to its registration context.
	* @param ctx - context that determines both scope visibility and effect ownership.
	* @param action - atomic mutation returning its synchronous undo.
	* @param options - Cordis effect label and optional change notification.
	* @returns the exact disposer returned by `ctx.effect()`.
	*/
	effect(ctx, action, options) {
		const scope = scopeOf(ctx);
		const notify = options.notify ?? true;
		return ctx.effect(function* () {
			let layer;
			let created = false;
			if (scope === void 0) layer = this.global;
			else {
				const existing = this.scoped.get(scope);
				if (existing === void 0) {
					layer = this.createLayer(scope);
					this.scoped.set(scope, layer);
					created = true;
				} else layer = existing;
			}
			let undo;
			try {
				undo = action(layer);
			} catch (error) {
				if (scope !== void 0 && created && layer.isEmpty()) this.scoped.delete(scope);
				throw error;
			}
			yield () => {
				undo();
				if (scope !== void 0 && layer.isEmpty()) this.scoped.delete(scope);
				if (notify) this.onChange();
			};
			if (notify) this.onChange();
		}.bind(this), options.label);
	}
};
/**
* Scoped-context primitive: mint a Cordis context that tags registrations with
* an opaque identity and build routing-only event carriers for that identity.
*
* @module @deepseek-ai/dsh-scope
*/
/** Context tag written by {@link createScope}. */
const kScope = Symbol("dsh.scope");
/** The key associated with each carrier. Presence distinguishes an unkeyed carrier from a non-carrier. */
const carrierKeys = /* @__PURE__ */ new WeakMap();
/**
* The enclosing scope of each key. One relation powers both directions of
* scope nesting: registration views inherit DOWN the chain (a child scope
* sees its ancestors' layers — {@link ScopedLayers}), and event admission
* extends UP it (a listener tagged with an ancestor receives events dispatched
* to a descendant key — {@link scopeTarget}).
*/
const scopeParents = /* @__PURE__ */ new WeakMap();
/**
* The chain from a key to its root ancestor.
* @param key - the starting key, or `undefined` for the empty chain.
* @returns keys nearest-first: `[key, parent, grandparent, …]`.
*/
function scopeChainOf(key) {
	const chain = [];
	for (let cursor = key; cursor !== void 0; cursor = scopeParents.get(cursor)) chain.push(cursor);
	return chain;
}
/**
* Read the nearest scope tag inherited by a context.
* @param ctx - context to inspect.
* @returns its scope key, or `undefined` for an unscoped context.
*/
function scopeOf(ctx) {
	return ctx[kScope];
}
/**
* Build an opaque receiver that preserves the base filter, admits untagged
* listeners globally, and admits tagged listeners for a matching key or any
* of its ancestors ({@link bindScopeParent}): a listener owned by an enclosing
* scope receives every descendant scope's events, which is what lets one
* standing composition observe each of the agents composed under it. A tag
* BELOW the dispatch key stays excluded — events flow up the chain, never
* down.
* @param base - subject or service whose existing Cordis filter is preserved.
* @param key - routed scope identity, or `undefined` for an unscoped subject.
* @returns a carrier whose subject remains available only through event arguments.
*/
function scopeTarget(base, key) {
	const baseFilter = base[Context.filter];
	const carrier = { [Context.filter](ctx) {
		if (baseFilter !== void 0 && !baseFilter.call(base, ctx)) return false;
		const tag = scopeOf(ctx);
		if (tag === void 0) return true;
		for (let cursor = key; cursor !== void 0; cursor = scopeParents.get(cursor)) if (cursor === tag) return true;
		return false;
	} };
	carrierKeys.set(carrier, key);
	return carrier;
}
//#endregion
//#region ../../../deepseek-harness/packages/core/tools/lib/index.js
/**
* Enforced JSON Schema subset shared by tool outputs, generated PTC mode
* types, subagents, and workflows. The subset accepts any JSON root, an
* annotation-only schema for unconstrained JSON, one scalar `type`, object
* `properties`/`required`/boolean `additionalProperties`, array `items`,
* type-correct scalar `enum`/`const`, and exact-one `oneOf`.
*
* Unsupported or misplaced keywords reject rather than being accepted without
* enforcement. Consumers that require an object root apply
* {@link assertObjectJsonSchema} before accepting input.
* @module dsh-tools/json-schema
*/
/**
* Thrown when a raw schema falls outside the enforced subset. `violations`
* lists every offending path instead of stopping at the first author error.
*/
var JsonSchemaError = class extends HarnessError {
	/** Individual schema violations in walk order. */
	violations;
	constructor(violations) {
		super(`unsupported JSON schema: ${violations.join("; ")}`, "UNSUPPORTED_SCHEMA");
		this.name = "JsonSchemaError";
		this.violations = violations;
	}
};
const CONSTRAINT_KEYWORDS = new Set([
	"type",
	"oneOf",
	"properties",
	"required",
	"additionalProperties",
	"items",
	"enum",
	"const"
]);
const ANNOTATION_KEYWORDS = new Set([
	"description",
	"title",
	"default",
	"examples"
]);
const SCHEMA_TYPES = [
	"object",
	"array",
	"string",
	"number",
	"integer",
	"boolean",
	"null"
];
/** Whether a realm-owned intrinsic prototype is backed by its native constructor. */
function hasIntrinsicConstructor(prototype, name) {
	const constructor = Object.getOwnPropertyDescriptor(prototype, "constructor")?.value;
	if (typeof constructor !== "function") return false;
	try {
		return constructor.name === name && constructor.prototype === prototype && Function.prototype.toString.call(constructor) === `function ${name}() { [native code] }`;
	} catch {
		return false;
	}
}
/** Whether a candidate is one realm's intrinsic `Object.prototype`. */
function isIntrinsicObjectPrototype(value) {
	return Object.getPrototypeOf(value) === null && hasIntrinsicConstructor(value, "Object");
}
/**
* Test for a realm-agnostic plain JSON record without accepting arrays or
* exotic objects.
* @param value - candidate record from any JavaScript realm.
* @returns Whether the value has a plain-object prototype chain.
*/
function isPlainJsonRecord(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	try {
		const prototype = Object.getPrototypeOf(value);
		return prototype === null || typeof prototype === "object" && isIntrinsicObjectPrototype(prototype);
	} catch {
		return false;
	}
}
/** Whether an array uses one realm's intrinsic `Array.prototype`. */
function hasPlainArrayPrototype(value) {
	const prototype = Object.getPrototypeOf(value);
	if (!Array.isArray(prototype) || !hasIntrinsicConstructor(prototype, "Array")) return false;
	const objectPrototype = Object.getPrototypeOf(prototype);
	return typeof objectPrototype === "object" && objectPrototype !== null && isIntrinsicObjectPrototype(objectPrototype);
}
/** Return whether a record contains only own enumerable string keys. */
function hasOnlyEnumerableStringKeys(value) {
	try {
		return Reflect.ownKeys(value).every((key) => typeof key === "string" && Object.prototype.propertyIsEnumerable.call(value, key));
	} catch {
		return false;
	}
}
/**
* Test for an ordinary schema record whose keys survive JSON projection.
* @param value - candidate record from any JavaScript realm.
* @returns Whether the record has an intrinsic prototype and only own enumerable string keys.
*/
function isJsonSchemaRecord(value) {
	return isPlainJsonRecord(value) && hasOnlyEnumerableStringKeys(value);
}
/**
* Test for a dense ordinary array with no JSON-invisible decorations.
* @param value - candidate array from any JavaScript realm.
* @returns Whether the array is intrinsic, dense, and undecorated.
*/
function isPlainJsonArray(value) {
	if (!Array.isArray(value)) return false;
	try {
		if (!hasPlainArrayPrototype(value) || Reflect.ownKeys(value).length !== value.length + 1) return false;
		for (let index = 0; index < value.length; index++) if (!Object.hasOwn(value, index)) return false;
		return true;
	} catch {
		return false;
	}
}
/** Lossless finite JSON number, excluding negative zero. */
function isJsonNumber(value) {
	return typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0);
}
/** Whether a scalar is valid for one declared schema type. */
function scalarMatches(type, value) {
	switch (type) {
		case "string": return typeof value === "string";
		case "number": return isJsonNumber(value);
		case "integer": return isJsonNumber(value) && Number.isInteger(value);
		case "boolean": return typeof value === "boolean";
		case "null": return value === null;
		/* v8 ignore next -- JsonSchemaScalarType is closed; this retains compile-time exhaustiveness. */
		default: return assertNever(type, "JsonSchemaType");
	}
}
/** Keywords that are invalid beside `oneOf`. */
const ONE_OF_SIBLING_KEYWORDS = [
	"properties",
	"required",
	"additionalProperties",
	"items",
	"enum",
	"const"
];
/** Validate object-only fields after its property schemas have been visited. */
function checkObjectSchemaTail(node, path, properties, violations) {
	const hasRequired = Object.hasOwn(node, "required");
	const required = hasRequired ? node.required : void 0;
	if (hasRequired) if (!isPlainJsonArray(required) || required.some((entry) => typeof entry !== "string")) violations.push(`${path}.required must be an array of strings`);
	else {
		const declared = isJsonSchemaRecord(properties) ? properties : {};
		for (const key of required) if (!Object.hasOwn(declared, key)) violations.push(`${path}.required names "${key}" which is not in properties`);
	}
	if (Object.hasOwn(node, "additionalProperties") && typeof node.additionalProperties !== "boolean") violations.push(`${path}.additionalProperties must be a boolean`);
}
/** Collect every violation for one raw schema tree without using the JavaScript call stack. */
function checkSchemaNode(root, rootPath, violations, seen) {
	const tasks = [{
		kind: "enter",
		node: root,
		path: rootPath
	}];
	for (let task = tasks.pop(); task !== void 0; task = tasks.pop()) {
		if (task.kind === "leave") {
			seen.delete(task.node);
			continue;
		}
		if (task.kind === "one-of-tail") {
			for (const key of ONE_OF_SIBLING_KEYWORDS) if (Object.hasOwn(task.node, key)) violations.push(`${task.path}.${key} is not supported beside oneOf`);
			continue;
		}
		if (task.kind === "object-tail") {
			checkObjectSchemaTail(task.node, task.path, task.properties, violations);
			continue;
		}
		const { node, path } = task;
		if (!isJsonSchemaRecord(node)) {
			violations.push(`${path} must be a schema object`);
			continue;
		}
		if (seen.has(node)) {
			violations.push(`${path} is circular`);
			continue;
		}
		seen.add(node);
		tasks.push({
			kind: "leave",
			node
		});
		for (const key of Object.keys(node)) {
			if (CONSTRAINT_KEYWORDS.has(key)) continue;
			if (ANNOTATION_KEYWORDS.has(key)) {
				try {
					if (!isJsonValue(node[key])) violations.push(`${path}.${key} annotation must be lossless JSON data`);
				} catch {
					violations.push(`${path}.${key} annotation must be lossless JSON data`);
				}
				continue;
			}
			violations.push(`${path}.${key} is not a supported keyword (subset: type/oneOf/properties/required/additionalProperties/items/enum/const + annotations)`);
		}
		if (Object.hasOwn(node, "description") && typeof node.description !== "string") violations.push(`${path}.description must be a string`);
		if (Object.hasOwn(node, "title") && typeof node.title !== "string") violations.push(`${path}.title must be a string`);
		const hasType = Object.hasOwn(node, "type");
		const hasOneOf = Object.hasOwn(node, "oneOf");
		if (hasType && hasOneOf) {
			violations.push(`${path} cannot declare both type and oneOf`);
			continue;
		}
		if (!hasType && !hasOneOf) {
			for (const key of ONE_OF_SIBLING_KEYWORDS) if (Object.hasOwn(node, key)) violations.push(`${path}.${key} requires type or oneOf`);
			continue;
		}
		if (hasOneOf) {
			const oneOf = node.oneOf;
			tasks.push({
				kind: "one-of-tail",
				node,
				path
			});
			if (!isPlainJsonArray(oneOf) || oneOf.length < 2) violations.push(`${path}.oneOf must be an array of at least two schemas`);
			else for (let index = oneOf.length - 1; index >= 0; index--) tasks.push({
				kind: "enter",
				node: oneOf[index],
				path: `${path}.oneOf[${index}]`
			});
			continue;
		}
		const type = node.type;
		if (typeof type !== "string" || !SCHEMA_TYPES.includes(type)) {
			violations.push(Array.isArray(type) ? `${path}.type must be a single type string (type arrays are not supported)` : `${path}.type must be one of ${SCHEMA_TYPES.join("/")}`);
			continue;
		}
		const schemaType = type;
		for (const [key, types] of Object.entries({
			properties: ["object"],
			required: ["object"],
			additionalProperties: ["object"],
			items: ["array"],
			enum: [
				"string",
				"number",
				"integer",
				"boolean",
				"null"
			],
			const: [
				"string",
				"number",
				"integer",
				"boolean",
				"null"
			]
		})) if (Object.hasOwn(node, key) && !types.includes(schemaType)) violations.push(`${path}.${key} is not supported on type "${schemaType}"`);
		switch (schemaType) {
			case "object": {
				const properties = Object.hasOwn(node, "properties") ? node.properties : void 0;
				tasks.push({
					kind: "object-tail",
					node,
					path,
					properties
				});
				if (Object.hasOwn(node, "properties")) if (!isJsonSchemaRecord(properties)) violations.push(`${path}.properties must be an object of schemas`);
				else {
					const entries = Object.entries(properties);
					for (let index = entries.length - 1; index >= 0; index--) {
						const entry = entries[index];
						/* v8 ignore next -- the loop is bounded by the captured entry count. */
						if (entry === void 0) continue;
						tasks.push({
							kind: "enter",
							node: entry[1],
							path: `${path}.properties.${entry[0]}`
						});
					}
				}
				break;
			}
			case "array":
				if (Object.hasOwn(node, "items")) tasks.push({
					kind: "enter",
					node: node.items,
					path: `${path}.items`
				});
				break;
			case "string":
			case "number":
			case "integer":
			case "boolean":
			case "null": {
				const hasEnum = Object.hasOwn(node, "enum");
				const allowed = hasEnum ? node.enum : void 0;
				const enumValid = isPlainJsonArray(allowed) && allowed.length > 0 && allowed.every((entry) => scalarMatches(schemaType, entry));
				if (hasEnum && !enumValid) violations.push(`${path}.enum must be a non-empty array of ${schemaType} values`);
				const hasConst = Object.hasOwn(node, "const");
				const declaredConst = hasConst ? node.const : void 0;
				const constValid = scalarMatches(schemaType, declaredConst);
				if (hasConst) {
					if (!constValid) violations.push(`${path}.const must be a ${schemaType} value`);
					else if (enumValid && !allowed.includes(declaredConst)) violations.push(`${path}.const must be one of ${path}.enum when both are declared`);
				}
				break;
			}
			/* v8 ignore next -- schemaType was narrowed from the closed SCHEMA_TYPES table above. */
			default: assertNever(schemaType, "JsonSchemaType");
		}
	}
}
/**
* Assert that an arbitrary raw schema uses only the enforced subset.
* Annotation-only schemas are accepted as the standard unconstrained-JSON
* form; callers that require an object root use {@link assertObjectJsonSchema}.
* @param schema - untrusted raw JSON Schema.
* @returns Assertion that the schema belongs to the supported subset.
*/
function assertSupportedJsonSchema(schema) {
	const violations = [];
	checkSchemaNode(schema, "schema", violations, /* @__PURE__ */ new Set());
	if (violations.length > 0) throw new JsonSchemaError(violations);
}
/** Safely test the lossless JSON boundary when a getter may throw. */
function safelyIsJsonValue(value) {
	try {
		return isJsonValue(value);
	} catch {
		return false;
	}
}
/** Root-aware diagnostic path for the parameter validator's empty sentinel. */
function diagnosticPath(path) {
	return path === "" ? "arguments" : path;
}
/** Append one object property without a leading dot at an implicit root. */
function propertyPath(path, key) {
	return path === "" ? key : `${path}.${key}`;
}
/** The generic exception-containment diagnostic owned by one valid schema node. */
function losslessValueViolation(path) {
	return [`"${diagnosticPath(path)}" must be a lossless JSON value`];
}
/** Append diagnostics without spreading a potentially wide child result as call arguments. */
function appendViolations(target, source) {
	for (const violation of source) target.push(violation);
}
/** Initialize one validation frame with empty aggregation state. */
function valueFrame(node, value, path) {
	return {
		node,
		value,
		path,
		catches: false,
		phase: "start",
		children: [],
		childIndex: 0,
		violations: [],
		tailViolations: [],
		matches: 0
	};
}
/** Validate one scalar node after its primitive type check. */
function checkScalarValue(node, value, path) {
	const allowed = Object.hasOwn(node, "enum") ? node.enum : void 0;
	if (allowed !== void 0 && !allowed.includes(value)) return [`"${diagnosticPath(path)}" must be one of ${JSON.stringify(allowed)}`];
	if (Object.hasOwn(node, "const") && value !== node.const) return [`"${diagnosticPath(path)}" must be ${JSON.stringify(node.const)}`];
	return [];
}
/** Validate one trusted schema/value pair with explicit frames rather than recursive calls. */
function checkValue(schema, value, path) {
	const frames = [valueFrame(schema, value, path)];
	let rootResult;
	const receive = (result) => {
		const parent = frames.at(-1);
		if (parent === void 0) {
			rootResult = result;
			return;
		}
		if (parent.kind === "oneOf") {
			if (result.length === 0) parent.matches++;
		} else appendViolations(parent.violations, result);
	};
	const finish = (result) => {
		frames.pop();
		receive(result);
	};
	while (frames.length > 0) {
		const frame = frames.at(-1);
		/* v8 ignore next -- the loop condition guarantees a current frame. */
		if (frame === void 0) break;
		try {
			if (frame.phase === "children") {
				if (frame.childIndex < frame.children.length) {
					const child = frame.children[frame.childIndex];
					/* v8 ignore next -- childIndex is bounded by children.length. */
					if (child === void 0) throw new Error("missing schema-value child frame");
					frame.childIndex++;
					frames.push(valueFrame(child.node, child.value, child.path));
					continue;
				}
				if (frame.kind === "oneOf") {
					finish(frame.matches === 1 ? [] : [`"${diagnosticPath(frame.path)}" must match exactly one oneOf branch (matched ${frame.matches})`]);
					continue;
				}
				appendViolations(frame.violations, frame.tailViolations);
				if (frame.violations.length > 0) finish(frame.violations);
				else if (frame.kind === "object") finish(safelyIsJsonValue(frame.value) ? [] : [`"${diagnosticPath(frame.path)}" must be a lossless JSON object`]);
				else finish(safelyIsJsonValue(frame.value) ? [] : [`"${diagnosticPath(frame.path)}" must be a dense lossless JSON array`]);
				continue;
			}
			const nodeType = Object.hasOwn(frame.node, "type") ? frame.node.type : void 0;
			frame.catches = !(nodeType !== void 0 && !SCHEMA_TYPES.includes(nodeType));
			const oneOf = Object.hasOwn(frame.node, "oneOf") ? frame.node.oneOf : void 0;
			if (oneOf !== void 0) {
				frame.kind = "oneOf";
				frame.children = Array.from(oneOf, (branch) => ({
					node: branch,
					value: frame.value,
					path: frame.path
				}));
				frame.childIndex = 0;
				frame.matches = 0;
				frame.phase = "children";
				continue;
			}
			if (nodeType === void 0) {
				finish(safelyIsJsonValue(frame.value) ? [] : losslessValueViolation(frame.path));
				continue;
			}
			switch (nodeType) {
				case "object": {
					if (!isPlainJsonRecord(frame.value)) {
						finish([`"${diagnosticPath(frame.path)}" must be an object`]);
						break;
					}
					const properties = Object.hasOwn(frame.node, "properties") ? frame.node.properties ?? {} : {};
					const violations = [];
					const required = Object.hasOwn(frame.node, "required") ? frame.node.required ?? [] : [];
					for (const key of required) if (!Object.hasOwn(frame.value, key) || frame.value[key] === void 0) violations.push(`missing required property "${propertyPath(frame.path, key)}"`);
					const children = [];
					for (const [key, child] of Object.entries(properties)) {
						if (!Object.hasOwn(frame.value, key) || frame.value[key] === void 0) continue;
						children.push({
							node: child,
							value: frame.value[key],
							path: propertyPath(frame.path, key)
						});
					}
					const tailViolations = [];
					if (Object.hasOwn(frame.node, "additionalProperties") && frame.node.additionalProperties === false) {
						for (const key of Object.keys(frame.value)) if (!Object.hasOwn(properties, key)) tailViolations.push(`"${propertyPath(frame.path, key)}" is not a declared property (additionalProperties: false)`);
					}
					frame.kind = "object";
					frame.children = children;
					frame.childIndex = 0;
					frame.violations = violations;
					frame.tailViolations = tailViolations;
					frame.phase = "children";
					break;
				}
				case "array": {
					if (!Array.isArray(frame.value)) {
						finish([`"${diagnosticPath(frame.path)}" must be an array`]);
						break;
					}
					const items = Object.hasOwn(frame.node, "items") ? frame.node.items : void 0;
					const children = items === void 0 ? [] : frame.value.flatMap((entry, index) => [{
						node: items,
						value: entry,
						path: `${frame.path}[${index}]`
					}]);
					frame.kind = "array";
					frame.children = children;
					frame.childIndex = 0;
					frame.violations = [];
					frame.phase = "children";
					break;
				}
				case "string":
					finish(typeof frame.value === "string" ? checkScalarValue(frame.node, frame.value, frame.path) : [`"${diagnosticPath(frame.path)}" must be a string`]);
					break;
				case "number":
					finish(typeof frame.value !== "number" ? [`"${diagnosticPath(frame.path)}" must be a number`] : !isJsonNumber(frame.value) ? [`"${diagnosticPath(frame.path)}" must be a finite JSON number`] : checkScalarValue(frame.node, frame.value, frame.path));
					break;
				case "integer":
					finish(!isJsonNumber(frame.value) || !Number.isInteger(frame.value) ? [`"${diagnosticPath(frame.path)}" must be an integer`] : checkScalarValue(frame.node, frame.value, frame.path));
					break;
				case "boolean":
					finish(typeof frame.value === "boolean" ? checkScalarValue(frame.node, frame.value, frame.path) : [`"${diagnosticPath(frame.path)}" must be a boolean`]);
					break;
				case "null":
					finish(frame.value === null ? checkScalarValue(frame.node, frame.value, frame.path) : [`"${diagnosticPath(frame.path)}" must be null`]);
					break;
				default: finish(assertNever(nodeType, "JsonSchemaType"));
			}
		} catch (error) {
			let failed = frames.pop();
			while (failed !== void 0 && !failed.catches) failed = frames.pop();
			if (failed === void 0) throw error;
			receive(losslessValueViolation(failed.path));
		}
	}
	/* v8 ignore next -- every root frame finishes or throws. */
	return rootResult ?? losslessValueViolation(path);
}
/**
* Validate a candidate value against an asserted raw schema. The function is
* total for arbitrary values and returns path-qualified violations.
* @param schema - a schema accepted by {@link assertSupportedJsonSchema}.
* @param value - the candidate JSON value.
* @param path - root label used in diagnostics.
* @returns All violations in walk order; empty means valid.
*/
function validateJsonSchemaValue(schema, value, path = "value") {
	return checkValue(schema, value, path);
}
/** Unified JSON-value schema DSL, inference, compilation, and typed tool helper. @module dsh-tools/schema */
const ANNOTATION_KEYS = [
	"description",
	"title",
	"default",
	"examples"
];
/** Throw one author-schema violation through the shared schema error type. */
function authorError(message) {
	throw new JsonSchemaError([message]);
}
/** Copy own annotation fields for validation by the raw-schema boundary. */
function copyAnnotations(source, target) {
	if (Object.hasOwn(source, "description")) target.description = source.description;
	if (Object.hasOwn(source, "title")) target.title = source.title;
	if (Object.hasOwn(source, "default")) target.default = source.default;
	if (Object.hasOwn(source, "examples")) target.examples = source.examples;
}
/** Reject author-only keys outside one node's declared vocabulary. */
function assertAuthorKeys(source, path, allowed) {
	for (const key of Object.keys(source)) if (!allowed.includes(key)) authorError(`${path}.${key} is not supported by the value schema DSL`);
}
/** Install a compiled node without giving `__proto__` assignment semantics. */
function assignCompiledNode(destination, node) {
	switch (destination.kind) {
		case "root":
			destination.holder.value = node;
			break;
		case "property":
			Object.defineProperty(destination.target, destination.key, {
				value: node,
				enumerable: true,
				configurable: true,
				writable: true
			});
			break;
		case "item":
			destination.target.items = node;
			break;
		case "one-of":
			destination.target[destination.index] = node;
			break;
	}
}
/** Install a compiled property map at its root or containing object node. */
function assignCompiledPropertyMap(destination, compiled) {
	if (destination.kind === "root") destination.holder.value = compiled;
	else destination.target.properties = compiled.properties;
}
/** Execute an author-schema compilation task graph without recursive descent. */
function runSchemaCompiler(initial) {
	const seen = /* @__PURE__ */ new Set();
	const tasks = [initial];
	for (let task = tasks.pop(); task !== void 0; task = tasks.pop()) {
		if (task.kind === "leave") {
			seen.delete(task.input);
			continue;
		}
		if (task.kind === "property-map-tail") {
			if (task.required.length > 0) {
				task.compiled.required = task.required;
				if (task.destination.kind === "object") task.destination.target.required = task.required;
			}
			continue;
		}
		if (task.kind === "property") {
			if (!isJsonSchemaRecord(task.property)) authorError(`${task.path} must be a value schema object`);
			if (Object.hasOwn(task.property, "required") && task.property.required !== true) authorError(`${task.path}.required must be true when present`);
			if (Object.hasOwn(task.property, "required") && task.property.required === true) task.required.push(task.key);
			tasks.push({
				kind: "value",
				input: task.property,
				path: task.path,
				allowRequired: true,
				destination: {
					kind: "property",
					target: task.properties,
					key: task.key
				}
			});
			continue;
		}
		if (task.kind === "property-map") {
			if (!isJsonSchemaRecord(task.input)) authorError(`${task.path} must be an object of value schemas`);
			if (seen.has(task.input)) authorError(`${task.path} is circular`);
			seen.add(task.input);
			const compiled = { properties: {} };
			const required = [];
			assignCompiledPropertyMap(task.destination, compiled);
			tasks.push({
				kind: "leave",
				input: task.input
			});
			tasks.push({
				kind: "property-map-tail",
				compiled,
				required,
				destination: task.destination
			});
			const entries = Object.entries(task.input);
			for (let index = entries.length - 1; index >= 0; index--) {
				const entry = entries[index];
				/* v8 ignore next -- the loop is bounded by the captured entry count. */
				if (entry === void 0) continue;
				tasks.push({
					kind: "property",
					property: entry[1],
					path: `${task.path}.${entry[0]}`,
					key: entry[0],
					properties: compiled.properties,
					required
				});
			}
			continue;
		}
		const { input, path } = task;
		if (!isJsonSchemaRecord(input)) authorError(`${path} must be a value schema object`);
		if (seen.has(input)) authorError(`${path} is circular`);
		seen.add(input);
		const authorKeys = [...ANNOTATION_KEYS, ...task.allowRequired ? ["required"] : []];
		const node = {};
		assignCompiledNode(task.destination, node);
		tasks.push({
			kind: "leave",
			input
		});
		if (Object.hasOwn(input, "oneOf")) {
			assertAuthorKeys(input, path, [
				...authorKeys,
				"oneOf",
				"type"
			]);
			if (Object.hasOwn(input, "type")) authorError(`${path} cannot declare both type and oneOf`);
			if (!isPlainJsonArray(input.oneOf)) authorError(`${path}.oneOf must be an array of at least two value schemas`);
			const branches = [];
			node.oneOf = branches;
			copyAnnotations(input, node);
			for (let index = input.oneOf.length - 1; index >= 0; index--) tasks.push({
				kind: "value",
				input: input.oneOf[index],
				path: `${path}.oneOf[${index}]`,
				allowRequired: false,
				destination: {
					kind: "one-of",
					target: branches,
					index
				}
			});
			continue;
		}
		const inputType = Object.hasOwn(input, "type") ? input.type : void 0;
		switch (inputType) {
			case "json":
				assertAuthorKeys(input, path, [...authorKeys, "type"]);
				copyAnnotations(input, node);
				break;
			case "object":
				assertAuthorKeys(input, path, [
					...authorKeys,
					"type",
					"properties",
					"additionalProperties"
				]);
				if (!Object.hasOwn(input, "additionalProperties") || typeof input.additionalProperties !== "boolean") authorError(`${path}.additionalProperties must be explicitly true or false`);
				node.type = "object";
				copyAnnotations(input, node);
				node.additionalProperties = input.additionalProperties;
				if (Object.hasOwn(input, "properties")) tasks.push({
					kind: "property-map",
					input: input.properties,
					path: `${path}.properties`,
					destination: {
						kind: "object",
						target: node
					}
				});
				break;
			case "array":
				assertAuthorKeys(input, path, [
					...authorKeys,
					"type",
					"items"
				]);
				node.type = "array";
				copyAnnotations(input, node);
				if (Object.hasOwn(input, "items")) tasks.push({
					kind: "value",
					input: input.items,
					path: `${path}.items`,
					allowRequired: false,
					destination: {
						kind: "item",
						target: node
					}
				});
				break;
			case "string":
			case "number":
			case "integer":
			case "boolean":
			case "null":
				assertAuthorKeys(input, path, [
					...authorKeys,
					"type",
					"enum",
					"const"
				]);
				node.type = inputType;
				copyAnnotations(input, node);
				if (Object.hasOwn(input, "enum")) {
					if (!isPlainJsonArray(input.enum)) authorError(`${path}.enum must be a non-empty array of scalar values`);
					node.enum = Array.from(input.enum, (entry) => entry);
				}
				if (Object.hasOwn(input, "const")) node.const = input.const;
				break;
			default: authorError(`${path}.type must be string/number/integer/boolean/null/array/object/json, or use oneOf`);
		}
	}
}
/** Compile one implicit property map, collecting per-property requiredness. */
function compilePropertyMap(input, path) {
	const holder = {};
	runSchemaCompiler({
		kind: "property-map",
		input,
		path,
		destination: {
			kind: "root",
			holder
		}
	});
	/* v8 ignore next -- the root task assigns before scheduling any descendants. */
	return holder.value ?? authorError(`${path} did not compile`);
}
/** Compile one author node without applying any consumer root restriction. */
function compileValueSchema(input, path) {
	const holder = {};
	runSchemaCompiler({
		kind: "value",
		input,
		path,
		allowRequired: false,
		destination: {
			kind: "root",
			holder
		}
	});
	/* v8 ignore next -- the root task assigns before scheduling any descendants. */
	return holder.value ?? authorError(`${path} did not compile`);
}
/**
* Compile one author-facing value schema to the enforced raw JSON Schema
* subset. The author-only `json` node becomes an annotation-only schema.
* @param spec - schema for any JSON-value root.
* @returns The asserted raw schema projection.
*/
function valueSchemaSpecToJsonSchema(spec) {
	const schema = compileValueSchema(spec, "schema");
	assertSupportedJsonSchema(schema);
	return schema;
}
/**
* Compile the implicit open parameter object into raw JSON Schema.
* @param spec - per-property parameter definitions.
* @returns An object-rooted raw schema with no implicit-root openness override.
*/
function parameterSchemaSpecToJsonSchema(spec) {
	const compiled = compilePropertyMap(spec, "parameters");
	const schema = {
		type: "object",
		properties: compiled.properties,
		...compiled.required === void 0 ? {} : { required: compiled.required }
	};
	assertSupportedJsonSchema(schema);
	return schema;
}
/** Invalid model-generated arguments for a typed tool. */
var ToolArgsError = class extends HarnessError {
	/** Individual violations in schema-walk order. */
	violations;
	constructor(violations) {
		super(`invalid arguments: ${violations.join("; ")}`, "INVALID_ARGS");
		this.name = "ToolArgsError";
		this.violations = violations;
	}
};
/**
* Define a first-party tool with inferred arguments and strict execution
* validation. Replay-only presenters validate softly and fall back to generic
* rendering for obsolete logged arguments.
* @param options - typed definition and optional finalizer and presenters.
* @returns A registry-ready definition.
*/
function defineTool(options) {
	const userExecute = options.execute;
	const userFinalizeContent = options.finalizeContent;
	const userRender = options.output.render;
	const userPresentationMeta = options.output.presentationMeta;
	const userPresentCall = options.presentCall;
	const userPresentResult = options.presentResult;
	const userIsConcurrencySafe = options.isConcurrencySafe;
	if (options.timeoutMs !== void 0 && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) throw new Error(`defineTool(${options.name}): timeoutMs must be a positive finite number`);
	const parameters = parameterSchemaSpecToJsonSchema(options.parameters);
	const outputSchema = valueSchemaSpecToJsonSchema(options.output.schema);
	const validate = (args) => validateJsonSchemaValue(parameters, args, "");
	const tool = {
		name: options.name,
		description: options.description,
		parameters,
		output: {
			schema: outputSchema,
			render(args, value) {
				return userRender(args, value);
			},
			...userPresentationMeta !== void 0 ? { presentationMeta(args, value) {
				return userPresentationMeta(args, value);
			} } : {}
		},
		...options.timeoutMs !== void 0 ? { timeoutMs: options.timeoutMs } : {},
		async execute(args, exec) {
			const violations = validate(args);
			if (violations.length > 0) throw new ToolArgsError(violations);
			return userExecute(args, exec);
		}
	};
	if (userFinalizeContent) tool.finalizeContent = (exec, result) => userFinalizeContent(exec, result);
	if (userPresentCall) tool.presentCall = (args) => {
		if (validate(args).length > 0) return void 0;
		return userPresentCall(args);
	};
	if (userPresentResult) tool.presentResult = (args, result) => {
		if (validate(args).length > 0) return void 0;
		return userPresentResult(args, result);
	};
	if (userIsConcurrencySafe) tool.isConcurrencySafe = (args) => {
		if (validate(args).length > 0) return false;
		return userIsConcurrencySafe(args);
	};
	return tool;
}
/**
* PTC mode `run_code` transport. Programs call the registry's agent-visible
* tools through nested executions scheduled under the native concurrency
* contract; each sub-dispatch is logged for reconstruction, while only the
* outer curated result enters model history.
* @module @deepseek-ai/dsh-tools/src/ptc
*/
/** The model-facing name of the PTC mode tool. */
const RUN_CODE_NAME = "run_code";
/**
* The TypeScript flavor: the fallback for a schema read with no runtime
* mounted ({@link resolveFlavor} owns which readers reach that). A real
* assembly always resolves a runtime first, so the model never sees this
* fallback outside its own language.
*/
const TYPESCRIPT_FLAVOR = {
	description: "Execute a TypeScript program against the available tools. Takes two required arguments: `code`, the BODY of an async function (erasable syntax only; top-level `await` and `return` work), and `description`, a short summary of what the program does. Call tools as `await tools.name(args)` per the declarations in the system prompt. Only what you print or return is program output — curate it. Image-bearing subtool results are attached after the run.",
	codeDescription: "The program: the body of an async TypeScript function."
};
/** Per-language `run_code` schema flavors (see {@link RunCodeFlavor}); one entry per {@link CodeSdkLanguage}. */
const RUN_CODE_FLAVORS = {
	typescript: TYPESCRIPT_FLAVOR,
	python: {
		description: "Execute a Python program against the available tools. Takes two required arguments: `code`, the BODY of an async function (top-level `await` and `return` work), and `description`, a short summary of what the program does. Call tools as `await tools.name(args)` per the declarations in the system prompt. Use `print(...)` and/or `return <value>` for program output — curate it. Image-bearing subtool results are attached after the run.",
		codeDescription: "The program: the body of an async Python function."
	}
};
/**
* The `description` parameter's model-facing description: language-independent
* (the UI label contract is the same for every runtime), shared between the
* static spec and the language-aware `parameters` getter so the two emissions
* can never drift.
*/
const RUN_CODE_DESCRIPTION_PARAM_DESCRIPTION = "Clear, concise description of what this program does in active voice, 5-10 words (shown in the UI). Examples: \"Count TODO markers across packages\"; \"Read failing test and its fixture\"; \"Rename config key in every cordis.yml\".";
/**
* Resolve the {@link RunCodeFlavor} for the loaded runtime's language, read at
* schema-emission time so the model-visible `run_code` schema always matches
* the SDK section's language. `peekRuntime` returns `undefined` only when no
* runtime is mounted, which reaches this function through definition readers
* and `schemas()` — the doc-catalog harvest is the only shipped one, and none
* of them feeds a model, because `wireSchemas` calls `requireCodeRuntime`
* before projecting — so that path degrades to {@link TYPESCRIPT_FLAVOR}. A
* mounted runtime whose language has no flavor entry fails loud, exactly as
* `requireCodeRuntime` rejects it at assembly. Keeping this table in step with
* `SDK_RENDERERS` is the compiler's job ({@link CodeSdkLanguage}); what this
* guard owns is the runtime-supplied language neither table knows, which never
* yields a wrong-language schema for a real runtime.
*/
function resolveFlavor(peekRuntime) {
	const runtime = peekRuntime();
	if (runtime === void 0) return TYPESCRIPT_FLAVOR;
	const flavor = RUN_CODE_FLAVORS[runtime.language];
	if (!Object.hasOwn(RUN_CODE_FLAVORS, runtime.language) || flavor === void 0) {
		const known = Object.keys(RUN_CODE_FLAVORS).map((name) => JSON.stringify(name)).join(", ");
		throw new Error(`dsh-tools: no run_code schema flavor registered for runtime language ${JSON.stringify(runtime.language)} (known: ${known})`);
	}
	return flavor;
}
/**
* Thrown by `run_code` when the program run itself failed — a program
* exception, a budget expiry, an abort, or substrate death. Extends
* {@link HarnessError} (`code: 'CODE_RUN_FAILED'`); the registry's execution
* pipeline converts it into a structured `isError` result whose text carries
* the failure kind plus the captured logs, so the model can self-correct.
*/
var CodeRunFailedError = class extends HarnessError {
	constructor(message) {
		super(message, "CODE_RUN_FAILED");
		this.name = "CodeRunFailedError";
	}
};
/**
* Snapshot one binding call's argument as lossless JSON, then snapshot that
* detached value again so dispatch and logging stay independent without
* reintroducing structured-clone's platform-specific nesting limit.
*/
function jsonNormalizeArgs(value) {
	let snapshot;
	try {
		snapshot = snapshotJsonValue(value);
	} catch (error) {
		throw new Error(`tool arguments must be lossless JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (snapshot === void 0) throw new Error("tool arguments must be lossless JSON (call the tool with an arguments object, e.g. `{}`)");
	const logged = snapshotJsonValue(snapshot);
	/* v8 ignore next -- snapshot is already a detached lossless JSON value. */
	if (logged === void 0) throw new Error("tool arguments could not be detached for durable logging");
	return {
		dispatched: snapshot,
		logged
	};
}
/** Two-space JSON presentation, matching the existing shallow `run_code` text contract. */
const JSON_INDENT = "  ";
/**
* ECMAScript caps `JSON.stringify`'s `space` string at ten characters. The
* renderer also caps TOTAL indentation there, compacting deeper subtrees, so
* formatted output remains linear in the canonical JSON size.
*/
const MAX_JSON_INDENT_CHARS = 10;
/** Render one non-string JSON root without recursive traversal or unbounded indentation growth. */
function renderJsonValue(value) {
	const chunks = [];
	const tasks = [{
		kind: "value",
		value,
		depth: 0,
		compact: false
	}];
	for (let task = tasks.pop(); task !== void 0; task = tasks.pop()) {
		if (task.kind === "text") {
			chunks.push(task.text);
			continue;
		}
		const current = task.value;
		if (current === null || typeof current === "boolean" || typeof current === "number") {
			chunks.push(String(current));
			continue;
		}
		if (typeof current === "string") {
			chunks.push(JSON.stringify(current));
			continue;
		}
		const compact = task.compact || (task.depth + 1) * 2 > MAX_JSON_INDENT_CHARS;
		const childDepth = task.depth + 1;
		if (Array.isArray(current)) {
			chunks.push("[");
			if (current.length === 0) {
				chunks.push("]");
				continue;
			}
			tasks.push({
				kind: "text",
				text: compact ? "]" : `\n${JSON_INDENT.repeat(task.depth)}]`
			});
			for (let index = current.length - 1; index >= 0; index--) {
				const item = current[index];
				/* v8 ignore next -- canonical JsonValue arrays are dense. */
				if (item === void 0) throw new Error("cannot render a sparse JSON array");
				tasks.push({
					kind: "value",
					value: item,
					depth: childDepth,
					compact
				});
				tasks.push({
					kind: "text",
					text: compact ? index === 0 ? "" : "," : `${index === 0 ? "\n" : ",\n"}${JSON_INDENT.repeat(childDepth)}`
				});
			}
			continue;
		}
		const keys = Object.keys(current);
		chunks.push("{");
		if (keys.length === 0) {
			chunks.push("}");
			continue;
		}
		tasks.push({
			kind: "text",
			text: compact ? "}" : `\n${JSON_INDENT.repeat(task.depth)}}`
		});
		for (let index = keys.length - 1; index >= 0; index--) {
			const key = keys[index];
			/* v8 ignore next -- the loop is bounded by the captured key count. */
			if (key === void 0) throw new Error("cannot render a missing JSON object key");
			const item = current[key];
			/* v8 ignore next -- canonical JsonValue records contain no undefined properties. */
			if (item === void 0) throw new Error("cannot render an undefined JSON object property");
			tasks.push({
				kind: "value",
				value: item,
				depth: childDepth,
				compact
			});
			tasks.push({
				kind: "text",
				text: compact ? `${index === 0 ? "" : ","}${JSON.stringify(key)}:` : `${index === 0 ? "\n" : ",\n"}${JSON_INDENT.repeat(childDepth)}${JSON.stringify(key)}: `
			});
		}
	}
	return chunks.join("");
}
/** Render one present program completion value for the model-facing result text. */
function renderValue(value) {
	return typeof value === "string" ? value : renderJsonValue(value);
}
/**
* Build the `run_code` {@link ToolDefinition}: required `code` and
* `description` parameters, executed through the dispatch bridge described
* above. The
* registry reserves it as presentation infrastructure under non-native modes,
* outside the filterable global/scoped capability layers.
* @param registry - the owning registry (sub-calls go through its `execute`,
*   bindings cover its registered tools).
* @param options - the registry-private capabilities described above.
* @returns the registry-ready definition.
*/
function createRunCodeTool(registry, options) {
	const { requireRuntime, peekRuntime, maxParallel, shapeDispatchLog } = options;
	const definition = defineTool({
		name: RUN_CODE_NAME,
		description: TYPESCRIPT_FLAVOR.description,
		parameters: {
			code: {
				type: "string",
				required: true,
				description: TYPESCRIPT_FLAVOR.codeDescription
			},
			description: {
				type: "string",
				required: true,
				description: RUN_CODE_DESCRIPTION_PARAM_DESCRIPTION
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					logs: {
						type: "array",
						required: true,
						items: { type: "string" }
					},
					result: { type: "json" }
				}
			},
			render: (_args, value) => {
				const rendered = value.result === void 0 ? "" : renderValue(value.result);
				const parts = [value.logs.join("\n"), rendered].filter((part) => part.length > 0);
				return [{
					type: "text",
					text: parts.length > 0 ? parts.join("\n") : "(run_code completed with no output)"
				}];
			}
		},
		async execute(args, exec) {
			if (args.description.trim().length === 0) throw new Error("invalid description: expected a non-empty string");
			const runtime = requireRuntime();
			const runController = new AbortController();
			const onOuterAbort = () => {
				runController.abort(exec.signal.reason);
			};
			exec.signal.addEventListener("abort", onOuterAbort, { once: true });
			let dispatches = 0;
			const pendingQueue = [];
			const inFlight = /* @__PURE__ */ new Set();
			/** Tracked settle-event side work (log-content listener + append), drained at run settlement. */
			const logWork = /* @__PURE__ */ new Set();
			const commitQueue = [];
			let exclusiveActive = false;
			let driving = false;
			let driverRun = Promise.resolve();
			let wake;
			const wakeup = () => {
				const release = wake;
				wake = void 0;
				release?.();
			};
			/**
			* The single ordered lane. Each pass commits the head-of-line settled
			* dispatch (ordered post-execute), then starts the next queued entry if
			* its slot is free (ordered pre-execute), and otherwise sleeps until a
			* body settles or a new submission arrives. One run reaching the
			* empty-queues/empty-pool state is quiescence.
			*/
			const drive = () => {
				if (driving) return driverRun;
				driving = true;
				driverRun = (async () => {
					try {
						for (;;) {
							const signal = new Promise((resolve) => {
								wake = resolve;
							});
							const commitHead = commitQueue[0];
							if (commitHead !== void 0 && commitHead.settled) {
								commitQueue.shift();
								await commitHead.commit();
								if (commitHead.mode === "exclusive") exclusiveActive = false;
								continue;
							}
							const head = pendingQueue[0];
							if (head !== void 0) {
								if (runController.signal.aborted) {
									pendingQueue.shift();
									head.abandon();
									continue;
								}
								const mode = head.classify();
								if (!exclusiveActive && (mode === "exclusive" ? inFlight.size === 0 : inFlight.size < maxParallel)) {
									if (mode === "exclusive") exclusiveActive = true;
									head.mode = mode;
									pendingQueue.shift();
									commitQueue.push(head);
									await head.start();
									const flight = head.flight.finally(() => {
										inFlight.delete(flight);
										wakeup();
									});
									inFlight.add(flight);
									continue;
								}
							}
							if (pendingQueue.length === 0 && commitQueue.length === 0 && inFlight.size === 0) return;
							await signal;
						}
					} finally {
						driving = false;
						wake = void 0;
					}
				})();
				return driverRun;
			};
			/** Every dispatch settled AND committed; nothing can start (the run is aborted at call time). */
			const drainDispatches = async () => {
				await drive();
				while (logWork.size > 0) await Promise.allSettled([...logWork]);
			};
			const runOver = () => runController.signal.aborted;
			const binding = (name) => async (rawArgs) => {
				if (runOver()) throw new Error(`run_code run is over (${String(runController.signal.reason)}); ${name} not dispatched`);
				const normalized = jsonNormalizeArgs(rawArgs);
				const n = ++dispatches;
				const subCallId = brandString(`${String(exec.callId)}:ptc:${n}`);
				const input = {
					callId: subCallId,
					rootCallId: exec.rootCallId,
					name,
					arguments: normalized.dispatched,
					...exec.agent ? { agent: exec.agent } : {},
					parent: exec.token,
					signal: runController.signal
				};
				const scheduler = registry[TOOL_RUNTIME_SCHEDULER];
				const outcome = await new Promise((resolve, reject) => {
					let parked;
					const settle = (result) => {
						resolve(result.isError ? {
							isError: true,
							message: result.error.message
						} : {
							isError: false,
							value: result.value
						});
						const agent = exec.agent;
						if (agent === void 0) return;
						const task = (async () => {
							const logged = await shapeDispatchLog({
								exec,
								agent,
								subCallId,
								name,
								isError: result.isError,
								content: result.content
							});
							agent.session.append("tool/ptc-dispatch", {
								rootCallId: exec.rootCallId,
								parentCallId: exec.callId,
								subCallId,
								name,
								arguments: normalized.logged,
								isError: result.isError,
								content: logged
							});
						})().finally(() => {
							logWork.delete(task);
						});
						logWork.add(task);
					};
					pendingQueue.push({
						flight: Promise.resolve(),
						settled: false,
						classify: () => registry.executionMode(input).kind,
						abandon: () => {
							reject(/* @__PURE__ */ new Error(`run_code run is over (${String(runController.signal.reason)}); ${name} tool call abandoned`));
						},
						async start() {
							exec.agent?.session.append("tool/ptc-dispatch-start", {
								rootCallId: exec.rootCallId,
								parentCallId: exec.callId,
								subCallId,
								name,
								arguments: normalized.logged
							});
							const prepared = await scheduler.prepare(input);
							if (prepared.kind === "dispatch") {
								this.flight = scheduler.dispatch(prepared.exec).then((dispatchOutcome) => {
									parked = {
										kind: dispatchOutcome.kind,
										exec: prepared.exec,
										result: dispatchOutcome.result
									};
									this.settled = true;
								});
								return;
							}
							parked = {
								kind: prepared.kind,
								exec: prepared.exec,
								result: prepared.result
							};
							this.settled = true;
						},
						async commit() {
							/* v8 ignore next -- commit() runs only after `settled` flipped, which set parked. */
							if (parked === void 0) return;
							const result = parked.kind === "post-result" ? await scheduler.finalize(parked.exec, parked.result) : scheduler.finish(parked.exec, parked.result);
							if (!result.isError && result.content.some((block) => block.type === "image")) exec.deferContext(createUserMessage({
								content: result.content,
								source: {
									kind: "plugin",
									plugin: "tools-ptc"
								}
							}));
							for (const context of result.additionalContexts ?? []) exec.deferContext(context);
							if (result.concludesTurn) exec.concludeTurn();
							settle(result);
							while (logWork.size > maxParallel) await Promise.race(logWork);
						}
					});
					wakeup();
					drive();
				});
				if (runOver()) throw new Error(`run_code run is over (${String(runController.signal.reason)}); ${name} result discarded`);
				if (outcome.isError) throw new Error(outcome.message);
				return outcome.value;
			};
			const functions = Object.create(null);
			for (const schema of registry.schemas(exec.agent)) {
				if (schema.name === "run_code") continue;
				Object.defineProperty(functions, schema.name, {
					enumerable: true,
					value: binding(schema.name)
				});
			}
			try {
				let result;
				try {
					result = await runtime.run({
						program: args.code,
						bindings: [{
							global: "tools",
							functions,
							errorClass: {
								name: "ToolCallError",
								memberNameProperty: "toolName"
							}
						}],
						signal: runController.signal
					});
				} finally {
					runController.abort("run_code settled");
					await drainDispatches();
				}
				if (result.error) {
					const logsText = result.logs.length > 0 ? `\nCaptured output:\n${result.logs.join("\n")}` : "";
					throw new CodeRunFailedError(`code run failed (${result.error.kind}): ${result.error.message}${logsText}`);
				}
				return {
					logs: result.logs,
					...result.value !== void 0 ? { result: result.value } : {}
				};
			} finally {
				exec.signal.removeEventListener("abort", onOuterAbort);
			}
		},
		presentCall: (args) => ({
			card: "generic",
			title: args.description,
			kind: "execute",
			rawInput: args.code
		})
	});
	Object.defineProperty(definition, "description", {
		enumerable: true,
		get: () => resolveFlavor(peekRuntime).description
	});
	Object.defineProperty(definition, "parameters", {
		enumerable: true,
		get: () => parameterSchemaSpecToJsonSchema({
			code: {
				type: "string",
				required: true,
				description: resolveFlavor(peekRuntime).codeDescription
			},
			description: {
				type: "string",
				required: true,
				description: RUN_CODE_DESCRIPTION_PARAM_DESCRIPTION
			}
		})
	});
	return definition;
}
/**
* PTC mode codegen: the pure projection from registered tool schemas to the TypeScript SDK
* text the model programs against (the `tools:sdk` prompt section). Sibling of
* `json-schema.ts` — `schemas()` (native function calling) and this module (the generated
* `declare const tools` API) are two projections of the same store.
* @module @deepseek-ai/dsh-tools/src/ts-types
*/
/** Property names that are valid bare TS identifiers; anything else is quoted. */
const IDENTIFIER$1 = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
/** Render an object key: bare when it is a valid identifier, quoted otherwise (every name stays reachable, no aliasing). */
function renderKey(name) {
	return IDENTIFIER$1.test(name) ? name : JSON.stringify(name);
}
/** One `indent`-deep line prefix (two spaces per level). */
function pad$1(indent) {
	return "  ".repeat(indent);
}
/** A one-line JSDoc block for a schema `description`, or no lines when there is none. */
function docLines$1(description, indent) {
	if (typeof description !== "string" || description.length === 0) return [];
	const collapsed = description.replace(/\s+/g, " ").trim();
	return [`${pad$1(indent)}/** ${collapsed.replaceAll("*/", String.raw`*\/`)} */`];
}
/** Render one scalar already validated by the unified schema boundary. */
function renderScalar(value) {
	return JSON.stringify(value);
}
/** Render a validated scalar `const`/`enum`, falling back to the broad type. */
function renderConstrainedScalar$1(node, type) {
	const broad = type === "integer" ? "number" : type;
	if (Object.hasOwn(node, "const")) return renderScalar(node.const);
	if (Object.hasOwn(node, "enum")) return node.enum.map(renderScalar).join(" | ");
	return broad;
}
/** Build one document from captured parts while retaining the legacy array-parenthesization test. */
function typeDocumentFrom(parts) {
	return {
		parts,
		containsUnionOrIntersection: parts.some((part) => typeof part === "string" ? part.includes("|") || part.includes("&") : part.containsUnionOrIntersection)
	};
}
/** Build a small document without an intermediate array at each call site. */
function typeDocument(...parts) {
	return typeDocumentFrom(parts);
}
/** Flatten a nested document with an explicit work stack. */
function flattenTypeDocument(document) {
	const chunks = [];
	const tasks = [document];
	for (let task = tasks.pop(); task !== void 0; task = tasks.pop()) {
		if (typeof task === "string") {
			chunks.push(task);
			continue;
		}
		for (let index = task.parts.length - 1; index >= 0; index--) {
			const part = task.parts[index];
			/* v8 ignore next -- the loop is bounded by the captured part count. */
			if (part !== void 0) tasks.push(part);
		}
	}
	return chunks.join("");
}
/** Initialize one schema-render frame with empty aggregation state. */
function schemaRenderFrame(node, indent) {
	return {
		node,
		indent,
		phase: "start",
		children: [],
		childIndex: 0,
		childDocuments: [],
		entries: []
	};
}
/** Render an already asserted schema to a composable document. */
function renderSupportedSchema(schema, indent) {
	const frames = [schemaRenderFrame(schema, indent)];
	let rootDocument;
	const finish = (document) => {
		frames.pop();
		const parent = frames.at(-1);
		if (parent === void 0) rootDocument = document;
		else parent.childDocuments.push(document);
	};
	while (frames.length > 0) {
		const frame = frames.at(-1);
		/* v8 ignore next -- the loop condition guarantees a current frame. */
		if (frame === void 0) break;
		if (frame.phase === "children") {
			if (frame.childIndex < frame.children.length) {
				const child = frame.children[frame.childIndex];
				/* v8 ignore next -- childIndex is bounded by children.length. */
				if (child === void 0) throw new Error("missing schema render child");
				frame.childIndex++;
				frames.push(schemaRenderFrame(child.node, child.indent));
				continue;
			}
			if (frame.kind === "oneOf") {
				const parts = [];
				for (let index = 0; index < frame.childDocuments.length; index++) {
					if (index > 0) parts.push(" | ");
					const child = frame.childDocuments[index];
					/* v8 ignore next -- child documents correspond one-to-one with children. */
					if (child !== void 0) parts.push(child);
				}
				finish(typeDocumentFrom(parts));
				continue;
			}
			if (frame.kind === "array") {
				const child = frame.childDocuments[0];
				/* v8 ignore next -- array frames always schedule exactly one child. */
				if (child === void 0) throw new Error("missing array item type");
				finish(child.containsUnionOrIntersection ? typeDocument("(", child, ")[]") : typeDocument(child, "[]"));
				continue;
			}
			const required = new Set(frame.node.required);
			const parts = ["{"];
			for (let index = 0; index < frame.entries.length; index++) {
				const entry = frame.entries[index];
				const child = frame.childDocuments[index];
				/* v8 ignore next -- object entries and child documents have the same length. */
				if (entry === void 0 || child === void 0) throw new Error("missing object property type");
				const [name, prop] = entry;
				for (const line of docLines$1(prop.description, frame.indent + 1)) parts.push("\n", line);
				parts.push("\n", `${pad$1(frame.indent + 1)}${renderKey(name)}${required.has(name) ? "" : "?"}: `, child, ";");
			}
			parts.push("\n", `${pad$1(frame.indent)}}`);
			const declared = typeDocumentFrom(parts);
			finish(frame.node.additionalProperties === false ? declared : typeDocument(declared, " & Record<string, JsonValue>"));
			continue;
		}
		const node = frame.node;
		if (node.oneOf !== void 0) {
			frame.kind = "oneOf";
			frame.children = Array.from(node.oneOf, (child) => ({
				node: child,
				indent: frame.indent
			}));
			frame.childIndex = 0;
			frame.childDocuments = [];
			frame.phase = "children";
			continue;
		}
		if (node.type === void 0) {
			finish(typeDocument("JsonValue"));
			continue;
		}
		switch (node.type) {
			case "string":
			case "number":
			case "integer":
			case "boolean":
			case "null":
				finish(typeDocument(renderConstrainedScalar$1(node, node.type)));
				break;
			case "array":
				if (node.items === void 0) finish(typeDocument("JsonValue[]"));
				else {
					frame.kind = "array";
					frame.children = [{
						node: node.items,
						indent: frame.indent
					}];
					frame.childIndex = 0;
					frame.childDocuments = [];
					frame.phase = "children";
				}
				break;
			case "object": {
				const open = node.additionalProperties !== false;
				const entries = Object.entries(node.properties ?? {});
				if (entries.length === 0) finish(typeDocument(open ? "Record<string, JsonValue>" : "Record<string, never>"));
				else {
					frame.kind = "object";
					frame.entries = entries;
					frame.children = entries.map(([, child]) => ({
						node: child,
						indent: frame.indent + 1
					}));
					frame.childIndex = 0;
					frame.childDocuments = [];
					frame.phase = "children";
				}
				break;
			}
			/* v8 ignore next -- assertSupportedJsonSchema narrowed this closed type union. */
			default: finish(typeDocument("unknown"));
		}
	}
	/* v8 ignore next -- every root frame produces one document. */
	return rootDocument ?? typeDocument("unknown");
}
/**
* Map one enforced JSON-Schema node to a TypeScript type literal. Supports
* every unified schema construct and returns `unknown` for malformed or
* unsupported inputs without throwing.
* @param schema - the JSON-Schema node (any shape; hostile inputs degrade).
* @param indent - the indentation level for nested object members.
* @returns the TS type text (multi-line for objects with properties).
*/
function jsonSchemaToTs(schema, indent = 0) {
	try {
		assertSupportedJsonSchema(schema);
		return flattenTypeDocument(renderSupportedSchema(schema, indent));
	} catch {
		return "unknown";
	}
}
/** The fixed model-facing usage contract rendered above the declarations (see the PTC mode Agent Note's "What the model sees"). */
const SDK_INSTRUCTIONS$1 = `## Writing code for run_code

\`run_code\` takes two required arguments: \`code\` — the body of an async TypeScript function (erasable syntax only — no \`enum\` or namespaces; type annotations are advisory, the code runs type-stripped) — and \`description\`, a short summary of what the program does. The declarations below are SDK bindings for this program. A declaration does not make its name a directly callable tool; only names supplied as separate tool schemas may be called directly.`;
const SDK_PROGRAM_INSTRUCTIONS = `Inside the program:

- Call tools as \`await tools.name(args)\` — quoted access for exotic names: \`tools["my-tool"](args)\`. Every call resolves to the tool's typed canonical JSON value. Tool arguments must be lossless JSON.
- A FAILED tool call rejects with \`ToolCallError\`, whose \`toolName\` identifies the failed tool and whose \`message\` is human-readable — \`try/catch\` it to handle and continue.
- Independent read-only calls MAY overlap under \`Promise.all\` (safe calls run concurrently; mutating calls run alone, in submission order). Sequence dependent work with \`await\`.
- Emit results with \`return\` and/or \`console.log(...)\`. Only what you print or return is program output. A successful tool result containing an image is attached after the run so you can inspect it on the next step; every other intermediate result stays out of the conversation, so extract just what you need.

Program-only SDK bindings:`;
/** Whether one string schema accepts the literal used by the bash example. */
function acceptsExampleString(schema, value) {
	return schema?.type === "string" && (schema.const === void 0 || schema.const === value) && (schema.enum === void 0 || schema.enum.includes(value));
}
/** Render the bash example only when its literal arguments satisfy the current parameter schema. */
function renderBashExample(schemas) {
	const bash = schemas.find((schema) => schema.name === "bash");
	if (bash === void 0) return "";
	const parameters = bash.parameters;
	if (parameters.type !== "object") return "";
	const required = parameters.required ?? [];
	if (required.some((name) => name !== "command" && name !== "description")) return "";
	if (!acceptsExampleString(parameters.properties?.command, "pwd")) return "";
	const needsDescription = required.includes("description");
	if (needsDescription && !acceptsExampleString(parameters.properties?.description, "Show current directory")) return "";
	return ` When no separate \`bash\` schema is supplied, invoke a declared \`bash\` binding inside \`run_code\`:\n\n\`run_code({ code: "return await tools.bash({ command: 'pwd'${needsDescription ? ", description: 'Show current directory'" : ""} })", description: "Show current directory" })\``;
}
/**
* Render the full `tools:sdk` prompt section: the fixed usage instructions
* plus one `declare const tools` interface covering every given tool.
* Deterministic — tools are emitted in lexicographic name order, so an
* unchanged tool set produces byte-identical text across assemblies. The sort
* is not a total order on byte-equal names, so two schemas sharing a name
* would render in argument order; the caller's visible-capability map is keyed
* by name, so the input never carries a duplicate.
* @param schemas - the tool schemas to declare (the caller excludes
*   `run_code` itself).
* @returns the complete section text.
*/
function renderToolsSdk(schemas) {
	const sorted = [...schemas].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
	const argsMembers = [];
	const outputMembers = [];
	for (const schema of sorted) {
		argsMembers.push(...docLines$1(schema.description, 1));
		argsMembers.push(`${pad$1(1)}${renderKey(schema.name)}: ${jsonSchemaToTs(schema.parameters, 1)};`);
		outputMembers.push(`${pad$1(1)}${renderKey(schema.name)}: ${jsonSchemaToTs(schema.output, 1)};`);
	}
	const declaration = [
		`interface ToolArgsMap {${argsMembers.length > 0 ? `\n${argsMembers.join("\n")}\n` : ""}}`,
		`interface ToolOutputMap {${outputMembers.length > 0 ? `\n${outputMembers.join("\n")}\n` : ""}}`,
		"type ToolName = keyof ToolOutputMap",
		[
			"declare class ToolCallError extends Error {",
			"  readonly name: \"ToolCallError\";",
			"  readonly toolName: ToolName;",
			"}"
		].join("\n"),
		[
			"declare const tools: {",
			"  [K in ToolName]: (args: ToolArgsMap[K]) => Promise<ToolOutputMap[K]>;",
			"}"
		].join("\n")
	].join("\n\n");
	return `${SDK_INSTRUCTIONS$1}${renderBashExample(sorted)}\n\n${SDK_PROGRAM_INSTRUCTIONS}\n\n\`\`\`ts\ntype JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }\n\n${declaration}\n\`\`\``;
}
/**
* PTC mode codegen — Python flavor. The pure projection from registered tool schemas to the
* Python SDK text the model programs against under `runtime.language === 'python'`. Sibling of
* {@link ./ts-types.ts | ts-types.ts}; the two files are two projections of the same registry
* store, keyed by the loaded {@link @deepseek-ai/dsh-code-runtime#CodeRuntime.language | code
* runtime's language}.
*
* Under `mode: 'ptc'` the native tool schemas are omitted from the request, so this generated
* SDK is the model's ONLY source for each tool's argument names, required fields, types,
* descriptions, and canonical output shapes; under `mode: 'both'` the native schemas ship
* alongside it and it is one of two. Object-shaped arguments and outputs therefore render as one
* named `TypedDict` per tool (and per nested object), not an opaque `dict[str, Any]`, so the
* shape survives into the program under the mode that has nothing else to carry it.
* @module @deepseek-ai/dsh-tools/src/py-types
*/
/**
* The reference grammar's `xid_start xid_continue*` — the set
* `str.isidentifier()` accepts on a CPython whose Unicode tables match the
* engine's. See {@link isBareIdentifier} for what a version skew does.
*/
const IDENTIFIER = /^[\p{XID_Start}_]\p{XID_Continue}*$/u;
/**
* Whether a name can be emitted as a bare Python identifier rather than
* routed to the subscript/`dict[str, Any]` path.
*
* Python identifiers are not ASCII: `路径` is as legal a field name as `path`,
* and rejecting it would degrade the whole enclosing object, dropping every
* field's name, requiredness, and type — information whose only source under
* `mode: 'ptc'` is this generated text.
*
* NFKC stability is a second and separate condition, because CPython
* normalizes identifiers at compile time while JSON keys are compared as
* written: `ﬁeld` would be declared and reachable as `field`, so the SDK would
* advertise a key under a spelling the harness never accepts, and two keys
* that normalize together would collapse into one declaration. Those names
* take the subscript path, which carries their exact bytes.
*
* `IDENTIFIER` matches `str.isidentifier()` (measured on Node 22.23.1 vs
* CPython 3.9.6 tables): the equivalence holds inside the two versions' shared
* tables, and the skew characters below are exactly where that pair diverges.
* The predicate as a whole is deliberately stricter than `isidentifier()`,
* which does not test NFKC stability: `'ﬁeld'.isidentifier()` is True and
* this returns false.
*
* Both conditions are evaluated against the ENGINE's Unicode tables, and the
* two sides are versioned independently — `\p{XID_Start}`/`\p{XID_Continue}`
* follow the running engine (Node 22.23.1 reports Unicode 17.0) while CPython
* follows its own (3.9.6 reports 13.0.0). The skew is not symmetric. A CPython
* older than the engine is the dangerous direction: a character added to either
* property since its tables (U+10570 Vithkuqi and U+1E290 Toto, 14.0; U+1E4D0
* Nag Mundari, 15.0; U+1C89 Cyrillic TJE, 16.0 — ages per `DerivedAge.txt`; all
* four are NFKC-stable and accepted here, and all four are `Cn` on that 3.9.6,
* which rejects them) is emitted bare and its tokenizer refuses the character,
* taking the whole SDK block down — the same parseability invariant
* {@link UNPRINTABLE}, {@link LONE_SURROGATE} and {@link MAX_LIST_NESTING}
* exist for. Both properties carry it: a character added only to `XID_Continue`
* passes the trailing `\p{XID_Continue}*` in a tail position and fails the same
* way — U+200C ZWNJ and U+200D ZWJ are that case, gaining `XID_Continue` in UCD
* 15.1 and absent from it in 13.0.0, 14.0.0 and 15.0.0, so `a\u{200C}b` is
* emitted bare here while `isidentifier()` is False on 3.9.6 and on 3.12.13
* (15.0.0). A CPython newer than the engine only routes a legal name to the
* subscript/`dict[str, Any]` path: less readable, still correct. The NFKC
* condition reduces to the same skew, since normalization stability guarantees
* an assigned character's normalization never changes afterwards.
*
* This predicate is not the only reader of engine tables. {@link camelCase}
* reads them at three further points — its split set, its head test, and its
* `toUpperCase()` case mapping — and this predicate's verdict gates none of
* them: a class name derived there reaches emitted text whenever any object
* shape in the tool's schema declares a `TypedDict`, including for a tool this
* predicate rejected. A tool named `zz-\u{1E4D0}x` with such parameters never
* reaches the skew here (the `-` rejects it outright) yet emits `class
* Zz\u{1E4D0}xArgs`, which that same 3.9.6 refuses — Nag Mundari arrived two
* releases after its tables. The case mapping is a separate table rather than
* an XID membership test, and it fails on names both conditions above accept:
* `\u{019B}` is XID_Start and NFKC-stable, so this predicate accepts it and
* `async def \u{019B}` compiles on 3.9.6, but Node uppercases it to
* `\u{A7DC}` — unassigned in that CPython, whose own `.upper()` is the identity
* here — and the declared `class \u{A7DC}Args` fails with `invalid
* non-printable character U+A7DC`. Closing the exposure therefore covers all
* four read points, not this predicate alone; it needs the target interpreter's
* version, which the backend reporting `language: 'python'` owns; the
* language-dispatch Agent Note records the deferral.
*
* The `ts-types` sibling keeps its own ASCII rule rather than sharing this
* one: ECMAScript identifiers are a different set (`$`) and are never
* normalized, so one predicate cannot be correct for both. ZWJ/ZWNJ are not
* part of that difference — both sets carry them on the engine's tables; what
* separates the two there is the CPython table version above.
* @param name - the raw schema field or tool name.
* @returns whether the name can be emitted bare.
*/
function isBareIdentifier(name) {
	return IDENTIFIER.test(name) && name.normalize("NFKC") === name;
}
/**
* Python hard keywords: reserved everywhere, so a tool or field named
* ``class`` or ``lambda`` is legal on the wire but not as an attribute
* (``tools.class`` would be a SyntaxError in the model program) and not as a
* class-syntax `TypedDict` field. Such a tool renders under subscript access
* and such an object degrades to ``dict[str, Any]`` — the model still reaches
* every tool and field without collisions.
* Soft keywords (``match``, ``case``, ``type``, ``_`` — the language
* reference's whole set) are deliberately ABSENT: each is special in exactly
* one syntactic position — a statement head (``match``, ``type``), a ``match``
* statement's clause head (``case``), or a pattern (``_``) — so ``match: str``
* as a field and ``async def match(...)`` as a method are both legal, and
* including them would needlessly degrade common search/regex tool fields to
* ``dict[str, Any]``. Underscore-leading names are handled separately, not
* here: a non-dunder ``__token`` name-mangles, a dunder present on
* ``object``/``type`` resolves before the proxy hook, and implicit
* special-method lookup bypasses the hook.
*/
const RESERVED = new Set([
	"False",
	"None",
	"True",
	"and",
	"as",
	"assert",
	"async",
	"await",
	"break",
	"class",
	"continue",
	"def",
	"del",
	"elif",
	"else",
	"except",
	"finally",
	"for",
	"from",
	"global",
	"if",
	"import",
	"in",
	"is",
	"lambda",
	"nonlocal",
	"not",
	"or",
	"pass",
	"raise",
	"return",
	"try",
	"while",
	"with",
	"yield",
	"__debug__"
]);
/** `typing` symbols this module may emit, in the deterministic import order. */
const TYPING_ORDER = [
	"Any",
	"Literal",
	"NotRequired",
	"Protocol",
	"TypedDict"
];
/** `indent`-deep line prefix (four spaces per level to match PEP 8 output). */
function pad(indent) {
	return "    ".repeat(indent);
}
/**
* The `Cc` code points that survive the whitespace collapse in {@link describe}
* and have no printable form: the C0 controls, DEL, and the C1 controls. Only
* U+0009 to U+000D are absent, because ECMAScript `\s` already collapsed them —
* `\s` is TAB/VT/FF/SP/NBSP/ZWNBSP/Zs plus LF/CR/LS/PS, so no C1 code point is
* in it and the whole U+0080 to U+009F block reaches this rule intact. Those
* are not hypothetical input: they are what Windows-1252 bytes 0x80 to 0x9F
* (smart quotes, em dash) become when decoded as Latin-1.
* CPython rejects source containing a NUL outright
* (`SyntaxError: source code string cannot contain null bytes`), whether it
* sits in a docstring or in a comment, so one such byte anywhere in a schema
* description would make the whole generated SDK unparseable — under
* `mode: 'ptc'`, the model's only declaration of the tools. The rest are
* legal but invisible; escaping them with the same rule keeps the emitted text
* readable and the treatment uniform.
*
* The boundary is the category, not per-code-point addressability: `\xNN`
* addresses U+0000 to U+00FF, so one escape form covers `Cc` exactly. The
* invisible `Cf` formatting characters pass through by design — of them only
* U+00AD soft hyphen would fit `\xNN` at all, and escaping that one while
* U+200B ZWSP, U+200E/U+200F bidi marks, and U+2060 word joiner passed through
* would leave a rule that is neither category- nor addressability-shaped. The
* whole family is legal in both consumers, since only LF and CR terminate a
* Python string literal or a `#` comment. That set is the tokenizer's, not
* `str.splitlines()`': NEL (U+0085), LS (U+2028), and PS (U+2029) split a
* string at run time but do not end a physical line in source — measured on
* CPython 3.9.6 and 3.12.13, each accepted in both positions with the value
* round-tripping — so they are safe raw wherever they reach emitted text
* unescaped, which for all three is `JSON.stringify`, at two call sites:
* {@link pyScalar}'s literal path, and the subscript tool-name comment's own
* call, which a name carrying any of them always reaches, none being
* `XID_Continue`. The `description` path escapes NEL under the class above and
* folds LS and PS in {@link describe}'s `\s+` collapse, both being `\s`.
*/
const UNPRINTABLE = /[\u0000-\u0008\u000e-\u001f\u007f-\u009f]/g;
/**
* Unpaired surrogate code points, escaped by {@link describe} as `\uNNNN` —
* its own form, since `\xNN` stops at U+00FF. The `u` flag is what makes this
* the LONE ones: in Unicode mode a well-formed pair is a single astral code
* point outside D800 to DFFF, so an emoji in a description survives untouched.
*
* This is the NUL case from {@link UNPRINTABLE}, not the invisible-character
* case. Python source must be UTF-8-encodable and a lone surrogate is not, so
* `compile()` raises `UnicodeEncodeError: surrogates not allowed` for one
* anywhere in the text — measured on 3.9 for a string literal and for a `#`
* comment alike. A raw or MCP tool description reaches this: `JSON.parse` on a
* wire `"\ud800"` escape yields exactly such a code point.
*/
const LONE_SURROGATE = /[\ud800-\udfff]/gu;
/**
* The collapsed one-line `description` of a schema node (byte-stable across
* formatting churn), or `undefined` when the node carries none. Every caller
* passes an object — a validated property node, the `ToolSdkSchema` itself, or
* the `{ description }` wrapper {@link docLines} synthesizes — so only the
* description field needs guarding. A description that collapses
* to nothing (empty, or whitespace only) is `undefined` too: it documents the
* node no better than an absent one, and emitting it would leave an empty
* `"""` docstring or a bare `#   ` line in the SDK. Only ECMAScript whitespace
* folds, so a description of whitespace plus one surviving control character is
* NOT absent: it collapses to that character's visible escape.
*
* Control characters left over after the whitespace collapse are rendered as
* their `\xNN` escapes (see {@link UNPRINTABLE}) and unpaired surrogates as
* their `\uNNNN` escapes (see {@link LONE_SURROGATE}); the escape's own backslash is
* emitted literally by both consumers, since {@link docLines} doubles it into a
* Python source escape and a `#` comment carries it verbatim.
*/
function describe(schema) {
	const description = schema.description;
	if (typeof description !== "string") return void 0;
	const collapsed = description.replace(/\s+/g, " ").replace(UNPRINTABLE, (char) => `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`).replace(LONE_SURROGATE, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`).trim();
	return collapsed.length === 0 ? void 0 : collapsed;
}
/**
* One-line docstring for a tool `description`, or no lines when there is none.
* Backslashes are doubled first, every quote is escaped, and a trailing
* backslash cannot survive: a description ending in `"` or an odd backslash
* would otherwise merge with (or escape) the closing triple quote and make
* the generated block — PTC mode's only SDK — syntactically invalid Python.
*/
function docLines(description, indent) {
	const collapsed = describe({ description });
	if (collapsed === void 0) return [];
	const escaped = collapsed.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"");
	return [`${pad(indent)}"""${escaped}"""`];
}
/**
* CamelCase a name into a Python type identifier: non-identifier characters
* split words, `_` splits too (it is `XID_Continue`, so the split set names it
* explicitly), and a head that cannot start an identifier takes a `Tool`
* prefix. Unicode survives, so a `路径` field yields `路径`-based class names
* instead of collapsing to the bare prefix. A character that is not
* `XID_Continue` splits even when it is a letter, so a name whose NFKC folding
* would leave the identifier set is not carried through — the split set is the
* grammar's, not an ASCII approximation of it.
*
* The result is NFKC-normalized: these names are generated, never matched
* against a JSON key, so normalizing is free here and keeps what CPython
* compiles identical to what is emitted — unlike {@link isBareIdentifier},
* which must reject unstable names outright. Normalizing AFTER the prefix
* decision is what makes that hold at the seam the prefix creates: `Tool` +
* a combining-mark head composes there (`U+0301` gives `Tooĺ`, U+013A), so
* normalizing only the un-prefixed part would emit a name CPython compiles to
* a different symbol. The second call is idempotent on the un-prefixed arm.
*
* The split set, the head test, and `toUpperCase()` all read the engine's
* Unicode tables, so this function carries the same version skew
* {@link isBareIdentifier} documents, by paths independent of it: a class name
* derived here reaches emitted text whenever any object shape in the tool's
* schema declares a `TypedDict`, and the predicate's verdict on the tool name
* does not gate that. The case mapping is the one that can fail on a name the
* predicate accepted; the worked example is there.
* @param raw - the schema field or tool name to derive from.
* @returns a class-name segment safe to emit.
*/
function camelCase(raw) {
	const joined = raw.split(/[^\p{XID_Continue}]+|_+/u).filter((part) => part.length > 0).map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`).join("").normalize("NFKC");
	return (/^\p{XID_Start}/u.test(joined) ? joined : `Tool${joined}`).normalize("NFKC");
}
/** Class-name base cap keeping each emitted name — and total text — linear in schema depth. */
const MAX_CLASS_NAME_BASE = 120;
/**
* Deepest `list[…]` nesting emitted into one annotation before the item type
* degrades to `Any`. CPython's tokenizer rejects a logical line holding more
* than 200 simultaneously-open brackets (`MAXLEVEL`, `SyntaxError: too many
* nested parentheses`), so an array chain deeper than that would render an SDK
* block that is not valid Python at all — the same failure the docstring
* escaping in {@link docLines} exists to prevent. 180 leaves headroom for the
* few brackets an annotation can add around the chain, all of which count
* toward the same limit. Per emission site, counting brackets open at the
* chain's innermost point:
*
* - Return annotation, `async def f(self, args: X) -> chain:` — 180 `list[`
*   plus an innermost `Literal[`. The parameter list's `(` closed at the `)`
*   before the `->`, so it is NOT open here: 181.
* - TypedDict field, `field: NotRequired[chain]` — a class-body line with no
*   other open bracket, and its children start at `listDepth: 1` to reserve
*   the `NotRequired[`, so 179 `list[` plus `Literal[`: 181. Required fields
*   share that start for uniformity, spending one level of representable depth
*   on a bracket they never emit.
* - Argument annotation, `async def f(self, args: chain) -> Y:` — the `(` IS
*   still open around it: 180 `list[` plus `Literal[` plus the paren, 182, the
*   worst case. Reachable only through a raw `register()` whose `parameters`
*   is an array reached from the root through `oneOf` arms alone — the root
*   array itself, or one nested under any depth of unions, since an arm
*   inherits the enclosing depth unchanged (`A | B` opens no bracket). An
*   object ancestor takes it out of this case: its fields restart the chain at
*   the 181 site. `defineTool` compiles an object root, so the annotation is a
*   bare TypedDict class name or a one-bracket `dict[str, Any]` when that
*   object degrades — never a chain.
*
* A CPython grammar limit, not a deployment choice, so it is fixed rather than
* configurable. The sibling `ts-types` renderer needs no counterpart: nothing
* in the TypeScript grammar bounds nesting, and its SDK block is never type-
* checked. Only bracket nesting counts — a `oneOf` renders as a flat `A | B`
* chain and nested objects render as separate `class` statements, so neither
* accumulates open brackets at any depth. The invariant this cap serves is
* grammatical validity; see the `oneOf` arm in {@link renderType} for the one
* interpreter limit deliberately left uncapped.
*/
const MAX_LIST_NESTING = 180;
/**
* Cap a class-name base at {@link MAX_CLASS_NAME_BASE} (see the callers for
* why capping keeps the render linear). `slice` counts UTF-16 code units, so
* an astral character straddling the boundary would be cut in half and leave a
* lone surrogate — not an identifier character, and not even well-formed text;
* drop it rather than emit it.
*/
function capClassNameBase(base) {
	if (base.length <= MAX_CLASS_NAME_BASE) return base;
	const capped = base.slice(0, MAX_CLASS_NAME_BASE);
	return /[\uD800-\uDBFF]$/.test(capped) ? capped.slice(0, -1) : capped;
}
/**
* Reserve a unique class name from a base, suffixing `2`, `3`, … on collision.
* The base is capped at {@link MAX_CLASS_NAME_BASE} first: child class names
* derive from their parent's allocated name (`ParentChild`), so an unbounded
* schema of single-field objects would otherwise grow each name by one field
* per level and the sum of all names to Θ(depth²). Capping the base keeps each
* name — and the total emitted text — linear in depth. Collisions resume from
* the per-base counter in `state.nextClassCounter` rather than rescanning from
* `2`, so a deep chain sharing one capped base stays O(1) per allocation
* (amortized) instead of Θ(depth²) in time.
*/
function allocateClassName(base, state) {
	const capped = capClassNameBase(base);
	let name = capped;
	if (state.usedClassNames.has(name)) {
		let n = state.nextClassCounter.get(capped) ?? 2;
		while (state.usedClassNames.has(`${capped}${n}`)) n++;
		name = `${capped}${n}`;
		state.nextClassCounter.set(capped, n + 1);
	}
	state.usedClassNames.add(name);
	return name;
}
/**
* Append a child-name segment to a parent class-name base, capping the result
* at {@link MAX_CLASS_NAME_BASE}. Capping AT PROPAGATION (not only inside
* {@link allocateClassName}) keeps each level O(1): a deep `oneOf`- or
* object-chain would otherwise carry an ever-growing ConsString down the tree
* and re-materialize it (via `.length`/`.slice`) at every level — Θ(depth²).
* The bounded base plus the collision counter still yields unique names.
*
* The join is NFKC-normalized because both sides are separately normalized yet
* their concatenation need not be: a base ending in a Hangul L jamo or LV
* syllable composes with a following V or T jamo head (`가` + `ᆨ` gives `각`),
* so the emitted class name would differ from the symbol CPython compiles, and
* two byte-distinct names could fold onto one — `usedClassNames` dedupes by the
* raw bytes, so the collision counter would not see it. Normalizing costs
* O(cap + segment) per level, the same order as the `slice` it feeds. The other
* two join points need no counterpart: `Args`/`Output` start with `A`/`O` and
* {@link allocateClassName}'s suffix is digits, none of which compose backwards.
*/
function childClassName(base, segment) {
	return capClassNameBase(`${base}${segment}`.normalize("NFKC"));
}
/**
* Render one validated scalar as Python literal text (`True`/`False`,
* JSON-quoted strings, bare numbers). `null` cannot reach here: the `null`
* type renders directly as `None`, and the unified validator rejects a null
* `const`/`enum` entry on every other scalar type.
*
* A beyond-safe-range integral number takes `BigInt` digits rather than
* `String`: Python integers are arbitrary-precision, so the emitted digits ARE
* the value the model programs against, and `String` can give a different
* integer than the double holds (`2 ** 60` prints the rounded `...847000`, not
* the exact `...846976`) or no integer literal at all (`1e21` prints `1e+21`).
* `String`'s rounding is not a bug in it: `Number::toString` emits the shortest
* decimal string that re-reads to the same double, then pads to the exponent
* with zeros (1 significant digit for `1e20`, 16 for `2 ** 60`) — and when the
* shortest string is shorter than the double's exact value, those padded digits
* name an integer no double holds. Passing one back would have to cross the
* argument boundary as a JSON number — a double again — so the SDK would
* document a value no program can pass. `BigInt` needs no case split: where
* `String` is already exact (`2 ** 53`, `1e20`) the two agree byte for byte,
* and where it is not, `BigInt` is the exact one. The TS flavor needs no
* counterpart at all: its literal is re-read by a JS parser back into the same
* double.
*
* `JSON.stringify` is also what keeps this path's output parseable, and it is
* the only thing that does. It covers both classes of hazard: the two kinds of
* code point CPython refuses anywhere in source — NUL among the C0 controls,
* and the whole D800–DFFF unpaired-surrogate block, escaped under ES2019
* well-formed stringification, which the engines range guarantees — and the
* ones that break this line in particular, a bare `"` closing the literal
* early, a trailing odd backslash eating the closing quote, and a bare LF/CR
* ending it before its terminator. The `description` path carries
* {@link UNPRINTABLE} and {@link LONE_SURROGATE} because nothing quotes it,
* and folds newlines in {@link describe}.
*
* That leans on a coincidence worth naming: every escape `JSON.stringify` can
* emit (`\"`, `\\`, `\b`, `\f`, `\n`, `\r`, `\t`, `\uXXXX`) is also a Python
* escape denoting the same character, so the emitted `Literal[...]` both
* parses and decodes back to the value the schema declared. DEL, the C1
* controls (NEL among them), and LS/PS (U+2028/U+2029) do reach it raw —
* legal but invisible, byte-for-byte as in the TS flavor; escaping them is a
* both-flavors change. Those last three are legal here for the reason
* {@link UNPRINTABLE} records: they are `str.splitlines()` boundaries, not
* tokenizer line terminators. The subscript tool-name comment quotes its name
* through its own call to the same `JSON.stringify`, never through this
* function, and inherits both halves — escapes and pass-throughs alike.
*/
function pyScalar(value) {
	if (value === true) return "True";
	if (value === false) return "False";
	if (typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number" && Number.isInteger(value) && !Number.isSafeInteger(value)) return BigInt(value).toString();
	return String(value);
}
/**
* Render a validated scalar `const`/`enum` as `Literal[...]`, falling back to
* the broad type. Deliberately deviates from PEP 586, which restricts `Literal`
* parameters to int/bool/str/bytes/enum/None: a non-integral number
* `const`/`enum` emits a float literal (`Literal[1.5]`) a strict checker would
* reject. An integral one does not deviate — {@link pyScalar} emits int digits,
* including for the beyond-safe-range values it widens through `BigInt`, and
* PEP 586 admits int parameters. Harmless either way — the stub is advisory
* prompt text, only required to parse — and keeping the exact value
* communicates the constraint to the model.
*/
function renderConstrainedScalar(node, broad, state) {
	if (node.const !== void 0) {
		state.typing.add("Literal");
		return `Literal[${pyScalar(node.const)}]`;
	}
	if (node.enum !== void 0) {
		state.typing.add("Literal");
		return `Literal[${node.enum.map(pyScalar).join(", ")}]`;
	}
	return broad;
}
/**
* Map one JSON-Schema node to a Python type expression, threading `state` to
* collect the `TypedDict` declarations and `typing` symbols a full render
* needs. `className` is the name to give an object node with properties (and
* the prefix for its nested objects). Handles every unified schema construct —
* `oneOf` (→ `X | Y`), `const`/`enum` (→ `Literal[...]`), `integer` (→ `int`),
* `null` (→ `None`) — and degrades an unsupported or malformed schema to `Any`
* without throwing, the same trusted-after-validation stance as the sibling
* {@link ./ts-types.ts | ts-types} renderer. {@link jsonSchemaToPy} is the
* context-free entry point; this is the collecting core.
*/
function renderType(schema, className, state) {
	const newFrame = (schema, className, listDepth) => ({
		schema,
		className,
		phase: "start",
		listDepth,
		children: [],
		childIndex: 0,
		childTypes: [],
		entries: []
	});
	try {
		assertSupportedJsonSchema(schema);
		const frames = [newFrame(schema, className, 0)];
		let result;
		const finish = (type) => {
			frames.pop();
			const parent = frames.at(-1);
			if (parent === void 0) result = type;
			else parent.childTypes.push(type);
		};
		while (frames.length > 0) {
			const frame = frames.at(-1);
			/* v8 ignore next -- the loop condition guarantees a current frame. */
			if (frame === void 0) break;
			if (frame.phase === "children") {
				if (frame.childIndex < frame.children.length) {
					const child = frame.children[frame.childIndex];
					/* v8 ignore next -- childIndex is bounded by children.length. */
					if (child === void 0) throw new Error("missing python render child");
					frame.childIndex++;
					frames.push(newFrame(child.schema, child.className, child.listDepth));
					continue;
				}
				if (frame.kind === "oneOf") {
					let union = "";
					for (const [index, childType] of frame.childTypes.entries()) union = index === 0 ? childType : `${union} | ${childType}`;
					finish(union);
					continue;
				}
				if (frame.kind === "array") {
					/* v8 ignore next -- the ?? arm needs a childless array frame, which start never builds. */
					finish(`list[${frame.childTypes[0] ?? "Any"}]`);
					continue;
				}
				const node = frame.node;
				const name = frame.allocated;
				/* v8 ignore next -- typeddict frames always set node and allocated at start. */
				if (node === void 0 || name === void 0) throw new Error("missing typeddict frame state");
				const required = new Set(node.required);
				const lines = [`class ${name}(TypedDict):`];
				for (let index = 0; index < frame.entries.length; index++) {
					const entry = frame.entries[index];
					const fieldType = frame.childTypes[index];
					/* v8 ignore next -- entries and childTypes correspond one-to-one. */
					if (entry === void 0 || fieldType === void 0) throw new Error("missing typeddict field type");
					const [field, fieldSchema] = entry;
					const description = describe(fieldSchema);
					if (description !== void 0) lines.push(`${pad(1)}# ${description}`);
					if (required.has(field)) lines.push(`${pad(1)}${field}: ${fieldType}`);
					else {
						state.typing.add("NotRequired");
						lines.push(`${pad(1)}${field}: NotRequired[${fieldType}]`);
					}
				}
				if (node.additionalProperties !== false) lines.push(`${pad(1)}# Additional keys beyond those declared are allowed.`);
				if (lines.length === 1) lines.push(`${pad(1)}pass`);
				state.classes.push(lines.join("\n"));
				finish(name);
				continue;
			}
			frame.phase = "children";
			const node = frame.schema;
			if (node.oneOf !== void 0) {
				frame.kind = "oneOf";
				frame.children = node.oneOf.map((branch, index) => ({
					schema: branch,
					className: childClassName(frame.className, `${index + 1}`),
					listDepth: frame.listDepth
				}));
				continue;
			}
			if (node.type === void 0) {
				state.typing.add("Any");
				finish("Any");
				continue;
			}
			switch (node.type) {
				case "string":
					finish(renderConstrainedScalar(node, "str", state));
					break;
				case "number":
					finish(renderConstrainedScalar(node, "float", state));
					break;
				case "integer":
					finish(renderConstrainedScalar(node, "int", state));
					break;
				case "boolean":
					finish(renderConstrainedScalar(node, "bool", state));
					break;
				case "null":
					finish("None");
					break;
				case "array":
					if (node.items === void 0) {
						state.typing.add("Any");
						finish("list[Any]");
						break;
					}
					if (frame.listDepth >= MAX_LIST_NESTING) {
						state.typing.add("Any");
						finish("Any");
						break;
					}
					frame.kind = "array";
					frame.children = [{
						schema: node.items,
						className: frame.className,
						listDepth: frame.listDepth + 1
					}];
					break;
				case "object": {
					const entries = Object.entries(node.properties ?? {});
					if (className === "" || !entries.every(([name]) => isBareIdentifier(name) && !RESERVED.has(name) && !(name.startsWith("__") && !name.endsWith("__")))) {
						state.typing.add("Any");
						finish("dict[str, Any]");
						break;
					}
					if (entries.length === 0 && node.additionalProperties !== false) {
						state.typing.add("Any");
						finish("dict[str, Any]");
						break;
					}
					frame.kind = "typeddict";
					frame.node = node;
					frame.allocated = allocateClassName(frame.className, state);
					state.typing.add("TypedDict");
					frame.entries = entries;
					/* v8 ignore next -- allocated is always set before children are built. */
					frame.children = entries.map(([field, child]) => ({
						schema: child,
						className: childClassName(frame.allocated ?? "", camelCase(field)),
						listDepth: 1
					}));
					break;
				}
				/* v8 ignore next 4 -- assertSupportedJsonSchema narrowed this closed type union. */
				default:
					state.typing.add("Any");
					finish("Any");
			}
		}
		/* v8 ignore next -- every root frame produces one expression. */
		return result ?? "Any";
	} catch {
		state.typing.add("Any");
		return "Any";
	}
}
/** The fixed model-facing usage contract rendered above the declarations. */
const SDK_INSTRUCTIONS = `## Writing code for run_code

\`run_code\` takes two required arguments: \`code\` — the body of an async Python function (top-level \`await\` and \`return\` both work) — and \`description\`, a short summary of what the program does. At run time exactly two of the names declared below are bound: \`tools\` and \`ToolCallError\`. Everything else is a STATIC STUB describing argument and return types — in particular the \`TypedDict\` classes do NOT exist at run time, so build arguments as plain \`dict\`/\`list\` JSON values: \`await tools.name({"field": 1})\`, never \`FooArgs(field=1)\`, which raises \`NameError\`. Inside the program:

- Call tools as \`await tools.name(args)\` — subscript access for exotic, reserved, or underscore-leading names: \`await tools["my-tool"](args)\`. Every call resolves to the tool's typed canonical JSON value (each method's return type below). Tool arguments must be lossless JSON.
- A FAILED tool call raises \`ToolCallError\`, whose \`toolName\` identifies the failed tool and whose message is human-readable — wrap in \`try/except\` to handle and continue.
- Independent read-only calls MAY overlap under \`asyncio.gather\` (safe calls run concurrently; mutating calls run alone, in submission order). Sequence dependent work with \`await\`.
- Emit the run's answer with \`print(...)\` and/or a top-level \`return <value>\`; the returned value must be lossless JSON. Only what you print and return is program output. A successful tool result containing an image is attached after the run so you can inspect it on the next step; every other intermediate result stays out of the conversation, so extract just what you need.

The available tools:`;
/**
* Render the full `tools:sdk` prompt section under `runtime.language ===
* 'python'`: the Python-flavored usage instructions plus one named `TypedDict`
* per tool argument or output object (and per nested object) and one awaitable
* method per visible tool on a `Tools` protocol — typed args in, the tool's
* canonical output value out — with a `tools: Tools` singleton the model calls
* into. The `typing` import line lists exactly the symbols the render used.
* Deterministic — tools are emitted in lexicographic name order, and class
* declarations precede the protocol in that same order (nested classes before
* the parent that references them), so an unchanged tool set produces
* byte-identical text across assemblies. The sort is not a total order on
* byte-equal names, so two schemas sharing a name would render in argument
* order; the caller's visible-capability map is keyed by name, so the input
* never carries a duplicate.
* @param schemas - the tool schemas plus canonical output schemas to declare
*   (the caller excludes `run_code` itself).
* @returns the complete section text.
*/
function renderToolsSdkPy(schemas) {
	const sorted = [...schemas].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
	const state = {
		classes: [],
		usedClassNames: /* @__PURE__ */ new Set(),
		nextClassCounter: /* @__PURE__ */ new Map(),
		typing: new Set(["Protocol"])
	};
	const members = [];
	let statements = 0;
	for (const schema of sorted) {
		const argType = renderType(schema.parameters, `${camelCase(schema.name)}Args`, state);
		const outputType = renderType(schema.output, `${camelCase(schema.name)}Output`, state);
		if (isBareIdentifier(schema.name) && !RESERVED.has(schema.name) && !schema.name.startsWith("_")) {
			const doc = docLines(schema.description, 2);
			members.push(doc.length > 0 ? `${pad(1)}async def ${schema.name}(self, args: ${argType}) -> ${outputType}:` : `${pad(1)}async def ${schema.name}(self, args: ${argType}) -> ${outputType}: ...`);
			members.push(...doc);
			statements += 1;
		} else {
			members.push(`${pad(1)}# tools[${JSON.stringify(schema.name)}](args: ${argType}) -> ${outputType}`);
			const description = describe(schema);
			if (description !== void 0) members.push(`${pad(1)}#   ${description}`);
		}
	}
	const body = (statements > 0 ? members : [`${pad(1)}pass`, ...members]).join("\n");
	const imports = TYPING_ORDER.filter((symbol) => state.typing.has(symbol));
	const classBlock = state.classes.length > 0 ? `${state.classes.join("\n\n")}\n\n` : "";
	return `${SDK_INSTRUCTIONS}\n\n\`\`\`python\n${`from typing import ${imports.join(", ")}\n\nclass ToolCallError(Exception):
    toolName: str\n\n${classBlock}class Tools(Protocol):\n${body}\n\ntools: Tools`}\n\`\`\``;
}
/**
* Tool registry, model presentation modes, and pre/guard/around/post/result
* execution pipeline.
* @module @deepseek-ai/dsh-tools
*/
/**
* Language → SDK-section renderer. The registry looks up the loaded
* `ctx.codeRuntime.language` in this table when assembling the `tools:sdk`
* section under a non-native mode; a runtime whose language is not a key
* fails the assembly loudly (same idiom as `toolOrder` violations). Adding a
* new backend language is three parallel edits — a {@link CodeSdkLanguage}
* member, an entry here, and a `RUN_CODE_FLAVORS` entry in `ptc.ts` for
* its `run_code` schema strings — plus the renderer function this table points
* at. The `satisfies` clause pins this table's key set to that union, which
* the flavor table is checked against too, so any of the three left out is a
* typecheck failure. What no check reaches is the prose that names the values
* instead of deriving them: the seam's `dsh-code-runtime` README pair, its
* `CodeRuntime.language` JSDoc, and `docs/subsystems/code-runtime.md`
* with its zh pair, plus this package's own README pair and the
* {@link Config.mode} JSDoc.
*/
/**
* The model-facing statement of the `ptc` collapse. Names the consequence
* (the call fails) and the route (inside the program), because a rule the
* model can only discover by being denied is one it corrects too late.
*/
const PTC_ONLY_INSTRUCTION = `\`${RUN_CODE_NAME}\` is the only tool you can call directly — a tool call naming any other tool fails. Reach every tool the SDK declares below from inside the program.`;
const SDK_RENDERERS = {
	typescript: renderToolsSdk,
	python: renderToolsSdkPy
};
/**
* Scheduler entry point omitted from the generated named service API.
* @internal
*/
const TOOL_RUNTIME_SCHEDULER = Symbol("@deepseek-ai/dsh-tools.scheduler");
/** Canonical error code for cancellation after a tool body was invoked. */
const TOOL_ABORTED = "ABORTED";
/** Canonical error code for cancellation before a tool body was invoked. */
const TOOL_ABORTED_BEFORE_DISPATCH = "ABORTED_BEFORE_DISPATCH";
/**
* Thrown (internally) when the model requests a tool that isn't registered.
* Extends {@link HarnessError} (`code: 'UNKNOWN_TOOL'`) so an unknown-tool
* failure is as routable as a tool-thrown one — retry/sandbox/replay code can
* distinguish it from a tool body's own error.
*/
var ToolNotFoundError = class extends HarnessError {
	/**
	* @param toolName - the name the caller asked for.
	* @param reachableFrom - how the model reaches this tool instead, when the
	*   name IS visible and only the presentation denies calling it directly.
	*   Omitted for a name that is registered nowhere.
	*/
	constructor(toolName, reachableFrom) {
		super(reachableFrom === void 0 ? `unknown tool "${toolName}"` : `unknown tool "${toolName}": ${reachableFrom}`, "UNKNOWN_TOOL");
		this.name = "ToolNotFoundError";
	}
};
/** Thrown when a tool body or post-policy value violates its declared output. */
var ToolOutputError = class extends HarnessError {
	/** Schema/value violations in validation order. */
	violations;
	constructor(toolName, violations) {
		super(`tool "${toolName}" returned invalid output: ${violations.join("; ")}`, "INVALID_TOOL_OUTPUT");
		this.name = "ToolOutputError";
		this.violations = violations;
	}
};
/** Convert one projector exception into the canonical invalid-output failure. */
function projectionError(toolName, projector, error) {
	return new ToolOutputError(toolName, [`output.${projector} failed: ${errorMessage(error)}`]);
}
/** Snapshot one projector result before later durable-result materialization. */
function snapshotProjection(toolName, projector, candidate) {
	try {
		const detached = snapshotJsonValue(candidate);
		if (detached === void 0) throw new ToolOutputError(toolName, [`output.${projector} returned non-lossless JSON`]);
		return detached;
	} catch (error) {
		if (error instanceof ToolOutputError) throw error;
		throw projectionError(toolName, projector, error);
	}
}
/** Snapshot one body or policy value into the canonical invalid-output failure class. */
function snapshotToolValue(toolName, candidate) {
	try {
		const detached = snapshotJsonValue(candidate);
		if (detached === void 0) throw new ToolOutputError(toolName, ["value is not lossless JSON"]);
		return detached;
	} catch (error) {
		if (error instanceof ToolOutputError) throw error;
		throw new ToolOutputError(toolName, [`value snapshot failed: ${errorMessage(error)}`]);
	}
}
/**
* Best-effort human-readable message from an arbitrary thrown value: Error
* instances use `.message`; non-Error objects with a string `message`
* property (e.g. `throw { message: 'denied' }`) use it too; everything else
* is stringified.
*/
function errorMessage(error) {
	try {
		if (error instanceof Error) return error.message;
		if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") return error.message;
		return String(error);
	} catch {
		return "<unprintable thrown value>";
	}
}
/** Derive one failure message from policy feedback without changing its rendered blocks. */
function failureMessageFromContent(content) {
	const text = content.map((block) => block.type === "text" ? block.text : `[${block.type} content]`).join("\n");
	return text.length > 0 ? text : "tool result blocked by post-execute policy";
}
/** Snapshot and freeze one durable tool-result projection or reject lossy data. */
function materializePresentation(candidate) {
	const detached = snapshotJsonValue(candidate);
	if (detached === void 0) throw new TypeError("tool result must be losslessly JSON-serializable");
	return deepFreeze(detached);
}
/** Structured `{ name, code }` for a thrown HarnessError, else undefined. */
function errorInfo(error) {
	try {
		return error instanceof HarnessError ? {
			name: error.name,
			code: error.code
		} : void 0;
	} catch {
		return;
	}
}
/** One scope's complete tool-registry contribution. */
var ToolLayer = class {
	tools;
	restrictions = new AnonymousEntries();
	guards = new AnonymousEntries();
	/**
	* Presentation this scope's agent declared for itself, shadowing the
	* deployment default. One cell rather than an entry table: two answers to
	* "which form does the model see" is a contradiction, not a merge.
	*/
	mode;
	constructor(scope) {
		this.tools = new NamedEntries((name) => /* @__PURE__ */ new Error(scope === void 0 ? `tool "${name}" is already registered (for a per-agent variant, register through that agent's \`agent.ctx\` instead)` : `tool "${name}" is already registered in this scope`));
	}
	/** Whether every contribution table in this aggregate layer is empty. */
	isEmpty() {
		return this.tools.isEmpty() && this.restrictions.isEmpty() && this.guards.isEmpty() && this.mode === void 0;
	}
	/** Whether every compiled restriction in this layer admits a global tool name. */
	admits(name) {
		for (const filter of this.restrictions.values()) if (filter.allow !== void 0 && !filter.allow.has(name) || filter.deny !== void 0 && filter.deny.has(name)) return false;
		return true;
	}
	/** First monotonic denial from this layer's live guard registrations. */
	guardReason(exec) {
		for (const guard of this.guards.values()) {
			const reason = guard(exec);
			if (reason !== void 0) return reason;
		}
	}
};
/** Resolve the run_code overlap cap at the owning config boundary (direct construction bypasses the Loader schema). */
function resolveMaxParallelSubCalls(value) {
	const maxParallelSubCalls = value ?? 10;
	if (!Number.isInteger(maxParallelSubCalls) || maxParallelSubCalls < 1) throw new Error("maxParallelSubCalls must be a positive integer");
	return maxParallelSubCalls;
}
(class extends Service {
	static inject = ["systemPrompt"];
	static Config = Schema.object({
		mode: Schema.union([
			"native",
			"ptc",
			"both"
		]).default("native"),
		maxParallelSubCalls: Schema.natural().min(1).default(10)
	});
	/** Internal staged view consumed by `dsh-agent-loop`'s parallel scheduler. */
	[TOOL_RUNTIME_SCHEDULER] = {
		prepare: (exec) => this.prepareScheduledExecution(exec),
		dispatch: (exec) => this.dispatchScheduledExecution(exec),
		finalize: (exec, result) => this.finalizeScheduledExecution(exec, result),
		finish: (exec, result) => this.finishScheduledExecution(exec, result)
	};
	/** Context deferred by a running tool body, keyed by its scheduler-owned execution. */
	deferredContexts = /* @__PURE__ */ new WeakMap();
	/** Executions whose tool body declared the current turn complete. */
	concludingExecutions = /* @__PURE__ */ new WeakSet();
	/** Original caller cancellation, kept outside the wrapper-mutable execution object. */
	cancellationStates = /* @__PURE__ */ new WeakMap();
	/** Definition-owned final content transform snapshotted before policy begins. */
	contentFinalizers = /* @__PURE__ */ new WeakMap();
	layers = new ScopedLayers((scope) => new ToolLayer(scope), () => {
		this.ctx.emit("tools/change");
	});
	/** Presentation for scopes that declare none; {@link presentAs} shadows it per scope. */
	defaultMode;
	maxParallelSubCalls;
	/**
	* Reserved presentation transport, kept outside the filterable registration
	* layers. Built on first need rather than at construction: which agents run
	* a PTC mode is no longer known when the service is constructed, and the
	* transport is stateless beyond its closures over `this`.
	*/
	ptcTransport;
	constructor(ctx, config = {}) {
		super(ctx, "tools");
		this.defaultMode = config.mode ?? "native";
		this.maxParallelSubCalls = resolveMaxParallelSubCalls(config.maxParallelSubCalls);
		ctx.systemPrompt.tools((context) => this.wireSchemas(context.scope));
		if (this.defaultMode !== "native") {
			ctx.systemPrompt.section(this.collapseSection());
			ctx.systemPrompt.section(this.sdkSection());
		}
	}
	/**
	* The prompt statement of the `ptc` executor collapse, registered wherever
	* {@link sdkSection} is and rendering empty outside an effective `ptc`.
	*
	* Every tool contributes its own guidance section naming its tool, none of
	* them qualify how that tool is reached, and they all render before the SDK.
	* Without this the model reads a catalog of tools it is told to use and no
	* statement that only `run_code` may be called, so it emits a native call,
	* receives `UNKNOWN_TOOL` for a tool the prompt just declared, and concludes
	* the deployment is inconsistent. Its order places the rule before that
	* guidance rather than after it.
	*
	* `both` renders empty: native calls do execute there, so the rule is false.
	* @returns the section registration.
	*/
	collapseSection() {
		return {
			name: "tools:ptc-only",
			order: this.ctx.systemPrompt.getSectionOrder("PTC_ONLY"),
			text: (context) => this.modeFor(context.scope) === "ptc" ? PTC_ONLY_INSTRUCTION : ""
		};
	}
	/**
	* The generated-SDK prompt section, registered globally by a PTC mode
	* deployment and per scope by {@link presentAs}.
	*
	* The body regenerates from the CALLING scope, and renders empty for an
	* agent presenting natively — an agent that opted out under a PTC mode
	* deployment still sees the global registration, and an empty section is
	* dropped from the rendered prompt.
	* @returns the section registration.
	*/
	sdkSection() {
		return {
			name: "tools:sdk",
			order: this.ctx.systemPrompt.getSectionOrder("TOOLS_SDK"),
			text: (context) => {
				const mode = this.modeFor(context.scope);
				if (mode === "native") return "";
				const runtime = this.requireCodeRuntime(mode);
				const render = SDK_RENDERERS[runtime.language];
				/* v8 ignore next -- requireCodeRuntime rejects an unknown language before this runs. */
				if (render === void 0) throw new Error(`dsh-tools: no SDK renderer for ${runtime.language}`);
				return render(this.sdkSchemas(context.scope));
			}
		};
	}
	/**
	* The presentation one scope's agent sees: its own declaration, else the
	* deployment default.
	* @param scope - the calling agent, or undefined for the global view.
	* @returns the resolved presentation mode.
	*/
	modeFor(scope) {
		const layers = this.layers.chainLayers(scope);
		for (let index = layers.length - 1; index >= 0; index -= 1) {
			const mode = layers[index]?.mode;
			if (mode !== void 0) return mode;
		}
		return this.defaultMode;
	}
	/**
	* The reserved `run_code` transport, built on first need.
	*
	* It never enters the global layer: per-agent restrictions must not remove
	* it, and a scoped registration must not shadow it. The visibility resolver
	* appends it after resolving the filterable global/scoped capability layers,
	* and only for scopes whose mode actually presents it.
	* @returns the shared transport definition.
	*/
	requireCodeTransport() {
		this.ptcTransport ??= createRunCodeTool(this, {
			requireRuntime: () => this.requireCodeRuntime(this.defaultMode),
			peekRuntime: () => this.ctx.get("codeRuntime"),
			maxParallel: this.maxParallelSubCalls,
			shapeDispatchLog: (dispatch) => this.shapeDispatchLog(dispatch)
		});
		return this.ptcTransport;
	}
	/**
	* Present the calling scope's tools in `mode` instead of the deployment
	* default. Nearest scope on the chain wins, so a preset's standing
	* declaration covers every agent joined under it.
	*
	* Scoped only, and one declaration per scope: this is how an agent preset
	* composes PTC mode agents beside native ones in the same process, and a
	* process-global override would be the `mode` config field instead.
	* @param mode - the presentation the covered agents' models see.
	* @returns the exact disposer that restores the deployment default.
	*/
	presentAs(mode) {
		const ctx = this.ctx;
		if (scopeOf(ctx) === void 0) throw new Error("tools.presentAs() requires a scoped context (agent.ctx): a context-global presentation is the `mode` config field on the tools row");
		return ctx.effect(function* () {
			yield this.layers.effect(ctx, (layer) => {
				if (layer.mode !== void 0) throw new Error(`tools.presentAs("${mode}") conflicts with "${layer.mode}" already declared for this scope; one composition selects one presentation`);
				layer.mode = mode;
				return () => {
					layer.mode = void 0;
				};
			}, { label: "tools.presentAs()" });
			if (mode !== "native") {
				yield ctx.systemPrompt.section(this.collapseSection());
				yield ctx.systemPrompt.section(this.sdkSection());
			}
		}.bind(this), "tools.presentAs()");
	}
	/**
	* Build one scope's wire schemas and names for prompt-order validation.
	* Restrictions do not make known tools invalid, but a mode collapse does.
	*/
	wireSchemas(scope) {
		const view = this.view(scope);
		const mode = this.modeFor(scope);
		if (mode === "native") return {
			schemas: [...view.visible.values()].map((definition) => this.schemaOf(definition, false)),
			knownNames: [...view.knownNames]
		};
		this.requireCodeRuntime(mode);
		const schemas = [...view.visible.values()].map((definition) => this.schemaOf(definition, false));
		if (mode === "ptc") return {
			schemas: schemas.filter((schema) => schema.name === RUN_CODE_NAME),
			knownNames: [RUN_CODE_NAME]
		};
		return {
			schemas,
			knownNames: [...view.knownNames, RUN_CODE_NAME]
		};
	}
	/**
	* Resolve the code runtime or throw the actionable misconfiguration error.
	* Read at use time (assembly / run_code execution), NOT via static
	* `inject`: an inject entry would hold `ctx.tools` — and every tool plugin
	* behind it — hostage to a code runtime existing even under `mode:
	* 'native'`.
	*
	* Assembly and `run_code` execution read separately, so the language is not
	* bound to a request. Harmless while one published backend exists — both
	* reads return the same flavor — but a reload that swapped in a second
	* language between them would hand a program written against one SDK to the
	* other. Binding it is deferred until a second backend ships (the first
	* point it is testable).
	*/
	requireCodeRuntime(mode) {
		const runtime = this.ctx.get("codeRuntime");
		if (!runtime) throw new Error(`dsh-tools: mode "${mode}" requires a code runtime — load a ctx.codeRuntime implementation (e.g. @deepseek-ai/dsh-code-runtime-worker-thread) or set tools mode to "native"`);
		if (!Object.hasOwn(SDK_RENDERERS, runtime.language)) {
			const known = Object.keys(SDK_RENDERERS).map((name) => JSON.stringify(name)).join(", ");
			throw new Error(`dsh-tools: no SDK renderer registered for runtime language ${JSON.stringify(runtime.language)} (known: ${known})`);
		}
		return runtime;
	}
	/**
	* Register globally or in the calling agent scope. Scoped tools shadow
	* globals; duplicates within one layer and the reserved `run_code` name fail.
	* @param definition - tool schema, execution, and optional finalization/presentation callbacks.
	* @returns the exact disposer that unregisters the tool.
	*/
	register(definition) {
		const name = definition.name;
		const output = definition.output;
		if (output === void 0 || typeof output !== "object" || typeof output.render !== "function" || output.presentationMeta !== void 0 && typeof output.presentationMeta !== "function") throw new TypeError(`tool "${name}" must declare output { schema, render, presentationMeta? }`);
		assertSupportedJsonSchema(output.schema);
		const timeoutMs = definition.timeoutMs;
		if (timeoutMs !== void 0 && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) throw new TypeError(`tool "${name}" timeoutMs must be a positive finite number`);
		if (name === "run_code") throw new Error(`tool name "${RUN_CODE_NAME}" is reserved for the PTC mode presentation transport and cannot be registered or shadowed`);
		return this.layers.effect(this.ctx, (layer) => layer.tools.insert(name, definition), { label: "tools.register()" });
	}
	/**
	* Restrict global tools for the calling agent scope. Empty filters, unknown
	* names, scope-local names, and reserved transport names fail. Restrictions
	* intersect; scoped registrations remain visible.
	* @param filter - global-tool mask: `allow` (keep only) and/or `deny` (remove).
	* @returns the exact disposer that lifts this restriction.
	*/
	restrict(filter) {
		const scope = scopeOf(this.ctx);
		if (scope === void 0) throw new Error("tools.restrict() requires a scoped context (agent.ctx): a context-global restriction would mask every agent — deny the tool for the intended agent instead");
		const allow = filter.allow;
		const deny = filter.deny;
		if (allow === void 0 && deny === void 0) throw new Error("tools.restrict({}) is a no-op: pass `allow` and/or `deny` (an empty filter is almost always a materialized-empty-config bug)");
		const compiled = {
			...allow !== void 0 ? { allow: new Set(allow) } : {},
			...deny !== void 0 ? { deny: new Set(deny) } : {}
		};
		if ([...allow ?? [], ...deny ?? []].includes("run_code")) throw new Error(`tools.restrict() cannot name reserved PTC mode presentation transport "${RUN_CODE_NAME}"; restrict end-capability tools instead`);
		const known = this.view(scope).restrictableNames;
		const unknown = [...allow ?? [], ...deny ?? []].filter((name) => !known.has(name));
		if (unknown.length > 0) throw new Error(`tools.restrict() names unknown global tool${unknown.length > 1 ? "s" : ""} ${unknown.map((n) => `"${n}"`).join(", ")}; known global tools: ${[...known].sort().join(", ") || "(none)"}`);
		return this.layers.effect(this.ctx, (layer) => layer.restrictions.append(compiled), { label: "tools.restrict()" });
	}
	/**
	* Register a monotonic guard after the extensible `tools/pre-execute`
	* waterfall. A plain-context guard applies globally; one registered through
	* `agent.ctx` applies only to that agent. Any matching guard may deny by
	* returning a reason, while no guard can force-allow a call another guard
	* denied. The exact effect disposer is returned for ordered ownership and
	* HMR cleanup.
	* @param guard - synchronous check; a returned string denies the execution.
	* @returns the exact disposer that unregisters the guard.
	*/
	guard(guard) {
		return this.layers.effect(this.ctx, (layer) => layer.guards.append(guard), {
			label: "tools.guard()",
			notify: false
		});
	}
	/** First monotonic denial from the global then the scope chain's guard layers, farthest first. */
	guardReason(exec) {
		const globalReason = this.layers.global.guardReason(exec);
		if (globalReason !== void 0) return globalReason;
		if (exec.agent === void 0) return void 0;
		for (const layer of this.layers.chainLayers(exec.agent)) {
			const reason = layer.guardReason(exec);
			if (reason !== void 0) return reason;
		}
	}
	/**
	* Resolve every registry fact one scope needs in one layer traversal. The
	* visible map applies restrictions to the INHERITED surface, then the
	* scope's own registrations and the reserved presentation transport; the
	* other sets retain the pre-restriction facts needed by restriction and
	* prompt-order validation.
	*
	* A restriction filters what a scope inherits — the global layer and every
	* ancestor layer on its chain — and never what its OWN layer registers.
	* That exemption is what a per-child capability filter has to keep intact:
	* the delegation runtime registers a child's structured-output tool into the
	* child's own layer, and a filter naming the capabilities the child may use
	* must not strip the machinery it answers through.
	*
	* Reading the exempt set as "the global layer" instead of "not mine" held
	* only while every model-facing tool sat in the host composition. Once
	* presets moved them onto the agent plane they became an ANCESTOR
	* contribution, so a child's filter silently stopped constraining anything
	* it was given.
	* @param scope - the viewing scope (the agent), or undefined for the global view.
	* @returns the complete derived view for that scope.
	*/
	view(scope) {
		const layers = this.layers.chainLayers(scope);
		const own = this.layers.peek(scope);
		const inherited = new Map(this.layers.global.tools.entries());
		for (const layer of layers) {
			if (layer === own) continue;
			for (const [name, definition] of layer.tools.entries()) inherited.set(name, definition);
		}
		const visible = /* @__PURE__ */ new Map();
		const knownNames = /* @__PURE__ */ new Set();
		const restrictableNames = /* @__PURE__ */ new Set();
		for (const [name, definition] of inherited) {
			knownNames.add(name);
			restrictableNames.add(name);
			if (layers.every((layer) => layer.admits(name))) visible.set(name, definition);
		}
		if (own !== void 0) for (const [name, definition] of own.tools.entries()) {
			knownNames.add(name);
			visible.set(name, definition);
		}
		if (this.modeFor(scope) !== "native") visible.set(RUN_CODE_NAME, this.requireCodeTransport());
		return {
			visible,
			knownNames,
			restrictableNames
		};
	}
	/**
	* Look up a tool as one scope sees it (scoped
	* shadows global; a restricted-away global reads as absent). Presenters pass
	* the calling agent so the rendered card matches the definition that
	* actually executed.
	* @param name - the tool name as registered.
	* @param scope - the viewing scope (the agent); omitted = the global view.
	* @returns the definition the scope resolves, or undefined when none is visible.
	*/
	get(name, scope) {
		return this.view(scope).visible.get(name);
	}
	/**
	* Resolve the definition that MAY EXECUTE for a call, applying the mode
	* collapse at the operation boundary that owns it. The registry view
	* (`get`) is presentation-agnostic; here a MODEL-DIRECT call under `ptc`
	* may only name the reserved `run_code` transport, while a nested
	* sub-dispatch (a `parent` token set — the `run_code` SDK calling a tool
	* it bound) may call any visible tool. Denial surfaces as `UNKNOWN_TOOL`
	* through the executor, matching an absent definition.
	* @param name - the tool name as registered.
	* @param scope - the viewing scope (the agent); omitted = the global view.
	* @param nested - whether the call is a transport sub-dispatch, not a model-direct call.
	* @returns the definition that may run, or undefined when the call must be rejected.
	*/
	resolveExecution(name, scope, nested) {
		const tool = this.get(name, scope);
		if (tool === void 0) return void 0;
		if (this.collapses(name, scope, nested)) return void 0;
		return tool;
	}
	/**
	* Project visible definitions onto the allowlisted model-facing schema fields,
	* excluding execution and presentation callbacks.
	* @param scope - the viewing scope (the agent); omitted = the global view.
	* @returns one deep-cloned schema per visible tool.
	*/
	schemas(scope) {
		return [...this.view(scope).visible.values()].map((definition) => this.schemaOf(definition, true));
	}
	/** Project visible callable tools onto the generated PTC mode SDK contract. */
	sdkSchemas(scope) {
		return [...this.view(scope).visible.values()].filter((definition) => definition.name !== RUN_CODE_NAME).map((definition) => {
			const output = snapshotJsonValue(definition.output.schema);
			/* v8 ignore next -- registration already validated and retained this schema as lossless JSON. */
			if (output === void 0) throw new Error(`tool "${definition.name}" output schema must be lossless JSON before SDK projection`);
			return {
				...this.schemaOf(definition, true),
				output
			};
		});
	}
	/** Project one definition onto the model-facing schema fields. */
	schemaOf(definition, detachParameters) {
		const { name, description, parameters } = definition;
		const detached = detachParameters ? snapshotJsonValue(parameters) : parameters;
		if (detached === void 0) throw new Error(`tool "${name}" parameters must be lossless JSON before schema projection`);
		return {
			name,
			description,
			parameters: detached
		};
	}
	/**
	* Classify a pending call through the caller's visible tool definition. Only
	* an exact `true` is parallel; unknown, hidden, undeclared, invalid, or
	* throwing classifiers are exclusive.
	* @param exec - call name, parsed arguments, and optional agent scope.
	* @returns the fail-closed scheduling mode.
	*/
	executionMode(exec) {
		const tool = this.resolveExecution(exec.name, exec.agent, exec.parent !== void 0);
		if (!tool?.isConcurrencySafe) return { kind: "exclusive" };
		try {
			return tool.isConcurrencySafe(exec.arguments) === true ? { kind: "parallel" } : { kind: "exclusive" };
		} catch {
			return { kind: "exclusive" };
		}
	}
	/**
	* Run the `tools/ptc-dispatch-log` waterfall over one settled sub-dispatch
	* and return the content the bridge should log on `tool/ptc-dispatch`.
	* Contained: when a listener throws, the method logs the original settled
	* content; that failure must not fail the dispatch or omit the settle event. Private:
	* the ONE consumer is the `run_code` bridge this registry constructs, which
	* receives it as a capability parameter (the `requireRuntime` idiom) — the
	* waterfall, not this invoker, is the public extension point.
	*/
	async shapeDispatchLog(dispatch) {
		try {
			return await this.ctx.waterfall(scopeTarget(this, dispatch.agent), "tools/ptc-dispatch-log", dispatch, () => Promise.resolve(dispatch.content));
		} catch (error) {
			this.ctx.logger.warn(`tools: ptc-dispatch-log listener failed for ${dispatch.name}: ${errorMessage(error)}; logging the original settled content`);
			return dispatch.content;
		}
	}
	/**
	* Whether the `ptc` mode collapse denies a model-direct call: only the
	* reserved `run_code` transport may be named. Nested sub-dispatches (a
	* `parent` token set) bypass the collapse. One home for the
	* security-relevant predicate, shared by {@link resolveExecution} and
	* {@link createExecution} so the two can never drift apart.
	*
	* Resolved through {@link modeFor}, NOT `defaultMode`: an agent given `ptc`
	* by an agent preset under a native deployment is the composition
	* `dsh-agent-tool-presentation` exists for, and reading the deployment default would
	* leave exactly that agent uncollapsed — announcing one surface while
	* executing another, which is the bypass this collapse closes.
	* @param name - the tool name as registered.
	* @param scope - the viewing scope whose effective presentation mode applies.
	* @param nested - whether the call is a transport sub-dispatch, not a model-direct call.
	*/
	collapses(name, scope, nested) {
		return !nested && this.modeFor(scope) === "ptc" && name !== "run_code";
	}
	/**
	* Execute through pre-policy, guards, around-dispatch, post-policy,
	* definition-owned content finalization, and final notification. Tool and
	* listener failures resolve as materialized error results; an invisible tool
	* reports `UNKNOWN_TOOL`. The returned outcome is the same lossless, frozen
	* snapshot final observers receive. Cancellation
	* arriving after entry and before final result materialization skips a
	* not-yet-started body with `ABORTED_BEFORE_DISPATCH` or replaces a
	* successful started outcome with `ABORTED`; already-started work is still
	* drained and may retain a tool-owned structured error.
	* @param exec - the typed same-process call input. The registry assigns its
	*   correlation token before policy begins.
	* @returns the materialized final result.
	*/
	async execute(exec) {
		return this.prepareExecution(exec, (prepared) => this.completeScheduledExecution(prepared));
	}
	async completeScheduledExecution(prepared) {
		switch (prepared.kind) {
			case "dispatch": {
				const dispatched = await this.dispatchScheduledExecution(prepared.exec);
				return dispatched.kind === "post-result" ? await this.finalizeScheduledExecution(prepared.exec, dispatched.result) : this.finishScheduledExecution(prepared.exec, dispatched.result);
			}
			case "post-result": return await this.finalizeScheduledExecution(prepared.exec, prepared.result);
			case "final-result": return this.finishScheduledExecution(prepared.exec, prepared.result);
			/* v8 ignore next -- closed-union exhaustiveness guard */
			default: return assertNever(prepared, "scheduled tool preparation");
		}
	}
	createExecution(exec) {
		const deferredContexts = [];
		const token = createExecutionToken();
		const callId = exec.callId;
		const rootCallId = exec.rootCallId ?? callId;
		const name = exec.name;
		const agent = exec.agent;
		const parent = exec.parent;
		const signal = exec.signal;
		const visible = this.get(name, agent);
		const collapsed = visible !== void 0 && this.collapses(name, agent, parent !== void 0);
		const concludingExecutions = this.concludingExecutions;
		const base = {
			token,
			callId,
			rootCallId,
			name,
			signal,
			...agent !== void 0 ? { agent } : {},
			...parent !== void 0 ? { parent } : {},
			deferContext(context) {
				deferredContexts.push(context);
			},
			concludeTurn() {
				concludingExecutions.add(this);
			}
		};
		const capturedFinalizer = visible?.finalizeContent?.bind(visible);
		const finalizerFor = () => collapsed && !signal.aborted ? void 0 : capturedFinalizer;
		try {
			const detached = snapshotJsonValue(exec.arguments);
			if (detached === void 0) throw new TypeError("tool execution arguments must be losslessly JSON-serializable");
			const execution = {
				...base,
				arguments: deepFreeze(detached)
			};
			this.deferredContexts.set(execution, deferredContexts);
			this.contentFinalizers.set(execution, finalizerFor());
			this.cancellationStates.set(execution, {
				callerSignal: signal,
				bodyInvoked: false
			});
			if (collapsed) {
				if (signal.aborted) return {
					kind: "final-result",
					exec: execution,
					result: toolAbortedBeforeDispatchResult()
				};
				return {
					kind: "final-result",
					exec: execution,
					result: toolErrorResult(new ToolNotFoundError(name, `only \`${RUN_CODE_NAME}\` is callable directly — call \`${name}\` from inside a \`${RUN_CODE_NAME}\` program instead`))
				};
			}
			return {
				kind: "ready",
				exec: execution
			};
		} catch (error) {
			const execution = {
				...base,
				arguments: void 0
			};
			this.contentFinalizers.set(execution, finalizerFor());
			return {
				kind: "final-result",
				exec: execution,
				result: toolErrorResult(error)
			};
		}
	}
	/**
	* Run the ordered pre-execute and monotonic guard stages for the scheduler.
	* @param input - the caller-supplied execution input.
	* @returns the prepared execution plus the next scheduler stage.
	* @internal
	*/
	async prepareScheduledExecution(input) {
		return this.prepareExecution(input, (prepared) => prepared);
	}
	async prepareExecution(input, next) {
		const created = this.createExecution(input);
		if (created.kind !== "ready") return next(created);
		const exec = created.exec;
		if (this.callerCancelled(exec)) return next({
			kind: "final-result",
			exec,
			result: toolAbortedBeforeDispatchResult()
		});
		try {
			const carrier = scopeTarget(this, exec.agent);
			const gate = await this.ctx.waterfall(carrier, "tools/pre-execute", exec, () => Promise.resolve({ kind: "allow" }));
			const askResolution = gate.kind === "ask" ? await this.serviceAsk(exec, gate) : {
				decision: gate,
				approvalCancelled: false
			};
			const { decision } = askResolution;
			if (this.callerCancelled(exec) && askResolution.approvalCancelled) return await next({
				kind: "post-result",
				exec,
				result: toolAbortedBeforeDispatchResult()
			});
			const denialReason = decision.kind === "allow" ? this.guardReason(exec) : decision.reason;
			if (denialReason !== void 0) return await next({
				kind: "post-result",
				exec,
				result: this.materializeFinalResult({
					content: [{
						type: "text",
						text: `Error: ${denialReason}`
					}],
					isError: true,
					error: { message: denialReason }
				})
			});
			if (this.callerCancelled(exec)) return await next({
				kind: "post-result",
				exec,
				result: toolAbortedBeforeDispatchResult()
			});
			return await next({
				kind: "dispatch",
				exec
			});
		} catch (error) {
			return next({
				kind: "final-result",
				exec,
				result: toolErrorResult(error)
			});
		}
	}
	/** Whether the original caller signal is currently aborted. */
	callerCancelled(exec) {
		const state = this.cancellationStates.get(exec);
		/* v8 ignore next -- only registry-minted executions reach the staged scheduler methods */
		if (state === void 0) throw new Error("tool registry scheduler invariant violated: missing cancellation state");
		return state.callerSignal.aborted;
	}
	/** Canonical cancellation outcome selected by whether the tool body started. */
	cancellationResult(exec, prior) {
		const state = this.cancellationStates.get(exec);
		/* v8 ignore next -- only registry-minted executions reach the staged scheduler methods */
		if (state === void 0) throw new Error("tool registry scheduler invariant violated: missing cancellation state");
		return state.bodyInvoked ? toolAbortedResult(prior) : toolAbortedBeforeDispatchResult(prior);
	}
	/**
	* Dispatch the registered body with the original caller signal fused back
	* into any around-wrapper replacement. Cancellation never abandons the body:
	* a started promise reaches quiescence before its outcome becomes `ABORTED`.
	*/
	async dispatchToolBody(exec) {
		const state = this.cancellationStates.get(exec);
		/* v8 ignore next -- only registry-minted executions reach the staged scheduler methods */
		if (state === void 0) throw new Error("tool registry scheduler invariant violated: missing cancellation state");
		const wrapperSignal = exec.signal;
		const fused = fuseToolSignals(state.callerSignal, wrapperSignal);
		const signal = fused.signal;
		if (isAborted(signal)) {
			fused.dispose();
			return toolAbortedBeforeDispatchResult();
		}
		exec.signal = signal;
		try {
			const tool = this.resolveExecution(exec.name, exec.agent, exec.parent !== void 0);
			if (!tool) throw new ToolNotFoundError(exec.name);
			state.bodyInvoked = true;
			const returned = await tool.execute(exec.arguments, exec);
			const result = this.createSuccessResult(exec, tool, returned);
			return isAborted(signal) ? toolAbortedResult(result) : result;
		} catch (error) {
			return toolErrorResult(error);
		} finally {
			fused.dispose();
			exec.signal = wrapperSignal;
		}
	}
	/**
	* Run around-dispatch and the tool body. Tool and unknown-tool failures still
	* receive post-execute; pipeline failures are already final.
	* @param exec - the prepared execution.
	* @returns whether the result still needs post-execute.
	* @internal
	*/
	async dispatchScheduledExecution(exec) {
		try {
			const mutableExec = exec;
			const carrier = scopeTarget(this, exec.agent);
			const result = await this.ctx.waterfall(carrier, "tools/execute", mutableExec, () => this.dispatchToolBody(mutableExec));
			const normalized = this.normalizeDispatchResult(exec, result);
			const deferredContexts = this.deferredContexts.get(exec);
			/* v8 ignore next -- dispatch only receives executions minted by this registry's prepare stage */
			if (deferredContexts === void 0) throw new Error("tool registry scheduler invariant violated: unprepared execution");
			const resultWithDeferredContexts = deferredContexts.length === 0 ? normalized : this.markCanonical(exec, {
				...normalized,
				additionalContexts: [...deferredContexts, ...normalized.additionalContexts ?? []]
			});
			return {
				kind: "post-result",
				result: this.callerCancelled(exec) && !resultWithDeferredContexts.isError ? this.cancellationResult(exec, resultWithDeferredContexts) : resultWithDeferredContexts
			};
		} catch (error) {
			return {
				kind: "final-result",
				result: toolErrorResult(error)
			};
		}
	}
	/**
	* Run ordered post-execute, then apply definition-owned content finalization,
	* materialize, and notify the final outcome.
	* @param exec - the prepared execution.
	* @param result - dispatch/pre result that still needs post-execute.
	* @returns the materialized final result.
	* @internal
	*/
	async finalizeScheduledExecution(exec, result) {
		try {
			const postResult = await this.postExecute(exec, result);
			return this.finishScheduledExecution(exec, this.callerCancelled(exec) && !postResult.isError ? this.cancellationResult(exec, postResult) : postResult);
		} catch (error) {
			return this.finishScheduledExecution(exec, toolErrorResult(error));
		}
	}
	/**
	* Materialize the candidate, apply definition-owned content finalization,
	* then materialize and notify the authoritative result.
	* @param exec - the prepared execution.
	* @param result - final result.
	* @returns the materialized final result.
	* @internal
	*/
	finishScheduledExecution(exec, result) {
		let materializedResult;
		try {
			materializedResult = this.materializeFinalResult(result);
		} catch (error) {
			materializedResult = this.materializeFinalResult(toolErrorResult(error));
		}
		let finalResult;
		try {
			finalResult = this.materializeFinalResult(this.applyFinalContent(exec, materializedResult));
		} catch (error) {
			finalResult = this.materializeFinalResult(toolErrorResult(error));
		}
		this.notifyResult(exec, finalResult);
		return finalResult;
	}
	/** Apply the snapshotted tool-owned content transform without exposing other result fields. */
	applyFinalContent(exec, result) {
		const finalizeContent = this.contentFinalizers.get(exec);
		if (finalizeContent === void 0) return result;
		const content = finalizeContent(exec, result);
		return content === void 0 ? result : {
			...result,
			content
		};
	}
	/** Notify observers without exposing a mutation or error channel into the outcome. */
	notifyResult(exec, result) {
		Object.freeze(exec);
		const { name: toolName, callId } = exec;
		const reportFailure = (error) => {
			this.ctx.logger.warn(`tool "${toolName}" (${callId}): tools/result observer failed: ${errorMessage(error)}`);
		};
		const callbacks = this.ctx.events.dispatch("emit", [
			scopeTarget(this, exec.agent),
			"tools/result",
			exec,
			result
		]);
		for (const callback of callbacks) try {
			const returned = callback(exec, result);
			Promise.resolve(returned).catch(reportFailure);
		} catch (error) {
			reportFailure(error);
		}
	}
	/**
	* Resolve an `ask` decision to allow/deny through the approval seam. The
	* seam is consumed opportunistically with `ctx.get('approval')` — a
	* deployment that composes no ApprovalService keeps the historical degrade
	* to deny, and an unmount mid-session degrades the same way on the next ask.
	* An agent-less execution also degrades: without an agent there is no
	* session to audit to and no UI to route to. Otherwise the outcome maps
	* one-to-one — `allowed-once` proceeds; the three non-grants deny with
	* distinct reasons so the model can tell a human "no" from an absent
	* approval channel.
	*/
	async serviceAsk(exec, ask) {
		const approval = this.ctx.get("approval");
		if (approval === void 0) return {
			decision: {
				kind: "deny",
				reason: ask.reason ?? `tool "${exec.name}" requires approval (not yet supported)`
			},
			approvalCancelled: false
		};
		if (exec.agent === void 0) return {
			decision: {
				kind: "deny",
				reason: `tool "${exec.name}" requires approval, but the call has no agent to route it through`
			},
			approvalCancelled: false
		};
		const outcome = await approval.request({
			agent: exec.agent,
			toolName: exec.name,
			callId: exec.callId,
			...ask.reason !== void 0 ? { reason: ask.reason } : {},
			signal: exec.signal
		});
		switch (outcome) {
			case "allowed-once": return {
				decision: { kind: "allow" },
				approvalCancelled: false
			};
			case "rejected": return {
				decision: {
					kind: "deny",
					reason: `the user rejected tool "${exec.name}"`
				},
				approvalCancelled: false
			};
			case "cancelled": return {
				decision: {
					kind: "deny",
					reason: `approval for tool "${exec.name}" was cancelled`
				},
				approvalCancelled: true
			};
			case "unavailable": return {
				decision: {
					kind: "deny",
					reason: `tool "${exec.name}" requires approval, but no approval channel is available`
				},
				approvalCancelled: false
			};
			default: return assertNever(outcome, "ApprovalOutcome");
		}
	}
	/**
	* Run the `tools/post-execute` waterfall over a dispatched `result` and apply
	* its {@link PostToolDecision}: `accept` keeps the call successful (replacing
	* `content` when given), `block` turns it into an `isError` whose content is
	* the corrective `feedback`. Either decision may attach `additionalContexts`,
	* which are ferried on the returned result for the loop's active-batch FIFO.
	* Context deferred by the tool body survives an accepted result but is
	* discarded when the outer call is blocked; a block exposes only context the
	* blocking decision explicitly supplied.
	* Runs inside `execute`'s outer try/catch (a throwing listener → isError).
	*/
	async postExecute(exec, result) {
		const decision = await this.ctx.waterfall(scopeTarget(this, exec.agent), "tools/post-execute", exec, result, () => Promise.resolve({ kind: "accept" }));
		const decisionContexts = decision.additionalContexts ?? [];
		if (decision.kind === "block") {
			const message = failureMessageFromContent(decision.feedback);
			return this.markCanonical(exec, {
				content: decision.feedback,
				isError: true,
				error: { message },
				...decisionContexts.length > 0 ? { additionalContexts: decisionContexts } : {}
			});
		}
		if (Object.hasOwn(decision, "content") && Object.hasOwn(decision, "value")) throw new TypeError("tools/post-execute accept decision cannot replace both value and content");
		const additionalContexts = [...result.additionalContexts ?? [], ...decisionContexts];
		if (Object.hasOwn(decision, "value")) {
			if (result.isError) throw new TypeError("tools/post-execute cannot replace the value of a failed result");
			const tool = this.resolveExecution(exec.name, exec.agent, exec.parent !== void 0);
			if (tool === void 0) throw new ToolNotFoundError(exec.name);
			const replaced = this.createSuccessResult(exec, tool, decision.value);
			return this.markCanonical(exec, {
				...replaced,
				...additionalContexts.length > 0 ? { additionalContexts } : {}
			});
		}
		return this.markCanonical(exec, {
			...result,
			...decision.content !== void 0 ? { content: decision.content } : {},
			...additionalContexts.length > 0 ? { additionalContexts } : {}
		});
	}
	/** Registry-normalized results and the exact dispatch that validated each value. */
	canonicalResults = /* @__PURE__ */ new WeakMap();
	/** Mark one registry-normalized result as canonical only for its owning dispatch. */
	markCanonical(exec, result) {
		this.canonicalResults.set(result, exec.token);
		return result;
	}
	/** Snapshot, validate, render, and optionally project one successful body value. */
	createSuccessResult(exec, tool, candidate) {
		const detached = snapshotToolValue(tool.name, candidate);
		const violations = validateJsonSchemaValue(tool.output.schema, detached, "value");
		if (violations.length > 0) throw new ToolOutputError(tool.name, violations);
		const value = deepFreeze(detached);
		let rendered;
		try {
			rendered = tool.output.render(exec.arguments, value);
		} catch (error) {
			throw projectionError(tool.name, "render", error);
		}
		const content = snapshotProjection(tool.name, "render", rendered);
		let meta;
		if (exec.parent === void 0 && tool.output.presentationMeta !== void 0) {
			let projected;
			try {
				projected = tool.output.presentationMeta(exec.arguments, value);
			} catch (error) {
				throw projectionError(tool.name, "presentationMeta", error);
			}
			meta = snapshotProjection(tool.name, "presentationMeta", projected);
		}
		const concludesTurn = this.concludingExecutions.has(exec);
		return this.markCanonical(exec, this.materializeFinalResult({
			isError: false,
			value,
			content,
			...meta !== void 0 ? { meta } : {},
			...concludesTurn ? { concludesTurn: true } : {}
		}));
	}
	/** Normalize an around-dispatch wrapper's authored result through the owning output contract. */
	normalizeDispatchResult(exec, result) {
		if (this.canonicalResults.get(result) === exec.token) return result;
		if (result.isError) return this.markCanonical(exec, {
			isError: true,
			error: result.error,
			content: result.content,
			...result.meta !== void 0 ? { meta: result.meta } : {},
			...result.additionalContexts !== void 0 ? { additionalContexts: result.additionalContexts } : {}
		});
		const tool = this.resolveExecution(exec.name, exec.agent, exec.parent !== void 0);
		if (tool === void 0) throw new ToolNotFoundError(exec.name);
		const normalized = this.createSuccessResult(exec, tool, result.value);
		return this.markCanonical(exec, {
			...normalized,
			...result.additionalContexts !== void 0 ? { additionalContexts: result.additionalContexts } : {}
		});
	}
	/** Materialize the authoritative commit outcome once, immediately before `tools/result`. */
	materializeFinalResult(result) {
		const presentation = {
			content: result.content,
			...result.meta !== void 0 ? { meta: result.meta } : {},
			...result.additionalContexts !== void 0 ? { additionalContexts: result.additionalContexts } : {}
		};
		if (result.isError) return materializePresentation({
			isError: true,
			error: result.error,
			...presentation
		});
		return deepFreeze({
			...materializePresentation({
				isError: false,
				...presentation,
				...result.concludesTurn === true ? { concludesTurn: true } : {}
			}),
			value: result.value
		});
	}
});
/** Mint a same-process correlation token whose identity is its value. */
function createExecutionToken() {
	return Symbol("dsh.tool.execution");
}
function toolErrorResult(error) {
	const info = errorInfo(error);
	const message = errorMessage(error);
	return {
		content: [{
			type: "text",
			text: `Error: ${message}`
		}],
		isError: true,
		error: {
			message,
			...info ? { info } : {}
		}
	};
}
/** Read live abort state across an await without treating it as synchronously immutable. */
function isAborted(signal) {
	return signal.aborted;
}
/**
* Fuse caller and wrapper cancellation without nesting `AbortSignal.any`.
* Keeping the relay dispatch-scoped also removes listeners when work settles.
*/
function fuseToolSignals(caller, wrapper) {
	if (caller === wrapper) return {
		signal: caller,
		dispose() {}
	};
	const controller = new AbortController();
	let listening = false;
	const dispose = () => {
		if (!listening) return;
		listening = false;
		caller.removeEventListener("abort", abortFromCaller);
		wrapper.removeEventListener("abort", abortFromWrapper);
	};
	const abortFrom = (source) => {
		const reason = source.reason;
		controller.abort(reason);
		dispose();
	};
	const abortFromCaller = () => {
		abortFrom(caller);
	};
	const abortFromWrapper = () => {
		abortFrom(wrapper);
	};
	if (wrapper.aborted) abortFromWrapper();
	else if (caller.aborted) abortFromCaller();
	else {
		listening = true;
		caller.addEventListener("abort", abortFromCaller, { once: true });
		wrapper.addEventListener("abort", abortFromWrapper, { once: true });
	}
	return {
		signal: controller.signal,
		dispose
	};
}
/** Canonical result when cancellation supersedes success after body invocation. */
function toolAbortedResult(prior) {
	const additionalContexts = prior?.additionalContexts ?? [];
	return {
		content: [{
			type: "text",
			text: "Error: tool call aborted"
		}],
		isError: true,
		error: {
			message: "tool call aborted",
			info: {
				name: "AbortError",
				code: TOOL_ABORTED
			}
		},
		...additionalContexts.length > 0 ? { additionalContexts } : {}
	};
}
/** Canonical result when cancellation prevents tool body invocation. */
function toolAbortedBeforeDispatchResult(prior) {
	const additionalContexts = prior?.additionalContexts ?? [];
	return {
		content: [{
			type: "text",
			text: "Error: tool call aborted before dispatch"
		}],
		isError: true,
		error: {
			message: "tool call aborted before dispatch",
			info: {
				name: "AbortError",
				code: TOOL_ABORTED_BEFORE_DISPATCH
			}
		},
		...additionalContexts.length > 0 ? { additionalContexts } : {}
	};
}
//#endregion
//#region src/business/engine.ts
/**
* 团队开发编排引擎 —— 项目状态管理、阶段流转、角色 agent 创建与唤醒、
* 产物落盘、评审门禁处理。
*
* 为什么独立成模块：编排是业务组合（组合 features 的纯能力 +
* DSH 运行时服务），集中在这里，装配层只做工具注册。
*
* 核心设计（修复 pipeline-kernel 的两个缺陷）：
*  1. 任务"有内容"：每个阶段产物（需求清单/功能清单/用例矩阵/验收报告）
*     渲染为 Markdown 直接落盘 artifactsDir，并作为引导消息内容
*     投递给对应角色 agent（而非只有标题）。
*  2. 有业务门禁：评审阶段（req-review/product-review/testcase-review）
*     由评审角色判定 pass/打回；打回自动回到上一阶段带意见重做。
*/
/** 审计日志文件名（追加式 JSONL，链式哈希防篡改）。 */
const AUDIT_FILE$1 = "audit.jsonl";
/** 项目状态文件名。 */
const STATE_FILE = "state.json";
/** 阶段产物文件名映射（stage → 文件名）。 */
const STAGE_ARTIFACT_FILE = {
	requirement: "requirements.md",
	"req-review": "req-review.md",
	product: "features.md",
	"product-review": "product-review.md",
	testcase: "testcases.md",
	"testcase-review": "testcase-review.md",
	develop: "development.md",
	"feature-accept": "acceptance.md",
	"e2e-accept": "e2e.md"
};
/** 从 Cordis Context 构造运行时（装配层调用）。 */
function runtimeFromCtx(ctx, cwd) {
	const fs = ctx.get("fs");
	const agents = ctx.get("agents");
	const agentPresets = ctx.get("agentPresets");
	const workspaceRegistry = ctx.get("workspaceRegistry");
	/** 拼接 cwd 相对路径（防路径穿越）。 */
	const join = (rel) => {
		const normalized = rel.replace(/\\/g, "/").replace(/^\/+/, "");
		return `${cwd.replace(/\/+$/, "")}/${normalized}`;
	};
	return {
		async readText(relPath) {
			if (!fs) return void 0;
			try {
				const target = await fs.resolve(join(relPath));
				return await fs.readText(target);
			} catch {
				return;
			}
		},
		async writeText(relPath, content) {
			if (!fs) throw new Error("fs 服务不可用");
			const target = await fs.resolve(join(relPath));
			await fs.writeText(target, content);
		},
		async exists(relPath) {
			if (!fs) return false;
			try {
				const target = await fs.resolve(join(relPath));
				return await fs.stat(target) !== void 0;
			} catch {
				return false;
			}
		},
		async listDir(relPath) {
			if (!fs) return [];
			try {
				const target = await fs.resolve(join(relPath));
				return (await fs.listDir(target)).map((e) => e.name);
			} catch {
				return [];
			}
		},
		async createRoleAgent(projectId, role, roleCwd, greeting) {
			if (!agents || !agentPresets) throw new Error("agents/agentPresets 服务不可用");
			const sessionId = `agiteam-fallback-${projectId}-${role}-${randomUUID()}`;
			const presetId = ROLE_PRESET[role];
			try {
				await agentPresets.resolve(presetId);
				const caller = ctx.agent;
				const headerConfig = caller?.session?.requestHeader?.()?.config;
				const agentOptions = {};
				if (headerConfig?.provider || caller?.options?.provider) agentOptions.provider = headerConfig?.provider ?? caller?.options?.provider ?? "";
				if (headerConfig?.model || caller?.options?.model) agentOptions.model = headerConfig?.model ?? caller?.options?.model ?? "";
				if (headerConfig?.reasoningEffort || caller?.options?.reasoningEffort) agentOptions.reasoningEffort = ReasoningEffortId(headerConfig?.reasoningEffort ?? caller?.options?.reasoningEffort ?? "");
				console.error(`[dsh-agiteam] createRoleAgent 模型继承（${role}）：provider=${agentOptions.provider ?? "无"}, model=${agentOptions.model ?? "无"}`);
				const createOptions = {
					sessionId,
					meta: {
						cwd: roleCwd,
						agentPreset: presetId
					},
					...Object.keys(agentOptions).length > 0 ? { agentOptions } : {},
					setup: async (agentCtx) => {
						await agentPresets.mount(agentCtx, presetId);
					}
				};
				const live = (await agents.create(createOptions)).agent;
				if (live && typeof live.followup === "function") live.followup(createUserMessage({
					content: [{
						type: "text",
						text: greeting
					}],
					source: {
						kind: "plugin",
						plugin: "dsh-agiteam",
						form: "instructions"
					}
				}));
				if (workspaceRegistry) try {
					const ws = await workspaceRegistry.resolveByPath(roleCwd);
					if (ws && typeof ws.attachSession === "function") await ws.attachSession(sessionId);
				} catch {}
				return { sessionId };
			} catch (err) {
				const detail = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
				console.error(`[dsh-agiteam] createRoleAgent 失败（role=${role}, sessionId=${sessionId}, preset=${presetId}, cwd=${roleCwd}）:\n${detail}`);
				throw new Error(`创建角色会话失败（role=${role}, sessionId=${sessionId}, cwd=${roleCwd}）：\n${detail}`);
			}
		},
		async wakeRoleAgent(projectId, role, text) {
			if (!agents) return false;
			const sessionId = `session-${projectId}-${role}`;
			const live = agents.get(sessionId);
			if (!live || typeof live.followup !== "function") return false;
			live.followup(createUserMessage({
				content: [{
					type: "text",
					text
				}],
				source: {
					kind: "plugin",
					plugin: "dsh-agiteam",
					form: "instructions"
				}
			}));
			return true;
		},
		async appendAudit(input) {
			const auditFile = `${input.projectId}/${AUDIT_FILE$1}`;
			const auditText = await this.readText(auditFile);
			const entries = auditText ? parseAuditLog(auditText) : [];
			const prevHash = entries.length > 0 ? entries[entries.length - 1].hash : "GENESIS";
			const entry = makeAuditEntry(entries.length + 1, {
				time: Date.now(),
				action: input.action,
				role: input.role,
				projectId: input.projectId,
				stage: input.stage,
				detail: input.detail,
				...input.fingerprint ? { fingerprint: input.fingerprint } : {}
			}, prevHash);
			const nextText = auditText ? `${auditText}\n${JSON.stringify(entry)}` : JSON.stringify(entry);
			await this.writeText(auditFile, nextText);
			return {
				seq: entry.seq,
				hash: entry.hash
			};
		}
	};
}
/** 构造空项目状态。 */
function emptyState(projectId, projectName, rawRequirement, cwd) {
	return {
		projectId,
		projectName,
		rawRequirement,
		stage: "requirement",
		completed: {},
		reviewComments: {},
		artifacts: {},
		cwd,
		updatedAt: Date.now()
	};
}
/** 读取项目状态；不存在返回 undefined。 */
async function loadState(rt, projectId) {
	const text = await rt.readText(`${projectId}/${STATE_FILE}`);
	if (!text) return void 0;
	try {
		return JSON.parse(text);
	} catch {
		return;
	}
}
/** 保存项目状态。 */
async function saveState(rt, state) {
	state.updatedAt = Date.now();
	await rt.writeText(`${state.projectId}/${STATE_FILE}`, JSON.stringify(state, null, 2));
}
/** 记录评审意见。 */
async function recordReviewComment(state, stage, comment) {
	const list = state.reviewComments[stage] ?? [];
	list.push(comment);
	state.reviewComments[stage] = list;
}
/**
* 推进阶段（正常流转或评审打回）。
*  - 正常：stage → nextStage
*  - 评审不通过：stage → reviewBackTo（回到上一阶段）
* @returns 新阶段 id。
*/
function advanceStage(state, passed) {
	const current = state.stage;
	if (!passed && reviewBackTo(current)) {
		const back = reviewBackTo(current);
		state.stage = back;
		return back;
	}
	const next = nextStage(current);
	if (next) state.stage = next;
	return state.stage;
}
/** 阶段 → 角色引导消息（投递给负责角色，含产物内容回灌对话）。 */
function stageGreeting(state, stage, artifactText) {
	const name = STAGE_NAMES[stage] ?? stage;
	const role = STAGE_ROLE[stage];
	const roleName = role ? ROLE_NAMES[role] : "对应角色";
	const base = [`【dsh-agiteam】项目「${state.projectName}」进入阶段：${name}。`, `你作为${roleName}，请完成本阶段工作。`];
	if (artifactText) base.push("", "以下是本阶段依据/产物：", "", artifactText);
	base.push("", "完成后请汇报结论；若你是评审角色，请给出明确 通过/打回 判定与意见。");
	return base.join("\n");
}
/**
* 启动一个新团队开发项目。
* @returns 新项目状态。
*/
async function startProject(rt, projectId, projectName, rawRequirement, cwd) {
	const state = emptyState(projectId, projectName, rawRequirement, cwd);
	await rt.writeText(`${projectId}/${STATE_FILE}`, JSON.stringify(state, null, 2));
	const greeting = stageGreeting(state, "requirement", rawRequirement);
	await rt.createRoleAgent(projectId, "requirement", cwd, greeting);
	return state;
}
/**
* 推进当前阶段到下一阶段（或打回），并唤醒对应角色 agent 继续工作。
* @returns 更新后的状态。
*/
async function advanceAndWake(rt, state, passed, comment) {
	if (comment) await recordReviewComment(state, state.stage, comment);
	const next = advanceStage(state, passed);
	await saveState(rt, state);
	const artifactFile = STAGE_ARTIFACT_FILE[next];
	const artifactText = artifactFile ? await rt.readText(`${state.projectId}/${artifactFile}`) : void 0;
	const role = STAGE_ROLE[next];
	if (role) {
		const greeting = stageGreeting(state, next, artifactText);
		if (!await rt.wakeRoleAgent(state.projectId, role, greeting)) await rt.createRoleAgent(state.projectId, role, state.cwd, greeting);
	}
	return state;
}
//#endregion
//#region src/business/tools.ts
/**
* agiteam_* 工具的顶层 execute —— 业务编排入口。
*
* 每个 execute 是顶层导出函数（可独立单元测试），装配层只做
* defineTool 包装与注册。所有错误路径返回中文可操作消息。
* 返回值统一为可 JSON 序列化的对象（与工具 output schema 一致）。
*/
/** 错误结果。 */
function errorResult(message) {
	return {
		status: "error",
		message
	};
}
/** 从工具执行上下文构造引擎运行时与项目 cwd。 */
function buildRuntime(ctx, config, cwd) {
	const projectCwd = cwd ?? process.cwd();
	return {
		rt: runtimeFromCtx(ctx, projectCwd),
		cwd: projectCwd
	};
}
/** 启动团队开发项目（agiteam_start）—— 数据库版（storageDomain），自动唤醒需求分析师开始第一阶段。 */
async function executeStartProject(ctx, config, args) {
	const projectId = args.projectId ?? safeId(args.projectName);
	const cwd = args.cwd ?? process.cwd();
	try {
		const { tbProjectExists, tbProjectKey } = await import("./agiteam-tb-ljENbGJx.js");
		const { agiteamStartFlow } = await import("./agiteam-flow-CU1UfjsK.js");
		if (tbProjectExists(projectId)) return errorResult(`项目 ${projectId} 已存在（key=${tbProjectKey(projectId)}，先查询 agiteam_status 或用其他 projectId）`);
		const rootDir = args.cwd ? `${args.cwd.replace(/\/+$/, "")}/${projectId}` : `${process.cwd().replace(/\/+$/, "")}/${projectId}`;
		const subDirs = [
			"requirements",
			"features",
			"testcases",
			"code",
			"tests",
			"scripts",
			"docs"
		];
		try {
			await mkdir(rootDir, { recursive: true });
			for (const sub of subDirs) await mkdir(`${rootDir}/${sub}`, { recursive: true }).catch(() => {});
		} catch {}
		const result = await agiteamStartFlow(ctx, projectId, args.projectName, args.requirement, void 0, args.kbPath);
		return {
			status: "ok",
			message: `团队开发项目「${args.projectName}」已启动（id: ${projectId}，taskboard 项目 key: ${result.project.key}），当前阶段：需求分析。需求分析师已自动唤醒。${args.kbPath ? `产物将按规范自动落盘团队知识库：${args.kbPath}` : "（未指定 kbPath，产物仅存工程目录）"}`,
			projectId,
			stage: "requirement",
			rootDir,
			taskboardKey: result.project.key,
			task: result.task.identifier,
			...args.kbPath ? { kbPath: args.kbPath } : {}
		};
	} catch (err) {
		const original = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
		try {
			const { openAgiteamDomain, upsertProject, getProject } = await import("./store-CGxi4q_W.js");
			const { autoDriveRuntimeFromCtx, ensureStageTask } = await import("./auto-drive-Dswz7wd8.js");
			const domain = await openAgiteamDomain(ctx);
			if (getProject(domain, projectId)) return errorResult(`项目 ${projectId} 已存在（先查询 agiteam_status 或用其他 projectId）`);
			const now = Date.now();
			const rootDir = args.cwd ? `${args.cwd.replace(/\/+$/, "")}/${projectId}` : `${process.cwd().replace(/\/+$/, "")}/${projectId}`;
			const agentSelf = ctx.agent;
			const project = {
				id: projectId,
				name: args.projectName,
				rawRequirement: args.requirement,
				stage: "requirement",
				completed: {},
				reviewComments: {},
				artifacts: {},
				cwd: rootDir,
				autoDrive: true,
				currentReqId: "",
				requirements: {},
				ownerSession: agentSelf?.session?.id ?? "",
				kbPath: args.kbPath ?? "",
				ownerProvider: agentSelf?.options?.provider ?? "",
				ownerModel: agentSelf?.options?.model ?? "",
				ownerEffort: agentSelf?.options?.reasoningEffort ?? "",
				createdAt: now,
				updatedAt: now
			};
			await upsertProject(domain, project);
			await ensureStageTask(domain, project, "requirement");
			const rt = autoDriveRuntimeFromCtx(ctx, rootDir);
			const { stageGreeting, wakeStageRole } = await import("./auto-drive-Dswz7wd8.js");
			await wakeStageRole(domain, rt, project, "requirement", stageGreeting(project, "requirement", args.requirement));
			return {
				status: "ok",
				message: `团队开发项目「${args.projectName}」已启动（id: ${projectId}，回退模式），当前阶段：需求分析。`,
				projectId,
				stage: "requirement",
				rootDir,
				fallback: true
			};
		} catch (fallbackErr) {
			try {
				const { rt } = buildRuntime(ctx, config, args.cwd);
				const state = await startProject(rt, projectId, args.projectName, args.requirement, cwd);
				return {
					status: "ok",
					message: `团队开发项目「${args.projectName}」已启动（id: ${projectId}，文件系统模式），当前阶段：${STAGE_NAMES.requirement}。`,
					projectId,
					stage: state.stage,
					fallback: true
				};
			} catch (fileErr) {
				const fileDetail = fileErr instanceof Error ? `${fileErr.message}\n${fileErr.stack ?? ""}` : String(fileErr);
				return errorResult(`项目启动失败（taskboard 路径：${original}\nstorageDomain 路径：${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)}\n文件系统路径：${fileDetail}）`);
			}
		}
	}
}
/** 查询项目状态（agiteam_status）—— taskboard 底座优先，回退 storageDomain。 */
async function executeStatus(ctx, config, args) {
	try {
		const { tbProjectExists, tbProjectKey, tbProvider } = await import("./agiteam-tb-ljENbGJx.js");
		const { agiteamProjectView } = await import("./agiteam-flow-CU1UfjsK.js");
		if (tbProjectExists(args.projectId)) {
			const provider = tbProvider();
			const view = agiteamProjectView(args.projectId);
			return {
				status: "ok",
				projectId: args.projectId,
				projectName: provider.getProject(tbProjectKey(args.projectId)).name,
				stage: view.stage,
				stageName: STAGE_NAMES[view.stage] ?? view.stage,
				...view.currentTask ? { currentTask: {
					id: view.currentTask.id,
					title: view.currentTask.title,
					status: view.currentTask.status,
					...view.currentTask.stage ? { stage: view.currentTask.stage } : {},
					version: view.currentTask.version
				} } : {},
				tasks: view.tasks.map((t) => ({
					id: t.id,
					identifier: t.identifier,
					title: t.title,
					status: t.status,
					...t.stage ? { stage: t.stage } : {},
					version: t.version,
					createdAt: t.createdAt
				})),
				taskboard: true
			};
		}
	} catch {}
	try {
		const { openAgiteamDomain, getProject, listTasks, listEntities, listAudit } = await import("./store-CGxi4q_W.js");
		const domain = await openAgiteamDomain(ctx);
		const project = getProject(domain, args.projectId);
		if (!project) return errorResult(`项目 ${args.projectId} 不存在（先 agiteam_start）`);
		const tasks = listTasks(domain, args.projectId);
		const entities = listEntities(domain, args.projectId);
		const audit = listAudit(domain, args.projectId, 50);
		const completed = Object.entries(project.completed).filter(([, v]) => v).map(([k]) => STAGE_NAMES[k] ?? k);
		return {
			status: "ok",
			projectId: project.id,
			projectName: project.name,
			stage: project.stage,
			stageName: STAGE_NAMES[project.stage] ?? project.stage,
			completed,
			reviewComments: project.reviewComments,
			currentReqId: project.currentReqId,
			requirements: Object.keys(project.requirements),
			tasks: tasks.map((t) => ({
				id: t.id,
				stage: t.stage,
				title: t.title,
				role: t.role,
				status: t.status
			})),
			entityCount: entities.length,
			auditCount: audit.length
		};
	} catch (err) {
		const { rt } = buildRuntime(ctx, config, args.cwd);
		const state = await loadState(rt, args.projectId);
		if (!state) return errorResult(`项目 ${args.projectId} 不存在（先 agiteam_start）`);
		return {
			status: "ok",
			projectId: state.projectId,
			projectName: state.projectName,
			stage: state.stage,
			stageName: STAGE_NAMES[state.stage] ?? state.stage,
			completed: Object.entries(state.completed).filter(([, v]) => v).map(([k]) => STAGE_NAMES[k] ?? k),
			reviewComments: state.reviewComments,
			artifacts: state.artifacts
		};
	}
}
/** 推进阶段（agiteam_advance：通过 或 打回）—— DB 版。 */
async function executeAdvance(ctx, config, args) {
	try {
		const { openAgiteamDomain, getProject } = await import("./store-CGxi4q_W.js");
		const { autoDriveRuntimeFromCtx, autoAdvance, reviewDecision } = await import("./auto-drive-Dswz7wd8.js");
		const { isReviewStage } = await import("./stage-6kxWDxZR.js").then((n) => n.a);
		const domain = await openAgiteamDomain(ctx);
		const project = getProject(domain, args.projectId);
		if (!project) return errorResult(`项目 ${args.projectId} 不存在（先 agiteam_start）`);
		const before = project.stage;
		const rt = autoDriveRuntimeFromCtx(ctx, args.cwd ?? project.cwd);
		let updated;
		if (isReviewStage(before)) updated = await reviewDecision(ctx, domain, rt, args.projectId, args.passed, args.comment ?? "");
		else {
			if (!args.passed) return errorResult(`当前阶段「${STAGE_NAMES[before] ?? before}」不是评审阶段，只能通过推进`);
			updated = await autoAdvance(ctx, domain, rt, args.projectId, args.comment ?? "阶段推进");
		}
		const verb = args.passed ? "通过" : "打回";
		return {
			status: "ok",
			message: `阶段「${STAGE_NAMES[before] ?? before}」${verb}，当前阶段：${STAGE_NAMES[updated.stage] ?? updated.stage}。`,
			from: before,
			to: updated.stage,
			passed: args.passed
		};
	} catch (err) {
		const { rt } = buildRuntime(ctx, config, args.cwd);
		const state = await loadState(rt, args.projectId);
		if (!state) return errorResult(`项目 ${args.projectId} 不存在（先 agiteam_start）`);
		const before = state.stage;
		const next = await advanceAndWake(rt, state, args.passed, args.comment);
		const verb = args.passed ? "通过" : "打回";
		return {
			status: "ok",
			message: `阶段「${STAGE_NAMES[before] ?? before}」${verb}，当前阶段：${STAGE_NAMES[next.stage] ?? next.stage}。`,
			from: before,
			to: next.stage,
			passed: args.passed
		};
	}
}
/** 让指定角色 agent 执行一个任务（agiteam_task：分派工作给角色）—— DB 版。 */
async function executeRoleTask(ctx, config, args) {
	try {
		const { openAgiteamDomain, getProject } = await import("./store-CGxi4q_W.js");
		const { autoDriveRuntimeFromCtx } = await import("./auto-drive-Dswz7wd8.js");
		const project = getProject(await openAgiteamDomain(ctx), args.projectId);
		if (!project) return errorResult(`项目 ${args.projectId} 不存在（先 agiteam_start）`);
		const roleName = ROLE_NAMES[args.role] ?? args.role;
		const text = [
			`【dsh-agiteam】项目「${project.name}」分派任务给 ${roleName}：`,
			"",
			args.task
		].join("\n");
		const roleCwd = args.cwd ?? project.cwd;
		const rt = autoDriveRuntimeFromCtx(ctx, roleCwd);
		try {
			await rt.ensureRole(args.projectId, args.role, roleCwd, text, project.currentReqId || void 0, {
				provider: project.ownerProvider,
				model: project.ownerModel,
				effort: project.ownerEffort
			});
		} catch (err) {
			return errorResult(`分派任务给 ${roleName} 失败：角色启动失败（${err instanceof Error ? err.message : String(err)}）。请检查角色 preset/模型配置后重试。`);
		}
		return {
			status: "ok",
			message: `已分派任务给 ${roleName}（${args.role}）。`,
			role: args.role
		};
	} catch (err) {
		const { rt, cwd } = buildRuntime(ctx, config, args.cwd);
		const state = await loadState(rt, args.projectId);
		if (!state) return errorResult(`项目 ${args.projectId} 不存在（先 agiteam_start）`);
		const roleName = ROLE_NAMES[args.role] ?? args.role;
		const text = [
			`【dsh-agiteam】项目「${state.projectName}」分派任务给 ${roleName}：`,
			"",
			args.task
		].join("\n");
		const woken = await rt.wakeRoleAgent(state.projectId, args.role, text);
		if (!woken) await rt.createRoleAgent(state.projectId, args.role, cwd, text);
		return {
			status: "ok",
			message: `已分派任务给 ${roleName}（${args.role}）。`,
			role: args.role,
			woken
		};
	}
}
/** 列出/读取阶段产物（agiteam_artifact：查看需求清单/功能清单/用例矩阵/验收报告）—— DB 版。 */
async function executeReadArtifact(ctx, config, args) {
	try {
		const { openAgiteamDomain, getProject } = await import("./store-CGxi4q_W.js");
		const project = getProject(await openAgiteamDomain(ctx), args.projectId);
		if (!project) return errorResult(`项目 ${args.projectId} 不存在（先 agiteam_start）`);
		const rel = {
			requirements: "requirements/requirements.md",
			features: "features/features.md",
			testcases: "testcases/testcases.md",
			acceptance: "acceptance.md",
			e2e: "e2e.md"
		}[args.artifact];
		if (!rel) return errorResult(`未知产物类型 ${args.artifact}（可选：requirements/features/testcases/acceptance/e2e）`);
		const { rt } = buildRuntime(ctx, config, args.cwd);
		const text = await rt.readText(`${project.cwd.replace(/\/+$/, "")}/${rel}`);
		if (!text) return errorResult(`产物 ${args.artifact} 尚不存在或内容为空`);
		return {
			status: "ok",
			artifact: args.artifact,
			content: text
		};
	} catch (err) {
		const { rt } = buildRuntime(ctx, config, args.cwd);
		const state = await loadState(rt, args.projectId);
		if (!state) return errorResult(`项目 ${args.projectId} 不存在（先 agiteam_start）`);
		const file = state.artifacts[args.artifact];
		if (!file) return errorResult(`产物 ${args.artifact} 尚不存在`);
		const text = await rt.readText(`${state.projectId}/${file}`);
		if (!text) return errorResult(`产物 ${args.artifact} 内容为空`);
		return {
			status: "ok",
			artifact: args.artifact,
			content: text
		};
	}
}
/** 把中文项目名安全化为目录/会话 id。 */
function safeId(name) {
	return name.trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-").replace(/^-+|-+$/g, "") || `project-${Date.now().toString(36)}`;
}
/**
* 登记追溯实体（agiteam_register）—— 角色 agent 每完成一个实体
* （需求/功能/用例/单测/代码/脚本）后调用，写入审计日志（带指纹），
* 成为追溯矩阵与多层校验的数据源。
*
* action 取值：
*  - register-requirement   需求条目（detail: {id, title, priority}）
*  - register-feature      功能条目（detail: {id, name, requirementIds}）
*  - register-testcase     用例条目（detail: {id, featureId, title, kind}）
*  - register-unittest     单测条目（detail: {id, testCaseId, title, filePath, status}）
*  - register-codefile     代码文件（detail: {id, featureId, path}）
*  - register-script       验收脚本（detail: {id, featureId, path, kind}）
*/
async function executeRegister(ctx, config, args) {
	const validActions = [
		"register-requirement",
		"register-feature",
		"register-testcase",
		"register-unittest",
		"register-codefile",
		"register-script"
	];
	if (!validActions.includes(args.action)) return errorResult(`action 必须是：${validActions.join("/")}`);
	let parsed;
	try {
		parsed = JSON.parse(args.detail);
	} catch {
		return errorResult("detail 必须是合法 JSON 字符串");
	}
	try {
		const { openAgiteamDomain, getProject, upsertEntity, appendAuditRecord, lastAudit } = await import("./store-CGxi4q_W.js");
		const { makeAuditEntry } = await import("./audit-CJNju73G.js").then((n) => n.t);
		const domain = await openAgiteamDomain(ctx);
		if (!getProject(domain, args.projectId)) return errorResult(`项目 ${args.projectId} 不存在（先 agiteam_start）`);
		const type = {
			"register-requirement": "requirement",
			"register-feature": "feature",
			"register-testcase": "testcase",
			"register-unittest": "unittest",
			"register-codefile": "codefile",
			"register-script": "script"
		}[args.action];
		const entityId = parsed.id ?? `${type}-${Date.now().toString(36)}`;
		const refs = {};
		const p = parsed;
		if (typeof p.featureId === "string") refs.featureId = p.featureId;
		if (typeof p.testCaseId === "string") refs.testCaseId = p.testCaseId;
		if (Array.isArray(p.requirementIds)) refs.requirementIds = p.requirementIds;
		const now = Date.now();
		await upsertEntity(domain, {
			id: entityId,
			type,
			projectId: args.projectId,
			data: args.detail,
			refs,
			status: p.status === "passed" ? "passed" : "pending",
			createdAt: now,
			updatedAt: now
		});
		const prev = lastAudit(domain, args.projectId);
		const entry = makeAuditEntry(prev ? prev.seq + 1 : 1, {
			time: now,
			action: args.action,
			role: args.role,
			projectId: args.projectId,
			stage: args.stage,
			detail: args.detail
		}, prev ? prev.hash : "GENESIS");
		await appendAuditRecord(domain, entry);
		return {
			status: "ok",
			message: `已登记 ${args.action}（${entityId}），进入数据库与审计日志。`,
			seq: entry.seq,
			hash: entry.hash,
			entityId
		};
	} catch (err) {
		const { rt } = buildRuntime(ctx, config, args.cwd);
		if (!await loadState(rt, args.projectId)) return errorResult(`项目 ${args.projectId} 不存在（先 agiteam_start）`);
		const result = await rt.appendAudit({
			projectId: args.projectId,
			role: args.role,
			stage: args.stage,
			action: args.action,
			detail: args.detail,
			...args.fingerprint ? { fingerprint: args.fingerprint } : {}
		});
		return {
			status: "ok",
			message: `已登记 ${args.action}（seq=${result.seq}，文件系统模式），进入审计日志。`,
			seq: result.seq,
			hash: result.hash
		};
	}
}
/**
* 执行验收脚本（agiteam_run_acceptance）—— 测试验收员运行真实命令，
* 记录运行日志文件 + 登记审计（脚本层/日志层证据）。
*/
async function executeRunAcceptance(ctx, config, args) {
	const { rt, cwd } = buildRuntime(ctx, config, args.cwd);
	if (!await loadState(rt, args.projectId)) return errorResult(`项目 ${args.projectId} 不存在（先 agiteam_start）`);
	if (!args.command) return errorResult("command 必填（要执行的命令）");
	const { runAcceptanceCommand } = await import("./runner-x4pdYKSy.js");
	const run = await runAcceptanceCommand(args.command, args.argsList ?? [], {
		cwd,
		timeoutMs: args.timeoutMs ?? 12e4
	});
	const logRel = `${args.projectId}/logs/${args.scriptId}-${Date.now()}.log`;
	const logContent = [
		`# 验收脚本执行日志：${args.scriptId}`,
		`命令: ${args.command} ${(args.argsList ?? []).join(" ")}`,
		`工作目录: ${cwd}`,
		`退出码: ${run.exitCode}`,
		`耗时: ${run.durationMs}ms`,
		`超时: ${run.timedOut}`,
		"",
		"## stdout",
		run.stdout,
		"",
		"## stderr",
		run.stderr
	].join("\n");
	await rt.writeText(logRel, logContent);
	const passed = run.exitCode === 0 && !run.timedOut;
	const scriptDetail = JSON.stringify({
		id: args.scriptId,
		featureId: args.featureId,
		path: args.path,
		kind: args.kind,
		status: passed ? "passed" : "failed",
		logFile: logRel,
		ranAt: Date.now(),
		exitCode: run.exitCode
	});
	const result = await rt.appendAudit({
		projectId: args.projectId,
		role: args.role,
		stage: args.stage,
		action: "register-script",
		detail: scriptDetail,
		fingerprint: run.exitCode === 0 ? run.stdout.slice(0, 64) : run.stderr.slice(0, 64)
	});
	return {
		status: "ok",
		message: `验收脚本 ${args.scriptId} 执行${passed ? "通过" : "失败"}（退出码 ${run.exitCode}）。`,
		scriptId: args.scriptId,
		passed,
		exitCode: run.exitCode,
		timedOut: run.timedOut,
		durationMs: run.durationMs,
		logFile: logRel,
		outputTail: (passed ? run.stdout : run.stderr).slice(-2e3),
		seq: result.seq,
		hash: result.hash
	};
}
/**
* 阶段完成自动推进（agiteam_done）—— 角色完成当前阶段任务后调用。
* 任务进入 in_review 等待人工审批；你审批放行后才推进到下一阶段。
*/
async function executeAutoDone(ctx, config, args) {
	try {
		const { tbProjectExists, tbCurrentStageTask, tbSubmitStageReview } = await import("./agiteam-tb-ljENbGJx.js");
		if (tbProjectExists(args.projectId)) {
			const current = tbCurrentStageTask(args.projectId);
			if (!current) return errorResult(`项目 ${args.projectId} 当前无进行中任务`);
			const submitted = tbSubmitStageReview(current.id, current.version, args.result, "阶段完成，等待审批");
			return {
				status: "ok",
				message: `任务「${current.title}」已完成，已提交审批（in_review）。请用 agiteam_approve 放行推进，或 agiteam_reject 打回。`,
				projectId: args.projectId,
				taskId: current.id,
				stage: submitted.status,
				awaitingApproval: true
			};
		}
	} catch {}
	const { openAgiteamDomain, getProject } = await import("./store-CGxi4q_W.js");
	const { autoAdvance, autoDriveRuntimeFromCtx } = await import("./auto-drive-Dswz7wd8.js");
	try {
		const domain = await openAgiteamDomain(ctx);
		const project = getProject(domain, args.projectId);
		const advanced = await autoAdvance(ctx, domain, autoDriveRuntimeFromCtx(ctx, args.cwd ?? project?.cwd ?? process.cwd()), args.projectId, args.result);
		const stageName = STAGE_NAMES[advanced.stage] ?? advanced.stage;
		return {
			status: "ok",
			message: `阶段「${stageName}」已完成，任务已提交审批（in_review）。请用 agiteam_approve 放行推进，或 agiteam_reject 打回。`,
			projectId: advanced.id,
			stage: advanced.stage,
			stageName,
			awaitingApproval: true
		};
	} catch (err) {
		return errorResult(`自动推进失败：${err instanceof Error ? err.message : String(err)}`);
	}
}
/**
* 人工审批放行（agiteam_approve）—— 只有你能审批放行。
* in_review → done（taskboard accept），创建下阶段任务并唤醒下角色。
*/
async function executeApprove(ctx, config, args) {
	try {
		const { tbProjectExists, tbCurrentStageTask, tbProjectStage } = await import("./agiteam-tb-ljENbGJx.js");
		const { agiteamApproveFlow } = await import("./agiteam-flow-CU1UfjsK.js");
		if (tbProjectExists(args.projectId)) {
			const current = tbCurrentStageTask(args.projectId);
			if (!current) return errorResult(`项目 ${args.projectId} 当前无待审批任务`);
			const result = await agiteamApproveFlow(ctx, args.projectId, current.id, current.version, current.title.split("·")[0]?.trim() ?? args.projectId, args.comment ?? "");
			const stage = tbProjectStage(args.projectId);
			return {
				status: "ok",
				message: `任务「${current.title}」已审批放行（done）。${result.nextStage ? `已创建下阶段任务：${result.nextStage}，角色已唤醒。` : "项目已交付。"}`,
				projectId: args.projectId,
				taskId: current.id,
				stage,
				...result.nextStage ? { nextStage: result.nextStage } : {}
			};
		}
	} catch {}
	const { openAgiteamDomain, getProject } = await import("./store-CGxi4q_W.js");
	const { approveStage, autoDriveRuntimeFromCtx } = await import("./auto-drive-Dswz7wd8.js");
	try {
		const domain = await openAgiteamDomain(ctx);
		const project = getProject(domain, args.projectId);
		if (!project) return errorResult(`项目 ${args.projectId} 不存在（先 agiteam_start）`);
		const updated = await approveStage(ctx, domain, autoDriveRuntimeFromCtx(ctx, args.cwd ?? project.cwd), args.projectId, args.comment ?? "", args.advance ?? true);
		const stageName = STAGE_NAMES[updated.stage] ?? updated.stage;
		return {
			status: "ok",
			message: `阶段已审批放行，当前阶段：${stageName}。`,
			projectId: updated.id,
			stage: updated.stage,
			stageName
		};
	} catch (err) {
		return errorResult(`审批放行失败：${err instanceof Error ? err.message : String(err)}`);
	}
}
/**
* 人工打回（agiteam_reject）—— 只有你能打回。
* in_review → todo（返工），带意见。
*/
async function executeReject(ctx, config, args) {
	try {
		const { tbProjectExists, tbCurrentStageTask } = await import("./agiteam-tb-ljENbGJx.js");
		const { agiteamRejectFlow } = await import("./agiteam-flow-CU1UfjsK.js");
		if (tbProjectExists(args.projectId)) {
			const current = tbCurrentStageTask(args.projectId);
			if (!current) return errorResult(`项目 ${args.projectId} 当前无进行中任务`);
			const updated = agiteamRejectFlow(args.projectId, current.id, current.version, args.comment);
			return {
				status: "ok",
				message: `任务「${updated.title}」已打回返工（${args.comment}）。`,
				projectId: args.projectId,
				taskId: current.id,
				stage: updated.status
			};
		}
	} catch {}
	const { openAgiteamDomain, getProject } = await import("./store-CGxi4q_W.js");
	const { rejectStage, autoDriveRuntimeFromCtx } = await import("./auto-drive-Dswz7wd8.js");
	try {
		const domain = await openAgiteamDomain(ctx);
		const project = getProject(domain, args.projectId);
		if (!project) return errorResult(`项目 ${args.projectId} 不存在（先 agiteam_start）`);
		const updated = await rejectStage(ctx, domain, autoDriveRuntimeFromCtx(ctx, args.cwd ?? project.cwd), args.projectId, args.comment);
		const stageName = STAGE_NAMES[updated.stage] ?? updated.stage;
		return {
			status: "ok",
			message: `阶段已打回（${args.comment}），返回阶段：${stageName} 返工。`,
			projectId: updated.id,
			stage: updated.stage,
			stageName
		};
	} catch (err) {
		return errorResult(`打回失败：${err instanceof Error ? err.message : String(err)}`);
	}
}
/**
* 人工暂停（agiteam_pause）—— 随时暂停当前阶段（你是魔王）。
* 暂停的任务不会自动推进；恢复用 agiteam_resume。
*/
async function executePause(ctx, config, args) {
	try {
		const { tbProjectExists, tbCurrentStageTask } = await import("./agiteam-tb-ljENbGJx.js");
		const { agiteamPauseFlow } = await import("./agiteam-flow-CU1UfjsK.js");
		if (tbProjectExists(args.projectId)) {
			const current = tbCurrentStageTask(args.projectId);
			if (!current) return errorResult(`项目 ${args.projectId} 当前无进行中任务`);
			await agiteamPauseFlow(args.projectId, current.id, current.version, args.reason);
			return {
				status: "ok",
				message: `任务「${current.title}」已暂停（${args.reason}）。恢复用 agiteam_resume。`,
				projectId: args.projectId,
				taskId: current.id,
				paused: true
			};
		}
	} catch {}
	const { openAgiteamDomain, getProject } = await import("./store-CGxi4q_W.js");
	const { pauseStage } = await import("./auto-drive-Dswz7wd8.js");
	try {
		const domain = await openAgiteamDomain(ctx);
		if (!getProject(domain, args.projectId)) return errorResult(`项目 ${args.projectId} 不存在（先 agiteam_start）`);
		await pauseStage(ctx, domain, args.projectId, args.reason);
		return {
			status: "ok",
			message: `阶段已暂停（${args.reason}）。恢复用 agiteam_resume。`,
			projectId: args.projectId,
			paused: true
		};
	} catch (err) {
		return errorResult(`暂停失败：${err instanceof Error ? err.message : String(err)}`);
	}
}
/**
* 恢复暂停阶段（agiteam_resume）—— 恢复后继续当前阶段。
*/
async function executeResume(ctx, config, args) {
	try {
		const { tbProjectExists, tbCurrentStageTask } = await import("./agiteam-tb-ljENbGJx.js");
		const { agiteamResumeFlow } = await import("./agiteam-flow-CU1UfjsK.js");
		if (tbProjectExists(args.projectId)) {
			const current = tbCurrentStageTask(args.projectId);
			if (!current) return errorResult(`项目 ${args.projectId} 当前无暂停任务`);
			await agiteamResumeFlow(args.projectId, current.id, current.version);
			return {
				status: "ok",
				message: `任务「${current.title}」已恢复。`,
				projectId: args.projectId,
				taskId: current.id,
				resumed: true
			};
		}
	} catch {}
	const { openAgiteamDomain, getProject } = await import("./store-CGxi4q_W.js");
	const { resumeStage, autoDriveRuntimeFromCtx } = await import("./auto-drive-Dswz7wd8.js");
	try {
		const domain = await openAgiteamDomain(ctx);
		const project = getProject(domain, args.projectId);
		if (!project) return errorResult(`项目 ${args.projectId} 不存在（先 agiteam_start）`);
		await resumeStage(ctx, domain, autoDriveRuntimeFromCtx(ctx, args.cwd ?? project.cwd), args.projectId);
		return {
			status: "ok",
			message: "阶段已恢复，角色已唤醒继续。",
			projectId: args.projectId,
			resumed: true
		};
	} catch (err) {
		return errorResult(`恢复失败：${err instanceof Error ? err.message : String(err)}`);
	}
}
/**
* AI 代为审批（agiteam_ai_approve）—— AI 依据验收标准给出审批建议，
* 提交到任务（in_review 或直接建议），但最终放行权在你。
*/
async function executeAiApprove(ctx, config, args) {
	const { openAgiteamDomain, getProject } = await import("./store-CGxi4q_W.js");
	const { aiApproveSuggestion } = await import("./auto-drive-Dswz7wd8.js");
	try {
		const domain = await openAgiteamDomain(ctx);
		if (!getProject(domain, args.projectId)) return errorResult(`项目 ${args.projectId} 不存在（先 agiteam_start）`);
		await aiApproveSuggestion(ctx, domain, args.projectId, args.suggestion, args.approve ?? true);
		return {
			status: "ok",
			message: `AI 审批建议已提交：${args.approve ? "建议放行" : "建议打回"}（${args.suggestion}）。最终决定权在你：agiteam_approve / agiteam_reject。`,
			projectId: args.projectId,
			suggestion: args.suggestion,
			aiApprove: args.approve ?? true
		};
	} catch (err) {
		return errorResult(`AI 审批建议失败：${err instanceof Error ? err.message : String(err)}`);
	}
}
/**
* 任务板列表（agiteam_task_list）—— 查看项目任务板全部任务及状态。
*/
async function executeTaskList(ctx, config, args) {
	const { openAgiteamDomain, getProject, listTasks } = await import("./store-CGxi4q_W.js");
	try {
		const domain = await openAgiteamDomain(ctx);
		if (!getProject(domain, args.projectId)) return errorResult(`项目 ${args.projectId} 不存在（先 agiteam_start）`);
		const tasks = listTasks(domain, args.projectId, args.status);
		return {
			status: "ok",
			projectId: args.projectId,
			tasks: tasks.map((t) => ({
				id: t.id,
				stage: t.stage,
				title: t.title,
				role: t.role,
				status: t.status,
				sessionId: t.sessionId,
				approvalSuggestion: t.approvalSuggestion,
				reviewComment: t.reviewComment,
				pausedByHuman: t.pausedByHuman,
				result: t.result.slice(0, 200),
				updatedAt: t.updatedAt
			}))
		};
	} catch (err) {
		return errorResult(`任务列表失败：${err instanceof Error ? err.message : String(err)}`);
	}
}
/**
* 评审判定（agiteam_review）—— 评审角色判定 通过/打回。
* 通过则自动前进，打回则带意见返回上一阶段。
*/
async function executeReview(ctx, config, args) {
	const { openAgiteamDomain, getProject } = await import("./store-CGxi4q_W.js");
	const { reviewDecision, autoDriveRuntimeFromCtx } = await import("./auto-drive-Dswz7wd8.js");
	try {
		const domain = await openAgiteamDomain(ctx);
		const project = getProject(domain, args.projectId);
		const updated = await reviewDecision(ctx, domain, autoDriveRuntimeFromCtx(ctx, args.cwd ?? project?.cwd ?? process.cwd()), args.projectId, args.passed, args.comment ?? "");
		const stageName = STAGE_NAMES[updated.stage] ?? updated.stage;
		return {
			status: "ok",
			message: `评审${args.passed ? "通过" : "打回"}，当前阶段：${stageName}。`,
			projectId: updated.id,
			stage: updated.stage,
			stageName,
			passed: args.passed
		};
	} catch (err) {
		return errorResult(`评审判定失败：${err instanceof Error ? err.message : String(err)}`);
	}
}
/**
* 项目内新建需求（agiteam_new_requirement）—— 每次对话 = 一个需求。
* 在已有项目内新建需求，自动进入该需求的需求分析（阶段会话）。
*/
async function executeNewRequirement(ctx, config, args) {
	try {
		const { openAgiteamDomain, getProject, upsertProject } = await import("./store-CGxi4q_W.js");
		const { autoDriveRuntimeFromCtx } = await import("./auto-drive-Dswz7wd8.js");
		const domain = await openAgiteamDomain(ctx);
		const project = getProject(domain, args.projectId);
		if (!project) return errorResult(`项目 ${args.projectId} 不存在（先 agiteam_start）`);
		const reqId = `R-${Object.keys(project.requirements ?? {}).length + 1}`;
		const title = args.title ?? `需求 ${reqId}`;
		const rt = autoDriveRuntimeFromCtx(ctx, project.cwd);
		const { stageGreeting } = await import("./auto-drive-Dswz7wd8.js");
		const greeting = stageGreeting(project, "requirement", `【新需求 ${reqId}】${title}\n${args.requirement}`);
		try {
			await rt.ensureRole(args.projectId, "requirement", project.cwd, greeting, reqId, {
				provider: project.ownerProvider,
				model: project.ownerModel,
				effort: project.ownerEffort
			});
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);
			console.error(`[dsh-agiteam] 新需求角色启动失败，需求未登记（project=${args.projectId}, reqId=${reqId}）:\n${detail}`);
			return errorResult(`新需求 ${reqId} 创建失败：需求分析师角色启动失败（${detail}）。请检查角色 preset/模型配置后重试。`);
		}
		const now = Date.now();
		await upsertProject(domain, {
			...project,
			rawRequirement: args.requirement,
			stage: "requirement",
			currentReqId: reqId,
			requirements: {
				...project.requirements,
				[reqId]: title
			},
			artifacts: {
				...project.artifacts,
				[`requirement-${reqId}`]: `${reqId}`
			},
			updatedAt: now
		});
		return {
			status: "ok",
			message: `项目「${project.name}」内新建需求 ${reqId}「${title}」，已进入需求分析（需求分析师已唤醒）。`,
			projectId: args.projectId,
			requirementId: reqId,
			title
		};
	} catch (err) {
		return errorResult(`新建需求失败：${err instanceof Error ? err.message : String(err)}`);
	}
}
/**
* 主管分派执行者（agiteam_assign）—— 给 taskboard 任务指派执行智能体。
*
* 我是主管：任务批准（todo）后，由主管决定谁来执行——写入任务 source.executorPreset，
* coordinator 扫描时启动对应 preset 的 agent。executor 取值：
*  - 内置角色：requirement/product/developer/tester/architect（agiteam-* preset）
*  - 通用工作：code（PTC 模式，含标准能力）
*  - 其他已装 preset id
* dependsOn（可选）：任务 id 数组。传入后自动给【每个前置任务】→【本任务】建
* blocks 关系（前置 tasks blocks 目标任务），coordinator 会等到前置 done 才认领执行
* ——实现"单测必须在代码写完后"这类顺序编排（与 taskboard UI 详情页 relations 等价）。
*/
async function executeAssign(ctx, config, args) {
	try {
		const { loadTaskboard } = await import("./taskboard-bridge-D3dMqFx9.js").then((n) => n.c);
		const { DatabaseSync } = await import("node:sqlite");
		const presetId = [
			"code",
			"requirement",
			"product",
			"developer",
			"tester",
			"architect",
			"req-reviewer",
			"prod-reviewer",
			"test-designer",
			"supervisor"
		].includes(args.executor) ? `agiteam-${args.executor}`.replace("agiteam-code", "code") : args.executor;
		const db = new DatabaseSync("/home/as-workstation01/.dsh/profiles/web/.dsh/taskboard.sqlite");
		const task = db.prepare("SELECT id, source_json, version, project_id FROM tasks WHERE id = ? OR identifier = ?").get(args.taskId, args.taskId);
		if (!task) {
			db.close();
			return errorResult(`任务 ${args.taskId} 不存在（taskboard）`);
		}
		const source = task.source_json ? JSON.parse(task.source_json) : {};
		source.executorPreset = presetId;
		source.executorAssignedAt = Date.now();
		db.prepare("UPDATE tasks SET source_json = ?, version = version + 1, updated_at = ? WHERE id = ?").run(JSON.stringify(source), Date.now(), task.id);
		const commentId = `comment-${Date.now().toString(36)}`;
		db.prepare(`INSERT INTO comments(id, task_id, body, author_id, session_id, version, created_at, updated_at)
      VALUES (?, ?, ?, 'human:supervisor', NULL, 1, ?, ?)`).run(commentId, task.id, `主管分派：由 ${presetId} 执行${args.note ? `。说明：${args.note}` : ""}`, Date.now(), Date.now());
		const dependencyTargets = [];
		for (const dependency of args.dependsOn ?? []) {
			const dep = db.prepare("SELECT id, identifier, status, version FROM tasks WHERE id = ? OR identifier = ?").get(dependency, dependency);
			if (!dep) {
				db.close();
				return errorResult(`dependsOn 任务 ${dependency} 不存在（先创建它）`);
			}
			if (dep.id === task.id) {
				db.close();
				return errorResult(`dependsOn 不能依赖自身（${args.taskId}）`);
			}
			dependencyTargets.push({
				id: dep.id,
				version: dep.version
			});
		}
		db.close();
		if (dependencyTargets.length > 0) {
			const { tbAddDependency } = await import("./agiteam-tb-ljENbGJx.js");
			for (const dep of dependencyTargets) tbAddDependency(dep.id, dep.version, task.id);
		}
		return {
			status: "ok",
			message: `已分派执行者 ${presetId} 执行任务 ${args.taskId}（coordinator 将自动启动该 agent）${dependencyTargets.length > 0 ? `。已建 ${dependencyTargets.length} 条前置依赖（blocks），前置完成前不会执行` : ""}。`,
			taskId: args.taskId,
			executor: presetId,
			...dependencyTargets.length > 0 ? { dependsOn: dependencyTargets.map((item) => item.id) } : {}
		};
	} catch (err) {
		return errorResult(`分派失败：${err instanceof Error ? err.message : String(err)}`);
	}
}
//#endregion
//#region src/features/qoder-runner.ts
/**
* Qoder CLI 执行器 —— 以非交互模式（-p/--print）运行 qodercli 完成一次任务。
*
* 为什么独立成砖块：Qoder 是外部 CLI 智能体，通过子进程调用，
* 环境敏感逻辑（spawn/超时/有界输出）集中在这里，业务层只描述
* "让 Qoder 在哪个目录做什么"。
*
* 调用形态（已实测可用）：
*   qodercli -p --permission-mode bypass_permissions --cwd <dir> "<任务指令>"
*/
const DEFAULT_TIMEOUT_MS = 6e5;
const DEFAULT_MAX_OUTPUT = 128 * 1024;
/** 有界捕获一个流（头尾保留、中间截断）。 */
function captureStream(stream, maxBytes) {
	if (stream === null) return Promise.resolve("");
	const head = [];
	const tail = [];
	let headLen = 0;
	let tailLen = 0;
	let sawOverflow = false;
	return new Promise((resolve, reject) => {
		stream.on("data", (chunk) => {
			const len = chunk.length;
			if (headLen + len <= maxBytes) {
				head.push(chunk);
				headLen += len;
			} else {
				sawOverflow = true;
				const remaining = maxBytes - tailLen;
				if (remaining > 0) {
					const slice = len > remaining ? chunk.subarray(len - remaining) : chunk;
					tail.push(slice);
					tailLen += slice.length;
					if (tailLen > maxBytes) tail.shift();
				}
			}
		});
		stream.on("error", reject);
		stream.on("close", () => {
			let text = "";
			if (headLen > 0 || tailLen > 0) text = (sawOverflow ? Buffer.concat([
				...head,
				Buffer.from("\n…<truncated>…\n"),
				...tail
			]) : Buffer.concat(head)).toString("utf8");
			resolve(text);
		});
	});
}
/**
* 运行一次 Qoder 非交互任务直到结束（带超时与有界输出）。
* 非零退出不抛错，由调用方检查 exitCode / stderr 判定成败。
* @param task 任务指令（完整 prompt，Qoder 将按它执行）
* @param options 工作目录/超时/模型等
*/
async function runQoderTask(task, options) {
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const maxBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
	const started = performance.now();
	const args = [
		"-p",
		"--permission-mode",
		"bypass_permissions"
	];
	if (options.model) args.push("--model", options.model);
	args.push("--cwd", options.cwd, task);
	const child = spawn("qodercli", args, {
		cwd: options.cwd,
		env: process.env,
		stdio: [
			"ignore",
			"pipe",
			"pipe"
		]
	});
	let timedOut = false;
	let killed = false;
	let spawnError;
	let settled = false;
	let settleExit = () => {};
	const timer = setTimeout(() => {
		timedOut = true;
		killed = true;
		child.kill("SIGKILL");
		if (!settled) {
			settled = true;
			settleExit(null);
		}
	}, timeoutMs);
	const exitCodeP = new Promise((resolve) => {
		settleExit = resolve;
		child.on("error", (error) => {
			spawnError = `${error.code ?? "spawn"}: ${error.message}`;
			if (!settled) {
				settled = true;
				resolve(killed ? null : -1);
			}
		});
		child.on("close", (code) => {
			if (!settled) {
				settled = true;
				resolve(code);
			}
		});
	});
	const [stdout, stderr] = await Promise.all([captureStream(child.stdout, maxBytes), captureStream(child.stderr, maxBytes)]);
	const exitCode = await exitCodeP;
	clearTimeout(timer);
	return {
		exitCode,
		stdout,
		stderr: `${stderr}${spawnError !== void 0 ? `\n${spawnError}` : ""}`,
		durationMs: Math.round(performance.now() - started),
		timedOut
	};
}
//#endregion
//#region src/business/qoder.ts
/**
* 指挥 Qoder CLI 执行一次任务。
* @param ctx 插件上下文
* @param config 插件配置
* @param args 任务参数
* @returns 执行结果（含 Qoder 输出摘要与审计 seq）
*/
async function executeQoderTask(ctx, config, args) {
	let projectCwd = args.cwd;
	try {
		const { openAgiteamDomain, getProject } = await import("./store-CGxi4q_W.js");
		const project = getProject(await openAgiteamDomain(ctx), args.projectId);
		if (project && project.cwd) projectCwd = project.cwd;
	} catch {}
	const cwd = projectCwd ?? process.cwd();
	if (!args.task || args.task.trim().length === 0) return {
		status: "error",
		message: "task 必填（Qoder 要执行的任务指令）"
	};
	const run = await runQoderTask(args.task, {
		cwd,
		...args.timeoutMs !== void 0 ? { timeoutMs: args.timeoutMs } : {},
		...args.model !== void 0 ? { model: args.model } : {}
	});
	let seq;
	let hash;
	try {
		const { openAgiteamDomain, appendAuditRecord, lastAudit } = await import("./store-CGxi4q_W.js");
		const { makeAuditEntry } = await import("./audit-CJNju73G.js").then((n) => n.t);
		const domain = await openAgiteamDomain(ctx);
		const prev = lastAudit(domain, args.projectId);
		const entry = makeAuditEntry(prev ? prev.seq + 1 : 1, {
			time: Date.now(),
			action: "qoder-task",
			role: "qoder",
			projectId: args.projectId,
			stage: "",
			detail: JSON.stringify({
				task: args.task.slice(0, 200),
				exitCode: run.exitCode,
				timedOut: run.timedOut,
				durationMs: run.durationMs
			}),
			fingerprint: run.exitCode === 0 ? run.stdout.slice(0, 64) : run.stderr.slice(0, 64)
		}, prev ? prev.hash : "GENESIS");
		await appendAuditRecord(domain, entry);
		seq = entry.seq;
		hash = entry.hash;
	} catch {}
	const passed = run.exitCode === 0 && !run.timedOut;
	const output = (passed ? run.stdout : run.stderr).trim();
	return {
		status: passed ? "ok" : "error",
		message: `Qoder 任务${passed ? "完成" : `失败（退出码 ${run.exitCode}${run.timedOut ? "，超时" : ""}）`}，耗时 ${(run.durationMs / 1e3).toFixed(1)}s。`,
		projectId: args.projectId,
		passed,
		exitCode: run.exitCode,
		timedOut: run.timedOut,
		durationMs: run.durationMs,
		outputTail: output.slice(-4e3),
		...seq !== void 0 && hash !== void 0 ? {
			seq,
			hash
		} : {}
	};
}
//#endregion
//#region src/features/trace.ts
/**
* 组装追溯矩阵：每个功能一行，聚合其需求、用例、单测、代码、验收脚本。
* @returns 按功能编号排序的追溯行。
*/
function buildTraceRows(requirements, features, testcases, unitTests, codeFiles, scripts) {
	const reqById = new Map(requirements.map((r) => [r.id, r]));
	const rows = [];
	for (const feature of features) {
		const reqIds = feature.requirementIds.length > 0 ? feature.requirementIds : ["-"];
		const featureCases = testcases.filter((t) => t.featureId === feature.id);
		const caseIds = featureCases.map((t) => t.id);
		const featureUnitTests = unitTests.filter((u) => featureCases.some((tc) => tc.id === u.testCaseId));
		const unitTestIds = featureUnitTests.map((u) => u.id);
		const featureCodeFiles = codeFiles.filter((cf) => cf.featureId === feature.id);
		const featureScripts = scripts.filter((s) => s.featureId === feature.id);
		let status = "pending";
		if (featureCases.length > 0 && featureUnitTests.length > 0 && featureScripts.length > 0) status = featureScripts.every((s) => s.status === "passed") && featureUnitTests.every((u) => u.status === "passed") ? "passed" : "failed";
		for (const reqId of reqIds) {
			const req = reqById.get(reqId);
			rows.push({
				requirementId: reqId,
				requirementTitle: req?.title ?? "（未关联需求）",
				featureId: feature.id,
				featureName: feature.name,
				testCaseIds: caseIds,
				unitTestIds,
				codeFiles: featureCodeFiles.map((cf) => cf.path),
				acceptanceScripts: featureScripts.map((s) => s.path),
				status
			});
		}
	}
	return rows.sort((a, b) => a.featureId.localeCompare(b.featureId, void 0, { numeric: true }));
}
/** 追溯矩阵是否全部通过。 */
function traceAllPassed(rows) {
	return rows.length > 0 && rows.every((r) => r.status === "passed");
}
//#endregion
//#region src/features/verify.ts
/** 空结果。 */
function emptyResult() {
	return {
		mathPass: true,
		scriptPass: true,
		logPass: true,
		allPass: true,
		details: []
	};
}
/**
* 多层校验一个项目的追溯链。
* @param requirements 需求清单
* @param features 产品功能清单
* @param testcases 测试用例
* @param unitTests 单元测试
* @param codeFiles 代码文件
* @param scripts 验收脚本
* @param auditEntries 审计日志
* @param fileExists 文件存在性检查（脚本层）
* @param fileHasContent 文件有内容检查（日志层）
*/
async function verifyProject(requirements, features, testcases, unitTests, codeFiles, scripts, auditEntries, fileExists, fileHasContent) {
	const result = emptyResult();
	const details = [];
	new Set(requirements.map((r) => r.id));
	new Set(features.flatMap((f) => f.requirementIds));
	for (const req of requirements) if (!features.some((f) => f.requirementIds.includes(req.id))) {
		result.mathPass = false;
		details.push(`需求 ${req.id} 没有对应产品功能（数学层）`);
	}
	new Set(features.map((f) => f.id));
	new Set(testcases.map((t) => t.featureId));
	for (const f of features) if (!testcases.some((t) => t.featureId === f.id)) {
		result.mathPass = false;
		details.push(`功能 ${f.id} 没有对应测试用例（数学层）`);
	}
	new Set(testcases.map((t) => t.id));
	for (const tc of testcases) if (!unitTests.some((u) => u.testCaseId === tc.id)) {
		result.mathPass = false;
		details.push(`用例 ${tc.id} 没有对应单元测试（数学层）`);
	}
	for (const f of features) if (!codeFiles.some((cf) => cf.featureId === f.id)) {
		result.mathPass = false;
		details.push(`功能 ${f.id} 没有对应代码文件（数学层）`);
	}
	for (const f of features) if (!scripts.some((s) => s.featureId === f.id)) {
		result.mathPass = false;
		details.push(`功能 ${f.id} 没有对应验收脚本（数学层）`);
	}
	const passedUnitTests = unitTests.filter((u) => u.status === "passed").length;
	const coveredCases = new Set(unitTests.map((u) => u.testCaseId)).size;
	if (passedUnitTests < coveredCases) {
		result.mathPass = false;
		details.push(`单测通过数 ${passedUnitTests} < 用例覆盖数 ${coveredCases}（数学层）`);
	}
	for (const script of scripts) {
		if (script.status !== "passed") {
			result.scriptPass = false;
			details.push(`验收脚本 ${script.id} 未通过（状态 ${script.status}）（脚本层）`);
			continue;
		}
		if (!await fileExists(script.path)) {
			result.scriptPass = false;
			details.push(`验收脚本 ${script.id} 文件不存在：${script.path}（脚本层）`);
		}
		if (!script.ranAt) {
			result.scriptPass = false;
			details.push(`验收脚本 ${script.id} 无最近运行记录（脚本层）`);
		}
	}
	const brokenAt = verifyAuditChain(auditEntries);
	if (brokenAt >= 0) {
		result.logPass = false;
		details.push(`审计日志链在 seq=${auditEntries[brokenAt]?.seq} 处断裂（日志层）`);
	}
	for (const script of scripts) {
		if (!script.logFile) {
			result.logPass = false;
			details.push(`验收脚本 ${script.id} 无运行日志文件（日志层）`);
			continue;
		}
		if (!await fileHasContent(script.logFile)) {
			result.logPass = false;
			details.push(`验收脚本 ${script.id} 日志文件为空或不存在：${script.logFile}（日志层）`);
		}
	}
	result.allPass = result.mathPass && result.scriptPass && result.logPass;
	if (result.allPass) details.push("三层校验全部通过（数学对账 ✓ 脚本存在 ✓ 日志链完整 ✓）");
	result.details = details;
	return result;
}
//#endregion
//#region src/business/web.ts
/** 项目状态文件名（与 engine 一致）。 */
const AUDIT_FILE = "audit.jsonl";
/** 读取请求体（JSON）。 */
function readBody(req) {
	return new Promise((resolve) => {
		let body = "";
		req.on("data", (chunk) => {
			body += chunk.toString("utf8");
		});
		req.on("end", () => resolve(body));
		req.on("error", () => resolve(""));
	});
}
/** JSON 响应助手。 */
function json(res, code, body) {
	res.writeHead(code, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store"
	});
	res.end(JSON.stringify(body));
}
/**
* 构建一个项目的完整追溯快照（面板数据源）。
* @returns TraceState 或 null（项目不存在）。
*/
async function buildTraceSnapshot(rt, projectId) {
	const state = await loadState(rt, projectId);
	if (!state) return null;
	state.artifacts.requirements && await rt.readText(`${projectId}/${state.artifacts.requirements}`);
	state.artifacts.features && await rt.readText(`${projectId}/${state.artifacts.features}`);
	state.artifacts.testcases && await rt.readText(`${projectId}/${state.artifacts.testcases}`);
	const auditText = await rt.readText(`${projectId}/${AUDIT_FILE}`);
	const auditEntries = auditText ? parseAuditLog(auditText) : [];
	const requirements = extractFromAudit(auditEntries, "register-requirement", "detail").map((d, i) => ({
		id: d.id ?? `R-${i + 1}`,
		title: d.title ?? `需求 ${i + 1}`,
		detail: "",
		priority: "P1",
		acceptance: ""
	}));
	const features = extractFromAudit(auditEntries, "register-feature", "detail").map((d, i) => ({
		id: d.id ?? `F-${i + 1}`,
		name: d.name ?? `功能 ${i + 1}`,
		requirementIds: d.requirementIds ?? [],
		description: "",
		userFlow: ""
	}));
	const testcases = extractFromAudit(auditEntries, "register-testcase", "detail").map((d, i) => ({
		id: d.id ?? `TC-${i + 1}`,
		featureId: d.featureId ?? "",
		title: d.title ?? `用例 ${i + 1}`,
		preconditions: "",
		steps: [],
		expected: "",
		kind: "api"
	}));
	const unitTests = extractFromAudit(auditEntries, "register-unittest", "detail").map((d, i) => ({
		id: d.id ?? `UT-${i + 1}`,
		testCaseId: d.testCaseId ?? "",
		title: d.title ?? `单测 ${i + 1}`,
		filePath: d.filePath ?? "",
		status: d.status === "passed" ? "passed" : "pending"
	}));
	const codeFiles = extractFromAudit(auditEntries, "register-codefile", "detail").map((d, i) => ({
		id: d.id ?? `CF-${i + 1}`,
		featureId: d.featureId ?? "",
		path: d.path ?? "",
		sha256: sha256Hex(d.path ?? ""),
		updatedAt: Date.now(),
		lines: 0
	}));
	const scriptRaw = extractFromAudit(auditEntries, "register-script", "detail");
	const scriptById = /* @__PURE__ */ new Map();
	for (const d of scriptRaw) {
		const key = d.id ?? "";
		scriptById.set(key, d);
	}
	const acceptanceScripts = [...scriptById.values()].map((d, i) => ({
		id: d.id ?? `AS-${i + 1}`,
		featureId: d.featureId ?? "",
		path: d.path ?? "",
		kind: d.kind === "api" || d.kind === "ui" ? d.kind : "script",
		status: d.status === "passed" ? "passed" : "pending",
		...d.logFile ? { logFile: d.logFile } : {},
		...d.ranAt ? { ranAt: d.ranAt } : {},
		...d.exitCode !== void 0 && d.exitCode !== null ? { exitCode: d.exitCode } : {}
	}));
	const traceRows = buildTraceRows(requirements, features, testcases, unitTests, codeFiles, acceptanceScripts);
	const verification = await verifyProject(requirements, features, testcases, unitTests, codeFiles, acceptanceScripts, auditEntries, async (path) => rt.exists(path), async (path) => await rt.readText(path) !== void 0);
	return {
		projectId: state.projectId,
		projectName: state.projectName,
		stage: state.stage,
		requirements,
		features,
		testcases,
		unitTests,
		codeFiles,
		acceptanceScripts,
		traceRows,
		auditLog: auditEntries.slice(-200),
		verification: {
			mathPass: verification.mathPass,
			scriptPass: verification.scriptPass,
			logPass: verification.logPass,
			details: verification.details
		},
		reviewComments: state.reviewComments,
		updatedAt: state.updatedAt
	};
}
/** 从审计动作 detail 提取 JSON 实体（宽容解析：坏行跳过）。 */
function extractFromAudit(entries, action, _field) {
	const out = [];
	for (const e of entries) {
		if (e.action !== action) continue;
		try {
			out.push(JSON.parse(e.detail));
		} catch {}
	}
	return out;
}
/**
* 注册 web 路由（懒注册：webServer 服务晚加载时正常注册，
* 无 webServer 的 headless 环境仍可启动内核）。
*/
function registerWebSurface(ctx, config, getRuntime) {
	ctx.inject(["webServer"], (injectedCtx) => {
		const webCtx = injectedCtx;
		const webServer = webCtx.webServer;
		webCtx.effect(() => webServer.register({
			kind: "exact",
			path: "/plugins/agiteam/state",
			handler: async (req, res) => {
				try {
					const projectId = new URL(req.url ?? "", "http://x").searchParams.get("project") ?? "";
					const rt = getRuntime();
					if (projectId) {
						let snapshot = null;
						try {
							snapshot = await buildDbSnapshot(webCtx, projectId);
						} catch {
							snapshot = null;
						}
						if (!snapshot) snapshot = await buildTraceSnapshot(rt, projectId);
						if (!snapshot) return json(res, 404, { error: `项目 ${projectId} 不存在` });
						return json(res, 200, snapshot);
					}
					let projects = [];
					try {
						projects = await listDbProjects(webCtx);
					} catch {
						projects = [];
					}
					if (projects.length === 0) {
						const dirs = await rt.listDir("");
						for (const dir of dirs) {
							const state = await loadState(rt, dir);
							if (state) projects.push({
								projectId: state.projectId,
								projectName: state.projectName,
								stage: state.stage
							});
						}
					}
					return json(res, 200, { projects });
				} catch (err) {
					return json(res, 500, { error: err instanceof Error ? err.message : String(err) });
				}
			}
		}), "dsh-agiteam: state route");
		webCtx.effect(() => webServer.register({
			kind: "exact",
			path: "/plugins/agiteam/audit",
			handler: async (req, res) => {
				const body = await readBody(req);
				let payload;
				try {
					payload = JSON.parse(body);
				} catch {
					return json(res, 400, { error: "请求体必须是 JSON" });
				}
				if (!payload.projectId || !payload.action || !payload.role) return json(res, 400, { error: "projectId/action/role 必填" });
				try {
					const rt = getRuntime();
					const auditText = await rt.readText(`${payload.projectId}/${AUDIT_FILE}`);
					const entries = auditText ? parseAuditLog(auditText) : [];
					const prevHash = entries.length > 0 ? entries[entries.length - 1].hash : "GENESIS";
					const entry = makeAuditEntry(entries.length + 1, {
						time: Date.now(),
						action: payload.action,
						role: payload.role,
						projectId: payload.projectId,
						stage: payload.stage ?? "",
						detail: payload.detail,
						...payload.fingerprint ? { fingerprint: payload.fingerprint } : {}
					}, prevHash);
					const nextText = auditText ? `${auditText}\n${JSON.stringify(entry)}` : JSON.stringify(entry);
					await rt.writeText(`${payload.projectId}/${AUDIT_FILE}`, nextText);
					return json(res, 200, {
						ok: true,
						seq: entry.seq,
						hash: entry.hash
					});
				} catch (err) {
					return json(res, 500, { error: err instanceof Error ? err.message : String(err) });
				}
			}
		}), "dsh-agiteam: audit route");
		webCtx.effect(() => webServer.register({
			kind: "exact",
			path: "/plugins/agiteam/verify",
			handler: async (req, res) => {
				try {
					const projectId = new URL(req.url ?? "", "http://x").searchParams.get("project") ?? "";
					if (!projectId) return json(res, 400, { error: "project 必填" });
					const snapshot = await buildTraceSnapshot(getRuntime(), projectId);
					if (!snapshot) return json(res, 404, { error: `项目 ${projectId} 不存在` });
					return json(res, 200, {
						verification: snapshot.verification,
						traceAllPassed: traceAllPassed(snapshot.traceRows)
					});
				} catch (err) {
					return json(res, 500, { error: err instanceof Error ? err.message : String(err) });
				}
			}
		}), "dsh-agiteam: verify route");
		webCtx.effect(() => webServer.register({
			kind: "exact",
			path: "/plugins/agiteam/tasks",
			handler: async (req, res) => {
				try {
					const projectId = new URL(req.url ?? "", "http://x").searchParams.get("project") ?? "";
					if (!projectId) return json(res, 400, { error: "project 必填" });
					const snapshot = await buildBoardSnapshot(webCtx, projectId);
					if (!snapshot) return json(res, 404, { error: `项目 ${projectId} 不存在` });
					return json(res, 200, snapshot);
				} catch (err) {
					return json(res, 500, { error: err instanceof Error ? err.message : String(err) });
				}
			}
		}), "dsh-agiteam: tasks route");
	});
}
/**
* 从数据库构建项目追溯快照（面板数据源，替代文件系统）。
* @returns TraceState 或 null（项目不存在）。
*/
async function buildDbSnapshot(ctx, projectId) {
	const { openAgiteamDomain, getProject, listEntities, listAudit } = await import("./store-CGxi4q_W.js");
	const domain = await openAgiteamDomain(ctx);
	const project = getProject(domain, projectId);
	if (!project) return null;
	const requirements = listEntities(domain, projectId, "requirement").map((e) => JSON.parse(e.data));
	const features = listEntities(domain, projectId, "feature").map((e) => JSON.parse(e.data));
	const testcases = listEntities(domain, projectId, "testcase").map((e) => JSON.parse(e.data));
	const unitTests = listEntities(domain, projectId, "unittest").map((e) => JSON.parse(e.data));
	const codeFiles = listEntities(domain, projectId, "codefile").map((e) => JSON.parse(e.data));
	const acceptanceScripts = listEntities(domain, projectId, "script").map((e) => JSON.parse(e.data));
	const auditEntries = listAudit(domain, projectId, 200).map((a) => ({
		seq: a.seq,
		time: a.time,
		action: a.action,
		role: a.role,
		projectId: a.projectId,
		stage: a.stage,
		detail: a.detail,
		...a.fingerprint ? { fingerprint: a.fingerprint } : {},
		prevHash: a.prevHash,
		hash: a.hash
	}));
	const traceRows = buildTraceRows(requirements, features, testcases, unitTests, codeFiles, acceptanceScripts);
	const verification = await verifyProject(requirements, features, testcases, unitTests, codeFiles, acceptanceScripts, auditEntries, async (path) => {
		try {
			return await rtExists(ctx, project.cwd, path);
		} catch {
			return false;
		}
	}, async (path) => {
		try {
			return await rtRead(ctx, project.cwd, path) !== void 0;
		} catch {
			return false;
		}
	});
	return {
		projectId: project.id,
		projectName: project.name,
		stage: project.stage,
		requirements,
		features,
		testcases,
		unitTests,
		codeFiles,
		acceptanceScripts,
		traceRows,
		auditLog: auditEntries,
		verification: {
			mathPass: verification.mathPass,
			scriptPass: verification.scriptPass,
			logPass: verification.logPass,
			details: verification.details
		},
		reviewComments: project.reviewComments,
		updatedAt: project.updatedAt
	};
}
/** 读取项目 cwd 下相对路径的文件（用于脚本层校验）。dsh-fs 契约：resolve → readText(target)。 */
async function rtRead(ctx, cwd, rel) {
	const fs = ctx.get("fs");
	if (!fs) return void 0;
	try {
		const target = await fs.resolve(`${cwd.replace(/\/+$/, "")}/${rel.replace(/^\/+/, "")}`);
		return await fs.readText(target);
	} catch {
		return;
	}
}
/** 判断项目 cwd 下相对路径是否存在。 */
async function rtExists(ctx, cwd, rel) {
	const fs = ctx.get("fs");
	if (!fs) return false;
	try {
		const target = await fs.resolve(`${cwd.replace(/\/+$/, "")}/${rel.replace(/^\/+/, "")}`);
		return await fs.stat(target) !== void 0;
	} catch {
		return false;
	}
}
/** 列出数据库中的全部项目（面板项目列表）。 */
async function listDbProjects(ctx) {
	const { openAgiteamDomain, listProjects } = await import("./store-CGxi4q_W.js");
	return listProjects(await openAgiteamDomain(ctx)).map((p) => ({
		projectId: p.id,
		projectName: p.name,
		stage: p.stage
	}));
}
/** 从数据库构建任务板快照（面板数据源）。 */
async function buildBoardSnapshot(ctx, projectId) {
	const { openAgiteamDomain, getProject, listTasks } = await import("./store-CGxi4q_W.js");
	const domain = await openAgiteamDomain(ctx);
	const project = getProject(domain, projectId);
	if (!project) return null;
	const tasks = listTasks(domain, projectId).map((t) => ({
		id: t.id,
		stage: t.stage,
		title: t.title,
		role: t.role,
		status: t.status,
		sessionId: t.sessionId,
		approvalSuggestion: t.approvalSuggestion,
		reviewComment: t.reviewComment,
		pausedByHuman: t.pausedByHuman,
		pauseReason: t.pauseReason,
		result: t.result,
		updatedAt: t.updatedAt
	}));
	return {
		projectId: project.id,
		projectName: project.name,
		stage: project.stage,
		tasks
	};
}
//#endregion
//#region src/index.ts
/** 插件标识，同时作为 Cordis 入口名与注入来源标签。 */
const name = "dsh-agiteam";
const inject = ["tools"];
/** Schemastery 配置模式。 */
const Config = Schema.object({
	artifactsDir: Schema.string().default(".teamdev"),
	injectGuidance: Schema.boolean().default(true),
	taskboardDatabasePath: Schema.string().default(""),
	taskboardAttachmentRoot: Schema.string().default("")
});
/** 折叠进首个 agent step 的团队流程引导。 */
const TEAM_GUIDANCE = [
	"【dsh-agiteam】本会话具备 AGI 团队开发引擎（agiteam_* 工具），采用「项目制 + 需求制 + 阶段会话 + 项目记忆」工程化管理：",
	"1. 项目制：agiteam_start 创建项目（工程根目录 + requirements/features/testcases/code/tests/scripts/docs 子目录 + 数据库项目记录）。项目是工程单位，不是散乱会话。",
	"2. 需求制：每次对话 = 一个需求。agiteam_new_requirement 在项目内新建需求（自动编号 R-N），走完整流程：需求分析 → 需求确认(评审) → 需求执行(落实到产品功能点) → 开发 → 验收。",
	"3. 阶段会话：每个需求×阶段用专属会话（session-<项目>-<需求>-<阶段>），AI 在该会话完成对应阶段；出问题可续聊或开新会话（带项目记忆，避免历史错误误导）。",
	"4. 项目记忆：同一项目内所有需求的上下文/决策/踩坑按记忆规则共享（cerebrate project_id=<项目名>），换会话也能继续。",
	"流程：需求分析(需求清单) → 需求评审 → 产品设计(产品功能清单) → 产品评审 → 测试用例设计(用例矩阵) → 测试用例评审 → 正式开发(每功能点+单测) → 逐功能验收(单测+API+脚本) → 端到端验收 → 交付。",
	"用法：agiteam_start（建项目，可传 kbPath 指定团队知识库路径，产物自动落盘 Obsidian）→ agiteam_new_requirement（项目内新建需求）→ 角色自动接力（agiteam_done 推进 / agiteam_review 评审）→ agiteam_status（查状态）→ agiteam_artifact（读产物）。",
	"追溯登记（每完成一个实体必须登记）：agiteam_register 登记需求/功能/用例/单测/代码/验收脚本；agiteam_run_acceptance 执行验收脚本（真实命令）并记录日志。",
	"每个阶段由对应角色子 agent 执行；评审阶段（需求评审/产品评审/用例评审）自动判定 通过/打回，打回带意见回到上一阶段返工。",
	"知识库落盘：项目配置 kbPath 后，阶段产物按规范自动写入团队知识库（需求清单.md/产品方案.md/测试用例.md/验收报告.md/评审记录.md）；角色完成后自动通知发起会话继续指挥。"
].join("\n");
/** 本包注入消息的来源插件标签。 */
const PLUGIN_TAG = "dsh-agiteam";
/** 角色枚举（工具参数用）。 */
const ROLE_ENUM = Object.keys(ROLE_NAMES);
/** 引导消息是否已存在于会话可见面。 */
function guidanceAlreadyInjected(agent) {
	return agent.session.surface.nodes.some((seq) => {
		const event = agent.session.eventAt(seq);
		return event?.type === "user/message" && event.data.source.kind === "plugin" && event.data.source.plugin === PLUGIN_TAG;
	});
}
/** 把工具返回值以美化 JSON 文本呈现给模型。 */
function renderJson(_args, value) {
	return [{
		type: "text",
		text: JSON.stringify(value, null, 2)
	}];
}
/** agiteam 工具的通用 UI 卡片。 */
function presentCall(title, args) {
	return {
		card: "generic",
		title,
		kind: "other",
		rawInput: args
	};
}
/**
* 注册 `agiteam_*` 工具集，并按配置在首个 agent step 注入团队流程引导。
* 每个工具的 execute 委托给 business 层顶层函数（可独立测试）。
* @param ctx - 携带工具注册表的注册上下文。
* @param config - 插件配置。
*/
async function apply(ctx, config) {
	const toolConfig = {
		artifactsDir: config.artifactsDir,
		injectGuidance: config.injectGuidance
	};
	try {
		(await import(pathToFileURL(createRequire(import.meta.url).resolve("../lib/taskboard-host/index.js")).href)).apply(ctx, {
			databasePath: config.taskboardDatabasePath || "/home/as-workstation01/.dsh/profiles/web/.dsh/taskboard.sqlite",
			attachmentRoot: config.taskboardAttachmentRoot || "/home/as-workstation01/.dsh/profiles/web/.dsh/taskboard-attachments"
		});
		ensureDefaultAutomationRules();
	} catch (err) {
		const detail = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
		console.error(`[dsh-agiteam] taskboard 底座注册失败（将使用回退存储）:\n${detail}`);
	}
	const tools = {
		start: defineTool({
			name: "agiteam_start",
			description: "【启动团队开发项目】输入项目名与原始需求，启动完整 AGI 团队开发流程（需求分析→评审→产品→用例→开发→验收）。返回项目 id 与当前阶段。kbPath 可选：团队知识库相对路径（团队知识库/<项目>/<需求大类>/<具体需求>/），产物会自动按规范落盘 Obsidian。",
			parameters: {
				projectName: {
					type: "string",
					required: true,
					description: "项目/需求名称"
				},
				requirement: {
					type: "string",
					required: true,
					description: "原始需求描述（完整内容）"
				},
				projectId: {
					type: "string",
					description: "可选：自定义项目 id（默认由项目名生成）"
				},
				cwd: {
					type: "string",
					description: "可选：项目工作目录（默认当前目录）"
				},
				kbPath: {
					type: "string",
					description: "可选：团队知识库相对路径（如 IHM2-无息贷款/日志服务/无息贷款操作日志服务），产物自动落盘 Obsidian"
				}
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: true
				},
				render: renderJson
			},
			execute: (args) => executeStartProject(ctx, toolConfig, args),
			presentCall: (args) => presentCall("启动团队开发项目", args)
		}),
		status: defineTool({
			name: "agiteam_status",
			description: "【查询团队开发项目状态】返回项目当前阶段、已完成阶段、评审意见与产物清单。",
			parameters: {
				projectId: {
					type: "string",
					required: true,
					description: "项目 id"
				},
				cwd: {
					type: "string",
					description: "可选：项目工作目录（默认当前目录）"
				}
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: true
				},
				render: renderJson
			},
			execute: (args) => executeStatus(ctx, toolConfig, args),
			presentCall: (args) => presentCall("查询项目状态", args)
		}),
		advance: defineTool({
			name: "agiteam_advance",
			description: "【推进阶段/评审门禁】当前阶段完成后调用：passed=true 进入下一阶段；评审阶段 passed=false 打回上一阶段返工（可附评审意见）。",
			parameters: {
				projectId: {
					type: "string",
					required: true,
					description: "项目 id"
				},
				passed: {
					type: "boolean",
					required: true,
					description: "是否通过（评审门禁：true=通过放行，false=打回返工）"
				},
				comment: {
					type: "string",
					description: "可选：评审意见/打回原因"
				},
				cwd: {
					type: "string",
					description: "可选：项目工作目录（默认当前目录）"
				}
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: true
				},
				render: renderJson
			},
			execute: (args) => executeAdvance(ctx, toolConfig, args),
			presentCall: (args) => presentCall("推进阶段", args)
		}),
		task: defineTool({
			name: "agiteam_task",
			description: "【分派角色任务】向指定角色子 agent 分派一项具体任务（如\"请产出需求清单\"）。角色：" + ROLE_ENUM.join("/"),
			parameters: {
				projectId: {
					type: "string",
					required: true,
					description: "项目 id"
				},
				role: {
					type: "string",
					required: true,
					enum: ROLE_ENUM,
					description: "目标角色"
				},
				task: {
					type: "string",
					required: true,
					description: "任务内容（完整指令）"
				},
				cwd: {
					type: "string",
					description: "可选：项目工作目录（默认当前目录）"
				}
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: true
				},
				render: renderJson
			},
			execute: (args) => executeRoleTask(ctx, toolConfig, args),
			presentCall: (args) => presentCall("分派角色任务", args)
		}),
		qoder: defineTool({
			name: "agiteam_qoder",
			description: "【指挥 Qoder CLI 干活】把 Qoder（独立 CLI 智能体）作为可指挥角色：在项目工作目录用非交互模式执行任务（代码审查/测试编写/文档生成等）。返回 Qoder 输出与退出码。model 可选指定 Qoder 模型（如 Qwen3.8-Max），缺省用其默认模型。",
			parameters: {
				projectId: {
					type: "string",
					required: true,
					description: "项目 id（工作目录 = 项目 cwd）"
				},
				task: {
					type: "string",
					required: true,
					description: "任务指令（完整 prompt，Qoder 按它执行）"
				},
				model: {
					type: "string",
					description: "可选：指定 Qoder 模型（如 Qwen3.8-Max/Qwen3.8-Flash/Kimi-K2.7-Code）"
				},
				cwd: {
					type: "string",
					description: "可选：覆盖工作目录（默认项目 cwd）"
				},
				timeoutMs: {
					type: "number",
					description: "可选：超时毫秒（默认 600000=10 分钟）"
				}
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: true
				},
				render: renderJson
			},
			execute: (args) => executeQoderTask(ctx, toolConfig, args),
			presentCall: (args) => presentCall("指挥 Qoder 干活", args)
		}),
		artifact: defineTool({
			name: "agiteam_artifact",
			description: "【读取阶段产物】读取需求清单/产品功能清单/测试用例矩阵/验收报告等阶段产物全文。artifact 取值：requirements/features/testcases/acceptance/e2e。",
			parameters: {
				projectId: {
					type: "string",
					required: true,
					description: "项目 id"
				},
				artifact: {
					type: "string",
					required: true,
					enum: [
						"requirements",
						"features",
						"testcases",
						"acceptance",
						"e2e"
					],
					description: "产物名"
				},
				cwd: {
					type: "string",
					description: "可选：项目工作目录（默认当前目录）"
				}
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: true
				},
				render: renderJson
			},
			execute: (args) => executeReadArtifact(ctx, toolConfig, args),
			presentCall: (args) => presentCall("读取阶段产物", args)
		}),
		register: defineTool({
			name: "agiteam_register",
			description: "【登记追溯实体】角色 agent 每完成一个实体（需求/功能/用例/单测/代码/脚本）后调用，写入审计日志（带指纹），成为追溯矩阵与多层校验的数据源。action 取值：register-requirement（需求）/register-feature（功能）/register-testcase（用例）/register-unittest（单测）/register-codefile（代码）/register-script（脚本）。detail 为实体 JSON。",
			parameters: {
				projectId: {
					type: "string",
					required: true,
					description: "项目 id"
				},
				role: {
					type: "string",
					required: true,
					description: "执行角色（requirement/product/test-designer/developer/tester 等）"
				},
				stage: {
					type: "string",
					required: true,
					description: "当前阶段（requirement/product/testcase/develop/feature-accept 等）"
				},
				action: {
					type: "string",
					required: true,
					enum: [
						"register-requirement",
						"register-feature",
						"register-testcase",
						"register-unittest",
						"register-codefile",
						"register-script"
					],
					description: "登记动作类型"
				},
				detail: {
					type: "string",
					required: true,
					description: "实体 JSON（如 {\"id\":\"F-1\",\"name\":\"登录\",\"requirementIds\":[\"R-1\"]}）"
				},
				fingerprint: {
					type: "string",
					description: "可选：数据指纹（如文件 sha256），用于审计校验"
				},
				cwd: {
					type: "string",
					description: "可选：项目工作目录（默认当前目录）"
				}
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: true
				},
				render: renderJson
			},
			execute: (args) => executeRegister(ctx, toolConfig, args),
			presentCall: (args) => presentCall("登记追溯实体", args)
		}),
		runAcceptance: defineTool({
			name: "agiteam_run_acceptance",
			description: "【执行验收脚本】测试验收员运行真实命令（API 模拟请求/自动化脚本），记录运行日志文件 + 登记审计（脚本层/日志层证据）。返回退出码/耗时/日志路径。",
			parameters: {
				projectId: {
					type: "string",
					required: true,
					description: "项目 id"
				},
				role: {
					type: "string",
					required: true,
					description: "执行角色（tester）"
				},
				stage: {
					type: "string",
					required: true,
					description: "当前阶段（feature-accept/e2e-accept）"
				},
				scriptId: {
					type: "string",
					required: true,
					description: "验收脚本编号（AS-1 等）"
				},
				featureId: {
					type: "string",
					required: true,
					description: "关联功能编号（F-1 等）"
				},
				path: {
					type: "string",
					required: true,
					description: "脚本相对路径（如 scripts/accept-login.sh）"
				},
				kind: {
					type: "string",
					required: true,
					enum: [
						"api",
						"ui",
						"script"
					],
					description: "脚本类型"
				},
				command: {
					type: "string",
					required: true,
					description: "要执行的完整命令（如 curl ... 或 node scripts/e2e.mjs）"
				},
				argsList: {
					type: "array",
					items: { type: "string" },
					description: "命令参数列表"
				},
				timeoutMs: {
					type: "integer",
					description: "超时毫秒（默认 120000）"
				},
				cwd: {
					type: "string",
					description: "可选：项目工作目录（默认当前目录）"
				}
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: true
				},
				render: renderJson
			},
			execute: (args) => executeRunAcceptance(ctx, toolConfig, args),
			presentCall: (args) => presentCall("执行验收脚本", args)
		}),
		done: defineTool({
			name: "agiteam_done",
			description: "【阶段完成自动推进】角色完成当前阶段任务后调用，自动推进到下一阶段并唤醒下一角色（全自动驱动，无需手动 advance）。",
			parameters: {
				projectId: {
					type: "string",
					required: true,
					description: "项目 id"
				},
				result: {
					type: "string",
					required: true,
					description: "完成结果描述（产物路径/结论）"
				},
				cwd: {
					type: "string",
					description: "可选：项目工作目录（默认当前目录）"
				}
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: true
				},
				render: renderJson
			},
			execute: (args) => executeAutoDone(ctx, toolConfig, args),
			presentCall: (args) => presentCall("阶段完成自动推进", args)
		}),
		newRequirement: defineTool({
			name: "agiteam_new_requirement",
			description: "【项目内新建需求】在已有项目内新建一个需求（每次对话 = 一个需求），自动进入该需求的需求分析（阶段会话）。",
			parameters: {
				projectId: {
					type: "string",
					required: true,
					description: "项目 id"
				},
				requirement: {
					type: "string",
					required: true,
					description: "需求描述（完整内容）"
				},
				title: {
					type: "string",
					description: "可选：需求标题（默认 需求 R-N）"
				},
				cwd: {
					type: "string",
					description: "可选：项目工作目录（默认当前目录）"
				}
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: true
				},
				render: renderJson
			},
			execute: (args) => executeNewRequirement(ctx, toolConfig, args),
			presentCall: (args) => presentCall("项目内新建需求", args)
		}),
		review: defineTool({
			name: "agiteam_review",
			description: "【评审判定】评审角色判定 通过/打回：passed=true 自动前进到下一阶段；passed=false 带意见打回上一阶段返工。",
			parameters: {
				projectId: {
					type: "string",
					required: true,
					description: "项目 id"
				},
				passed: {
					type: "boolean",
					required: true,
					description: "是否通过评审"
				},
				comment: {
					type: "string",
					description: "评审意见（打回时必填原因）"
				},
				cwd: {
					type: "string",
					description: "可选：项目工作目录（默认当前目录）"
				}
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: true
				},
				render: renderJson
			},
			execute: (args) => executeReview(ctx, toolConfig, args),
			presentCall: (args) => presentCall("评审判定", args)
		}),
		approve: defineTool({
			name: "agiteam_approve",
			description: "【人工审批放行】你是唯一审批人：任务提交 in_review 后，approve 放行并推进到下一阶段。可附审批意见。",
			parameters: {
				projectId: {
					type: "string",
					required: true,
					description: "项目 id"
				},
				comment: {
					type: "string",
					description: "可选：审批意见"
				},
				advance: {
					type: "boolean",
					description: "是否立即推进下一阶段（默认 true）"
				},
				cwd: {
					type: "string",
					description: "可选：项目工作目录（默认当前目录）"
				}
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: true
				},
				render: renderJson
			},
			execute: (args) => executeApprove(ctx, toolConfig, args),
			presentCall: (args) => presentCall("人工审批放行", args)
		}),
		reject: defineTool({
			name: "agiteam_reject",
			description: "【人工打回】你是唯一审批人：打回任务并带意见返回上一阶段（或当前阶段）返工。",
			parameters: {
				projectId: {
					type: "string",
					required: true,
					description: "项目 id"
				},
				comment: {
					type: "string",
					required: true,
					description: "打回原因（必填）"
				},
				cwd: {
					type: "string",
					description: "可选：项目工作目录（默认当前目录）"
				}
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: true
				},
				render: renderJson
			},
			execute: (args) => executeReject(ctx, toolConfig, args),
			presentCall: (args) => presentCall("人工打回", args)
		}),
		pause: defineTool({
			name: "agiteam_pause",
			description: "【暂停任务】随时暂停当前阶段任务（你是魔王）。暂停的任务不会自动推进；恢复用 agiteam_resume。",
			parameters: {
				projectId: {
					type: "string",
					required: true,
					description: "项目 id"
				},
				reason: {
					type: "string",
					required: true,
					description: "暂停原因（必填）"
				},
				cwd: {
					type: "string",
					description: "可选：项目工作目录（默认当前目录）"
				}
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: true
				},
				render: renderJson
			},
			execute: (args) => executePause(ctx, toolConfig, args),
			presentCall: (args) => presentCall("暂停任务", args)
		}),
		resume: defineTool({
			name: "agiteam_resume",
			description: "【恢复任务】恢复暂停的任务，角色继续当前阶段工作。",
			parameters: {
				projectId: {
					type: "string",
					required: true,
					description: "项目 id"
				},
				cwd: {
					type: "string",
					description: "可选：项目工作目录（默认当前目录）"
				}
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: true
				},
				render: renderJson
			},
			execute: (args) => executeResume(ctx, toolConfig, args),
			presentCall: (args) => presentCall("恢复任务", args)
		}),
		aiApprove: defineTool({
			name: "agiteam_ai_approve",
			description: "【AI 代为审批】AI 依据验收标准给出审批建议（建议放行/打回），提交到任务。最终放行权在你：agiteam_approve / agiteam_reject。",
			parameters: {
				projectId: {
					type: "string",
					required: true,
					description: "项目 id"
				},
				suggestion: {
					type: "string",
					required: true,
					description: "AI 审批建议（依据/结论）"
				},
				approve: {
					type: "boolean",
					description: "AI 建议：true=放行，false=打回（默认 true）"
				},
				cwd: {
					type: "string",
					description: "可选：项目工作目录（默认当前目录）"
				}
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: true
				},
				render: renderJson
			},
			execute: (args) => executeAiApprove(ctx, toolConfig, args),
			presentCall: (args) => presentCall("AI 代为审批", args)
		}),
		assign: defineTool({
			name: "agiteam_assign",
			description: "【主管分派执行者】给 taskboard 任务指派执行智能体（写入任务 source.executorPreset，coordinator 自动启动该 agent 执行）。executor 可选：code（通用）/requirement/product/developer/tester/architect 等角色，或任意已装 preset id。dependsOn 可选：前置任务 id 数组（先完成的任务），自动建 blocks 依赖——顺序编排如\"单测必须在代码写完后\"。",
			parameters: {
				taskId: {
					type: "string",
					required: true,
					description: "任务 id（taskboard 的 task id 或 identifier 如 MF-2）"
				},
				executor: {
					type: "string",
					required: true,
					description: "执行者 preset：code/requirement/product/developer/tester/architect/req-reviewer/prod-reviewer/test-designer/supervisor"
				},
				note: {
					type: "string",
					description: "可选：分派说明"
				},
				dependsOn: {
					type: "array",
					items: { type: "string" },
					description: "可选：前置任务 id/identifier 数组（如 [\"MF-1\"]，表示 MF-1 完成后才执行本任务）"
				}
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: true
				},
				render: renderJson
			},
			execute: (args) => executeAssign(ctx, toolConfig, args),
			presentCall: (args) => presentCall("主管分派执行者", args)
		}),
		taskList: defineTool({
			name: "agiteam_task_list",
			description: "【任务板列表】查看项目任务板全部任务及状态（含审批状态/会话/审批建议）。",
			parameters: {
				projectId: {
					type: "string",
					required: true,
					description: "项目 id"
				},
				status: {
					type: "string",
					description: "可选：按状态过滤（open/claimed/in_progress/in_review/paused/done/failed/rejected）"
				},
				cwd: {
					type: "string",
					description: "可选：项目工作目录（默认当前目录）"
				}
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: true
				},
				render: renderJson
			},
			execute: (args) => executeTaskList(ctx, toolConfig, args),
			presentCall: (args) => presentCall("任务板列表", args)
		})
	};
	for (const tool of Object.values(tools)) ctx.tools.register(tool);
	registerWebSurface(ctx, toolConfig, () => runtimeFromCtx(ctx, process.cwd()));
	ctx.effect(async () => {
		const { openAgiteamDomain } = await import("./store-CGxi4q_W.js");
		const domain = await openAgiteamDomain(ctx);
		return () => {
			domain.handle.close();
		};
	}, "dsh-agiteam: storage domain");
	if (config.injectGuidance) ctx.on("agent/pre-step", async ({ agent, messages, step, signal }, next) => {
		const decision = await next();
		if (decision.kind === "reject" || step === 1 && decision.messages.length === 0) return decision;
		if (guidanceAlreadyInjected(agent)) return decision;
		signal.throwIfAborted();
		const guidance = createUserMessage({
			content: [{
				type: "text",
				text: TEAM_GUIDANCE
			}],
			source: {
				kind: "plugin",
				plugin: PLUGIN_TAG,
				form: "instructions"
			}
		});
		const lastClaimedIndex = decision.messages.findLastIndex((message) => messages.includes(message));
		return {
			kind: "enter",
			messages: decision.messages.toSpliced(lastClaimedIndex + 1, 0, guidance)
		};
	});
}
/**
* 为 taskboard 所有项目 ensure 默认自动化规则（enabled，幂等）。
*
* 为什么必要：taskboard 的自动化执行（coordinator 扫描 todo → claim → 启动 agent）
* 依赖 automation_rules 里有 enabled 规则。用户在 UI 创建/批准任务后，若无规则，
* 任务永远卡在 todo（"批准执行没反应"）。本函数给每个缺规则的项目补一条默认规则：
*  - agentPreset: 'code'（本机已装的通用工作 preset，含标准模式全部能力，
*    能读 Obsidian/执行任务；taskboard 默认的 'standard' 本机未安装）
*  - intervalMs: 15000（15 秒扫描一次 todo）
*  - 已有规则的项目跳过（尊重用户自定义）
*
* 直接写 SQLite（provider 的 createAutomation 要求 human actor 且 state=paused，
* 需要再 enable；SQL 一步到位且幂等）。
*/
async function ensureDefaultAutomationRules() {
	try {
		const { DatabaseSync } = await import("node:sqlite");
		const db = new DatabaseSync("/home/as-workstation01/.dsh/profiles/web/.dsh/taskboard.sqlite");
		const projects = db.prepare("SELECT id FROM projects").all();
		const now = Date.now();
		let added = 0;
		for (const project of projects) {
			const existing = db.prepare("SELECT id, config_json FROM automation_rules WHERE project_id = ?").all(project.id);
			for (const rule of existing) {
				const cfg = JSON.parse(rule.config_json);
				if (cfg.agentPreset === "standard") {
					cfg.agentPreset = "code";
					db.prepare("UPDATE automation_rules SET config_json = ?, version = version + 1, updated_at = ? WHERE id = ?").run(JSON.stringify(cfg), Date.now(), rule.id);
					console.error(`[dsh-agiteam] 规则 ${rule.id.slice(0, 20)} preset standard → code（本机无 standard）`);
				}
			}
			if ((db.prepare("SELECT count(*) c FROM automation_rules WHERE project_id = ?").get(project.id)?.c ?? 0) > 0) continue;
			const config = JSON.stringify({
				intervalMs: 15e3,
				agentPreset: "code",
				concurrencyLimit: 1,
				quotaPolicy: "ignore",
				autoPauseOnEmpty: false
			});
			db.prepare(`INSERT INTO automation_rules(id, project_id, config_json, state, version, last_decision_json, next_eligible_at, created_at, updated_at)
         VALUES (?, ?, ?, 'enabled', 1, NULL, ?, ?, ?)`).run(`automation-default-${project.id}`, project.id, config, now, now, now);
			added += 1;
		}
		db.close();
		if (added > 0) console.error(`[dsh-agiteam] 已为 ${added} 个项目补默认自动化规则（任务批准后自动执行）`);
	} catch (err) {
		console.error(`[dsh-agiteam] 默认自动化规则 ensure 失败: ${err instanceof Error ? err.message : String(err)}`);
	}
}
//#endregion
export { Config, apply, inject, name };
