import { createRequire } from "node:module";
import { statSync } from "node:fs";
import { resolve } from "node:path";
//#region \0rolldown/runtime.js
var __commonJSMin = (cb, mod) => () => (mod || (cb((mod = { exports: {} }).exports, mod), cb = null), mod.exports);
var __require = /* @__PURE__ */ createRequire(import.meta.url);
//#endregion
//#region ../../../deepseek-harness/vendor/cosmokit/lib/index.js
/** Return true when a value is `null` or `undefined`. */
function isNullable(value) {
	return value === null || value === void 0;
}
/** Return true for non-array object values. */
function isPlainObject(data) {
	return data && typeof data === "object" && !Array.isArray(data);
}
/** Filter object entries and return a new object. */
function filterKeys(object, filter) {
	return Object.fromEntries(Object.entries(object).filter(([key, value]) => filter(key, value)));
}
/** Map object values while preserving the original key set. */
function mapValues(object, transform) {
	return Object.fromEntries(Object.entries(object).map(([key, value]) => [key, transform(value, key)]));
}
/** Pick selected keys from an object, optionally including `undefined` values. */
function pick(source, keys, forced) {
	if (!keys) return { ...source };
	const result = {};
	for (const key of keys) if (forced || source[key] !== void 0) result[key] = source[key];
	return result;
}
/** Define a non-enumerable writable property and return the object. */
function defineProperty(object, key, value) {
	return Object.defineProperty(object, key, {
		writable: true,
		value,
		enumerable: false
	});
}
/** Shared config references used by schema validators and plugin runtimes. */
const write = Symbol.for("cosmokit.volatile.write");
function snapshot(value, ancestors = /* @__PURE__ */ new Set()) {
	if (typeof value === "function") throw new TypeError("volatile config cannot contain functions");
	if (value === null || typeof value !== "object") return value;
	if (ancestors.has(value)) throw new TypeError("volatile config cannot contain cycles");
	ancestors.add(value);
	try {
		if (Array.isArray(value)) return Object.freeze(value.map((item) => snapshot(item, ancestors)));
		if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new TypeError("volatile config objects must be plain objects or arrays");
		return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, snapshot(item, ancestors)])));
	} finally {
		ancestors.delete(value);
	}
}
/**
* Create a detached reference containing an immutable copy of the supplied data.
* @param value - validated config data; class instances and functions are unsupported.
* @returns a reference whose value is updated only by its owning runtime.
*/
function createVolatile(value) {
	let current = snapshot(value);
	return Object.freeze({
		get: () => current,
		[write]: (value) => {
			current = value;
		}
	});
}
/**
* Identify references across ESM/CJS copies of the shared library.
* @param value - a parsed config value.
* @returns whether the value implements the shared reference protocol.
*/
function isVolatile(value) {
	return typeof value === "object" && value !== null && write in value;
}
/** Test values using `instanceof` with a `toStringTag` fallback. */
function is(type, value) {
	if (arguments.length === 1) return (value) => is(type, value);
	return type in globalThis && value instanceof globalThis[type] || Object.prototype.toString.call(value).slice(8, -1) === type;
}
function isArrayBufferLike(value) {
	return is("ArrayBuffer", value) || is("SharedArrayBuffer", value);
}
function isArrayBufferSource(value) {
	return isArrayBufferLike(value) || ArrayBuffer.isView(value);
}
/** Binary source detection and base64/hex conversion helpers. */
var Binary;
(function(Binary) {
	Binary.is = isArrayBufferLike;
	Binary.isSource = isArrayBufferSource;
	function fromSource(source) {
		if (ArrayBuffer.isView(source)) return source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
		else return source;
	}
	Binary.fromSource = fromSource;
	function toBase64(source) {
		source = fromSource(source);
		if (typeof Buffer !== "undefined") return Buffer.from(source).toString("base64");
		let binary = "";
		const bytes = new Uint8Array(source);
		for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
		return btoa(binary);
	}
	Binary.toBase64 = toBase64;
	function fromBase64(source) {
		if (typeof Buffer !== "undefined") return fromSource(Buffer.from(source, "base64"));
		return Uint8Array.from(atob(source), (c) => c.charCodeAt(0));
	}
	Binary.fromBase64 = fromBase64;
	function toHex(source) {
		source = fromSource(source);
		if (typeof Buffer !== "undefined") return Buffer.from(source).toString("hex");
		return Array.from(new Uint8Array(source), (byte) => byte.toString(16).padStart(2, "0")).join("");
	}
	Binary.toHex = toHex;
	function fromHex(source) {
		if (typeof Buffer !== "undefined") return fromSource(Buffer.from(source, "hex"));
		const hex = source.length % 2 === 0 ? source : source.slice(0, source.length - 1);
		const buffer = [];
		for (let i = 0; i < hex.length; i += 2) buffer.push(parseInt(`${hex[i]}${hex[i + 1]}`, 16));
		return Uint8Array.from(buffer).buffer;
	}
	Binary.fromHex = fromHex;
})(Binary || (Binary = {}));
Binary.fromBase64;
Binary.toBase64;
Binary.fromHex;
Binary.toHex;
/** Deep-clone common JavaScript values while preserving prototypes and cycles. */
function clone(source, refs = /* @__PURE__ */ new Map()) {
	if (!source || typeof source !== "object") return source;
	if (is("Date", source)) return new Date(source.valueOf());
	if (is("RegExp", source)) return new RegExp(source.source, source.flags);
	if (isArrayBufferLike(source)) return source.slice(0);
	if (ArrayBuffer.isView(source)) return source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
	const cached = refs.get(source);
	if (cached) return cached;
	if (Array.isArray(source)) {
		const result = [];
		refs.set(source, result);
		source.forEach((value, index) => {
			result[index] = Reflect.apply(clone, null, [value, refs]);
		});
		return result;
	}
	const result = Object.create(Object.getPrototypeOf(source));
	refs.set(source, result);
	for (const key of Reflect.ownKeys(source)) {
		const descriptor = { ...Reflect.getOwnPropertyDescriptor(source, key) };
		if ("value" in descriptor) descriptor.value = Reflect.apply(clone, null, [descriptor.value, refs]);
		Reflect.defineProperty(result, key, descriptor);
	}
	return result;
}
/**
* Compare values recursively, treating two volatile references as equal regardless of value.
* Strict comparison distinguishes null/undefined, treats opaque objects by identity,
* compares URLs by normalized href, treats array holes as undefined, and considers distinct cyclic structures unequal.
* @param a - first value.
* @param b - second value.
* @param strict - whether to require strict data equality outside volatile references.
* @returns whether the values compare equal.
*/
function deepEqual(a, b, strict) {
	const ancestors = /* @__PURE__ */ new Set();
	function compare(a, b) {
		if (a === b) return true;
		if (isVolatile(a) || isVolatile(b)) return isVolatile(a) && isVolatile(b);
		if (!strict && isNullable(a) && isNullable(b)) return true;
		if (typeof a !== typeof b || typeof a !== "object" || !a || !b) return false;
		if (ancestors.has(a)) return false;
		function check(test, then) {
			return test(a) ? test(b) ? then(a, b) : false : test(b) ? false : void 0;
		}
		ancestors.add(a);
		try {
			return check(Array.isArray, (a, b) => {
				if (a.length !== b.length) return false;
				for (let index = 0; index < a.length; index++) if (!compare(a[index], b[index])) return false;
				return true;
			}) ?? check(is("Date"), (a, b) => a.valueOf() === b.valueOf()) ?? check(is("URL"), (a, b) => a.href === b.href) ?? check(is("RegExp"), (a, b) => a.source === b.source && a.flags === b.flags) ?? check(isArrayBufferLike, (a, b) => {
				if (a.byteLength !== b.byteLength) return false;
				const viewA = new Uint8Array(a);
				const viewB = new Uint8Array(b);
				for (let i = 0; i < viewA.length; i++) if (viewA[i] !== viewB[i]) return false;
				return true;
			}) ?? ((!strict || [a, b].every((value) => Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) && Object.keys({
				...a,
				...b
			}).every((key) => compare(a[key], b[key])));
		} finally {
			ancestors.delete(a);
		}
	}
	return compare(a, b);
}
function tokenize(source, delimiters, delimiter) {
	const output = [];
	let state = 0;
	for (let i = 0; i < source.length; i++) {
		const code = source.charCodeAt(i);
		if (code >= 65 && code <= 90) {
			if (state === 1) {
				const next = source.charCodeAt(i + 1);
				if (next >= 97 && next <= 122) output.push(delimiter);
				output.push(code + 32);
			} else {
				if (state !== 0) output.push(delimiter);
				output.push(code + 32);
			}
			state = 1;
		} else if (code >= 97 && code <= 122) {
			output.push(code);
			state = 2;
		} else if (delimiters.includes(code)) {
			if (state !== 0) output.push(delimiter);
			state = 0;
		} else output.push(code);
	}
	return String.fromCharCode(...output);
}
/** Convert text to dash-delimited parameter case. */
function paramCase(source) {
	return tokenize(source, [45, 95], 45);
}
/** Runtime alias for `paramCase`. */
const hyphenate = paramCase;
/** Time constants plus parsing and formatting helpers. */
var Time;
(function(Time) {
	Time.millisecond = 1;
	Time.second = 1e3;
	Time.minute = Time.second * 60;
	Time.hour = Time.minute * 60;
	Time.day = Time.hour * 24;
	Time.week = Time.day * 7;
	let timezoneOffset = (/* @__PURE__ */ new Date()).getTimezoneOffset();
	function setTimezoneOffset(offset) {
		timezoneOffset = offset;
	}
	Time.setTimezoneOffset = setTimezoneOffset;
	function getTimezoneOffset() {
		return timezoneOffset;
	}
	Time.getTimezoneOffset = getTimezoneOffset;
	function getDateNumber(date = /* @__PURE__ */ new Date(), offset) {
		if (typeof date === "number") date = new Date(date);
		if (offset === void 0) offset = timezoneOffset;
		return Math.floor((date.valueOf() / Time.minute - offset) / 1440);
	}
	Time.getDateNumber = getDateNumber;
	function fromDateNumber(value, offset) {
		const date = new Date(value * Time.day);
		if (offset === void 0) offset = timezoneOffset;
		return new Date(+date + offset * Time.minute);
	}
	Time.fromDateNumber = fromDateNumber;
	const numeric = /\d+(?:\.\d+)?/.source;
	const timeRegExp = new RegExp(`^${[
		"w(?:eek(?:s)?)?",
		"d(?:ay(?:s)?)?",
		"h(?:our(?:s)?)?",
		"m(?:in(?:ute)?(?:s)?)?",
		"s(?:ec(?:ond)?(?:s)?)?"
	].map((unit) => `(${numeric}${unit})?`).join("")}$`);
	function parseTime(source) {
		const capture = timeRegExp.exec(source);
		if (!capture) return 0;
		return (parseFloat(capture[1]) * Time.week || 0) + (parseFloat(capture[2]) * Time.day || 0) + (parseFloat(capture[3]) * Time.hour || 0) + (parseFloat(capture[4]) * Time.minute || 0) + (parseFloat(capture[5]) * Time.second || 0);
	}
	Time.parseTime = parseTime;
	function parseDate(date) {
		const parsed = parseTime(date);
		if (parsed) date = Date.now() + parsed;
		else if (/^\d{1,2}(:\d{1,2}){1,2}$/.test(date)) date = `${(/* @__PURE__ */ new Date()).toLocaleDateString()}-${date}`;
		else if (/^\d{1,2}-\d{1,2}-\d{1,2}(:\d{1,2}){1,2}$/.test(date)) date = `${(/* @__PURE__ */ new Date()).getFullYear()}-${date}`;
		return date ? new Date(date) : /* @__PURE__ */ new Date();
	}
	Time.parseDate = parseDate;
	function format(ms) {
		const abs = Math.abs(ms);
		if (abs >= Time.day - Time.hour / 2) return Math.round(ms / Time.day) + "d";
		else if (abs >= Time.hour - Time.minute / 2) return Math.round(ms / Time.hour) + "h";
		else if (abs >= Time.minute - Time.second / 2) return Math.round(ms / Time.minute) + "m";
		else if (abs >= Time.second) return Math.round(ms / Time.second) + "s";
		return ms + "ms";
	}
	Time.format = format;
	function toDigits(source, length = 2) {
		return source.toString().padStart(length, "0");
	}
	Time.toDigits = toDigits;
	function template(template, time = /* @__PURE__ */ new Date()) {
		return template.replace("yyyy", time.getFullYear().toString()).replace("yy", time.getFullYear().toString().slice(2)).replace("MM", toDigits(time.getMonth() + 1)).replace("dd", toDigits(time.getDate())).replace("hh", toDigits(time.getHours())).replace("mm", toDigits(time.getMinutes())).replace("ss", toDigits(time.getSeconds())).replace("SSS", toDigits(time.getMilliseconds(), 3));
	}
	Time.template = template;
})(Time || (Time = {}));
//#endregion
//#region ../../../deepseek-harness/vendor/schemastery/lib/index.mjs
const kSchema = Symbol.for("schemastery");
const kValidationError$1 = Symbol.for("ValidationError");
globalThis.__schemastery_index__ ??= 0;
globalThis.__schemastery_refs__ = void 0;
var ValidationError$1 = class extends TypeError {
	options;
	name = "ValidationError";
	constructor(message, options) {
		let prefix = "$";
		for (const segment of options.path || []) if (typeof segment === "string") prefix += "." + segment;
		else if (typeof segment === "number") prefix += "[" + segment + "]";
		else if (typeof segment === "symbol") prefix += `[Symbol(${segment.toString()})]`;
		if (prefix.startsWith(".")) prefix = prefix.slice(1);
		super((prefix === "$" ? "" : `${prefix} `) + message);
		this.options = options;
	}
	static is(error) {
		return !!error?.[kValidationError$1];
	}
};
Object.defineProperty(ValidationError$1.prototype, kValidationError$1, { value: true });
const Schema = function(options) {
	const schema = function(data, options = {}) {
		return Schema.resolve(data, schema, options)[0];
	};
	if (options.refs) {
		const refs = mapValues(options.refs, (options) => new Schema(options));
		const getRef = (uid) => refs[uid];
		for (const key in refs) {
			const options = refs[key];
			options.sKey = getRef(options.sKey);
			options.inner = getRef(options.inner);
			options.list = options.list && options.list.map(getRef);
			options.dict = options.dict && mapValues(options.dict, getRef);
		}
		return refs[options.uid];
	}
	Object.assign(schema, options);
	if (typeof schema.callback === "string") try {
		schema.callback = new Function("return " + schema.callback)();
	} catch {}
	Object.defineProperty(schema, "uid", { value: globalThis.__schemastery_index__++ });
	Object.setPrototypeOf(schema, Schema.prototype);
	schema.meta ||= {};
	schema.toString = schema.toString.bind(schema);
	return schema;
};
Schema.prototype = Object.create(Function.prototype);
Schema.prototype[kSchema] = true;
Object.defineProperty(Schema.prototype, "~standard", { get() {
	return {
		version: 1,
		vendor: "schemastery",
		validate: (value) => {
			try {
				return { value: Schema.resolve(value, this, {})[0] };
			} catch (error) {
				if (ValidationError$1.is(error)) return { issues: [{
					message: error.message,
					path: error.options.path
				}] };
				throw error;
			}
		}
	};
} });
Schema.ValidationError = ValidationError$1;
Schema.prototype.toJSON = function toJSON() {
	if (globalThis.__schemastery_refs__) {
		globalThis.__schemastery_refs__[this.uid] ??= JSON.parse(JSON.stringify({ ...this }));
		return this.uid;
	}
	globalThis.__schemastery_refs__ = { [this.uid]: { ...this } };
	globalThis.__schemastery_refs__[this.uid] = JSON.parse(JSON.stringify({ ...this }));
	const result = {
		uid: this.uid,
		refs: globalThis.__schemastery_refs__
	};
	globalThis.__schemastery_refs__ = void 0;
	return result;
};
Schema.prototype.set = function set(key, value) {
	this.dict[key] = value;
	return this;
};
Schema.prototype.push = function push(value) {
	this.list.push(value);
	return this;
};
function mergeDesc(original, messages) {
	const result = typeof original === "string" ? { "": original } : { ...original };
	for (const locale in messages) {
		const value = messages[locale];
		if (value?.$description || value?.$desc) result[locale] = value.$description || value.$desc;
		else if (typeof value === "string") result[locale] = value;
	}
	return result;
}
function getInner(value) {
	return value?.$value ?? value?.$inner;
}
function extractKeys(data) {
	return filterKeys(data ?? {}, (key) => !key.startsWith("$"));
}
Schema.prototype.i18n = function i18n(messages) {
	const schema = Schema(this);
	const desc = mergeDesc(schema.meta.description, messages);
	if (Object.keys(desc).length) schema.meta.description = desc;
	if (schema.dict) schema.dict = mapValues(schema.dict, (inner, key) => {
		return inner.i18n(mapValues(messages, (data) => getInner(data)?.[key] ?? data?.[key]));
	});
	if (schema.list) schema.list = schema.list.map((inner, index) => {
		return inner.i18n(mapValues(messages, (data = {}) => {
			if (Array.isArray(getInner(data))) return getInner(data)[index];
			if (Array.isArray(data)) return data[index];
			return extractKeys(data);
		}));
	});
	if (schema.inner) schema.inner = schema.inner.i18n(mapValues(messages, (data) => {
		if (getInner(data)) return getInner(data);
		return extractKeys(data);
	}));
	if (schema.sKey) schema.sKey = schema.sKey.i18n(mapValues(messages, (data) => data?.$key));
	return schema;
};
Schema.prototype.extra = function extra(key, value) {
	const schema = Schema(this);
	schema.meta = {
		...schema.meta,
		[key]: value
	};
	return schema;
};
for (const key of [
	"required",
	"disabled",
	"collapse",
	"hidden",
	"loose"
]) Object.assign(Schema.prototype, { [key](value = true) {
	const schema = Schema(this);
	schema.meta = {
		...schema.meta,
		[key]: value
	};
	return schema;
} });
Schema.prototype.deprecated = function deprecated() {
	const schema = Schema(this);
	schema.meta.badges ||= [];
	schema.meta.badges.push({
		text: "deprecated",
		type: "danger"
	});
	return schema;
};
Schema.prototype.experimental = function experimental() {
	const schema = Schema(this);
	schema.meta.badges ||= [];
	schema.meta.badges.push({
		text: "experimental",
		type: "warning"
	});
	return schema;
};
Schema.prototype.pattern = function pattern(regexp) {
	const schema = Schema(this);
	const pattern = pick(regexp, ["source", "flags"]);
	schema.meta = {
		...schema.meta,
		pattern
	};
	return schema;
};
Schema.prototype.simplify = function simplify(value) {
	if (isVolatile(value)) value = value.get();
	if (deepEqual(value, this.meta.default, this.type === "dict")) return null;
	if (isNullable(value)) return value;
	if (this.type === "object" || this.type === "dict") {
		const result = {};
		for (const key in value) {
			const item = (this.type === "object" ? this.dict[key] : this.inner)?.simplify(value[key]);
			if (this.type === "dict" || !isNullable(item)) result[key] = item;
		}
		if (deepEqual(result, this.meta.default, this.type === "dict")) return null;
		return result;
	} else if (this.type === "array" || this.type === "tuple") {
		const result = [];
		value.forEach((value, index) => {
			const schema = this.type === "array" ? this.inner : this.list[index];
			const item = schema ? schema.simplify(value) : value;
			result.push(item);
		});
		return result;
	} else if (this.type === "intersect") {
		const result = {};
		for (const item of this.list) Object.assign(result, item.simplify(value));
		return result;
	} else if (this.type === "union") for (const schema of this.list) try {
		Schema.resolve(value, schema, {});
		return schema.simplify(value);
	} catch {}
	return value;
};
Schema.prototype.toString = function toString(inline) {
	return formatters[this.type]?.(this, inline) ?? `Schema<${this.type}>`;
};
Schema.prototype.role = function role(role, extra) {
	const schema = Schema(this);
	schema.meta = {
		...schema.meta,
		role,
		extra
	};
	return schema;
};
for (const key of [
	"default",
	"link",
	"comment",
	"description",
	"max",
	"min",
	"step"
]) Object.assign(Schema.prototype, { [key](value) {
	const schema = Schema(this);
	schema.meta = {
		...schema.meta,
		[key]: value
	};
	return schema;
} });
Schema.prototype.volatile = function volatile() {
	if (this.meta.volatile) throw new TypeError("volatile schema is already wrapped");
	return this.extra("volatile", true);
};
const resolvers = {};
const checkedVolatile = Symbol("checked-volatile-schema");
function validateVolatileSchema(schema, path = [], blocked = false, seen = /* @__PURE__ */ new Map()) {
	const states = seen.get(schema) ?? /* @__PURE__ */ new Set();
	if (states.has(blocked)) return;
	states.add(blocked);
	seen.set(schema, states);
	if (schema.meta?.volatile && blocked) throw new ValidationError$1("volatile fields require a fixed object path without an enclosing volatile field", { path });
	const nested = blocked || !!schema.meta?.volatile;
	if (schema.dict) for (const [key, child] of Object.entries(schema.dict)) validateVolatileSchema(child, [...path, key], nested, seen);
	if (schema.sKey) validateVolatileSchema(schema.sKey, [...path, "<key>"], true, seen);
	if (schema.inner && (schema.type !== "lazy" || schema.inner[kSchema])) validateVolatileSchema(schema.inner, [...path, "*"], true, seen);
	if (schema.list) for (let index = 0; index < schema.list.length; index++) validateVolatileSchema(schema.list[index], [...path, String(index)], true, seen);
}
Schema.extend = function extend(type, resolve) {
	resolvers[type] = resolve;
};
Schema.resolve = function resolve(data, schema, options = {}, strict = false) {
	if (!schema) return [data];
	if (!options[checkedVolatile]) {
		validateVolatileSchema(schema, options.path);
		options = {
			...options,
			[checkedVolatile]: true
		};
	}
	if (schema.meta?.volatile) {
		const inner = Schema(schema);
		inner.meta = {
			...schema.meta,
			volatile: false
		};
		const [value, adapted] = Schema.resolve(data, inner, options, strict);
		try {
			return [createVolatile(value), adapted];
		} catch (error) {
			throw new ValidationError$1(error instanceof Error ? error.message : String(error), options);
		}
	}
	if (options.ignore?.(data, schema)) return [data];
	if (isNullable(data) && schema.type !== "lazy") {
		if (schema.meta.required) throw new ValidationError$1(`missing required value`, options);
		let current = schema;
		let fallback = schema.meta.default;
		while (current?.type === "intersect" && isNullable(fallback)) {
			current = current.list[0];
			fallback = current?.meta.default;
		}
		if (isNullable(fallback)) return [data];
		data = clone(fallback);
	}
	const callback = resolvers[schema.type];
	if (!callback) throw new ValidationError$1(`unsupported type "${schema.type}"`, options);
	try {
		return callback(data, schema, options, strict);
	} catch (error) {
		if (!schema.meta.loose) throw error;
		return [schema.meta.default];
	}
};
Schema.from = function from(source) {
	if (isNullable(source)) return Schema.any();
	else if ([
		"string",
		"number",
		"boolean"
	].includes(typeof source)) return Schema.const(source).required();
	else if (source[kSchema]) return source;
	else if (typeof source === "function") switch (source) {
		case String: return Schema.string().required();
		case Number: return Schema.number().required();
		case Boolean: return Schema.boolean().required();
		case Function: return Schema.function().required();
		default: return Schema.is(source).required();
	}
	else throw new TypeError(`cannot infer schema from ${source}`);
};
Schema.lazy = function lazy(builder) {
	const toJSON = () => {
		if (!schema.inner[kSchema]) {
			schema.inner = schema.builder();
			schema.inner.meta = {
				...schema.meta,
				...schema.inner.meta
			};
		}
		return schema.inner.toJSON();
	};
	const schema = new Schema({
		type: "lazy",
		builder,
		inner: { toJSON }
	});
	return schema;
};
Schema.natural = function natural() {
	return Schema.number().step(1).min(0);
};
Schema.percent = function percent() {
	return Schema.number().step(.01).min(0).max(1).role("slider");
};
Schema.date = function date() {
	return Schema.union([Schema.is(Date), Schema.transform(Schema.string().role("datetime"), (value, options) => {
		const date = new Date(value);
		if (isNaN(+date)) throw new ValidationError$1(`invalid date "${value}"`, options);
		return date;
	}, true)]);
};
Schema.regExp = function regExp(flag = "") {
	return Schema.union([Schema.is(RegExp), Schema.transform(Schema.string().role("regexp", { flag }), (value, options) => {
		try {
			return new RegExp(value, flag);
		} catch (e) {
			throw new ValidationError$1(e.message, options);
		}
	}, true)]);
};
Schema.arrayBuffer = function arrayBuffer(encoding) {
	return Schema.union([
		Schema.is(ArrayBuffer),
		Schema.is(SharedArrayBuffer),
		Schema.transform(Schema.any(), (value, options) => {
			if (Binary.isSource(value)) return Binary.fromSource(value);
			throw new ValidationError$1(`expected ArrayBufferSource but got ${value}`, options);
		}, true),
		...encoding ? [Schema.transform(Schema.string(), (value, options) => {
			try {
				return encoding === "base64" ? Binary.fromBase64(value) : Binary.fromHex(value);
			} catch (e) {
				throw new ValidationError$1(e.message, options);
			}
		}, true)] : []
	]);
};
Schema.extend("lazy", (data, schema, options, strict) => {
	if (!schema.inner[kSchema]) {
		schema.inner = schema.builder();
		schema.inner.meta = {
			...schema.meta,
			...schema.inner.meta
		};
		validateVolatileSchema(schema.inner, options.path, true);
	}
	return Schema.resolve(data, schema.inner, options, strict);
});
Schema.extend("any", (data) => {
	return [data];
});
Schema.extend("never", (data, _, options) => {
	throw new ValidationError$1(`expected nullable but got ${data}`, options);
});
Schema.extend("const", (data, { value }, options) => {
	if (deepEqual(data, value)) return [value];
	throw new ValidationError$1(`expected ${value} but got ${data}`, options);
});
function checkWithinRange(data, meta, description, options, skipMin = false) {
	const { max = Infinity, min = -Infinity } = meta;
	if (data > max) throw new ValidationError$1(`expected ${description} <= ${max} but got ${data}`, options);
	if (data < min && !skipMin) throw new ValidationError$1(`expected ${description} >= ${min} but got ${data}`, options);
}
Schema.extend("string", (data, { meta }, options) => {
	if (typeof data !== "string") throw new ValidationError$1(`expected string but got ${data}`, options);
	if (meta.pattern) {
		const regexp = new RegExp(meta.pattern.source, meta.pattern.flags);
		if (!regexp.test(data)) throw new ValidationError$1(`expect string to match regexp ${regexp}`, options);
	}
	checkWithinRange(data.length, meta, "string length", options);
	return [data];
});
function decimalShift(data, digits) {
	const str = data.toString();
	if (str.includes("e")) return data * Math.pow(10, digits);
	const index = str.indexOf(".");
	if (index === -1) return data * Math.pow(10, digits);
	const frac = str.slice(index + 1);
	const integer = str.slice(0, index);
	if (frac.length <= digits) return +(integer + frac.padEnd(digits, "0"));
	return +(integer + frac.slice(0, digits) + "." + frac.slice(digits));
}
function isMultipleOf(data, min, step) {
	step = Math.abs(step);
	if (!/^\d+\.\d+$/.test(step.toString())) return (data - min) % step === 0;
	const index = step.toString().indexOf(".");
	const digits = step.toString().slice(index + 1).length;
	return Math.abs(decimalShift(data, digits) - decimalShift(min, digits)) % decimalShift(step, digits) === 0;
}
Schema.extend("number", (data, { meta }, options) => {
	if (typeof data !== "number") throw new ValidationError$1(`expected number but got ${data}`, options);
	checkWithinRange(data, meta, "number", options);
	const { step } = meta;
	if (step && !isMultipleOf(data, meta.min ?? 0, step)) throw new ValidationError$1(`expected number multiple of ${step} but got ${data}`, options);
	return [data];
});
Schema.extend("boolean", (data, _, options) => {
	if (typeof data === "boolean") return [data];
	throw new ValidationError$1(`expected boolean but got ${data}`, options);
});
Schema.extend("bitset", (data, { bits, meta }, options) => {
	let value = 0, keys = [];
	if (typeof data === "number") {
		value = data;
		for (const key in bits) if (data & bits[key]) keys.push(key);
	} else if (Array.isArray(data)) {
		keys = data;
		for (const key of keys) {
			if (typeof key !== "string") throw new ValidationError$1(`expected string but got ${key}`, options);
			if (key in bits) value |= bits[key];
		}
	} else throw new ValidationError$1(`expected number or array but got ${data}`, options);
	if (value === meta.default) return [value];
	return [value, keys];
});
Schema.extend("function", (data, _, options) => {
	if (typeof data === "function") return [data];
	throw new ValidationError$1(`expected function but got ${data}`, options);
});
Schema.extend("is", (data, { constructor }, options) => {
	if (typeof constructor === "function") {
		if (data instanceof constructor) return [data];
		throw new ValidationError$1(`expected ${constructor.name} but got ${data}`, options);
	} else {
		if (isNullable(data)) throw new ValidationError$1(`expected ${constructor} but got ${data}`, options);
		let prototype = Object.getPrototypeOf(data);
		while (prototype) {
			if (prototype.constructor?.name === constructor) return [data];
			prototype = Object.getPrototypeOf(prototype);
		}
		throw new ValidationError$1(`expected ${constructor} but got ${data}`, options);
	}
});
function property(data, key, schema, options) {
	try {
		const [value, adapted] = Schema.resolve(data[key], schema, {
			...options,
			path: [...options.path || [], key]
		});
		if (adapted !== void 0) data[key] = adapted;
		return value;
	} catch (e) {
		if (!options?.autofix) throw e;
		delete data[key];
		return schema.meta.volatile ? createVolatile(schema.meta.default) : schema.meta.default;
	}
}
Schema.extend("array", (data, { inner, meta }, options) => {
	if (!Array.isArray(data)) throw new ValidationError$1(`expected array but got ${data}`, options);
	checkWithinRange(data.length, meta, "array length", options, !isNullable(inner.meta.default));
	return [data.map((_, index) => property(data, index, inner, options))];
});
Schema.extend("dict", (data, { inner, sKey }, options, strict) => {
	if (!isPlainObject(data)) throw new ValidationError$1(`expected object but got ${data}`, options);
	const result = {};
	for (const key in data) {
		let rKey;
		try {
			rKey = Schema.resolve(key, sKey, options)[0];
		} catch (error) {
			if (strict) continue;
			throw error;
		}
		result[rKey] = property(data, key, inner, options);
		data[rKey] = data[key];
		if (key !== rKey) delete data[key];
	}
	return [result];
});
Schema.extend("tuple", (data, { list }, options, strict) => {
	if (!Array.isArray(data)) throw new ValidationError$1(`expected array but got ${data}`, options);
	const result = list.map((inner, index) => property(data, index, inner, options));
	if (strict) return [result];
	result.push(...data.slice(list.length));
	return [result];
});
function merge(result, data) {
	for (const key in data) {
		if (key in result) continue;
		result[key] = data[key];
	}
}
Schema.extend("object", (data, { dict }, options, strict) => {
	if (!isPlainObject(data)) throw new ValidationError$1(`expected object but got ${data}`, options);
	const result = {};
	for (const key in dict) {
		const value = property(data, key, dict[key], options);
		if (!isNullable(value) || key in data) result[key] = value;
	}
	if (!strict) merge(result, data);
	return [result];
});
Schema.extend("union", (data, { list, toString }, options, strict) => {
	const messages = [];
	for (const inner of list) try {
		return Schema.resolve(data, inner, options, strict);
	} catch (error) {
		messages.push(error);
	}
	throw new ValidationError$1(`expected ${toString()} but got ${JSON.stringify(data)}`, options);
});
Schema.extend("intersect", (data, { list, toString }, options, strict) => {
	if (!list.length) return [data];
	let result;
	for (const inner of list) {
		const value = Schema.resolve(data, inner, options, true)[0];
		if (isNullable(value)) continue;
		if (isNullable(result)) result = value;
		else if (typeof result !== typeof value) throw new ValidationError$1(`expected ${toString()} but got ${JSON.stringify(data)}`, options);
		else if (typeof value === "object") merge(result ??= {}, value);
		else if (result !== value) throw new ValidationError$1(`expected ${toString()} but got ${JSON.stringify(data)}`, options);
	}
	if (!strict && isPlainObject(data)) merge(result, data);
	return [result];
});
Schema.extend("transform", (data, { inner, callback, preserve }, options) => {
	const [result, adapted = data] = Schema.resolve(data, inner, options, true);
	if (preserve) return [callback(result)];
	else return [callback(result), callback(adapted)];
});
const formatters = {};
function defineMethod(name, keys, format) {
	formatters[name] = format;
	Object.assign(Schema, { [name](...args) {
		const schema = new Schema({ type: name });
		keys.forEach((key, index) => {
			switch (key) {
				case "sKey":
					schema.sKey = args[index] ?? Schema.string();
					break;
				case "inner":
					schema.inner = Schema.from(args[index]);
					break;
				case "list":
					schema.list = args[index].map(Schema.from);
					break;
				case "dict":
					schema.dict = mapValues(args[index], Schema.from);
					break;
				case "bits":
					schema.bits = {};
					for (const key in args[index]) {
						if (typeof args[index][key] !== "number") continue;
						schema.bits[key] = args[index][key];
					}
					break;
				case "callback": {
					const callback = schema.callback = args[index];
					callback["toJSON"] ||= () => callback.toString();
					break;
				}
				case "constructor": {
					const constructor = schema.constructor = args[index];
					if (typeof constructor === "function") constructor["toJSON"] ||= () => constructor["name"];
					break;
				}
				default: schema[key] = args[index];
			}
		});
		if (name === "object" || name === "dict") schema.meta.default = {};
		else if (name === "array" || name === "tuple") schema.meta.default = [];
		else if (name === "bitset") schema.meta.default = 0;
		return schema;
	} });
}
defineMethod("is", ["constructor"], ({ constructor }) => {
	if (typeof constructor === "function") return constructor.name;
	else return constructor;
});
defineMethod("any", [], () => "any");
defineMethod("never", [], () => "never");
defineMethod("const", ["value"], ({ value }) => typeof value === "string" ? JSON.stringify(value) : value);
defineMethod("string", [], () => "string");
defineMethod("number", [], () => "number");
defineMethod("boolean", [], () => "boolean");
defineMethod("bitset", ["bits"], () => "bitset");
defineMethod("function", [], () => "function");
defineMethod("array", ["inner"], ({ inner }) => `${inner.toString(true)}[]`);
defineMethod("dict", ["inner", "sKey"], ({ inner, sKey }) => `{ [key: ${sKey.toString()}]: ${inner.toString()} }`);
defineMethod("tuple", ["list"], ({ list }) => `[${list.map((inner) => inner.toString()).join(", ")}]`);
defineMethod("object", ["dict"], ({ dict }) => {
	if (Object.keys(dict).length === 0) return "{}";
	return `{ ${Object.entries(dict).map(([key, inner]) => {
		return `${key}${inner.meta.required ? "" : "?"}: ${inner.toString()}`;
	}).join(", ")} }`;
});
defineMethod("union", ["list"], ({ list }, inline) => {
	const result = list.map(({ toString: format }) => format()).join(" | ");
	return inline ? `(${result})` : result;
});
defineMethod("intersect", ["list"], ({ list }) => {
	return `${list.map((inner) => inner.toString(true)).join(" & ")}`;
});
defineMethod("transform", [
	"inner",
	"callback",
	"preserve"
], ({ inner }, isInner) => inner.toString(isInner));
//#endregion
//#region ../../../deepseek-harness/vendor/cordis/lib/index.js
/** Ordered collection of disposable values with O(1) deletion by value. */
var DisposableList = class {
	sn = 0;
	map = /* @__PURE__ */ new Map();
	weak = /* @__PURE__ */ new WeakMap();
	get length() {
		return this.map.size;
	}
	push(value) {
		const sn = ++this.sn;
		this.map.set(sn, value);
		this.weak.set(value, sn);
		return () => this.map.delete(sn);
	}
	delete(value) {
		const sn = this.weak.get(value);
		if (!sn) return false;
		return this.map.delete(sn);
	}
	clear() {
		const values = [...this.map.values()];
		this.map.clear();
		return values.reverse();
	}
	[Symbol.iterator]() {
		return this.map.values();
	}
	[Symbol.for("nodejs.util.inspect.custom")]() {
		return [...this];
	}
};
/** Shared symbols used to avoid public property-name collisions. */
const symbols = {
	shadow: Symbol.for("cordis.shadow"),
	receiver: Symbol.for("cordis.receiver"),
	original: Symbol.for("cordis.original"),
	metadata: Symbol.for("cordis.metadata"),
	initHooks: Symbol.for("cordis.initHooks"),
	checkProto: Symbol.for("cordis.checkProto"),
	effect: Symbol.for("cordis.effect"),
	filter: Symbol.for("cordis.filter"),
	isolate: Symbol.for("cordis.isolate"),
	intercept: Symbol.for("cordis.intercept"),
	init: Symbol.for("cordis.init"),
	check: Symbol.for("cordis.check"),
	config: Symbol.for("cordis.config"),
	invoke: Symbol.for("cordis.invoke"),
	extend: Symbol.for("cordis.extend"),
	tracker: Symbol.for("cordis.tracker"),
	resolveConfig: Symbol.for("cordis.resolveConfig")
};
const GeneratorFunction = function* () {}.constructor;
const AsyncGeneratorFunction = async function* () {}.constructor;
/** Return true when a plugin callback should be constructed with `new`. */
function isConstructor(func) {
	if (!func.prototype) return false;
	if (func instanceof GeneratorFunction) return false;
	if (AsyncGeneratorFunction !== Function && func instanceof AsyncGeneratorFunction) return false;
	return true;
}
/** Merge two prototype chains while preserving descriptors from `proto1`. */
function joinPrototype(proto1, proto2) {
	if (proto1 === Object.prototype) return proto2;
	const result = Object.create(joinPrototype(Object.getPrototypeOf(proto1), proto2));
	for (const key of Reflect.ownKeys(proto1)) Object.defineProperty(result, key, Object.getOwnPropertyDescriptor(proto1, key));
	return result;
}
/** Return true for non-null objects and functions. */
function isObject(value) {
	return value && (typeof value === "object" || typeof value === "function");
}
/** Find a property descriptor by walking an object's prototype chain. */
function getPropertyDescriptor(target, prop) {
	let proto = target;
	while (proto) {
		const desc = Reflect.getOwnPropertyDescriptor(proto, prop);
		if (desc) return desc;
		proto = Object.getPrototypeOf(proto);
	}
}
/** Wrap services/functions so method calls see the caller's active context. */
function getTraceable(ctx, value) {
	if (!isObject(value)) return value;
	if (Object.hasOwn(value, symbols.shadow)) return Object.getPrototypeOf(value);
	const tracker = value[symbols.tracker];
	if (!tracker) return value;
	return createTraceable(ctx, value, tracker);
}
/** Return a proxy that overlays readonly or writable properties onto a target. */
function withProps(target, props) {
	if (!props) return target;
	return new Proxy(target, {
		get: (target, prop, receiver) => {
			if (prop in props && prop !== "constructor") return Reflect.get(props, prop, receiver);
			return Reflect.get(target, prop, receiver);
		},
		set: (target, prop, value, receiver) => {
			if (prop in props && prop !== "constructor") return Reflect.set(props, prop, value, receiver);
			return Reflect.set(target, prop, value, receiver);
		}
	});
}
function withProp(target, prop, value) {
	return withProps(target, Object.defineProperty(Object.create(null), prop, {
		value,
		writable: false
	}));
}
function createShadow(ctx, target, property, receiver) {
	if (!property) return receiver;
	const origin = Reflect.getOwnPropertyDescriptor(target, property)?.value;
	if (!origin) return receiver;
	return withProp(receiver, property, ctx.extend({ [symbols.shadow]: origin }));
}
function createShadowMethod(ctx, value, outer, shadow) {
	return new Proxy(value, { apply: (target, thisArg, args) => {
		if (thisArg === outer) thisArg = shadow;
		return getTraceable(ctx, Reflect.apply(target, thisArg, args));
	} });
}
function createTraceable(ctx, value, tracker) {
	if (ctx[symbols.shadow] && !tracker.noShadow) ctx = Object.getPrototypeOf(ctx);
	const proxy = new Proxy(value, {
		get: (target, prop, receiver) => {
			if (prop === symbols.original) return target;
			if (prop === tracker.property) return ctx;
			if (typeof prop === "symbol") return Reflect.get(target, prop, receiver);
			if (tracker.associate && ctx.reflect.props[`${tracker.associate}.${prop}`]) return Reflect.get(ctx, `${tracker.associate}.${prop}`, withProp(ctx, symbols.receiver, receiver));
			let shadow, innerValue;
			const desc = getPropertyDescriptor(target, prop);
			if (desc && "value" in desc) innerValue = desc.value;
			else {
				shadow = createShadow(ctx, target, tracker.property, receiver);
				innerValue = Reflect.get(target, prop, shadow);
			}
			const innerTracker = innerValue?.[symbols.tracker];
			if (innerTracker) return createTraceable(ctx, innerValue, innerTracker);
			else if (!tracker.noShadow && typeof innerValue === "function") {
				shadow ??= createShadow(ctx, target, tracker.property, receiver);
				return createShadowMethod(ctx, innerValue, receiver, shadow);
			} else return innerValue;
		},
		set: (target, prop, value, receiver) => {
			if (prop === symbols.original) return false;
			if (prop === tracker.property) return false;
			if (typeof prop === "symbol") return Reflect.set(target, prop, value, receiver);
			if (tracker.associate && ctx.reflect.props[`${tracker.associate}.${prop}`]) return Reflect.set(ctx, `${tracker.associate}.${prop}`, value, withProp(ctx, symbols.receiver, receiver));
			const shadow = createShadow(ctx, target, tracker.property, receiver);
			return Reflect.set(target, prop, value, shadow);
		},
		apply: (target, thisArg, args) => {
			return applyTraceable(proxy, target, thisArg, args);
		}
	});
	return proxy;
}
function applyTraceable(proxy, value, thisArg, args) {
	if (!value[symbols.invoke]) return Reflect.apply(value, thisArg, args);
	return value[symbols.invoke].apply(proxy, args);
}
/** Create a callable service object that dispatches through `symbols.invoke`. */
function createCallable(name, proto, tracker) {
	const self = function(...args) {
		return applyTraceable(createTraceable(self["ctx"], self, tracker), self, this, args);
	};
	defineProperty(self, "name", name);
	return Object.setPrototypeOf(self, proto);
}
function handleError(info, reason, getOuterStack) {
	const innerLines = info.error.stack.split("\n");
	if (typeof reason?.stack !== "string") {
		const outerError = new Error(reason);
		const lines = outerError.stack.split("\n");
		lines.splice(1, Infinity, ...getOuterStack());
		outerError.stack = lines.join("\n");
		throw outerError;
	}
	const lines = reason.stack.split("\n");
	let index = lines.indexOf(innerLines[2]);
	if (index === -1) throw reason;
	index -= info.offset;
	while (index > 0) {
		if (!lines[index - 1].endsWith(" (<anonymous>)")) break;
		index -= 1;
	}
	lines.splice(index, Infinity, ...getOuterStack());
	reason.stack = lines.join("\n");
	throw reason;
}
/** Run a callback and splice outer call-site frames into thrown async errors. */
function composeError(callback, getOuterStack = buildOuterStack()) {
	const info = {
		offset: 1,
		error: /* @__PURE__ */ new Error()
	};
	try {
		const result = callback(info);
		if (isObject(result) && "then" in result) return result.then(void 0, (reason) => handleError(info, reason, getOuterStack));
		else return result;
	} catch (reason) {
		handleError(info, reason, getOuterStack);
	}
}
/** Capture a lazy stack-frame supplier for later error composition. */
function buildOuterStack(offset = 0) {
	const outerError = /* @__PURE__ */ new Error();
	return () => outerError.stack.split("\n").slice(3 + offset);
}
/**
* Return whether an event result should stop a bail-style dispatch.
*
* @param value — a listener's return value.
* @returns `true` unless `value` is `null`, `false`, or `undefined`.
*/
function isBailed(value) {
	return value !== null && value !== false && value !== void 0;
}
/**
* Event bus installed as `ctx.events` and mixed into every context.
*
* The service supports concurrent, synchronous, serial, bail, and waterfall
* dispatch and automatically disposes listeners with their owning fiber.
*/
var EventsService = class {
	ctx;
	_hooks = {};
	constructor(ctx) {
		this.ctx = ctx;
		defineProperty(this, symbols.tracker, {
			property: "ctx",
			noShadow: true
		});
		this.on("internal/listener", function(name, listener, options) {
			if (name === "internal/update" && !options.global) return (this.fiber._hooks["internal/update"] ??= new DisposableList())[options.prepend ? "unshift" : "push"](listener);
		});
		this.on("internal/update", function(config, noSave, next) {
			const cbs = [...this._hooks["internal/update"] || []];
			const _next = () => {
				return (cbs.shift() ?? next).call(this, config, noSave, _next);
			};
			return _next();
		}, {
			global: true,
			prepend: true
		});
	}
	/**
	* Resolve listeners for one dispatch and apply context filtering.
	*
	* @param type — the dispatch mode, reported on `internal/dispatch`.
	* @param args — the raw dispatch arguments; consumed up to the event name.
	* @returns the matching listener callbacks, bound to the dispatch `this`.
	*/
	dispatch(type, args) {
		const thisArg = typeof args[0] === "object" || typeof args[0] === "function" ? args.shift() : null;
		const name = args.shift();
		if (!name.startsWith("internal/")) this.emit("internal/dispatch", type, name, args, thisArg);
		const filter = thisArg?.[Context.filter];
		return (this._hooks[name] || []).filter((hook) => hook.global || !filter || filter.call(thisArg, hook.ctx)).map((hook) => hook.callback.bind(thisArg));
	}
	/**
	* Run listeners concurrently and wait for all of them.
	*
	* @param args — optional `this`, the event name, then listener arguments.
	* @returns a promise resolving once every listener has settled.
	*/
	async parallel(...args) {
		const errors = (await Promise.allSettled(this.dispatch("emit", args).map(async (cb) => cb(...args)))).filter((result) => result.status === "rejected");
		if (errors.length) throw new AggregateError(errors.map((error) => error.reason));
	}
	/**
	* Run listeners synchronously without waiting for returned promises.
	*
	* @param args — optional `this`, the event name, then listener arguments.
	*/
	emit(...args) {
		this.dispatch("emit", args).map((cb) => cb(...args));
	}
	/**
	* Run listeners in order, awaiting each, until one returns a bail value.
	*
	* @param args — optional `this`, the event name, then listener arguments.
	* @returns the first bail value (see {@link isBailed}), if any.
	*/
	async serial(...args) {
		for (const cb of this.dispatch("serial", args)) {
			const result = await cb(...args);
			if (isBailed(result)) return result;
		}
	}
	/**
	* Run listeners synchronously until one returns a bail value.
	*
	* @param args — optional `this`, the event name, then listener arguments.
	* @returns the first bail value (see {@link isBailed}), if any.
	*/
	bail(...args) {
		for (const cb of this.dispatch("bail", args)) {
			const result = cb(...args);
			if (isBailed(result)) return result;
		}
	}
	/**
	* Compose listeners around the final `next` callback.
	*
	* The last dispatch argument is treated as the innermost `next`. Listeners
	* run outermost-first; a listener that does not call `next()` vetoes the
	* rest of the chain, including the built-in behavior.
	*
	* @param args — optional `this`, the event name, listener arguments, then `next`.
	* @returns the outermost listener's return value.
	*/
	waterfall(...args) {
		const cbs = this.dispatch("waterfall", args);
		const inner = args.pop();
		const next = () => {
			return (cbs.shift() ?? inner)(...args);
		};
		args.push(next);
		return next();
	}
	/**
	* Store a listener record as an effect on the current fiber.
	*
	* @param label — effect label shown in fiber diagnostics.
	* @param hooks — the listener list for one event.
	* @param callback — the listener to store.
	* @param options — placement and filtering options.
	* @returns a disposer that unregisters the listener.
	*/
	register(label, hooks, callback, options) {
		const method = options.prepend ? "unshift" : "push";
		return this.ctx.fiber.effect(() => {
			hooks[method]({
				ctx: this.ctx,
				callback,
				...options
			});
			return () => this.unregister(hooks, callback);
		}, label);
	}
	/**
	* Remove a stored listener record.
	*
	* @param hooks — the listener list for one event.
	* @param callback — the listener to remove.
	* @returns `true` if the listener was found and removed.
	*/
	unregister(hooks, callback) {
		const index = hooks.findIndex((hook) => hook.callback === callback);
		if (index >= 0) {
			hooks.splice(index, 1);
			return true;
		}
	}
	/**
	* Register an event listener owned by the current fiber.
	*
	* The listener is removed automatically when the fiber unloads. Throws
	* `CordisError('INACTIVE_EFFECT')` if the fiber is already disposed.
	*
	* @param name — the event name to listen for.
	* @param listener — called with the dispatch arguments.
	* @param options — listener options; a boolean is shorthand for `prepend`.
	* @returns a disposer removing the listener; `true` if it was still registered.
	*/
	on(name, listener, options) {
		if (typeof options !== "object") options = { prepend: options };
		this.ctx.fiber.assertActive();
		listener = this.ctx.reflect.bind(listener);
		const result = this.bail(this.ctx, "internal/listener", name, listener, options);
		if (result) return result;
		const hooks = this._hooks[name] ||= [];
		const label = `ctx.on(${typeof name === "string" ? JSON.stringify(name) : name.toString()})`;
		return this.register(label, hooks, listener, options);
	}
	/**
	* Register an event listener that disposes itself after the first call.
	*
	* @param name — the event name to listen for.
	* @param listener — called at most once with the dispatch arguments.
	* @param options — listener options; a boolean is shorthand for `prepend`.
	* @returns a disposer removing the listener; `true` if it was still registered.
	*/
	once(name, listener, options) {
		const dispose = this.on(name, function(...args) {
			dispose();
			return listener.apply(this, args);
		}, options);
		return dispose;
	}
};
/** Built-in placeholder formatters used by `Logger.format()`. */
const defaultFormatters = {
	s: (value) => String(value),
	d: (value) => Math.trunc(Number(value)),
	i: (value) => Math.trunc(Number(value)),
	f: (value) => Number(value),
	o: (value) => JSON.stringify(value),
	O: (value) => JSON.stringify(value),
	c: () => "",
	C: (value, exporter, message) => {
		return Logger.color(exporter, Logger.code(message.name, exporter.colors), value);
	}
};
function isAggregateError(error) {
	return error instanceof Error && Array.isArray(error["errors"]);
}
/** Logger facade for one named subsystem. */
var Logger = class {
	service;
	static color(exporter, code, value, decoration = "") {
		if (!exporter.colors) return "" + value;
		return `\u001b[3${code < 8 ? code : "8;5;" + code}${exporter.colors >= 2 ? decoration : ""}m${value}\u001b[0m`;
	}
	static code(name, level) {
		let hash = 0;
		for (let i = 0; i < name.length; i++) {
			hash = (hash << 3) - hash + name.charCodeAt(i) + 13;
			hash |= 0;
		}
		const colors = !level ? [] : level >= 2 ? c256 : c16;
		return colors[Math.abs(hash) % colors.length];
	}
	static format(exporter, message) {
		const args = message.args.slice();
		if (args[0] instanceof Error) {
			args[0] = args[0].stack || args[0].message;
			args.unshift("%s");
		} else if (typeof args[0] !== "string") args.unshift("%o");
		let format = args.shift();
		format = format.replace(/%([a-zA-Z%])/g, (match, char) => {
			if (match === "%%") return "%";
			const formatter = exporter.formatters?.[char] ?? defaultFormatters[char];
			if (typeof formatter === "function") return formatter(args.shift(), exporter, message);
			return match;
		});
		const oFormatter = exporter.formatters?.o ?? defaultFormatters.o;
		for (let arg of args) {
			if (typeof arg === "object" && arg) arg = oFormatter(arg, exporter, message);
			format += " " + arg;
		}
		const { maxLength = 10240 } = exporter;
		return format.split(/\r?\n/g).map((line) => {
			return line.slice(0, maxLength) + (line.length > maxLength ? "..." : "");
		}).join("\n");
	}
	constructor(options, service) {
		this.service = service;
		Object.assign(this, options);
		this.error = this._method("error", 0);
		this.info = this._method("info", 1);
		this.warn = this._method("warn", 2);
		this.debug = this._method("debug", 3);
	}
	_method(type, level) {
		return (...args) => {
			if (args.length === 1 && args[0] instanceof Error) {
				if (args[0].cause) this[type](args[0].cause);
				else if (isAggregateError(args[0])) {
					args[0].errors.forEach((error) => this[type](error));
					return;
				}
			}
			const sn = ++this.service._snMessage;
			const ts = Date.now();
			for (const exporter of this.service.exporters.values()) {
				if ((exporter.levels?.[this.name] ?? exporter.levels?.default ?? this.level ?? 1) < level) continue;
				const message = {
					sn,
					ts,
					type,
					level,
					name: this.name,
					...this.meta,
					args
				};
				exporter.export(message);
			}
		};
	}
};
/** ANSI 16-color palette indexes used for logger name coloring. */
const c16 = [
	6,
	2,
	3,
	4,
	5,
	1
];
/** ANSI 256-color palette indexes used for logger name coloring. */
const c256 = [
	20,
	21,
	26,
	27,
	32,
	33,
	38,
	39,
	40,
	41,
	42,
	43,
	44,
	45,
	56,
	57,
	62,
	63,
	68,
	69,
	74,
	75,
	76,
	77,
	78,
	79,
	80,
	81,
	92,
	93,
	98,
	99,
	112,
	113,
	129,
	134,
	135,
	148,
	149,
	160,
	161,
	162,
	163,
	164,
	165,
	166,
	167,
	168,
	169,
	170,
	171,
	172,
	173,
	178,
	179,
	184,
	185,
	196,
	197,
	198,
	199,
	200,
	201,
	202,
	203,
	204,
	205,
	206,
	207,
	208,
	209,
	214,
	215,
	220,
	221
];
/**
* Built-in logging service.
*
* Call `ctx.logger()` to create a named logger, or call `ctx.logger.info()`
* directly to log with the current fiber-derived name.
*/
var LoggerService = class LoggerService {
	bufferSize = 1e3;
	buffer = [];
	ctx;
	_snMessage = 0;
	_snExporter = 0;
	exporters = /* @__PURE__ */ new Map();
	constructor(ctx) {
		const tracker = {
			property: "ctx",
			noShadow: true
		};
		const self = createCallable("logger", joinPrototype(Object.getPrototypeOf(this), Function.prototype), tracker);
		Object.assign(self, this);
		self.ctx = ctx;
		defineProperty(self, symbols.tracker, tracker);
		self.exporter({
			colors: 3,
			export: (message) => {
				self.buffer.push(message);
				if (self.buffer.length > self.bufferSize) self.buffer = self.buffer.slice(-self.bufferSize);
			}
		});
		return self;
	}
	/**
	* Register an exporter and dispose it with the current fiber.
	*
	* @param exporter — the sink that receives structured log messages.
	* @returns a disposer that removes the exporter.
	*/
	exporter(exporter) {
		return this.ctx.effect(() => {
			const id = ++this._snExporter;
			this.exporters.set(id, exporter);
			return () => this.exporters.delete(id);
		}, "ctx.logger.exporter()");
	}
	_resolveConfig() {
		let intercept = this.ctx[symbols.intercept];
		const configs = [];
		while ("logger" in intercept) {
			if (Object.hasOwn(intercept, "logger")) configs.unshift(intercept["logger"]);
			intercept = Object.getPrototypeOf(intercept);
		}
		return Object.assign({}, ...configs);
	}
	[symbols.invoke](name) {
		const config = this._resolveConfig();
		const fiber = (this.ctx[symbols.shadow] ?? this.ctx).fiber;
		name ??= config.name;
		name ??= hyphenate(fiber.name);
		return new Logger({
			name,
			level: config.level,
			meta: { fiber: new WeakRef(fiber) }
		}, this);
	}
	static {
		for (const type of [
			"error",
			"info",
			"warn",
			"debug"
		]) LoggerService.prototype[type] = function(...args) {
			return this()[type](...args);
		};
	}
};
function enhanceError(error) {
	const lines = error.stack.split("\n");
	lines.splice(0, 2, `Error: ${error.message}`);
	error.stack = lines.join("\n");
	return error;
}
const RESERVED_WORDS = ["prototype", "then"];
function isSpecialProperty(prop) {
	return typeof prop === "symbol" || RESERVED_WORDS.includes(prop) || parseInt(prop).toString() === prop || prop.startsWith("_");
}
/**
* Reflection and service-resolution layer installed as `ctx.reflect`.
*
* This service powers the context proxy, service registration, accessors, and
* the mixins that expose core service methods directly on `ctx`.
*/
var ReflectService = class {
	ctx;
	/** Proxy traps implementing service resolution for every context object. */
	static handler = {
		get: (target, prop, ctx) => {
			if (isSpecialProperty(prop)) return Reflect.get(target, prop, ctx);
			if (Reflect.has(target, prop)) return getTraceable(ctx, Reflect.get(target, prop, ctx));
			const error = /* @__PURE__ */ new Error(`cannot get property "${prop}" without inject`);
			try {
				const def = target.reflect.props[prop];
				if (def?.type === "accessor") return def.get.call(ctx, ctx[symbols.receiver], error);
				if (!ctx.fiber.runtime) return ctx.reflect.get(prop, false);
				return ctx.events.waterfall("internal/get", ctx, prop, error, () => {
					const key = target[symbols.isolate][prop];
					let fiber = (ctx[symbols.shadow] ?? ctx).fiber;
					while (true) {
						const impl = fiber.store?.[prop];
						if (impl) return getTraceable(ctx, impl.value);
						if (prop in fiber.inject) {
							error.message = `cannot get required service "${prop}" in inactive context`;
							throw error;
						}
						if (!fiber.runtime) throw error;
						if (fiber.parent[symbols.isolate][prop] !== key) throw error;
						fiber = fiber.parent.fiber;
					}
				});
			} catch (e) {
				throw e === error ? enhanceError(e) : e;
			}
		},
		set: (target, prop, value, ctx) => {
			if (isSpecialProperty(prop)) return Reflect.set(target, prop, value, ctx);
			const error = /* @__PURE__ */ new Error(`cannot set property "${prop}" without provide`);
			const def = target.reflect.props[prop];
			if (!def) {
				if (!ctx.fiber.runtime) return Reflect.set(target, prop, value, ctx);
				throw enhanceError(error);
			}
			try {
				if (def.type === "accessor") {
					if (!def.set) return false;
					return def.set.call(ctx, value, ctx[symbols.receiver], error);
				}
				return ctx.events.waterfall("internal/set", ctx, prop, value, error, () => {
					return ctx.reflect.set(prop, value, error);
				});
			} catch (e) {
				throw e === error ? enhanceError(e) : e;
			}
		},
		has: (target, prop) => {
			if (isSpecialProperty(prop)) return Reflect.has(target, prop);
			if (Reflect.has(target, prop)) return true;
			return !!target.reflect.props[prop];
		}
	};
	/** Service implementations, keyed by isolation label. */
	store = Object.create(null);
	/** Declared context properties (services and accessors), by name. */
	props = Object.create(null);
	constructor(ctx) {
		this.ctx = ctx;
		defineProperty(this, symbols.tracker, {
			property: "ctx",
			noShadow: true
		});
		this.mixin("reflect", [
			"get",
			"set",
			"provide",
			"accessor",
			"mixin"
		]);
		this.mixin("fiber", ["runtime", "effect"]);
		this.mixin("registry", ["inject", "plugin"]);
		this.mixin("events", [
			"on",
			"once",
			"parallel",
			"emit",
			"serial",
			"bail",
			"waterfall"
		]);
	}
	/**
	* Read a service from the store without the inject requirement.
	*
	* @param name — the service name.
	* @param strict — when `true`, only return implementations whose providing
	* fiber is currently active.
	* @returns the service value, or `undefined` when not (yet) provided.
	*/
	get(name, strict = true) {
		return getTraceable(this.ctx, this._getImpl(name, strict)?.value);
	}
	_getImpl(name, strict = true) {
		const key = this.ctx[symbols.isolate][name];
		const impl = key && this.store[key];
		if (!impl) return;
		if (strict && impl.fiber.state !== 2) return;
		return impl;
	}
	/**
	* Overwrite a provided service's value.
	*
	* @param name — the service name.
	* @param value — the new service value.
	* @param error — carrier for the caller stack in diagnostics.
	* @returns `true` on success.
	* @throws when `name` was never provided, or was provided by another fiber.
	*/
	set(name, value, error) {
		const key = this.ctx[symbols.isolate][name];
		const impl = this.store[key];
		if (!impl) throw new Error(`cannot set property "${name}" without provide`);
		if (impl.fiber !== this.ctx.fiber) throw new Error(`cannot set property "${name}" in multiple fibers`);
		impl.value = value;
		return true;
	}
	/**
	* Register a service implementation owned by the current fiber.
	*
	* See the `ctx.provide()` overload above for the full contract.
	*
	* @param name — the service name.
	* @param value — the service value.
	* @param check — optional availability predicate for dependents.
	* @returns a disposer that unregisters the service.
	*/
	provide(name, value, check) {
		return this.ctx.fiber.effect(() => {
			if (!this.props[name]) this.props[name] ??= { type: "service" };
			else if (this.props[name].type !== "service") throw new Error(`property "${name}" is already declared as ${this.props[name].type}`);
			this.props[name] = { type: "service" };
			this.ctx.root[symbols.isolate][name] ??= Symbol(name);
			const key = this.ctx[symbols.isolate][name];
			const impl = {
				name,
				value,
				fiber: this.ctx.fiber,
				check
			};
			if (this.store[key]) throw new Error(`service "${name}" has been registered at <${this.store[key].fiber.name}>`);
			this.store[key] = impl;
			this.ctx.fiber.store[name] = impl;
			if (this.ctx.fiber.state === 2) this.notify([name]);
			return async () => {
				delete this.store[key];
				const fibers = this.notify([name]);
				await Promise.allSettled(fibers.map((fiber) => fiber.await()));
				delete this.ctx.fiber.store[name];
			};
		}, `ctx.provide(${JSON.stringify(name)})`);
	}
	/**
	* Re-evaluate every fiber that requires one of the given services.
	*
	* @param names — the service names that changed.
	* @param filter — restricts notification to matching isolation scopes.
	* @returns the fibers whose dependency state was refreshed.
	*/
	notify(names, filter = (ctx, name) => ctx[symbols.isolate][name] === this.ctx[symbols.isolate][name]) {
		const fibers = [];
		for (const runtime of this.ctx.registry.values()) for (const fiber of runtime.fibers) {
			let hasUpdate = false;
			for (const name of names) {
				if (!(name in fiber.inject)) continue;
				if (!filter(fiber.ctx, name)) continue;
				hasUpdate = true;
				fiber._checkImpl(name);
			}
			if (!hasUpdate) continue;
			fiber._refresh();
			fibers.push(fiber);
		}
		for (const name of names) {
			const self = Object.create(this.ctx);
			self[symbols.filter] = (target) => filter(target, name);
			this.ctx.events.emit(self, "internal/service", name, this._getImpl(name, false)?.value);
		}
		return fibers;
	}
	/**
	* Define a computed context property backed by get/set hooks.
	*
	* @param name — the context property name.
	* @param options — the `get` hook and optional `set` hook.
	* @returns a disposer that removes the accessor.
	*/
	accessor(name, options) {
		return this.ctx.fiber.effect(() => {
			if (name in this.props) throw new Error(`property "${name}" is already declared as ${this.props[name].type}`);
			this.props[name] = {
				type: "accessor",
				...options
			};
			return () => delete this.props[name];
		}, `ctx.accessor(${JSON.stringify(name)})`);
	}
	/**
	* Expose selected members of a service directly on `ctx`.
	*
	* See the `ctx.mixin()` overload above for the full contract.
	*
	* @param source — a context property name or a source object.
	* @param mixins — keys to forward, or a source-key → ctx-key map.
	* @returns a disposer that removes all created accessors.
	*/
	mixin(source, mixins) {
		const self = this;
		return this.ctx.fiber.effect(function* () {
			const entries = Array.isArray(mixins) ? mixins.map((key) => [key, key]) : Object.entries(mixins);
			const getTarget = (ctx, error) => {
				return ctx[source];
			};
			for (const [key, value] of entries) yield self.accessor(value, {
				get(receiver, error) {
					const service = getTarget(this, error);
					if (isNullable(service)) return service;
					const mixin = receiver ? withProps(receiver, service) : service;
					const value = Reflect.get(service, key, mixin);
					if (typeof value !== "function") return value;
					return value.bind(mixin ?? service);
				},
				set(value, receiver, error) {
					const service = getTarget(this, error);
					const mixin = receiver ? withProps(receiver, service) : service;
					return Reflect.set(service, key, value, mixin);
				}
			});
		}, `ctx.mixin(${JSON.stringify(source)})`);
	}
	/**
	* Attach this context's tracing wrapper to a value.
	*
	* @param value — the value to wrap.
	* @returns the traceable wrapper (or the value itself when not applicable).
	*/
	trace(value) {
		return getTraceable(this.ctx, value);
	}
	/**
	* Wrap a callback so calls trace `this` and arguments to this context.
	*
	* @param callback — the function to wrap.
	* @returns a proxy delegating to `callback` with traced values.
	*/
	bind(callback) {
		return new Proxy(callback, {
			apply: (target, thisArg, args) => {
				return Reflect.apply(target, this.trace(thisArg), args.map((arg) => this.trace(arg)));
			},
			construct: (target, args, newTarget) => {
				return Reflect.construct(target, args.map((arg) => this.trace(arg)), newTarget);
			}
		});
	}
};
const kValidationError = Symbol.for("ValidationError");
/** Error raised when plugin configuration fails standard-schema validation. */
var ValidationError = class extends TypeError {
	name = "ValidationError";
	/**
	* Build the aggregated message from schema issues.
	*
	* @param issues — the standard-schema issues, one message line each.
	*/
	constructor(issues) {
		super(`invalid config:\n` + issues.map((issue) => {
			if (issue.path) return `  - ${issue.message} (at ${issue.path.join(".")})`;
			else return `  - ${issue.message}`;
		}).join("\n"));
	}
};
Object.defineProperty(ValidationError.prototype, kValidationError, { value: true });
/**
* Validate and normalize config for a plugin runtime before it starts.
*
* @param runtime — the plugin runtime whose `Config` schema to apply.
* @param config — the raw user config.
* @returns the validated config, or `config` unchanged if the runtime has no schema.
* @throws {ValidationError} when validation reports issues.
*/
function resolveConfig(runtime, config) {
	if (!runtime.Config) return config;
	const result = runtime.Config["~standard"].validate(config);
	if ("then" in result) throw new TypeError("Async config validation is not supported");
	if (result.issues) throw new ValidationError(result.issues);
	else return result.value;
}
const effectInertia = /* @__PURE__ */ new WeakMap();
function runDisposable(dispose) {
	const result = dispose();
	return effectInertia.get(dispose)?.() ?? result;
}
/** Notify plugin teardown without allowing one observer to break ownership cleanup. */
function emitPluginDisposed(context, fiber) {
	const args = ["internal/plugin", fiber];
	let callbacks;
	try {
		callbacks = context.events.dispatch("emit", args);
	} catch (error) {
		context.logger.error(error);
		return;
	}
	for (const callback of callbacks) try {
		const returned = callback(...args);
		Promise.resolve(returned).catch((error) => context.logger.error(error));
	} catch (error) {
		context.logger.error(error);
	}
}
/** Framework error with a stable machine-readable code. */
var CordisError = class CordisError extends Error {
	code;
	/**
	* @param code — the stable error code; also the default message.
	* @param message — optional human-readable override.
	*/
	constructor(code, message) {
		super(message ?? CordisError.Code[code]);
		this.code = code;
	}
};
/** Cordis error code definitions. */
(function(CordisError) {
	CordisError.Code = { INACTIVE_EFFECT: "cannot create effect on inactive context" };
})(CordisError || (CordisError = {}));
const INACTIVE = "__INACTIVE__";
/**
* Runtime instance of one plugin application.
*
* A fiber tracks dependency state, validated config, lifecycle effects, and
* cleanup for the plugin context returned by `ctx.plugin()`.
*/
var Fiber = class {
	parent;
	inject;
	runtime;
	/** Unique id within the registry; 0 for the root fiber, `null` once disposed. */
	uid;
	/** The context this fiber's plugin runs in (extends the parent context). */
	ctx;
	/** The validated plugin config (updated by `update()`). */
	config;
	/** The raw plugin config, re-resolved before each activation. */
	_config;
	/** Current lifecycle state; transitions emit `internal/status`. */
	state = 0;
	/** Dispose this fiber: unload the plugin, then settle once cleanup finished. */
	dispose;
	/** Snapshot of required service implementations while loaded; `undefined` otherwise. */
	store;
	/** The in-flight load/unload transition, if one is currently running. */
	inertia;
	_hooks = Object.create(null);
	_disposables = new DisposableList();
	context;
	_error;
	_runner;
	_store = Object.create(null);
	/**
	* Create a fiber. Plugin authors normally obtain fibers from `ctx.plugin()`
	* rather than constructing them directly.
	*
	* @param parent — the context the plugin was loaded from.
	* @param config — raw config, validated against the runtime's schema.
	* @param inject — resolved dependency map (service name → intercept config).
	* @param runtime — the shared plugin runtime, or `null` for the root fiber.
	* @param getOuterStack — captures the caller stack for effect diagnostics.
	*/
	constructor(parent, config, inject, runtime, getOuterStack) {
		this.parent = parent;
		this.inject = inject;
		this.runtime = runtime;
		this._config = config;
		const collect = (dispose) => {
			this._disposables.push(dispose);
		};
		if (runtime) {
			this.uid = parent.registry.counter;
			this.ctx = this.context = parent.extend({ fiber: this });
			const injectEntries = Object.entries(this.inject);
			if (injectEntries.length) {
				this.ctx[Context.intercept] = Object.create(parent[Context.intercept]);
				for (const [name, config] of injectEntries) {
					if (isNullable(config)) continue;
					this.ctx[Context.intercept][name] = config;
				}
			}
			this._runner = {
				epoch: INACTIVE,
				getOuterStack,
				execute: function() {
					if (isConstructor(runtime.callback)) {
						const instance = new runtime.callback(this.ctx, this.config);
						for (const hook of instance?.[symbols.initHooks] ?? []) hook();
						return instance?.[symbols.init]?.();
					} else return runtime.callback(this.ctx, this.config);
				},
				collect
			};
			this.dispose = parent.fiber.effect(() => {
				const remove = runtime.fibers.push(this);
				return async () => {
					this.uid = null;
					emitPluginDisposed(this.context, this);
					if (this.ctx.registry.has(runtime.callback)) {
						remove();
						if (!runtime.fibers.length) this.ctx.registry.delete(runtime.callback);
					}
					this._setEpoch(INACTIVE);
					if (!this.inertia) this._updateState(() => {
						this.inertia = this._unload();
						return 5;
					});
					while (this.inertia) await this.inertia;
				};
			}, "ctx.plugin()");
			try {
				this.context.emit("internal/plugin", this);
			} catch (error) {
				Promise.resolve(this.dispose()).catch((reason) => this.ctx.logger.error(reason));
				throw error;
			}
			if (this.uid !== null && parent.fiber.state !== 5) {
				for (const name of Object.keys(this.inject)) this._checkImpl(name);
				this._refresh();
			}
		} else {
			this.uid = 0;
			this.ctx = this.context = parent;
			this.state = 2;
			this.store = Object.create(null);
			this._runner = {
				epoch: "",
				getOuterStack,
				execute: () => {},
				collect
			};
			this.dispose = () => this.restart();
		}
	}
	/** The plugin's display name, inherited from the nearest named ancestor, else `'root'`. */
	get name() {
		let fiber = this;
		do {
			if (fiber.runtime?.name) return fiber.runtime.name;
			fiber = fiber.parent.fiber;
		} while (fiber !== fiber.parent.fiber);
		return "root";
	}
	/**
	* Throw if the fiber has already been disposed.
	*
	* @returns nothing when the fiber is still active.
	* @throws {CordisError} `INACTIVE_EFFECT` when the fiber's uid has been cleared.
	*/
	assertActive() {
		if (this.uid !== null) return;
		throw new CordisError("INACTIVE_EFFECT");
	}
	_execute(runner) {
		const oldEpoch = runner.epoch;
		return composeError((info) => {
			const safeCollect = (dispose) => {
				if (typeof dispose === "function") runner.collect(dispose);
				else if (!isNullable(dispose)) throw new TypeError("Invalid effect");
			};
			const effect = runner.execute.call(this);
			if (typeof effect === "function") return runner.collect(effect);
			else if (isNullable(effect)) {} else if (!isObject(effect)) throw new TypeError("Invalid effect");
			else if ("then" in effect) return effect.then(safeCollect);
			else if (Symbol.iterator in effect) {
				info.error = /* @__PURE__ */ new Error();
				const iter = effect[Symbol.iterator]();
				while (true) {
					const result = iter.next();
					safeCollect(result.value);
					if (result.done) return;
				}
			} else if (Symbol.asyncIterator in effect) {
				const iter = effect[Symbol.asyncIterator]();
				return (async () => {
					await Promise.resolve();
					info.error = /* @__PURE__ */ new Error();
					while (true) {
						if (runner.epoch !== oldEpoch) return;
						const result = await iter.next();
						safeCollect(result.value);
						if (result.done) return;
					}
				})();
			} else throw new TypeError("Invalid effect");
		}, runner.getOuterStack);
	}
	effect(execute, label = "anonymous") {
		this.assertActive();
		if (this.state === 5) throw new CordisError("INACTIVE_EFFECT");
		const disposables = [];
		let disposing = false;
		let disposalTask;
		const dispose = () => {
			if (disposing) return disposalTask;
			disposing = true;
			let task;
			for (const disposable of disposables.splice(0).reverse()) if (task) task = task.then(() => runDisposable(disposable));
			else {
				const result = runDisposable(disposable);
				if (isObject(result) && "then" in result) task = result;
			}
			return disposalTask = task;
		};
		const meta = {
			label,
			children: []
		};
		const runner = {
			execute,
			epoch: true,
			collect: (dispose) => {
				disposables.push(dispose);
				this._disposables.delete(dispose);
				if (dispose[symbols.effect]) meta.children.push(dispose[symbols.effect]);
			},
			getOuterStack: buildOuterStack()
		};
		let task;
		let executing = true;
		let resolveSetup;
		let rejectSetup;
		let setupBarrier;
		let setupFailed = false;
		let inFlight;
		let removeWrapper = () => false;
		const waitForSetup = () => {
			setupBarrier ??= new Promise((resolve, reject) => {
				resolveSetup = resolve;
				rejectSetup = reject;
			});
			return setupBarrier;
		};
		const disposeAfter = (setup) => {
			return Promise.resolve(setup).then(() => dispose(), async (reason) => {
				await dispose();
				throw reason;
			});
		};
		const finalizeDisposal = (callback) => {
			let result;
			try {
				result = callback();
			} catch (error) {
				removeWrapper();
				throw error;
			}
			if (isObject(result) && "then" in result) {
				const pending = Promise.resolve(result).finally(() => {
					removeWrapper();
					if (inFlight === pending) inFlight = void 0;
				});
				return inFlight = pending;
			}
			removeWrapper();
			return result;
		};
		const wrapper = defineProperty(() => {
			if (!runner.epoch) return setupFailed ? inFlight : void 0;
			runner.epoch = false;
			return finalizeDisposal(() => {
				if (executing) return disposeAfter(waitForSetup());
				return task ? disposeAfter(task) : dispose();
			});
		}, symbols.effect, meta);
		effectInertia.set(wrapper, () => inFlight);
		removeWrapper = this._disposables.push(wrapper);
		try {
			task = this._execute(runner);
		} catch (reason) {
			executing = false;
			setupFailed = true;
			runner.epoch = false;
			let cleanup;
			try {
				cleanup = finalizeDisposal(dispose);
			} finally {
				rejectSetup?.(reason);
			}
			if (isObject(cleanup) && "then" in cleanup) cleanup.catch((error) => this.ctx.logger.error(error));
			throw reason;
		}
		executing = false;
		if (setupBarrier) Promise.resolve(task).then(resolveSetup, rejectSetup);
		task?.catch(() => {
			if (!runner.epoch) return dispose();
			return finalizeDisposal(dispose);
		}).catch((error) => this.ctx.logger.error(error));
		const disposeAsync = () => {
			if (!runner.epoch) return;
			runner.epoch = false;
			return finalizeDisposal(dispose);
		};
		wrapper.then = async (onFulfilled, onRejected) => {
			return Promise.resolve(task).then(() => disposeAsync).then(onFulfilled, onRejected);
		};
		return wrapper;
	}
	/**
	* Return metadata for currently registered effects.
	*
	* @returns one {@link EffectMeta} tree per labeled live effect.
	*/
	getEffects() {
		return [...this._disposables].map((dispose) => dispose[symbols.effect]).filter(Boolean);
	}
	_getState() {
		if (this.uid === null) return 4;
		if (this._error) return 3;
		if (this._runner.epoch !== INACTIVE) return 2;
		return 0;
	}
	_updateState(callback) {
		const oldState = this.state;
		this.state = callback() ?? this._getState();
		if (oldState === this.state) return;
		this.context.emit("internal/status", this, oldState);
		if (oldState !== 2 && this.state !== 2) return;
		for (const key of Reflect.ownKeys(this.ctx.reflect.store)) {
			const impl = this.ctx.reflect.store[key];
			if (impl.fiber !== this) continue;
			this.ctx.reflect.notify([impl.name]);
		}
	}
	_checkImpl(name) {
		const impl = this.ctx.reflect._getImpl(name, true);
		if (!impl) return delete this._store[name];
		try {
			if (impl.check && !impl.check.call(getTraceable(this.ctx, impl.value))) return delete this._store[name];
		} catch (error) {
			impl.fiber.ctx.logger.error(error);
			return delete this._store[name];
		}
		this._store[name] = impl;
	}
	_refresh() {
		let epoch = false;
		epoch = "";
		for (const name of Object.keys(this.inject)) {
			const impl = this._store[name];
			if (!impl) {
				epoch = INACTIVE;
				break;
			}
			epoch += ":" + impl.fiber.uid;
		}
		this._setEpoch(epoch);
	}
	_setEpoch(epoch) {
		const oldEpoch = this._runner.epoch;
		if (epoch === oldEpoch) return;
		this._runner.epoch = epoch;
		if (this.inertia) return;
		this._updateState(() => {
			if (epoch !== INACTIVE && oldEpoch === INACTIVE) {
				this.inertia = this._reload();
				return 1;
			} else {
				this.inertia = this._unload();
				return 5;
			}
		});
	}
	_resolveConfig(config) {
		config = this.context.waterfall(this, "internal/config", config, () => config);
		return this.runtime ? resolveConfig(this.runtime, config) : config;
	}
	async _reload() {
		this.store = { ...this._store };
		const oldEpoch = this._runner.epoch;
		try {
			await Promise.resolve();
			if (this._runner.epoch === oldEpoch) {
				this.config = this._resolveConfig(this._config);
				await this._execute(this._runner);
				this._error = void 0;
			}
		} catch (reason) {
			this.ctx.logger.error(reason);
			this._error = reason;
			this._runner.epoch = INACTIVE;
		}
		this._updateState(() => {
			if (this._runner.epoch === oldEpoch) this.inertia = void 0;
			else {
				this.inertia = this._unload();
				return 5;
			}
		});
	}
	async _unload() {
		await Promise.all(this._disposables.clear().map(async (dispose) => {
			try {
				await composeError(async (info) => {
					await Promise.resolve();
					info.error = /* @__PURE__ */ new Error();
					await runDisposable(dispose);
				}, this._runner.getOuterStack);
			} catch (reason) {
				this.ctx.logger.error(reason);
			}
		}));
		this.store = void 0;
		this._updateState(() => {
			if (this._runner.epoch === INACTIVE) this.inertia = void 0;
			else {
				this.inertia = this._reload();
				return 1;
			}
		});
	}
	/**
	* Wait for current lifecycle work and rethrow startup errors.
	*
	* @returns this fiber, once it has settled into a stable state.
	* @throws the config-validation or plugin-startup error, if any.
	*/
	async await() {
		while (this.inertia) await this.inertia;
		if (this._error) throw this._error;
		return this;
	}
	/**
	* Dispose and immediately reload this plugin with its current config.
	*
	* @returns a promise resolving once the reload settled.
	* @throws {CordisError} `INACTIVE_EFFECT` when the fiber is already disposed.
	*/
	async restart() {
		this.assertActive();
		this._setEpoch(INACTIVE);
		this._refresh();
		await this.await();
	}
	/**
	* Validate and apply new config, then restart the plugin.
	*
	* Runs the `internal/update` waterfall first, so update hooks (and HMR)
	* can veto or replace the restart.
	*
	* @param config — the new raw config; validated before anything restarts.
	* @param noSave — hint for persistence hooks not to write the change back.
	* @returns nothing; the restart runs behind the `internal/update` waterfall.
	* @throws {ValidationError} when the new config fails validation.
	*/
	update(config, noSave = false) {
		this.assertActive();
		this._config = config;
		if (this.state !== 2) {
			this._error = void 0;
			this._setEpoch(INACTIVE);
			this._refresh();
			return;
		}
		config = this._resolveConfig(config);
		this.context.waterfall(this, "internal/update", config, noSave, () => {
			this.config = config;
			this._error = void 0;
			return this.restart();
		});
	}
};
function isApplicable(object) {
	return object && typeof object === "object" && typeof object.apply === "function";
}
/**
* Decorator for declaring service dependencies on classes or class methods.
*
* On classes it contributes to the plugin's static `inject` map. On methods it
* delays the method call until the declared services are available.
*/
/**
* @param name — the required service name.
* @param config — optional intercept config applied for that service.
* @returns the class or method decorator.
*/
function Inject(name, config) {
	return function(value, decorator) {
		if (decorator.kind === "class") {
			if (!Object.hasOwn(value, "inject")) {
				defineProperty(value, "inject", Object.create(Object.getPrototypeOf(value).inject ?? null));
				defineProperty(value.inject, symbols.checkProto, true);
			}
			value.inject[name] = config;
		} else if (decorator.kind === "method") {
			const inject = (value[symbols.metadata] ??= {}).inject ??= Object.create(null);
			inject[name] = config;
			decorator.addInitializer(function() {
				const property = this[symbols.tracker]?.property;
				(this[symbols.initHooks] ??= []).push(() => {
					this.ctx.inject(inject, (ctx) => {
						return value.call(property ? withProps(this, { [property]: ctx }) : this);
					});
				});
			});
		} else throw new Error("@Inject() can only be used on class or class methods");
	};
}
/** Utilities for normalizing plugin dependency declarations. */
(function(Inject) {
	/**
	* Convert array/object/class-inherited inject metadata into a plain map.
	*
	* @param inject — the declaration to normalize; `null`/`undefined` add nothing.
	* @param result — the map to fill (service name → intercept config or `null`).
	* @returns `result`.
	*/
	function resolve(inject, result = Object.create(null)) {
		if (!inject) return result;
		if (Array.isArray(inject)) for (const name of inject) result[name] = null;
		else if (Reflect.has(inject, symbols.checkProto)) {
			Object.assign(result, resolve(Object.getPrototypeOf(inject)));
			for (const name of Object.keys(inject)) result[name] = inject[name] ?? null;
		} else for (const name of Object.keys(inject)) result[name] = inject[name] ?? null;
		return result;
	}
	Inject.resolve = resolve;
})(Inject || (Inject = {}));
/**
* Plugin registry installed as `ctx.registry` and mixed into every context.
*
* It normalizes plugin shapes, tracks plugin runtimes, starts fibers, and
* exposes map-like inspection over active plugin callbacks.
*/
var RegistryService = class {
	ctx;
	_counter = 0;
	_internal = /* @__PURE__ */ new Map();
	constructor(ctx) {
		this.ctx = ctx;
		defineProperty(this, symbols.tracker, {
			property: "ctx",
			noShadow: true
		});
	}
	/** Allocate the next fiber uid (increments on every read). */
	get counter() {
		return ++this._counter;
	}
	/** Number of registered plugin runtimes. */
	get size() {
		return this._internal.size;
	}
	/**
	* Resolve a supported plugin shape to its executable callback.
	*
	* @param plugin — a function, class, or `{ apply }` object plugin.
	* @returns the callback identifying the plugin, or `undefined` if invalid.
	*/
	resolve(plugin) {
		try {
			if (typeof plugin === "function") return plugin;
			if (isApplicable(plugin)) return plugin.apply;
		} catch {}
	}
	/**
	* Look up the runtime record for a plugin.
	*
	* @param plugin — any supported plugin shape.
	* @returns the runtime, or `undefined` when the plugin is not registered.
	*/
	get(plugin) {
		const key = this.resolve(plugin);
		return key && this._internal.get(key);
	}
	/**
	* Check whether a plugin has a registered runtime.
	*
	* @param plugin — any supported plugin shape.
	* @returns `true` when at least one fiber of the plugin exists.
	*/
	has(plugin) {
		const key = this.resolve(plugin);
		return !!key && this._internal.has(key);
	}
	/**
	* Dispose every running fiber for a plugin and remove its runtime record.
	*
	* @param plugin — any supported plugin shape.
	* @returns the removed runtime, or `undefined` when none was registered.
	*/
	delete(plugin) {
		const key = this.resolve(plugin);
		const runtime = key && this._internal.get(key);
		if (!runtime) return;
		this._internal.delete(key);
		for (const fiber of runtime.fibers) fiber.dispose();
		return runtime;
	}
	/** Iterate the registered plugin callbacks. */
	keys() {
		return this._internal.keys();
	}
	/** Iterate the registered plugin runtimes. */
	values() {
		return this._internal.values();
	}
	/** Iterate `[callback, runtime]` pairs. */
	entries() {
		return this._internal.entries();
	}
	/**
	* Visit every registered runtime.
	*
	* @param callback — receives each runtime and its identifying callback.
	*/
	forEach(callback) {
		return this._internal.forEach(callback);
	}
	/**
	* Start a callback once the requested dependencies are available.
	*
	* @param inject — required services, as an array or a name → config map.
	* @param callback — plugin body called with `(ctx, config)`.
	* @returns the fiber; awaiting it settles once loading finished.
	*/
	inject(inject, callback) {
		return this.plugin({
			inject,
			apply: callback,
			name: callback.name
		});
	}
	/**
	* Start a plugin in the current context and return its fiber.
	*
	* Creates (or reuses) the plugin's runtime record, then starts a new fiber
	* under the current context. Throws if `plugin` is not a supported shape or
	* if the current fiber is already disposed.
	*
	* @param plugin — a function, class, or `{ apply }` object plugin.
	* @param config — the plugin config, validated against its `Config` schema.
	* @param getOuterStack — captures the caller stack for effect diagnostics.
	* @returns the fiber; awaiting it settles once loading finished.
	*/
	plugin(plugin, config, getOuterStack = buildOuterStack()) {
		const callback = this.resolve(plugin);
		if (!callback) throw new Error("invalid plugin, expect function or object with an \"apply\" method, received " + typeof plugin);
		this.ctx.fiber.assertActive();
		let runtime = this._internal.get(callback);
		if (!runtime) {
			let name = plugin.name;
			if (name === "apply") name = void 0;
			runtime = {
				name,
				callback,
				fibers: new DisposableList(),
				Config: plugin.Config
			};
			this._internal.set(callback, runtime);
		}
		const fiber = new Fiber(this.ctx, config, Inject.resolve(plugin.inject), runtime, getOuterStack);
		const wrapped = Object.create(fiber);
		wrapped.then = (onFulfilled, onRejected) => {
			return fiber.await().then(onFulfilled, onRejected);
		};
		return wrapped;
	}
};
/**
* Root and child dependency containers for Cordis plugins.
*
* A context is a proxy: normal property reads go through the service resolver,
* while `extend()`, `isolate()`, and `intercept()` create scoped child
* contexts without mutating their parent.
*/
var Context = class Context {
	/** Symbol key under which a disposer exposes its {@link EffectMeta} diagnostics tree. */
	static effect = symbols.effect;
	/** Symbol key for a context's listener filter, consulted on every event dispatch. */
	static filter = symbols.filter;
	/** Symbol key of the isolation map (see the `Context[symbols.isolate]` property). */
	static isolate = symbols.isolate;
	/** Symbol key of the intercept map (see the `Context[symbols.intercept]` property). */
	static intercept = symbols.intercept;
	/**
	* Returns true for Cordis context proxies and context prototypes.
	*
	* Works across realms and across multiple copies of cordis, because the
	* brand is keyed by a global symbol rather than by `instanceof`.
	*
	* @param value — the value to test.
	* @returns `true` if `value` is a Cordis context, narrowing its type.
	*/
	static is(value) {
		return !!value?.[Context.is];
	}
	static {
		Context.is[Symbol.toPrimitive] = () => Symbol.for("cordis.is");
		Context.prototype[Context.is] = true;
	}
	/** Create the root context and install the built-in services. */
	constructor() {
		this[symbols.isolate] = Object.create(null);
		this[symbols.intercept] = Object.create(null);
		const self = new Proxy(this, ReflectService.handler);
		this.root = self;
		this.baseUrl = void 0;
		this.fiber = new Fiber(self, {}, Object.create(null), null, () => []);
		this.reflect = new ReflectService(self);
		this.registry = new RegistryService(self);
		this.events = new EventsService(self);
		this.logger = new LoggerService(self);
		this.fiber._disposables.clear();
		return self;
	}
	[Symbol.for("nodejs.util.inspect.custom")]() {
		return `Context <${this.fiber.name}>`;
	}
	/**
	* Create a child context with extra metadata on top of the current scope.
	*
	* The child prototypally inherits every property of this context; own
	* properties of `meta` shadow the inherited ones. The parent is not mutated.
	*
	* @param meta — own properties (including symbol keys) to define on the child.
	* @returns a child context inheriting from this one.
	*/
	extend(meta = {}) {
		const shadow = Reflect.getOwnPropertyDescriptor(this, symbols.shadow)?.value;
		const self = Object.create(getTraceable(this, this));
		for (const prop of Reflect.ownKeys(meta)) Object.defineProperty(self, prop, Reflect.getOwnPropertyDescriptor(meta, prop));
		if (!shadow) return self;
		return Object.assign(Object.create(self), { [symbols.shadow]: shadow });
	}
	/**
	* Create a child context with an independent service scope for `name`.
	*
	* Below the returned context, reads and writes of the service `name`
	* resolve against the new label instead of the parent's, so a different
	* implementation can be provided without affecting the parent scope.
	* Passing the same `label` to two `isolate()` calls joins their scopes.
	*
	* @param name — the service name to isolate.
	* @param label — scope label to join; defaults to a fresh unique symbol.
	* @returns a child context whose `name` service resolves in the new scope.
	*/
	isolate(name, label) {
		const shadow = Object.create(this[symbols.isolate]);
		shadow[name] = label ?? Symbol(name);
		return this.extend({ [symbols.isolate]: shadow });
	}
	intercept(name, config) {
		const intercept = Object.create(this[symbols.intercept]);
		intercept[name] = config;
		return this.extend({ [symbols.intercept]: intercept });
	}
};
/**
* Base class for services that expose a named API on `ctx`.
*
* Subclasses call `super(ctx, name)` from their constructor. The service is
* registered immediately and is automatically removed with the owning fiber.
*/
var Service = class Service {
	ctx;
	/** Symbol key of an instance method run after construction (class plugins). */
	static init = symbols.init;
	/** Symbol key of the availability predicate passed to `ctx.provide()`. */
	static check = symbols.check;
	/** Symbol key of the phantom intercept-config type parameter. */
	static config = symbols.config;
	/** Symbol key of the call body making a service callable (e.g. `ctx.logger()`). */
	static invoke = symbols.invoke;
	/** Symbol key of the helper deriving an extended service instance. */
	static extend = symbols.extend;
	/** Symbol key of the tracker metadata used for context tracing. */
	static tracker = symbols.tracker;
	/** Symbol key of the intercept-config resolution helper below. */
	static resolveConfig = symbols.resolveConfig;
	/** The service name this instance is registered under. */
	name;
	/**
	* Register this instance as `name` in the current context.
	*
	* Calls `ctx.reflect.provide(name, this, this[Service.check])`, so the
	* service is unregistered automatically when the owning fiber unloads.
	* Services with a `[Service.invoke]` body return a callable instance.
	*
	* @param ctx — the context to register in (stored as `this.ctx`).
	* @param name — the service name; defaults to the static `provide` field.
	*/
	constructor(ctx, name) {
		this.ctx = ctx;
		name ??= this.constructor["provide"];
		let self = this;
		const tracker = {
			associate: name,
			property: "ctx"
		};
		if (self[symbols.invoke]) self = createCallable(name, joinPrototype(Object.getPrototypeOf(this), Function.prototype), tracker);
		self.ctx = ctx;
		self.name = name;
		defineProperty(self, symbols.tracker, tracker);
		self.ctx.reflect.provide(name, self, this[symbols.check]);
		return self;
	}
	[symbols.filter](ctx) {
		return ctx[symbols.isolate][this.name] === this.ctx[symbols.isolate][this.name];
	}
	[symbols.extend](props) {
		let self;
		if (this[Service.invoke]) self = createCallable(this.name, this, this[symbols.tracker]);
		else self = Object.create(this);
		return Object.assign(self, props);
	}
	/**
	* Merge intercept config from ancestors with optional base and head values.
	*
	* Entries added closer to the root apply first; `base` is prepended and
	* `head` appended. Uses `Config.merge` when the service declares one,
	* otherwise a shallow `Object.assign`.
	*
	* @param base — lowest-precedence config merged before all intercepts.
	* @param head — highest-precedence config merged after all intercepts.
	* @returns the merged config.
	*/
	[symbols.resolveConfig](base, head) {
		let intercept = this.ctx[Context.intercept];
		const configs = [];
		while (this.name in intercept) {
			if (Object.hasOwn(intercept, this.name)) configs.unshift(intercept[this.name]);
			intercept = Object.getPrototypeOf(intercept);
		}
		if (base) configs.unshift(base);
		if (head) configs.push(head);
		if (this["Config"]?.merge) return this["Config"].merge(...configs);
		else return Object.assign({}, ...configs);
	}
	static [Symbol.hasInstance](instance) {
		if (!instance) return false;
		let constructor = instance.constructor;
		while (constructor) {
			constructor = constructor.prototype?.constructor;
			if (constructor === this) return true;
			constructor &&= Object.getPrototypeOf(constructor);
		}
		return false;
	}
};
//#endregion
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
//#region ../../../deepseek-harness/packages/typert/protocol/lib/index.js
/** The one Remote failure class shared by owners, the Gateway, and consumers. */
/**
* One Remote call failure: a real Error carrying its stable code and typed
* details. Owners throw it at the failure point; the Host Gateway encodes it
* onto the wire unchanged; the Client face rebuilds an instance for the
* `RemoteResult` error branch, so `throw result.error` keeps throw semantics.
* Discrimination is always by `code`, never by instanceof.
*/
var RemoteError = class extends Error {
	code;
	details;
	/** Structural marker: cross-realm/bundle identification never uses instanceof. */
	isDSHRemoteError = true;
	/**
	* @param code - stable failure code declared in {@link RemoteErrorDetailsMap}.
	* @param message - human diagnostic carried across the wire.
	* @param details - structured payload typed by the code.
	* @param options - standard Error options (`cause` survives in-process only).
	*/
	constructor(code, message, details, options) {
		super(message, options);
		this.code = code;
		this.details = details;
		this.name = "RemoteError";
	}
};
/**
* Remote decorators and explicit Gateway bindings backed by versioned
* descriptors carried on decorated class prototypes. Strict reflection
* remains a Typert compiler responsibility.
* @module @deepseek-ai/dsh-typert-protocol
*/
const TYPERT_REMOTE_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/;
/**
* Test one generated Remote name against the Connection endpoint grammar.
* @param value - namespace, method, lookup, or Context segment.
* @returns whether the value can cross the shared RPC carrier unchanged.
*/
function isTypertRemoteSegment(value) {
	return value !== "." && value !== ".." && TYPERT_REMOTE_SEGMENT_PATTERN.test(value);
}
const REMOTE_METHOD_DESCRIPTOR = "@deepseek-ai/dsh-typert-protocol/remote-methods";
/**
* Bind one visible Service field to a Cordis key and Remote namespace. A
* service that owns a Cordis Context also gives its tree `ctx.invocation`,
* `undefined` outside a Remote call, so no `TypertRemoteService` is needed for
* a Host composition to read it.
* @param service - owning Service instance, normally `this`.
* @param serviceKey - exact Cordis service key.
* @param options - optional distinct wire namespace.
* @returns a frozen, inspectable binding with no compiler-injected metadata.
*/
function bindTypertRemote(service, serviceKey, options = {}) {
	validateName("service key", serviceKey);
	const namespace = options.namespace ?? serviceKey;
	validateName("namespace", namespace);
	const ctx = Reflect.get(service, "ctx");
	if (ctx instanceof Context) provideInvocationAccessor(ctx);
	return Object.freeze({
		service,
		serviceKey,
		namespace
	});
}
/** Cordis Service base that exposes its registered name through Typert Gateway. */
var TypertRemoteService = class extends Service {
	/** Visible binding consumed by the Gateway's source-mode discovery. */
	typertRemote;
	/**
	* Register the Service and bind the same key to Typert Gateway.
	* @param ctx - owning Cordis Context.
	* @param serviceKey - exact Cordis service key and default wire namespace.
	* @param options - optional distinct wire namespace.
	*/
	constructor(ctx, serviceKey, options = {}) {
		super(ctx, serviceKey);
		this.typertRemote = bindTypertRemote(this, this.name, options);
	}
};
/**
* Make `ctx.invocation` read as `undefined` outside a Remote call instead of the
* reflect service's "cannot get property" error; a call-derived Context shadows
* the accessor with its own property. The first Remote Service constructed in a
* tree registers it on the root, where it outlives any one Service.
*/
function provideInvocationAccessor(ctx) {
	if (Object.hasOwn(ctx.root.reflect.props, "invocation")) return;
	ctx.root.accessor("invocation", { get: () => void 0 });
}
function Remote(methodExportOrOptions, context) {
	if (typeof methodExportOrOptions === "string") {
		validateName("Remote export name", methodExportOrOptions);
		return remoteDecorator({ kind: "direct" }, void 0, methodExportOrOptions);
	}
	if (typeof methodExportOrOptions === "object") {
		if (remoteOptionMode(methodExportOrOptions) !== "stream" || Reflect.ownKeys(methodExportOrOptions).length !== 1) throw new TypeError("typert-protocol: Remote options must contain exactly mode: \"stream\"");
		return remoteDecorator({ kind: "direct" }, "stream");
	}
	if (context === void 0) throw new TypeError("typert-protocol: Remote decorator context is missing");
	addMarkerInitializer(context, { kind: "direct" });
}
function remoteOptionMode(options) {
	return Reflect.get(options, "mode");
}
function remoteDecorator(invocation, mode, exportName) {
	return function(_method, context) {
		addMarkerInitializer(context, invocation, mode, exportName);
	};
}
function readRemoteMethodDescriptor(prototype) {
	const property = Object.getOwnPropertyDescriptor(prototype, REMOTE_METHOD_DESCRIPTOR);
	if (property === void 0) return void 0;
	const descriptor = property.value;
	if (descriptor === null || typeof descriptor !== "object") throw new TypeError("typert-protocol: Remote method descriptor must be an object");
	const version = Reflect.get(descriptor, "version");
	if (version !== 1) throw new TypeError(`typert-protocol: unsupported Remote method descriptor version ${String(version)}`);
	const methods = Reflect.get(descriptor, "methods");
	if (!Array.isArray(methods)) throw new TypeError("typert-protocol: Remote method descriptor methods must be an array");
	return descriptor;
}
function addMarkerInitializer(context, invocation, mode, exportName) {
	if (context.private || context.static || typeof context.name !== "string") throw new TypeError("typert-protocol: Remote decorators require a public instance method with a string name");
	const method = context.name;
	context.addInitializer(function() {
		const prototype = Object.getPrototypeOf(this);
		if (prototype === null) throw new TypeError(`typert-protocol: cannot mark Remote method "${method}" on an object without a prototype`);
		mark(prototype, method, invocation, mode, exportName);
	});
}
function mark(prototype, method, invocation, mode, exportName) {
	const descriptor = readRemoteMethodDescriptor(prototype);
	const marker = Object.freeze({
		method,
		...exportName === void 0 || exportName === method ? {} : { exportName },
		...mode === void 0 ? {} : { mode },
		invocation: Object.freeze(invocation)
	});
	const current = descriptor?.methods.find((candidate) => candidate.method === method);
	if (current !== void 0) {
		if (current.exportName === marker.exportName && current.mode === marker.mode && sameInvocation(current.invocation, invocation)) return;
		throw new Error(`typert-protocol: Remote method "${method}" has conflicting invocation markers`);
	}
	Object.defineProperty(prototype, REMOTE_METHOD_DESCRIPTOR, {
		configurable: true,
		value: Object.freeze({
			version: 1,
			methods: Object.freeze([...descriptor?.methods ?? [], marker])
		})
	});
}
function sameInvocation(left, right) {
	if (left.kind === "direct") return right.kind === "direct";
	if (right.kind === "direct") return false;
	return left.context === right.context;
}
function validateName(subject, value) {
	if (!isTypertRemoteSegment(value)) throw new TypeError(`typert-protocol: ${subject} must contain only RPC endpoint segment characters`);
}
//#endregion
//#region ../../../deepseek-harness/packages/util/values/lib/index.js
/** Duplicate-install-safe JSON and immutable-value helpers. @module @deepseek-ai/dsh-util-values */
/**
* Mark an unreachable closed-union branch.
* @param value - impossible value; an unhandled typed variant fails at the call site.
* @param context - optional switch-site label included in the failure message.
* @returns never; a runtime value that escaped its type always throws.
*/
function assertNever(value, context) {
	const rendered = JSON.stringify(value) ?? String(value);
	throw new Error(`unreachable variant${context ? ` in ${context}` : ""}: ${rendered}`);
}
/** Whether a realm-owned intrinsic prototype has a native constructor matching this engine's representation. */
function hasIntrinsicConstructor$1(prototype, name) {
	const constructor = Object.getOwnPropertyDescriptor(prototype, "constructor")?.value;
	if (typeof constructor !== "function") return false;
	try {
		return constructor.name === name && constructor.prototype === prototype && Function.prototype.toString.call(constructor) === Function.prototype.toString.call(name === "Array" ? Array : Object);
	} catch {
		return false;
	}
}
/** Whether a candidate is one realm's intrinsic `Object.prototype`. */
function isIntrinsicObjectPrototype$1(value) {
	return Object.getPrototypeOf(value) === null && hasIntrinsicConstructor$1(value, "Object");
}
/** Whether an array uses one realm's intrinsic `Array.prototype`, not a subclass or forged prototype. */
function hasPlainArrayPrototype$1(value) {
	const prototype = Object.getPrototypeOf(value);
	if (!Array.isArray(prototype) || !hasIntrinsicConstructor$1(prototype, "Array")) return false;
	const objectPrototype = Object.getPrototypeOf(prototype);
	return typeof objectPrototype === "object" && objectPrototype !== null && isIntrinsicObjectPrototype$1(objectPrototype);
}
/** Whether an object is a plain or null-prototype record from any JavaScript realm. */
function hasPlainObjectPrototype(value) {
	const prototype = Object.getPrototypeOf(value);
	return prototype === null || typeof prototype === "object" && isIntrinsicObjectPrototype$1(prototype);
}
/** Return every JSON-visible object key, or reject own data JSON would discard. */
function enumerableStringKeys(value) {
	const keys = Reflect.ownKeys(value);
	if (keys.some((key) => typeof key !== "string" || !Object.prototype.propertyIsEnumerable.call(value, key))) return void 0;
	return keys;
}
/** Validate lossless JSON iteratively, optionally materializing a detached snapshot. */
function walkJsonValue(value, detach) {
	const ancestors = /* @__PURE__ */ new Set();
	let root;
	const assign = (destination, item) => {
		if (destination === void 0) return;
		if (destination.kind === "root") root = item;
		else if (destination.kind === "array") destination.target[destination.index] = item;
		else Object.defineProperty(destination.target, destination.key, {
			value: item,
			enumerable: true,
			configurable: true,
			writable: true
		});
	};
	const tasks = [{
		kind: "visit",
		value,
		...detach ? { destination: { kind: "root" } } : {}
	}];
	for (let task = tasks.pop(); task !== void 0; task = tasks.pop()) {
		if (task.kind === "leave") {
			ancestors.delete(task.source);
			continue;
		}
		if (task.kind === "array-item") {
			if (!Object.prototype.hasOwnProperty.call(task.source, task.index)) return void 0;
			tasks.push({
				kind: "visit",
				value: task.source[task.index],
				...task.target === void 0 ? {} : { destination: {
					kind: "array",
					target: task.target,
					index: task.index
				} }
			});
			continue;
		}
		if (task.kind === "object-property") {
			tasks.push({
				kind: "visit",
				value: task.source[task.key],
				...task.target === void 0 ? {} : { destination: {
					kind: "object",
					target: task.target,
					key: task.key
				} }
			});
			continue;
		}
		const current = task.value;
		if (current === null) {
			assign(task.destination, null);
			continue;
		}
		if (typeof current === "boolean" || typeof current === "string") {
			assign(task.destination, current);
			continue;
		}
		if (typeof current === "number") {
			if (!Number.isFinite(current) || Object.is(current, -0)) return void 0;
			assign(task.destination, current);
			continue;
		}
		if (typeof current !== "object") return void 0;
		if (ancestors.has(current)) return void 0;
		if (Array.isArray(current)) {
			if (!hasPlainArrayPrototype$1(current)) return void 0;
			const length = current.length;
			if (Reflect.ownKeys(current).length !== length + 1) return void 0;
			const target = detach ? [] : void 0;
			if (target !== void 0) assign(task.destination, target);
			ancestors.add(current);
			tasks.push({
				kind: "leave",
				source: current
			});
			for (let index = length - 1; index >= 0; index--) tasks.push({
				kind: "array-item",
				source: current,
				index,
				...target === void 0 ? {} : { target }
			});
			continue;
		}
		if (!hasPlainObjectPrototype(current)) return void 0;
		const keys = enumerableStringKeys(current);
		if (keys === void 0) return void 0;
		const target = detach ? {} : void 0;
		if (target !== void 0) assign(task.destination, target);
		ancestors.add(current);
		tasks.push({
			kind: "leave",
			source: current
		});
		for (let index = keys.length - 1; index >= 0; index--) {
			const key = keys[index];
			/* v8 ignore next -- the loop is bounded by the captured key count. */
			if (key === void 0) return void 0;
			tasks.push({
				kind: "object-property",
				source: current,
				key,
				...target === void 0 ? {} : { target }
			});
		}
	}
	return detach ? root : true;
}
/**
* Validate and detach lossless JSON in one read per property.
* @param value - candidate value to validate and detach.
* @returns the detached snapshot, or `undefined` when the value is not losslessly JSON-serializable.
*/
function snapshotJsonValue(value) {
	return walkJsonValue(value, true);
}
/**
* Test the same lossless JSON rules as {@link snapshotJsonValue} without detaching the value.
* @param value - candidate value to test.
* @returns whether the value survives a JSON round trip without loss.
*/
function isJsonValue(value) {
	return walkJsonValue(value, false) === true;
}
/**
* Deep-freeze an object graph in place while leaving live AbortSignal objects mutable.
* @param value - value to freeze.
* @returns the same value after every reachable enumerable child is frozen.
*/
function deepFreeze(value) {
	const seen = /* @__PURE__ */ new WeakSet();
	const pending = [{
		kind: "visit",
		node: value
	}];
	while (pending.length > 0) {
		const task = pending.pop();
		/* v8 ignore next -- the loop condition guarantees one pending task. */
		if (task === void 0) continue;
		if (task.kind === "property") {
			pending.push({
				kind: "visit",
				node: task.source[task.key]
			});
			continue;
		}
		const node = task.node;
		if (node === null || typeof node !== "object") continue;
		if (node instanceof AbortSignal) continue;
		if (seen.has(node)) continue;
		seen.add(node);
		Object.freeze(node);
		const keys = Object.keys(node);
		for (let index = keys.length - 1; index >= 0; index--) {
			const key = keys[index];
			/* v8 ignore next -- the loop is bounded by the captured key count. */
			if (key === void 0) continue;
			pending.push({
				kind: "property",
				source: node,
				key
			});
		}
	}
	return value;
}
//#endregion
//#region ../../../deepseek-harness/packages/util/crypto/lib/index.js
/**
* Random v4 UUID, minted from `crypto.getRandomValues`.
* @returns the UUID string.
*/
function randomUUID() {
	const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
	const hex = Array.from(bytes, (byte, index) => {
		return (index === 6 ? byte & 15 | 64 : index === 8 ? byte & 63 | 128 : byte).toString(16).padStart(2, "0");
	}).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
//#endregion
//#region ../../../deepseek-harness/packages/util/brand/lib/index.js
/**
* Duplicate-install-safe nominal primitive helpers.
*
* A brand makes structurally identical strings or numbers non-interchangeable
* at the type level: a `SessionId` cannot be passed where a `ToolCallId` is
* expected, and an event sequence cannot be passed as a log offset. Comparison,
* logging, and serialization retain the underlying primitive behavior.
*
* This package owns no concrete domain value and keeps no runtime identity or mutable
* state, so independently installed copies produce interchangeable values.
*
* @module @deepseek-ai/dsh-brand
*/
/**
* Apply a compile-time string brand without changing the value.
* @param value - string admitted by the domain that owns the target brand.
* @returns the same string with the requested compile-time brand.
*/
function brandString(value) {
	return value;
}
//#endregion
//#region ../../../deepseek-harness/packages/util/timeout/lib/index.js
/** Largest delay Node schedules without clamping it to one millisecond. */
const MAX_TIMER_DELAY_MS = 2147483647;
//#endregion
//#region ../../../deepseek-harness/packages/llm/llm/lib/index.js
/**
* Detach and deep-freeze a message whose identity already exists.
* @param message - complete message, including its stable identity.
* @returns an immutable snapshot that preserves the identity.
*/
function freezeMessage(message) {
	return deepFreeze(structuredClone(message));
}
/**
* Create one identified message and freeze it before publication.
* @param input - complete role, content, and source for a new message.
* @returns an immutable message with a fresh stable identity.
*/
function createMessage(input) {
	return deepFreeze(structuredClone({
		...input,
		id: brandString(randomUUID())
	}));
}
/**
* Create one identified user-role message and freeze it before publication.
* @param input - complete content and source for a new user message.
* @returns an immutable user message with a fresh stable identity.
*/
function createUserMessage(input) {
	return createMessage({
		...input,
		role: "user"
	});
}
/**
* Harness error base with a stable machine-routable code and chained cause.
* Package errors extend it so tool results and replay can retain failure class.
* @module @deepseek-ai/dsh-llm/error
*/
/**
* Base class for all harness errors. Carries a `code` (stable, programmatic —
* e.g. `NO_ADAPTER`, `INVALID_ARGS`, `INVARIANT`) distinct from the
* human-readable `message`, and supports `cause` chaining via the standard
* `ErrorOptions`. `name` defaults to the subclass constructor name.
*/
var HarnessError = class extends Error {
	/** Stable machine-routable failure class (e.g. `RATE_LIMIT`); route on this, never by parsing `message`. */
	code;
	constructor(message, code, options) {
		super(message, options);
		this.code = code;
		this.name = new.target.name;
	}
};
/**
* Canonical provider-neutral code for a response that completed normally but
* carried no content blocks at all. Providers occasionally emit a degenerate
* completion (a terminal stop with zero output); adapters classify it as this
* failure instead of yielding an empty assistant message, because an empty
* message silently ends the turn with nothing for the user or the loop to act
* on. The attempt produced nothing durable, so retry policy treats it as safe
* to repeat.
*/
const EMPTY_RESPONSE_CODE = "EMPTY_RESPONSE";
new RegExp(String.raw`(?:^|[^a-z0-9])context[\s_-](?:length|window)[\s_-]` + String.raw`(?:exceed(?:ed|s)?|overflow(?:ed)?|limit[\s_-]exceeded)(?:$|[^a-z0-9])`, "i");
new RegExp(String.raw`\b(?:request|prompt|input|messages?)\s+(?:is\s+|are\s+)?` + String.raw`too\s+(?:large|long)\s+for\s+(?:(?:this|the)\s+)?` + String.raw`(?:model(?:'s)?\s+)?context(?:\s+window)?\b`, "i");
new RegExp(String.raw`\b(?:input|prompt|request|messages?)\b.{0,40}` + String.raw`\b(?:exceed(?:s|ed)?|overflows?|is\s+larger\s+than)\b.{0,40}` + String.raw`\b(?:the\s+)?(?:model(?:'s)?\s+)?context(?:\s+(?:length|window))?\b`, "i");
/**
* Provider-owned request-retry policy configuration and resolution.
*
* Adapters expose one resolved policy per registered provider route; the
* optional dsh-llm-retry plugin executes it on the agent's failed-step extension point.
*
* @module @deepseek-ai/dsh-llm/retry-policy
*/
const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_INITIAL_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 1e4;
const DEFAULT_JITTER_RATIO = .1;
const DEFAULT_RETRYABLE_CODES = Object.freeze([
	EMPTY_RESPONSE_CODE,
	"RATE_LIMIT",
	"SERVER",
	"TIMEOUT",
	"TRANSPORT"
]);
const backoffSchema = Schema.object({
	initialDelayMs: Schema.number().max(MAX_TIMER_DELAY_MS).default(DEFAULT_INITIAL_DELAY_MS),
	maxDelayMs: Schema.number().max(MAX_TIMER_DELAY_MS).default(DEFAULT_MAX_DELAY_MS),
	jitterRatio: Schema.number().min(0).max(1).default(DEFAULT_JITTER_RATIO)
});
const normalPolicySchema = Schema.object({
	mode: Schema.const("normal").required(),
	maxRetries: Schema.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_RETRIES),
	retryableCodes: Schema.array(Schema.string()).default([...DEFAULT_RETRYABLE_CODES]),
	backoff: backoffSchema
});
const alwaysPolicySchema = Schema.object({
	mode: Schema.const("always").required(),
	backoff: backoffSchema
});
Schema.union([normalPolicySchema, alwaysPolicySchema]);
const NORMAL_POLICY_KEYS = new Set([
	"mode",
	"maxRetries",
	"retryableCodes",
	"backoff"
]);
const ALWAYS_POLICY_KEYS = new Set([
	"mode",
	"maxRetries",
	"retryableCodes",
	"backoff"
]);
const BACKOFF_KEYS = new Set([
	"initialDelayMs",
	"maxDelayMs",
	"jitterRatio"
]);
function validateKeys(value, allowed, path) {
	for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`${path}: unknown key "${key}"`);
}
function resolveBackoff(config, path) {
	if (config !== void 0) validateKeys(config, BACKOFF_KEYS, path);
	const initialDelayMs = config?.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
	const maxDelayMs = config?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
	const jitterRatio = config?.jitterRatio ?? DEFAULT_JITTER_RATIO;
	if (!Number.isFinite(initialDelayMs) || initialDelayMs <= 0 || initialDelayMs > 2147483647) throw new Error(`${path}.initialDelayMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`);
	if (!Number.isFinite(maxDelayMs) || maxDelayMs <= 0 || maxDelayMs > 2147483647) throw new Error(`${path}.maxDelayMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`);
	if (initialDelayMs > maxDelayMs) throw new Error(`${path}.initialDelayMs must be less than or equal to maxDelayMs`);
	if (!Number.isFinite(jitterRatio) || jitterRatio < 0 || jitterRatio > 1) throw new Error(`${path}.jitterRatio must be between 0 and 1`);
	return Object.freeze({
		initialDelayMs,
		maxDelayMs,
		jitterRatio
	});
}
/**
* Validate, default, and detach one provider-owned retry policy.
* @param config - optional provider configuration; omission selects normal defaults.
* @param path - diagnostic path naming the provider config that owns the value.
* @returns an immutable policy safe to capture in provider registration state.
*/
function resolveRetryPolicy(config, path) {
	if (config === void 0) return Object.freeze({
		mode: "normal",
		maxRetries: DEFAULT_MAX_RETRIES,
		retryableCodes: DEFAULT_RETRYABLE_CODES,
		...resolveBackoff(void 0, `${path}.backoff`)
	});
	switch (config.mode) {
		case "normal": {
			validateKeys(config, NORMAL_POLICY_KEYS, path);
			const maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
			const retryableCodes = config.retryableCodes ?? [...DEFAULT_RETRYABLE_CODES];
			if (!Number.isSafeInteger(maxRetries) || maxRetries < 0) throw new Error(`${path}.maxRetries must be a non-negative safe integer`);
			if (retryableCodes.length === 0) throw new Error(`${path}.retryableCodes must not be empty`);
			if (retryableCodes.some((code) => typeof code !== "string" || code.length === 0)) throw new Error(`${path}.retryableCodes must contain only non-empty strings`);
			if (new Set(retryableCodes).size !== retryableCodes.length) throw new Error(`${path}.retryableCodes must not contain duplicates`);
			return Object.freeze({
				mode: "normal",
				maxRetries,
				retryableCodes: Object.freeze([...retryableCodes]),
				...resolveBackoff(config.backoff, `${path}.backoff`)
			});
		}
		case "always":
			validateKeys(config, ALWAYS_POLICY_KEYS, path);
			return Object.freeze({
				mode: "always",
				...resolveBackoff(config.backoff, `${path}.backoff`)
			});
		default: throw new Error(`${path}.mode must be "normal" or "always"`);
	}
}
/**
* Field-wise equality over {@link LlmCallConfig} — the comparison a caller
* runs to decide whether a proposed configuration is a real change (worth a
* logged header snapshot) or the held one restated.
* @param a - one configuration.
* @param b - the other.
* @returns whether every field (including the `stop` list, element-wise) matches.
*/
function callConfigEquals(a, b) {
	if (a.provider !== b.provider || a.model !== b.model || a.reasoningEffort !== b.reasoningEffort || a.temperature !== b.temperature || a.maxTokens !== b.maxTokens) return false;
	if (a.stop === void 0 || b.stop === void 0) return a.stop === b.stop;
	return a.stop.length === b.stop.length && a.stop.every((s, i) => s === b.stop?.[i]);
}
/**
* Normalization for values thrown by a final LLM adapter boundary.
*
* @module @deepseek-ai/dsh-llm/adapter-failure
*/
/**
* Detach serializable provider facts from a value thrown by an adapter.
* @param value - arbitrary value thrown during adapter dispatch or iteration.
* @returns immutable provider-neutral facts suitable for a terminal finish chunk.
* @internal
*/
function normalizeLlmFailure(value) {
	const error = value instanceof Error ? value : new HarnessError(thrownMessage(value), "UNKNOWN", { cause: value });
	const carried = ownFailureSnapshot(error);
	if (carried !== void 0 && carried.code === ownErrorCode(error)) return carried;
	return Object.freeze({
		message: errorMessage$1(error),
		code: harnessErrorCode(error)
	});
}
/** Render a non-Error throw without letting hostile coercion escape normalization. */
function thrownMessage(value) {
	try {
		const message = String(value);
		return message.length > 0 ? message : "LLM adapter failed";
	} catch (_hostileThrownValue) {
		return "LLM adapter failed";
	}
}
/** Read a foreign error's own data-backed `code` without invoking accessors. */
function ownErrorCode(error) {
	try {
		const descriptor = Object.getOwnPropertyDescriptor(error, "code");
		return descriptor !== void 0 && "value" in descriptor ? descriptor.value : void 0;
	} catch (_sdkPropertyTrap) {
		return;
	}
}
/** Snapshot an own data property without invoking an SDK-defined accessor. */
function ownFailureSnapshot(error) {
	try {
		const descriptor = Object.getOwnPropertyDescriptor(error, "failure");
		return descriptor !== void 0 && "value" in descriptor ? failureSnapshot(descriptor.value) : void 0;
	} catch (_sdkPropertyTrap) {
		return;
	}
}
/** Validate and detach an arbitrary serializable failure payload. */
function failureSnapshot(value) {
	if (typeof value !== "object" || value === null) return void 0;
	try {
		const candidate = value;
		const message = candidate.message;
		const code = candidate.code;
		const status = candidate.status;
		const providerRetryAfterMs = candidate.providerRetryAfterMs;
		const requestId = candidate.requestId;
		const offloadImages = candidate.offloadImages;
		if (typeof message !== "string" || message.length === 0 || typeof code !== "string" || code.length === 0 || status !== void 0 && (!Number.isInteger(status) || status < 100 || status > 599) || providerRetryAfterMs !== void 0 && (!Number.isFinite(providerRetryAfterMs) || providerRetryAfterMs <= 0) || requestId !== void 0 && (typeof requestId !== "string" || requestId.length === 0) || offloadImages !== void 0 && (!Number.isSafeInteger(offloadImages) || offloadImages <= 0)) return void 0;
		return Object.freeze({
			message,
			code,
			...status === void 0 ? {} : { status },
			...providerRetryAfterMs === void 0 ? {} : { providerRetryAfterMs },
			...requestId === void 0 ? {} : { requestId },
			...offloadImages === void 0 ? {} : { offloadImages }
		});
	} catch (_sdkFailureGetter) {
		return;
	}
}
/** Read an SDK error message without letting an accessor replace the primary failure. */
function errorMessage$1(error) {
	try {
		const message = error.message;
		if (typeof message === "string" && message.length > 0) return message;
	} catch (_sdkMessageGetter) {}
	return "LLM adapter failed";
}
/** Trust only Harness-owned codes; third-party SDK codes are not our taxonomy. */
function harnessErrorCode(error) {
	return error instanceof HarnessError ? error.code : "UNKNOWN";
}
function quoted(value) {
	return JSON.stringify(value);
}
/**
* Stable text shown to a model that cannot accept one durable image reference.
* @param ref - durable normalized attachment omitted from the request.
* @returns deterministic text-only placeholder.
*/
function textOnlyImageText(ref) {
	return `[image omitted because this model accepts text only; attachment sha256:${String(ref.attachmentId).slice(7, 15)}]`;
}
/**
* True when typed model content contains an image block. This is the one image
* walk shared by every image policy (capability gating, text-only
* serialization, compaction survey), so a consumer cannot silently diverge.
* @param content - typed model content blocks.
* @returns whether any block is an image.
*/
function contentHasImage(content) {
	return content.some((block) => block.type === "image");
}
/**
* True when typed model content contains a file block.
* Reads current content on every call without retaining scan results.
* @param content - typed model content blocks.
* @returns whether any block is a file.
*/
function contentHasFile(content) {
	for (const block of content) if (block.type === "file") return true;
	return false;
}
/**
* Stable model-facing handle for one durable file reference: the address of
* the verbatim stored copy and the instruction to read it on demand. This is
* the only representation a provider ever receives for a file.
* @param ref - durable verbatim file reference.
* @param readonlyPath - execution-world path of the stored copy, when resolvable.
* @returns deterministic handle text naming the file, its size, and its address.
*/
function fileHandleText(ref, readonlyPath) {
	const digest = String(ref.attachmentId).slice(7, 15);
	const identity = `File ${quoted(ref.name)} (${ref.bytes} bytes, sha256:${digest})`;
	if (readonlyPath === void 0) return `[${identity} was uploaded, but the current execution environment cannot access a readable path. Report that limitation if its contents are needed; do not claim to have read it.]`;
	return `[${identity}: verbatim read-only copy saved at ${quoted(readonlyPath)}. Read that path with your file tools when its contents are needed; copy it to a writable location before modifying it. When delegating file work, include this saved path in the delegation prompt; only subagents sharing this execution environment can read it.]`;
}
/** Replace every file occurrence with handle text. */
function replaceFilesWithHandles(blocks, resolvePath) {
	let next;
	for (const [index, block] of blocks.entries()) {
		if (block.type === "file") {
			next ??= blocks.slice(0, index);
			next.push({
				type: "text",
				text: fileHandleText(block.attachment, resolvePath(block.attachment))
			});
			continue;
		}
		next?.push(block);
	}
	return next ?? blocks;
}
function projectFilesToText(messages, resolvePath) {
	if (!messages.some((message) => contentHasFile(message.content))) return messages;
	return messages.map((message) => {
		const content = replaceFilesWithHandles(message.content, resolvePath);
		return content === message.content ? message : {
			...message,
			content
		};
	});
}
/** Replace every image occurrence for a text-only model. */
function replaceImagesForTextModel(blocks) {
	let next;
	for (const [index, block] of blocks.entries()) {
		if (block.type === "image") {
			next ??= blocks.slice(0, index);
			next.push({
				type: "text",
				text: textOnlyImageText(block.attachment)
			});
			continue;
		}
		next?.push(block);
	}
	return next ?? blocks;
}
function projectImagesForTextModel(messages) {
	if (!messages.some((message) => contentHasImage(message.content))) return messages;
	return messages.map((message) => {
		const content = replaceImagesForTextModel(message.content);
		return content === message.content ? message : {
			...message,
			content
		};
	});
}
function withoutDeveloperMessages(messages) {
	const retained = messages.filter((message) => message.role !== "developer");
	return retained.length === messages.length ? messages : retained;
}
function toolDeclarations(tools, mode, history) {
	const declarations = new Map(history.tools.map((tool) => [tool.name, tool]));
	for (const update of history.updates) for (const tool of update.additions) if (!declarations.has(tool.name)) declarations.set(tool.name, {
		...tool,
		deferLoading: true
	});
	switch (mode) {
		case "in-history": return declarations;
		case "addition-only": {
			const activeNames = new Set(tools?.map((tool) => tool.name));
			for (const name of declarations.keys()) if (!activeNames.has(name)) declarations.delete(name);
			return declarations;
		}
		/* v8 ignore next 2 -- closed-union exhaustiveness guard */
		default: return assertNever(mode);
	}
}
/**
* Construct provider declarations from session-folded history without changing logged active tools.
* Unsupported routes and incomplete history use current declarations without developer updates.
* Explicitly deferred baseline tools become available only after their first retained addition.
* @param messages - complete request inputs, or the prefix selected for an auxiliary call.
* @param tools - currently active tool schemas.
* @param toolUpdate - the resolved route's update mode.
* @param history - immutable state folded from committed headers and developer messages.
* @returns provider declarations and the corresponding filtered history.
*/
function projectToolUpdates(messages, tools, toolUpdate, history) {
	if (toolUpdate === void 0) {
		let immediateTools = tools;
		if (tools?.some((tool) => tool.deferLoading === true)) immediateTools = tools.map(({ deferLoading: _loading, ...tool }) => tool);
		return {
			messages: withoutDeveloperMessages(messages),
			tools: immediateTools
		};
	}
	if (history === void 0) return {
		messages: withoutDeveloperMessages(messages),
		tools
	};
	const messageIds = new Set(messages.flatMap((message) => message.role === "developer" ? [message.id] : []));
	if (history.updates.some((update) => !messageIds.has(update.messageId))) return {
		messages: withoutDeveloperMessages(messages),
		tools
	};
	const declarations = toolDeclarations(tools, toolUpdate, history);
	const updateIds = new Set(history.updates.map((update) => update.messageId));
	const offered = new Set(history.tools.filter((tool) => !tool.deferLoading).map((tool) => tool.name));
	const projectedMessages = [];
	for (const message of messages) {
		if (message.role !== "developer") {
			projectedMessages.push(message);
			continue;
		}
		if (!updateIds.has(message.id)) continue;
		const content = message.content.filter((block) => {
			switch (block.type) {
				case "tool-addition":
					if (!declarations.has(block.toolName) || offered.has(block.toolName)) return false;
					offered.add(block.toolName);
					return true;
				case "tool-removal":
					if (toolUpdate !== "in-history") return false;
					return offered.delete(block.toolName);
				default: return true;
			}
		});
		if (content.length === 0) continue;
		if (content.length === message.content.length) projectedMessages.push(message);
		else projectedMessages.push({
			...message,
			content
		});
	}
	return {
		messages: projectedMessages.length === messages.length && projectedMessages.every((message, index) => message === messages[index]) ? messages : projectedMessages,
		tools: [...declarations.values()]
	};
}
/**
* Centralize the non-secret product identity every provider request sends as `User-Agent`, keeping
* adapters from drifting. See
* `.agents/notes/implemented/architecture/2026-06-21-mandatory-app-attribution-headers.md`.
*
* App-attribution vocabulary for provider requests.
* @module @deepseek-ai/dsh-llm/attribution
*/
const { version } = createRequire(import.meta.url)("../package.json");
/**
* LLM service: adapter registry with a waterfall-interceptable streaming call
* API. Exports the `LlmRuntime` default, the abstract `LlmAdapter` for
* provider backends, and `BlockAssembler` for chunk assembly.
*
* @module @deepseek-ai/dsh-llm
*/
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
/**
* Typed error for LLM-related failures. Extends {@link HarnessError}, so the
* `code` string (e.g. `AUTH`, `RATE_LIMIT`, `NO_ADAPTER`) is shared taxonomy.
*/
var LlmError = class extends HarnessError {
	/** Serializable facts retained beside this live Error. */
	failure;
	/**
	* @param message - non-empty human-readable failure summary.
	* @param code - non-empty stable provider-neutral machine code.
	* @param options - optional cause and validated serializable provider facts.
	*/
	constructor(message, code, options) {
		if (typeof message !== "string" || message.length === 0) throw new Error("LlmError message must be a non-empty string");
		if (typeof code !== "string" || code.length === 0) throw new Error("LlmError code must be a non-empty string");
		if (options?.status !== void 0 && (!Number.isInteger(options.status) || options.status < 100 || options.status > 599)) throw new Error("LlmError status must be an integer from 100 through 599");
		if (options?.providerRetryAfterMs !== void 0 && (!Number.isFinite(options.providerRetryAfterMs) || options.providerRetryAfterMs <= 0)) throw new Error("LlmError providerRetryAfterMs must be a positive finite number");
		if (options?.requestId !== void 0 && (typeof options.requestId !== "string" || options.requestId.length === 0)) throw new Error("LlmError requestId must be a non-empty string");
		super(message, code, options);
		this.name = "LlmError";
		this.failure = Object.freeze({
			message,
			code,
			...options?.status === void 0 ? {} : { status: options.status },
			...options?.providerRetryAfterMs === void 0 ? {} : { providerRetryAfterMs: options.providerRetryAfterMs },
			...options?.requestId === void 0 ? {} : { requestId: options.requestId },
			...options?.offloadImages === void 0 ? {} : { offloadImages: options.offloadImages }
		});
	}
};
(() => {
	let _classSuper = TypertRemoteService;
	let _instanceExtraInitializers = [];
	let _listProviders_decorators;
	let _listConfigurableProviders_decorators;
	let _remoteDiscoverModels_decorators;
	return class LlmRuntime extends _classSuper {
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_listProviders_decorators = [Remote];
			_listConfigurableProviders_decorators = [Remote];
			_remoteDiscoverModels_decorators = [Remote("discoverModels")];
			__esDecorate(this, null, _listProviders_decorators, {
				kind: "method",
				name: "listProviders",
				static: false,
				private: false,
				access: {
					has: (obj) => "listProviders" in obj,
					get: (obj) => obj.listProviders
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _listConfigurableProviders_decorators, {
				kind: "method",
				name: "listConfigurableProviders",
				static: false,
				private: false,
				access: {
					has: (obj) => "listConfigurableProviders" in obj,
					get: (obj) => obj.listConfigurableProviders
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _remoteDiscoverModels_decorators, {
				kind: "method",
				name: "remoteDiscoverModels",
				static: false,
				private: false,
				access: {
					has: (obj) => "remoteDiscoverModels" in obj,
					get: (obj) => obj.remoteDiscoverModels
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
		adapters = (__runInitializers(this, _instanceExtraInitializers), /* @__PURE__ */ new Map());
		directory = /* @__PURE__ */ new Map();
		discoveries = /* @__PURE__ */ new Map();
		constructor(ctx) {
			super(ctx, "llm");
		}
		/** Notify topology observers without letting one broken listener veto the commit. */
		emitAdaptersUpdated() {
			let invariantFailure;
			for (const listener of this.ctx.events.dispatch("emit", ["llm/adapters-updated"])) try {
				const returned = listener();
				if (returned != null && typeof returned.then === "function") Promise.resolve(returned).then(void 0, (error) => {
					this.warnAdaptersListenerFailure(error);
				});
			} catch (error) {
				if (error?.code === "INVARIANT") {
					invariantFailure ??= error;
					continue;
				}
				this.warnAdaptersListenerFailure(error);
			}
			if (invariantFailure !== void 0) throw invariantFailure;
		}
		/** Contained-listener diagnostic shared by the sync and async failure paths. */
		warnAdaptersListenerFailure(error) {
			this.ctx.logger.warn("llm: an llm/adapters-updated listener failed");
			this.ctx.logger.warn(error);
		}
		/**
		* Register an adapter for the given provider routes. Throws `LlmError` with code
		* `DUPLICATE_ADAPTER` if any provider already has an adapter (all-or-nothing).
		* Disposed with the fiber.
		* @param providers - every provider route this adapter should serve.
		* @param adapter - the adapter that streams calls for those providers.
		* @returns the disposer, carrying {@link AdapterRegistrationHandle.replace}.
		*/
		registerAdapter(providers, adapter) {
			const owned = /* @__PURE__ */ new Set();
			let released = false;
			const dispose = this.ctx.effect(function* () {
				if (providers.length === 0) throw new LlmError("an adapter must register at least one provider", "INVALID_ADAPTER");
				this.commitRoutes(owned, this.prepareRoutes(providers, adapter, owned));
				yield () => {
					released = true;
					for (const provider of owned) this.adapters.delete(provider);
					owned.clear();
					this.emitAdaptersUpdated();
				};
			}.bind(this), "llm.registerAdapter()");
			const handle = (() => void dispose());
			handle.replace = (next) => {
				if (released) throw new LlmError("a disposed adapter registration cannot replace its routes", "REGISTRATION_DISPOSED");
				this.commitRoutes(owned, this.prepareRoutes(next, adapter, owned));
			};
			return handle;
		}
		/**
		* Validate one candidate route set for `adapter`, treating routes this
		* registration already holds as available. Nothing is mutated: a rejected
		* candidate leaves the registry exactly as it was.
		*/
		prepareRoutes(providers, adapter, owned) {
			const unique = /* @__PURE__ */ new Set();
			const registrations = [];
			for (const provider of providers) {
				if (provider.length === 0) throw new LlmError("adapter provider names must be non-empty", "INVALID_ADAPTER");
				if (unique.has(provider) || this.adapters.has(provider) && !owned.has(provider)) throw new LlmError(`an adapter for provider "${provider}" is already registered`, "DUPLICATE_ADAPTER");
				const info = adapter.providerInfo(provider);
				if (typeof info.id !== "string" || info.id !== provider || typeof info.name !== "string" || info.name.length === 0) throw new LlmError(`adapter metadata for provider "${provider}" must preserve its id and have a non-empty name`, "INVALID_ADAPTER");
				unique.add(provider);
				const retryPolicy = adapter.providerRetryPolicy(provider) ?? resolveRetryPolicy(void 0, `llm: provider "${provider}" retryPolicy`);
				registrations.push({
					adapter,
					provider: {
						id: info.id,
						name: info.name
					},
					retryPolicy
				});
			}
			return registrations;
		}
		/**
		* Swap this registration's routes for the prepared ones in one synchronous
		* section, so no observer can see the registry between the release and the
		* re-registration. The route set's one mutation point is also where
		* `llm/adapters-updated` is published, so a `replace` announces itself
		* exactly like a first registration.
		*/
		commitRoutes(owned, registrations) {
			for (const provider of owned) this.adapters.delete(provider);
			owned.clear();
			for (const registration of registrations) {
				this.adapters.set(registration.provider.id, registration);
				owned.add(registration.provider.id);
			}
			this.emitAdaptersUpdated();
		}
		/**
		* Describe provider routes with a registered adapter.
		* @returns detached provider metadata in registration order.
		*/
		listProviders() {
			return [...this.adapters.values()].map(({ provider }) => ({ ...provider }));
		}
		/**
		* Declare provider routes an adapter plugin can activate through
		* configuration. Registration is all-or-nothing: an empty list, invalid
		* entry, or a provider already declared by any registration throws
		* `LlmError` without registering the rest. Disposed with the fiber.
		* @param entries - every configurable provider this plugin owns.
		* @returns a handle that withdraws all of them, and can atomically replace them.
		*/
		registerConfigurableProviders(entries) {
			let held = [];
			let disposed = false;
			/**
			* Validate a candidate set in full against everything this registration
			* does not already hold, then publish it. Nothing is written until the
			* whole set passes, so a refused candidate leaves the current entries in
			* place — the property that makes `replace` a swap rather than a
			* delete-then-add that can strand the directory empty.
			*/
			const commit = (candidates) => {
				const detached = [];
				const own = new Set(held.map((entry) => entry.provider));
				for (const entry of candidates) {
					if (entry.provider.length === 0 || entry.displayName.length === 0 || entry.settingsNs.length === 0) throw new LlmError("configurable providers need a non-empty provider, displayName, and settingsNs", "INVALID_DIRECTORY");
					if (entry.settingsPath.some((segment) => segment.length === 0)) throw new LlmError(`configurable provider "${entry.provider}" has an empty settingsPath segment`, "INVALID_DIRECTORY");
					if (this.directory.has(entry.provider) && !own.has(entry.provider) || detached.some((seen) => seen.provider === entry.provider)) throw new LlmError(`configurable provider "${entry.provider}" is already declared`, "DUPLICATE_DIRECTORY");
					detached.push({
						...entry,
						settingsPath: [...entry.settingsPath]
					});
				}
				for (const entry of held) this.directory.delete(entry.provider);
				for (const entry of detached) this.directory.set(entry.provider, entry);
				held = detached;
				this.emitAdaptersUpdated();
			};
			const dispose = this.ctx.effect(function* () {
				if (entries.length === 0) throw new LlmError("a configurable-provider registration must declare at least one provider", "INVALID_DIRECTORY");
				commit(entries);
				yield () => {
					disposed = true;
					for (const entry of held) this.directory.delete(entry.provider);
					held = [];
					this.emitAdaptersUpdated();
				};
			}.bind(this), "llm.registerConfigurableProviders()");
			const handle = (() => void dispose());
			handle.replace = (next) => {
				if (disposed) throw new LlmError("this configurable-provider registration was disposed", "REGISTRATION_DISPOSED");
				commit(next);
			};
			return handle;
		}
		/**
		* List every declared configurable provider, registered or dormant.
		* @returns detached directory entries in declaration order.
		*/
		listConfigurableProviders() {
			return [...this.directory.values()].map((entry) => ({
				...entry,
				settingsPath: [...entry.settingsPath]
			}));
		}
		/**
		* Offer to interrogate provider endpoints on behalf of the settings
		* namespace this plugin owns. The namespace is the key because that is what
		* a configuration surface already holds from the configurable-provider
		* directory, and because a provider being *added* has no route to name yet.
		* Disposed with the fiber.
		* @param settingsNs - the namespace whose profiles this discovery serves.
		* @param discover - interrogates one endpoint and must honor the supplied signal.
		* @returns the disposer that withdraws the offer.
		*/
		registerModelDiscovery(settingsNs, discover) {
			const dispose = this.ctx.effect(function* () {
				if (settingsNs.length === 0) throw new LlmError("model discovery needs a non-empty settings namespace", "INVALID_DISCOVERY");
				if (this.discoveries.has(settingsNs)) throw new LlmError(`model discovery for "${settingsNs}" is already registered`, "DUPLICATE_DISCOVERY");
				this.discoveries.set(settingsNs, discover);
				yield () => {
					this.discoveries.delete(settingsNs);
				};
			}.bind(this), "llm.registerModelDiscovery()");
			return () => void dispose();
		}
		/**
		* Interrogate one provider endpoint for the models it advertises. The
		* request describes a draft, not a stored route, so nothing here reads or
		* writes settings or credentials — the caller owns both, and the reply is
		* candidate metadata a surface may offer for adoption.
		* @param settingsNs - namespace whose registered discovery serves this draft.
		* @param request - the endpoint, protocol, and one-shot credential to use.
		* @param signal - caller cancellation.
		* @returns the advertised models, deduplicated in endpoint order.
		*/
		async discoverModels(settingsNs, request, signal) {
			const discover = this.discoveries.get(settingsNs);
			if (discover === void 0) throw new LlmError(`no model discovery is registered for "${settingsNs}"`, "NO_DISCOVERY");
			if ((request.provider ?? "").length === 0 && (request.baseURL ?? "").length === 0) throw new LlmError("model discovery needs a provider route or a baseURL", "INVALID_DISCOVERY");
			const discovered = signal === void 0 ? await discover(request) : await discover(request, signal);
			const seen = /* @__PURE__ */ new Set();
			const models = [];
			for (const model of discovered) {
				if (typeof model.id !== "string" || model.id.length === 0 || seen.has(model.id)) continue;
				seen.add(model.id);
				models.push({
					id: model.id,
					...model.name === void 0 ? {} : { name: model.name },
					...model.contextWindow === void 0 ? {} : { contextWindow: model.contextWindow },
					...model.maxTokens === void 0 ? {} : { maxTokens: model.maxTokens },
					...model.inputModalities === void 0 ? {} : { inputModalities: [...model.inputModalities] }
				});
			}
			return models;
		}
		/**
		* Remote adapter for one draft provider interrogation.
		* @param settingsNs - namespace whose registered discovery serves this draft.
		* @param request - endpoint, protocol, and one-shot credential to use.
		* @param signal - caller cancellation supplied by the Remote carrier.
		* @returns advertised models in endpoint order.
		* @throws RemoteError with `llm/model-discovery-rejected` when discovery refuses or fails.
		*/
		async remoteDiscoverModels(settingsNs, request, signal) {
			try {
				return await this.discoverModels(settingsNs, request, signal);
			} catch (error) {
				throw new RemoteError("llm/model-discovery-rejected", error instanceof Error ? error.message : String(error), {
					settingsNs,
					...request.baseURL === void 0 ? {} : { baseURL: request.baseURL }
				}, { cause: error });
			}
		}
		/**
		* Resolve the retry policy captured when one provider route was registered.
		* @param provider - registered provider route to inspect.
		* @returns the provider-owned policy, with normal defaults already resolved.
		*/
		providerRetryPolicy(provider) {
			return this.registration(provider).retryPolicy;
		}
		/**
		* Resolve provider-side request-image pricing for one exact route, or
		* `undefined` when the provider is unregistered or declares none. Unknown
		* providers degrade to `undefined` rather than throwing because callers
		* price durable history whose route may no longer be mounted.
		* @param provider - provider route named by a request header.
		* @param model - exact model id named by the same header.
		* @returns the owning adapter's image pricing for the route, when declared.
		*/
		imageRequestPricing(provider, model) {
			return this.adapters.get(provider)?.adapter.imageRequestPricing(provider, model);
		}
		/**
		* Resolve the exact text one durable file occurrence contributes to every
		* provider request in the current execution environment.
		* @param ref - durable verbatim file reference from model history.
		* @returns the same deterministic handle text used at adapter dispatch.
		*/
		fileRequestText(ref) {
			return fileHandleText(ref, this.fileReadPath(ref));
		}
		/** Detach typed adapter-owned modality metadata. */
		detachedModalities(modalities) {
			return modalities === void 0 ? void 0 : [...modalities];
		}
		/**
		* Discover models advertised by one registered provider. Catalog membership
		* does not constrain core routing. Catalog-driven entry points may restrict
		* selection and submission to the advertised models.
		* @param provider - registered provider route to inspect.
		* @returns detached model metadata in adapter-preferred order.
		*/
		async listModels(provider) {
			const models = await this.registration(provider).adapter.listModels(provider);
			const seen = /* @__PURE__ */ new Set();
			return models.map((model) => {
				if (typeof model.provider !== "string" || model.provider !== provider || typeof model.id !== "string" || model.id.length === 0 || typeof model.name !== "string" || model.name.length === 0 || model.description !== void 0 && typeof model.description !== "string" || seen.has(model.id)) throw new LlmError(`adapter returned invalid or duplicate model metadata for provider "${provider}"`, "INVALID_CATALOG");
				seen.add(model.id);
				const inputModalities = this.detachedModalities(model.inputModalities);
				return {
					provider: model.provider,
					id: model.id,
					name: model.name,
					...model.description === void 0 ? {} : { description: model.description },
					...inputModalities === void 0 ? {} : { inputModalities }
				};
			});
		}
		/**
		* Resolve and validate all metadata from the adapter that owns one exact
		* route. The result is detached from adapter-owned objects; catalog
		* membership remains advisory and does not control request routing.
		* @param provider - registered provider route to inspect.
		* @param model - exact model id passed to the adapter.
		* @param signal - optional cancellation for adapter-owned asynchronous lookup.
		* @returns exact model identity plus available context and reasoning metadata.
		*/
		async resolveModelInfo(provider, model, signal) {
			return this.resolveModelInfoFor(this.registration(provider), model, signal);
		}
		async resolveModelInfoFor(registration, model, signal) {
			const resolved = await registration.adapter.resolveModel(registration.provider.id, model, signal);
			return this.normalizeModelInfo(registration, model, resolved);
		}
		/** Validate and detach one adapter-returned exact model result. */
		normalizeModelInfo(registration, model, resolved) {
			const provider = registration.provider.id;
			if (typeof resolved.provider !== "string" || resolved.provider !== provider || typeof resolved.id !== "string" || resolved.id !== model || typeof resolved.name !== "string" || resolved.name.length === 0 || resolved.description !== void 0 && typeof resolved.description !== "string") throw new LlmError(`adapter returned invalid exact model metadata for provider "${provider}" model "${model}"`, "INVALID_MODEL_INFO");
			const context = resolved.context;
			if (context !== void 0 && (!Number.isInteger(context.contextWindow) || context.contextWindow <= 0)) throw new LlmError(`adapter returned invalid context metadata for provider "${provider}" model "${model}"`, "INVALID_MODEL_CONTEXT");
			const inputModalities = this.detachedModalities(resolved.inputModalities);
			const systemPromptUpdate = resolved.systemPromptUpdate;
			if (systemPromptUpdate !== void 0 && systemPromptUpdate !== "in-history") throw new LlmError(`adapter returned invalid system prompt update mode for provider "${provider}" model "${model}"`, "INVALID_MODEL_INFO");
			const toolUpdate = resolved.toolUpdate;
			if (toolUpdate !== void 0 && toolUpdate !== "in-history" && toolUpdate !== "addition-only") throw new LlmError(`adapter returned invalid tool update mode for provider "${provider}" model "${model}"`, "INVALID_MODEL_INFO");
			const defaultMaxTokens = resolved.defaultMaxTokens;
			if (defaultMaxTokens !== void 0 && (!Number.isSafeInteger(defaultMaxTokens) || defaultMaxTokens <= 0)) throw new LlmError(`adapter returned invalid default maxTokens for provider "${provider}" model "${model}"`, "INVALID_MODEL_MAX_TOKENS");
			const info = {
				provider,
				id: model,
				name: resolved.name,
				...resolved.description === void 0 ? {} : { description: resolved.description },
				...inputModalities === void 0 ? {} : { inputModalities },
				...context === void 0 ? {} : { context: { contextWindow: context.contextWindow } },
				...defaultMaxTokens === void 0 ? {} : { defaultMaxTokens },
				...resolved.systemPromptUpdate === void 0 ? {} : { systemPromptUpdate: resolved.systemPromptUpdate },
				...resolved.toolUpdate === void 0 ? {} : { toolUpdate: resolved.toolUpdate }
			};
			const reasoning = resolved.reasoning;
			if (reasoning === void 0) return info;
			if (reasoning.efforts.length === 0) throw new LlmError(`adapter returned invalid reasoning metadata for provider "${provider}" model "${model}"`, "INVALID_MODEL_REASONING");
			const seen = /* @__PURE__ */ new Set();
			const efforts = reasoning.efforts.map((effort) => {
				if (typeof effort.id !== "string" || effort.id.length === 0 || typeof effort.name !== "string" || effort.name.length === 0 || effort.description !== void 0 && typeof effort.description !== "string" || seen.has(effort.id)) throw new LlmError(`adapter returned invalid or duplicate reasoning effort metadata for provider "${provider}" model "${model}"`, "INVALID_MODEL_REASONING");
				seen.add(effort.id);
				return {
					id: effort.id,
					name: effort.name,
					...effort.description === void 0 ? {} : { description: effort.description }
				};
			});
			if (reasoning.defaultEffort !== void 0 && !seen.has(reasoning.defaultEffort)) throw new LlmError(`adapter returned an unknown default reasoning effort for provider "${provider}" model "${model}"`, "INVALID_MODEL_REASONING");
			return {
				...info,
				reasoning: {
					efforts,
					...reasoning.defaultEffort === void 0 ? {} : { defaultEffort: reasoning.defaultEffort }
				}
			};
		}
		/**
		* Validate a conversation call config against its exact model capability and
		* materialize adapter-configured defaults. Unsupported explicit efforts
		* reject before provider I/O; no clamping or aliasing is performed. This
		* standalone query does not bind a later dispatch; use {@link prepareCall}
		* when logging and streaming must share one adapter registration.
		* @param config - provider/model route and optional request controls.
		* @param signal - optional cancellation for adapter-owned capability lookup.
		* @returns a detached config only when a default must be materialized.
		*/
		async resolveCallConfig(config, signal) {
			return (await this.resolveCallFor(this.registration(config.provider), config, signal)).config;
		}
		async resolveCallFor(registration, config, signal) {
			const info = await this.resolveModelInfoFor(registration, config.model, signal);
			return this.resolveCallWithInfo(config, info);
		}
		/** Validate request controls against one already-bound exact model result. */
		resolveCallWithInfo(config, info) {
			const defaulted = config.maxTokens === void 0 && info.defaultMaxTokens !== void 0 ? {
				...config,
				maxTokens: info.defaultMaxTokens
			} : config;
			const reasoning = info.reasoning;
			const requested = defaulted.reasoningEffort;
			let resolvedConfig = defaulted;
			if (reasoning === void 0) {
				if (requested !== void 0) throw new LlmError(`provider "${config.provider}" model "${config.model}" does not support reasoning effort "${requested}"`, "UNSUPPORTED_REASONING_EFFORT");
			} else {
				const effective = requested ?? reasoning.defaultEffort;
				if (effective !== void 0) {
					if (!reasoning.efforts.some((effort) => effort.id === effective)) throw new LlmError(`provider "${config.provider}" model "${config.model}" does not support reasoning effort "${effective}"`, "UNSUPPORTED_REASONING_EFFORT");
					if (requested !== effective) resolvedConfig = {
						...defaulted,
						reasoningEffort: effective
					};
				}
			}
			return {
				config: resolvedConfig,
				...info.context === void 0 ? {} : { context: info.context },
				modelInfo: info
			};
		}
		/**
		* Resolve one call under its current adapter registration. The returned
		* one-shot handle keeps that registration across header logging and dispatch,
		* so HMR cannot combine one adapter's capability result with another adapter.
		* @param config - provider/model route and optional request controls.
		* @param signal - optional cancellation for adapter-owned capability lookup.
		* @returns a prepared config and its registration-bound stream entry point.
		*/
		async prepareCall(config, signal) {
			const registration = this.registration(config.provider);
			const adapterCall = await registration.adapter.prepareCall(config.provider, config.model, signal);
			const modelInfo = this.normalizeModelInfo(registration, config.model, adapterCall.model);
			const resolved = this.resolveCallWithInfo(config, modelInfo);
			const resolvedConfig = deepFreeze(structuredClone(resolved.config));
			const context = resolved.context === void 0 ? void 0 : deepFreeze(structuredClone(resolved.context));
			const adapterDefaults = deepFreeze({
				...config.reasoningEffort === void 0 && resolvedConfig.reasoningEffort !== void 0 ? { reasoningEffort: true } : {},
				...config.maxTokens === void 0 && resolvedConfig.maxTokens !== void 0 ? { maxTokens: true } : {}
			});
			let dispatched = false;
			return Object.freeze({
				config: resolvedConfig,
				retryPolicy: registration.retryPolicy,
				adapterDefaults,
				...context === void 0 ? {} : { context },
				...modelInfo.inputModalities === void 0 ? {} : { inputModalities: Object.freeze([...modelInfo.inputModalities]) },
				...modelInfo.systemPromptUpdate === void 0 ? {} : { systemPromptUpdate: modelInfo.systemPromptUpdate },
				...modelInfo.toolUpdate === void 0 ? {} : { toolUpdate: modelInfo.toolUpdate },
				stream: (options) => {
					if (dispatched) throw new LlmError("a prepared LLM call can only be dispatched once", "INVALID_PREPARED_CALL");
					if (!callConfigEquals(options, resolvedConfig)) throw new LlmError("prepared LLM call config changed before adapter dispatch", "INVALID_PREPARED_CALL");
					dispatched = true;
					return this.streamWithRegistration(options, {
						registration,
						config: resolvedConfig,
						modelInfo,
						dispatch: (options) => adapterCall.stream(options)
					});
				}
			});
		}
		registration(provider) {
			const registration = this.adapters.get(provider);
			if (!registration) throw new LlmError(`no adapter registered for provider "${provider}"`, "NO_ADAPTER");
			return registration;
		}
		/** Remove replay state whose historical route is owned by another adapter. */
		forAdapter(options, adapter) {
			const messages = options.messages.map((message) => {
				if (message.role !== "assistant") return message;
				const source = message.source;
				if (source.replayState === void 0) return message;
				if (this.adapters.get(source.provider)?.adapter === adapter) return message;
				return freezeMessage({
					...message,
					source: {
						kind: "model",
						provider: source.provider,
						model: source.model
					}
				});
			});
			if (messages.every((message, index) => message === options.messages[index])) return options;
			const filtered = {
				...options,
				messages
			};
			return Object.isFrozen(options) ? deepFreeze(filtered) : filtered;
		}
		/**
		* Resolve the current execution-world read path of one durable file
		* reference through the mounted attachment and filesystem providers.
		*/
		fileReadPath(ref) {
			let hostPath;
			try {
				hostPath = this.ctx.get("attachments")?.fileHostPath(ref);
			} catch {
				return;
			}
			if (hostPath === void 0) return void 0;
			return this.ctx.get("fs")?.processPathFromHostPath(hostPath);
		}
		/**
		* Final adapter boundary. Adapter selection, dispatch, iterator construction,
		* and iteration failures become one terminal failure chunk. Middleware and
		* downstream consumer failures remain thrown plugin or consumer errors.
		*/
		async *adapterStream(options, prepared) {
			let iterator;
			try {
				const registration = prepared?.registration ?? this.registration(options.provider);
				const adapter = registration.adapter;
				let modelInfo;
				let resolvedConfig;
				let dispatch;
				if (prepared === void 0) {
					const adapterCall = await adapter.prepareCall(options.provider, options.model, options.signal);
					modelInfo = this.normalizeModelInfo(registration, options.model, adapterCall.model);
					resolvedConfig = this.resolveCallWithInfo(options, modelInfo).config;
					dispatch = (options) => adapterCall.stream(options);
				} else {
					modelInfo = prepared.modelInfo;
					resolvedConfig = prepared.config;
					dispatch = prepared.dispatch;
				}
				if (prepared !== void 0 && !callConfigEquals(options, resolvedConfig)) throw new LlmError("prepared LLM call config changed before adapter dispatch", "INVALID_PREPARED_CALL");
				const resolvedOptions = callConfigEquals(options, resolvedConfig) ? options : Object.isFrozen(options) ? deepFreeze({
					...options,
					...resolvedConfig
				}) : {
					...options,
					...resolvedConfig
				};
				let projectedMessages = resolvedOptions.messages;
				if (projectedMessages.some((message) => contentHasFile(message.content))) projectedMessages = projectFilesToText(projectedMessages, (ref) => this.fileReadPath(ref));
				if (modelInfo.inputModalities !== void 0 && !modelInfo.inputModalities.includes("image") && projectedMessages.some((message) => contentHasImage(message.content))) projectedMessages = projectImagesForTextModel(projectedMessages);
				const projectedTools = projectToolUpdates(projectedMessages, resolvedOptions.tools, modelInfo.toolUpdate, resolvedOptions.toolHistory);
				projectedMessages = projectedTools.messages;
				let projectedOptions = resolvedOptions;
				if (projectedMessages !== resolvedOptions.messages || projectedTools.tools !== resolvedOptions.tools) {
					projectedOptions = {
						...resolvedOptions,
						messages: projectedMessages,
						...projectedTools.tools === void 0 ? {} : { tools: projectedTools.tools }
					};
					if (Object.isFrozen(resolvedOptions)) deepFreeze(projectedOptions);
				}
				iterator = dispatch(this.forAdapter(projectedOptions, adapter))[Symbol.asyncIterator]();
			} catch (error) {
				yield adapterFailureChunk(error, options.signal);
				return;
			}
			let completed = false;
			try {
				while (true) {
					let item;
					try {
						const next = await iterator.next();
						item = next.done ? { done: true } : {
							done: false,
							value: next.value
						};
					} catch (error) {
						completed = true;
						yield adapterFailureChunk(error, options.signal);
						return;
					}
					if (item.done) {
						completed = true;
						return;
					}
					yield item.value;
				}
			} finally {
				if (!completed) {
					const close = iterator.return?.bind(iterator);
					if (close) await close();
				}
			}
		}
		/**
		* Stream one model call as raw chunks (token-level deltas). Replay state is
		* retained only when the same adapter instance owns its historical provider
		* and the target provider. Final adapter selection remains fixed through
		* asynchronous exact-model resolution and dispatch. Adapter selection,
		* dispatch, and iteration failures become terminal `error` or `aborted`
		* finish chunks; middleware, nested-call, cleanup, and consumer failures
		* remain thrown.
		* @param options - the full request; `options.provider` selects the adapter.
		* @returns the chunk stream, possibly wrapped by `llm/stream` listeners.
		*/
		stream(options) {
			return this.streamWithRegistration(options);
		}
		streamWithRegistration(options, prepared) {
			return this.ctx.waterfall(this, "llm/stream", options, () => this.adapterStream(options, prepared));
		}
	};
})();
/** Convert one adapter throw into the stream protocol's terminal outcome. */
function adapterFailureChunk(error, signal) {
	const failure = normalizeLlmFailure(error);
	return {
		type: "finish",
		reason: signal?.aborted || failure.code === "ABORTED" ? {
			kind: "aborted",
			failure
		} : {
			kind: "error",
			failure
		}
	};
}
//#endregion
//#region ../../../deepseek-harness/packages/sandbox/sandbox/lib/index.js
/**
* The escalation vocabulary and choreography shared by every sandbox-enforcing
* tool family (`@deepseek-ai/dsh-tool-bash`, `@deepseek-ai/dsh-tool-fs`): the
* strictly-wider ladder, the argument-pairing validation, the model-facing
* denial/hint markers, and {@link approveEscalation} — the ordered fail-closed
* sequence that resolves a `sandbox_permissions` request through a
* user-approval channel BEFORE anything executes. One home keeps the two
* families' approval ordering and verbatim error texts from drifting apart.
*
* The channel is a minimal STRUCTURAL function shape ({@link EscalationAsk}),
* not the approval service type: the tool layer — which owns the agent, the
* call id, and the tool name — closes over `ctx.approval.request(...)` and
* hands the closure down, so this package never depends on the approval or
* agent packages.
*
* @module dsh-sandbox/escalation
*/
/**
* The strictly-wider table: what a call whose effective mode is the key may
* escalate TO. Checked at EXECUTION, never baked into a tool schema — the
* schema's enum is {@link ESCALATION_TARGETS}, because schemas are
* registry-global while the effective mode is per-call truth.
*/
const WIDER_MODES = {
	"read-only": ["workspace-write", "danger-full-access"],
	"workspace-write": ["danger-full-access"]
};
/**
* The closed escalation-target vocabulary — every mode a call could ever
* escalate TO (`read-only` is the floor; nothing escalates to it). Advertised
* whenever the mounted capability confines: cutting the enum down to the modes
* wider than the composition's DEFAULT would strand a session whose effective
* mode sits below it (a `danger-full-access` default would advertise nothing
* while a narrower-switched session stays confined with no lever).
*/
const ESCALATION_TARGETS = ["workspace-write", "danger-full-access"];
/**
* Validate the escalation argument pairing a tool schema cannot express:
* `sandbox_permissions` and `justification` travel together — an approval
* prompt without a reason, or a reason driving nothing, is a malformed ask —
* and the justification must be a non-empty sentence.
* @param sandboxPermissions - the raw `sandbox_permissions` argument, if given.
* @param justification - the raw `justification` argument, if given.
*/
function validateEscalationArgs(sandboxPermissions, justification) {
	if (sandboxPermissions !== void 0 && justification === void 0) throw new Error("invalid escalation: sandbox_permissions requires a justification");
	if (justification !== void 0 && sandboxPermissions === void 0) throw new Error("invalid escalation: justification is only valid together with sandbox_permissions");
	if (justification !== void 0 && justification.trim().length === 0) throw new Error("invalid justification: expected a non-empty sentence");
}
/**
* Resolve a sandbox permission request before execution. Repeating the call's
* effective mode returns it without approval. A strictly wider mode requires
* approval and applies only to this call. Narrower or unsupported targets,
* missing approval services or agents for widening, and non-grant outcomes
* throw before execution.
* @param request - the escalation to judge (see {@link EscalationRequest}).
* @param approval - the approval ingredients the tool holds (see {@link EscalationApproval}).
* @returns the granted mode, consumed by the one call that asked.
*/
async function approveEscalation(request, approval) {
	const { requestedMode: mode, effectiveMode, justification, subject } = request;
	if (mode === effectiveMode) return effectiveMode;
	if (!(WIDER_MODES[effectiveMode] ?? []).includes(mode)) throw new Error(`sandbox escalation to "${mode}" is not strictly wider than this call's current "${effectiveMode}" mode`);
	if (approval.approver === void 0) throw new Error(`sandbox escalation to "${mode}" requires approval, but no approval service is composed`);
	if (approval.agent === void 0) throw new Error(`sandbox escalation to "${mode}" requires approval, but the call has no agent to route it through`);
	const outcome = await approval.approver.request({
		agent: approval.agent,
		toolName: approval.toolName,
		callId: approval.callId,
		reason: `escalate sandbox to ${mode}: ${justification}`,
		displayReason: {
			en: `Allow this operation with ${mode} permissions: ${justification}`,
			zh: `允许本次操作使用 ${mode} 权限：${justification}`
		},
		...approval.signal ? { signal: approval.signal } : {}
	});
	switch (outcome) {
		case "allowed-once": return mode;
		case "rejected": throw new Error(`the user rejected escalating this ${subject} to "${mode}"; it stays denied, so stop and explain instead of working around it`);
		case "cancelled": throw new Error(`approval for escalating to "${mode}" was cancelled`);
		case "unavailable": throw new Error(`sandbox escalation to "${mode}" requires approval, but no approval channel is available`);
		default: return assertNever(outcome, "EscalationOutcome");
	}
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
	const userProjectContent = options.projectContent;
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
		...options.deferLoading === true ? { deferLoading: options.deferLoading } : {},
		...options.timeoutMs !== void 0 ? { timeoutMs: options.timeoutMs } : {},
		async execute(args, exec) {
			const violations = validate(args);
			if (violations.length > 0) throw new ToolArgsError(violations);
			return userExecute(args, exec);
		}
	};
	if (userProjectContent) tool.projectContent = (exec, result) => userProjectContent(exec, result);
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
/** Per-language `run_code` schema flavors (see {@link RunCodeFlavor}); one entry per {@link PtcSdkLanguage}. */
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
const RUN_CODE_CONTROLS = {
	timeoutMs: {
		type: "number",
		description: "Positive elapsed-time budget in milliseconds, capped by the deployment maximum."
	},
	sandbox_permissions: {
		type: "string",
		enum: [...ESCALATION_TARGETS],
		description: "Wider sandbox mode for this complete program execution; requires justification and approval."
	},
	justification: {
		type: "string",
		description: "Reason this complete program needs wider access, shown to the user for approval. Use the language of the user’s current request."
	}
};
function controlParameters(runtime) {
	if (runtime === void 0) return RUN_CODE_CONTROLS;
	return {
		...runtime.timeout === void 0 ? {} : { timeoutMs: {
			...RUN_CODE_CONTROLS.timeoutMs,
			description: `Positive elapsed-time budget in milliseconds, including nested tool and approval waits. Default ${runtime.timeout.defaultMs}; capped at ${runtime.timeout.maxMs}. Zero does not disable the deadline.`
		} },
		...runtime.sandboxMode === void 0 ? {} : {
			sandbox_permissions: RUN_CODE_CONTROLS.sandbox_permissions,
			justification: RUN_CODE_CONTROLS.justification
		}
	};
}
function escalationGuidance(runtime) {
	return runtime?.sandboxMode === void 0 ? "" : " A sandbox escalation approves this complete program for one execution only. Nested tools retain their own policies and approvals. Request wider access only after evidence of a denial. Earlier effects may already have completed: inspect them before explicitly retrying. Programs are never replayed automatically.";
}
/**
* Resolve the {@link RunCodeFlavor} for the loaded runtime's language, read at
* schema-emission time so the model-visible `run_code` schema always matches
* the SDK section's language. `peekRuntime` returns `undefined` only when no
* runtime is mounted, which reaches this function through definition readers
* and `schemas()` — the doc-catalog harvest is the only shipped one, and none
* of them feeds a model, because `wireSchemas` calls `requirePtcRuntime`
* before projecting — so that path degrades to {@link TYPESCRIPT_FLAVOR}. A
* mounted runtime whose language has no flavor entry fails loud, exactly as
* `requirePtcRuntime` rejects it at assembly. Keeping this table in step with
* `SDK_RENDERERS` is the compiler's job ({@link PtcSdkLanguage}); what this
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
			},
			...RUN_CODE_CONTROLS
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
					result: { type: "json" },
					sandbox: {
						type: "object",
						additionalProperties: false,
						properties: {
							mode: {
								type: "string",
								required: true,
								enum: [
									"read-only",
									"workspace-write",
									"danger-full-access"
								]
							},
							denied: {
								type: "boolean",
								required: true
							},
							enforcement: {
								type: "string",
								enum: ["full", "partial"]
							}
						}
					}
				}
			},
			render: (_args, value) => {
				const rendered = value.result === void 0 ? "" : renderValue(value.result);
				const parts = [value.logs.join("\n"), rendered].filter((part) => part.length > 0);
				if (value.sandbox?.enforcement === "partial") parts.push("File sandbox enforcement is partial on this host.");
				if (value.sandbox?.denied) parts.push(`The ${value.sandbox.mode} file sandbox denied an operation.${escalationGuidance(peekRuntime())}`);
				return [{
					type: "text",
					text: parts.length > 0 ? parts.join("\n") : "(run_code completed with no output)"
				}];
			}
		},
		async execute(args, exec) {
			if (args.description.trim().length === 0) throw new Error("invalid description: expected a non-empty string");
			const runtime = requireRuntime();
			validateEscalationArgs(args.sandbox_permissions, args.justification);
			if (args.timeoutMs !== void 0 && runtime.timeout === void 0) throw new Error("timeoutMs is not available for this PTC runtime");
			if (args.timeoutMs !== void 0 && (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0)) throw new Error("invalid timeoutMs: expected a positive finite number");
			const standingPolicy = runtime.sandboxMode === void 0 ? void 0 : options.resolveSandboxPolicy(exec);
			let policy = standingPolicy;
			if (args.sandbox_permissions !== void 0 && args.justification !== void 0) {
				if (standingPolicy === void 0) throw new Error("sandbox_permissions is not available for this PTC runtime");
				const approvedMode = await approveEscalation({
					requestedMode: args.sandbox_permissions,
					justification: args.justification,
					effectiveMode: standingPolicy.mode,
					subject: "program"
				}, {
					approver: options.peekApprover(),
					agent: exec.agent,
					callId: exec.callId,
					toolName: RUN_CODE_NAME,
					signal: exec.signal
				});
				policy = {
					...standingPolicy,
					mode: approvedMode
				};
			}
			exec.signal.throwIfAborted();
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
			const binding = (schema) => async (rawArgs) => {
				const { name } = schema;
				if (runOver()) throw new Error(`run_code run is over (${String(runController.signal.reason)}); ${name} not dispatched`);
				const normalized = jsonNormalizeArgs(rawArgs);
				const n = ++dispatches;
				const subCallId = brandString(`${String(exec.callId)}:ptc:${n}`);
				const input = {
					callId: subCallId,
					rootCallId: exec.rootCallId,
					name,
					schema,
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
								...result.error?.info === void 0 ? {} : { error: result.error.info },
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
								source: { kind: "ptc-mode" }
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
					value: binding(deepFreeze(schema))
				});
			}
			try {
				let result;
				try {
					result = await runtime.run(runtime.resolve({
						program: args.code,
						bindings: [{
							global: "tools",
							functions,
							errorClass: {
								name: "ToolCallError",
								memberNameProperty: "toolName"
							}
						}],
						signal: runController.signal,
						...exec.agent?.session.header.cwd !== void 0 ? { cwd: exec.agent.session.header.cwd } : {},
						...policy !== void 0 ? { sandboxPolicy: policy } : {},
						...args.timeoutMs !== void 0 ? { timeoutMs: args.timeoutMs } : {}
					}));
				} finally {
					runController.abort("run_code settled");
					await drainDispatches();
				}
				if (result.error) {
					const logsText = result.logs.length > 0 ? `\nCaptured output:\n${result.logs.join("\n")}` : "";
					const sandboxText = result.sandbox === void 0 ? "" : `\nFile sandbox: ${result.sandbox.mode}${result.sandbox.enforcement === void 0 ? "" : `; enforcement: ${result.sandbox.enforcement}`}${result.sandbox.denied ? "; operation denied" : ""}.`;
					throw new CodeRunFailedError(`code run failed (${result.error.kind}): ${result.error.message}${logsText}${sandboxText}${result.sandbox?.denied ? escalationGuidance(runtime) : ""}`);
				}
				return {
					logs: result.logs,
					...result.sandbox === void 0 ? {} : { sandbox: result.sandbox },
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
		get: () => {
			const runtime = peekRuntime();
			const instructions = runtime?.executionInstructions;
			return resolveFlavor(peekRuntime).description + (instructions ? ` ${instructions}` : "") + (runtime === void 0 ? "" : " The working directory is the Session's current directory.") + escalationGuidance(runtime);
		}
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
			},
			...controlParameters(peekRuntime())
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
* store, keyed by the loaded {@link @deepseek-ai/dsh-ptc-runtime#PtcRuntime.language | PTC
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
* `ctx.ptcRuntime.language` in this table when assembling the `tools:sdk`
* section under a non-native mode; a runtime whose language is not a key
* fails the assembly loudly (same idiom as `toolOrder` violations). Adding a
* new backend language is three parallel edits — a {@link PtcSdkLanguage}
* member, an entry here, and a `RUN_CODE_FLAVORS` entry in `ptc.ts` for
* its `run_code` schema strings — plus the renderer function this table points
* at. The `satisfies` clause pins this table's key set to that union, which
* the flavor table is checked against too, so any of the three left out is a
* typecheck failure. What no check reaches is the prose that names the values
* instead of deriving them: the seam's `dsh-ptc-runtime` README pair, its
* `PtcRuntime.language` JSDoc, and `docs/subsystems/ptc-runtime.md`
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
	/** Execution-prepared content installed before post-execute policy. */
	contentProjectors = /* @__PURE__ */ new WeakMap();
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
			interpolate: false,
			text: (context) => {
				const mode = this.modeFor(context.scope);
				if (mode === "native") return "";
				const runtime = this.requirePtcRuntime(mode);
				const render = SDK_RENDERERS[runtime.language];
				/* v8 ignore next -- requirePtcRuntime rejects an unknown language before this runs. */
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
	requirePtcTransport() {
		this.ptcTransport ??= createRunCodeTool(this, {
			requireRuntime: () => this.requirePtcRuntime(this.defaultMode),
			peekApprover: () => this.ctx.get("approval"),
			resolveSandboxPolicy: (exec) => {
				const policy = this.ctx.get("sandboxPolicy");
				if (policy === void 0) throw new Error("dsh-tools: confined PTC runtime requires sandboxPolicy");
				return policy.resolve(exec.agent === void 0 ? {} : { session: exec.agent.session });
			},
			peekRuntime: () => this.ctx.get("ptcRuntime"),
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
		this.requirePtcRuntime(mode);
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
	* Resolve the PTC runtime or throw the actionable misconfiguration error.
	* Read at use time (assembly / run_code execution), NOT via static
	* `inject`: an inject entry would hold `ctx.tools` — and every tool plugin
	* behind it — hostage to a PTC runtime existing even under `mode:
	* 'native'`.
	*
	* Assembly and `run_code` execution read separately, so the language is not
	* bound to a request. Harmless while one published backend exists — both
	* reads return the same flavor — but a reload that swapped in a second
	* language between them would hand a program written against one SDK to the
	* other. Binding it is deferred until a second backend ships (the first
	* point it is testable).
	*/
	requirePtcRuntime(mode) {
		const runtime = this.ctx.get("ptcRuntime");
		if (!runtime) throw new Error(`dsh-tools: mode "${mode}" requires a PTC runtime — load a ctx.ptcRuntime implementation (e.g. @deepseek-ai/dsh-ptc-runtime-node) or set tools mode to "native"`);
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
		if (this.modeFor(scope) !== "native") visible.set(RUN_CODE_NAME, this.requirePtcTransport());
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
		const { name, description, parameters, deferLoading } = definition;
		const detached = detachParameters ? snapshotJsonValue(parameters) : parameters;
		if (detached === void 0) throw new Error(`tool "${name}" parameters must be lossless JSON before schema projection`);
		return {
			name,
			description,
			parameters: detached,
			...deferLoading === true ? { deferLoading } : {}
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
			...exec.schema !== void 0 ? { schema: exec.schema } : {},
			deferContext(context) {
				deferredContexts.push(context);
			},
			concludeTurn() {
				concludingExecutions.add(this);
			}
		};
		const capturedFinalizer = visible?.finalizeContent?.bind(visible);
		const capturedProjector = visible?.projectContent?.bind(visible);
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
			if (!collapsed) this.contentProjectors.set(execution, capturedProjector);
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
			if (decision.kind === "cancel") return await next({
				kind: "post-result",
				exec,
				result: toolAbortedBeforeDispatchResult()
			});
			const denialReason = decision.kind === "allow" ? this.guardReason(exec) : decision.reason;
			const denialInfo = decision.kind === "deny" ? decision.info : void 0;
			if (denialReason !== void 0) return await next({
				kind: "post-result",
				exec,
				result: this.materializeFinalResult({
					content: [{
						type: "text",
						text: `Error: ${denialReason}`
					}],
					isError: true,
					error: {
						message: denialReason,
						...denialInfo === void 0 ? {} : { info: denialInfo }
					}
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
			const project = this.contentProjectors.get(exec);
			this.contentProjectors.delete(exec);
			const content = project?.(exec, result);
			const projected = content === void 0 ? result : this.markCanonical(exec, this.materializeFinalResult({
				...result,
				content
			}));
			const postResult = await this.postExecute(exec, projected);
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
			...ask.displayReason !== void 0 ? { displayReason: ask.displayReason } : {},
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
//#region src/features/address.ts
/**
* 收件人地址解析砖块：把模型给出的「一个字符串」规范化为可用的邮箱地址数组。
*
* 为什么单独成砖块：模型输入形态不可控（单地址、英文逗号、中文逗号、分号、
* 换行混用），解析与校验是纯计算，单独沉淀便于单测覆盖；真正发信的 IO 在
* smtp.ts，本文件既不碰网络也不碰文件系统。
*
* @module @deepseek-ai/dsh-email/features/address
*/
/** 邮箱基本形态校验：本地部分@域名，域名至少含一个点，禁止分隔符与尖括号。 */
const EMAIL_PATTERN = /^[^\s@,;<>，；]+@[^\s@,;<>，；]+\.[^\s@,;<>，；]+$/;
/** 地址间隔符：英文/中文逗号、分号与任意空白都算分隔，容忍模型输出的多种写法。 */
const ADDRESS_SEPARATOR = /[,;，；\s]+/;
/**
* 解析地址串为地址数组，并挑出非法片段。
* @param input - 原始地址串，可含多种分隔符；undefined 或空串得到空结果。
* @returns 合法地址与非法的原始片段。
*/
function parseAddresses(input) {
	const addresses = [];
	const invalid = [];
	const seen = /* @__PURE__ */ new Set();
	if (input === void 0) return {
		addresses,
		invalid
	};
	for (const fragment of input.split(ADDRESS_SEPARATOR)) {
		const address = fragment.trim();
		if (address.length === 0) continue;
		if (!EMAIL_PATTERN.test(address)) {
			invalid.push(address);
			continue;
		}
		const key = address.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		addresses.push(address);
	}
	return {
		addresses,
		invalid
	};
}
/**
* 决定本次发信的真实收件人。
*
* 业务规则（用户明确要求）：调用方给了新地址就用新地址；没给才回退默认收件人。
* 默认收件人自身配置不合法时直接报错而不是静默回退——避免邮件发到错误的人手里。
*
* @param to - 调用方传入的收件人串，可为 undefined。
* @param defaultRecipient - 插件配置的默认收件人。
*/
function resolveRecipients(to, defaultRecipient) {
	const explicit = (to ?? "").trim();
	if (explicit.length === 0) {
		const fallback = parseAddresses(defaultRecipient);
		if (fallback.addresses.length !== 1 || fallback.invalid.length > 0) return {
			ok: false,
			error: `默认收件人配置不合法：${defaultRecipient}`
		};
		return {
			ok: true,
			recipients: fallback.addresses,
			source: "default"
		};
	}
	const parsed = parseAddresses(explicit);
	if (parsed.invalid.length > 0) return {
		ok: false,
		error: `收件人邮箱格式不合法：${parsed.invalid.join("、")}`
	};
	if (parsed.addresses.length === 0) return {
		ok: false,
		error: "收件人邮箱不能为空；如需使用默认收件人请省略 to 参数"
	};
	return {
		ok: true,
		recipients: parsed.addresses,
		source: "explicit"
	};
}
/** 块级标签换行规则：这些标签闭合处插入换行，避免正文被压成一整行。 */
const BLOCK_BOUNDARY = /<\/?(?:br|p|div|tr|li|h[1-6]|table|section|article)\b[^>]*>/gi;
/** 实体解码表：只覆盖邮件正文里最常见的几种，够用且无依赖。 */
const ENTITIES = {
	"&nbsp;": " ",
	"&amp;": "&",
	"&lt;": "<",
	"&gt;": ">",
	"&quot;": "\"",
	"&#39;": "'"
};
/**
* 把 HTML 正文降级为纯文本，作为 multipart/alternative 的文本分支提升送达率。
*
* 转换规则（尽力而为，不追求完整解析）：
*   1. 块级标签（p/div/br/li/tr/h1-h6 等）的开合都折算为换行，
*      于是相邻段落之间自然留出空行——这是 HTML→纯文本的通行语义；
*   2. 其余标签直接去除，行内标签（strong/span 等）不产生换行；
*   3. 解码常见实体，收敛连续空行。
* @param html - 原始 HTML 片段。
*/
function htmlToPlainText(html) {
	return html.replace(BLOCK_BOUNDARY, "\n").replace(/<[^>]*>/g, "").replace(/&nbsp;|&amp;|&lt;|&gt;|&quot;|&#39;/g, (match) => ENTITIES[match] ?? match).split("\n").map((line) => line.trim()).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
/**
* 规范化附件路径：去空白、剔除空项、按绝对路径去重。
* 这里只做字符串层面的归一，不判断文件是否存在——那是 IO，归 smtp.ts。
* @param attachments - 原始附件路径列表。
*/
function normalizeAttachments(attachments) {
	const resolved = [];
	const seen = /* @__PURE__ */ new Set();
	for (const raw of attachments) {
		const candidate = raw.trim();
		if (candidate.length === 0) continue;
		const absolute = resolve(candidate);
		if (seen.has(absolute)) continue;
		seen.add(absolute);
		resolved.push(absolute);
	}
	return resolved;
}
/**
* 校验并组装邮件内容。
*
* 主题必填；正文要求 body 与 html 至少有一个；只给 html 时自动生成纯文本分支；
* 抄送地址沿用与收件人同一套解析规则，非法即拒绝而非静默丢弃。
*
* @param input - 工具参数形态的原始输入。
* @returns 组装结果。
*/
function compileMail(input) {
	const subject = (input.subject ?? "").trim();
	if (subject.length === 0) return {
		ok: false,
		error: "邮件主题（subject）不能为空"
	};
	const body = (input.body ?? "").trim();
	const html = (input.html ?? "").trim();
	if (body.length === 0 && html.length === 0) return {
		ok: false,
		error: "邮件正文不能为空：请提供 body（纯文本）或 html（富文本）"
	};
	const text = body.length > 0 ? body : htmlToPlainText(html);
	const cc = parseAddresses(input.cc);
	if (cc.invalid.length > 0) return {
		ok: false,
		error: `抄送邮箱格式不合法：${cc.invalid.join("、")}`
	};
	const attachments = normalizeAttachments(input.attachments ?? []);
	if (attachments.length > 10) return {
		ok: false,
		error: `附件数量超过上限 10（当前 ${attachments.length} 个）`
	};
	return {
		ok: true,
		mail: {
			subject,
			text,
			...html.length > 0 ? { html } : {},
			cc: cc.addresses,
			attachments
		}
	};
}
//#endregion
//#region node_modules/nodemailer/lib/fetch/cookies.js
var require_cookies = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const urllib$4 = __require("url");
	const SESSION_TIMEOUT = 1800;
	/**
	* Creates a biskviit cookie jar for managing cookie values in memory
	*
	* @constructor
	* @param {Object} [options] Optional options object
	*/
	var Cookies = class {
		constructor(options) {
			this.options = options || {};
			this.cookies = [];
		}
		/**
		* Stores a cookie string to the cookie storage
		*
		* @param {String} cookieStr Value from the 'Set-Cookie:' header
		* @param {String} url Current URL
		*/
		set(cookieStr, url) {
			let urlparts = urllib$4.parse(url || "");
			let cookie = this.parse(cookieStr);
			let domain;
			if (cookie.domain) {
				domain = cookie.domain.replace(/^\./, "");
				if (urlparts.hostname.length < domain.length || ("." + urlparts.hostname).substr(-domain.length + 1) !== "." + domain) cookie.domain = urlparts.hostname;
			} else cookie.domain = urlparts.hostname;
			if (!cookie.path) cookie.path = this.getPath(urlparts.pathname);
			if (!cookie.expires) cookie.expires = new Date(Date.now() + (Number(this.options.sessionTimeout || SESSION_TIMEOUT) || SESSION_TIMEOUT) * 1e3);
			return this.add(cookie);
		}
		/**
		* Returns cookie string for the 'Cookie:' header.
		*
		* @param {String} url URL to check for
		* @returns {String} Cookie header or empty string if no matches were found
		*/
		get(url) {
			return this.list(url).map((cookie) => cookie.name + "=" + cookie.value).join("; ");
		}
		/**
		* Lists all valied cookie objects for the specified URL
		*
		* @param {String} url URL to check for
		* @returns {Array} An array of cookie objects
		*/
		list(url) {
			let result = [];
			let i;
			let cookie;
			for (i = this.cookies.length - 1; i >= 0; i--) {
				cookie = this.cookies[i];
				if (this.isExpired(cookie)) {
					this.cookies.splice(i, i);
					continue;
				}
				if (this.match(cookie, url)) result.unshift(cookie);
			}
			return result;
		}
		/**
		* Parses cookie string from the 'Set-Cookie:' header
		*
		* @param {String} cookieStr String from the 'Set-Cookie:' header
		* @returns {Object} Cookie object
		*/
		parse(cookieStr) {
			let cookie = {};
			(cookieStr || "").toString().split(";").forEach((cookiePart) => {
				let valueParts = cookiePart.split("=");
				let key = valueParts.shift().trim().toLowerCase();
				let value = valueParts.join("=").trim();
				let domain;
				if (!key) return;
				switch (key) {
					case "expires":
						value = new Date(value);
						if (value.toString() !== "Invalid Date") cookie.expires = value;
						break;
					case "path":
						cookie.path = value;
						break;
					case "domain":
						domain = value.toLowerCase();
						if (domain.length && domain.charAt(0) !== ".") domain = "." + domain;
						cookie.domain = domain;
						break;
					case "max-age":
						cookie.expires = new Date(Date.now() + (Number(value) || 0) * 1e3);
						break;
					case "secure":
						cookie.secure = true;
						break;
					case "httponly":
						cookie.httponly = true;
						break;
					default: if (!cookie.name) {
						cookie.name = key;
						cookie.value = value;
					}
				}
			});
			return cookie;
		}
		/**
		* Checks if a cookie object is valid for a specified URL
		*
		* @param {Object} cookie Cookie object
		* @param {String} url URL to check for
		* @returns {Boolean} true if cookie is valid for specifiec URL
		*/
		match(cookie, url) {
			let urlparts = urllib$4.parse(url || "");
			if (urlparts.hostname !== cookie.domain && (cookie.domain.charAt(0) !== "." || ("." + urlparts.hostname).substr(-cookie.domain.length) !== cookie.domain)) return false;
			if (this.getPath(urlparts.pathname).substr(0, cookie.path.length) !== cookie.path) return false;
			if (cookie.secure && urlparts.protocol !== "https:") return false;
			return true;
		}
		/**
		* Adds (or updates/removes if needed) a cookie object to the cookie storage
		*
		* @param {Object} cookie Cookie value to be stored
		*/
		add(cookie) {
			let i;
			let len;
			if (!cookie || !cookie.name) return false;
			for (i = 0, len = this.cookies.length; i < len; i++) if (this.compare(this.cookies[i], cookie)) {
				if (this.isExpired(cookie)) {
					this.cookies.splice(i, 1);
					return false;
				}
				this.cookies[i] = cookie;
				return true;
			}
			if (!this.isExpired(cookie)) this.cookies.push(cookie);
			return true;
		}
		/**
		* Checks if two cookie objects are the same
		*
		* @param {Object} a Cookie to check against
		* @param {Object} b Cookie to check against
		* @returns {Boolean} True, if the cookies are the same
		*/
		compare(a, b) {
			return a.name === b.name && a.path === b.path && a.domain === b.domain && a.secure === b.secure && a.httponly === a.httponly;
		}
		/**
		* Checks if a cookie is expired
		*
		* @param {Object} cookie Cookie object to check against
		* @returns {Boolean} True, if the cookie is expired
		*/
		isExpired(cookie) {
			return cookie.expires && cookie.expires < /* @__PURE__ */ new Date() || !cookie.value;
		}
		/**
		* Returns normalized cookie path for an URL path argument
		*
		* @param {String} pathname
		* @returns {String} Normalized path
		*/
		getPath(pathname) {
			let path = (pathname || "/").split("/");
			path.pop();
			path = path.join("/").trim();
			if (path.charAt(0) !== "/") path = "/" + path;
			if (path.substr(-1) !== "/") path += "/";
			return path;
		}
	};
	module.exports = Cookies;
}));
//#endregion
//#region node_modules/nodemailer/package.json
var require_package = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	module.exports = {
		"name": "nodemailer",
		"version": "7.0.13",
		"description": "Easy as cake e-mail sending from your Node.js applications",
		"main": "lib/nodemailer.js",
		"scripts": {
			"test": "node --test --test-concurrency=1 test/**/*.test.js test/**/*-test.js",
			"test:coverage": "c8 node --test --test-concurrency=1 test/**/*.test.js test/**/*-test.js",
			"format": "prettier --write \"**/*.{js,json,md}\"",
			"format:check": "prettier --check \"**/*.{js,json,md}\"",
			"lint": "eslint .",
			"lint:fix": "eslint . --fix",
			"update": "rm -rf node_modules/ package-lock.json && ncu -u && npm install"
		},
		"repository": {
			"type": "git",
			"url": "https://github.com/nodemailer/nodemailer.git"
		},
		"keywords": ["Nodemailer"],
		"author": "Andris Reinman",
		"license": "MIT-0",
		"bugs": { "url": "https://github.com/nodemailer/nodemailer/issues" },
		"homepage": "https://nodemailer.com/",
		"devDependencies": {
			"@aws-sdk/client-sesv2": "3.975.0",
			"bunyan": "1.8.15",
			"c8": "10.1.3",
			"eslint": "9.39.2",
			"eslint-config-prettier": "10.1.8",
			"globals": "17.1.0",
			"libbase64": "1.3.0",
			"libmime": "5.3.7",
			"libqp": "2.1.1",
			"nodemailer-ntlm-auth": "1.0.4",
			"prettier": "3.8.1",
			"proxy": "1.0.2",
			"proxy-test-server": "1.0.0",
			"smtp-server": "3.18.0"
		},
		"engines": { "node": ">=6.0.0" }
	};
}));
//#endregion
//#region node_modules/nodemailer/lib/fetch/index.js
var require_fetch = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const http = __require("http");
	const https = __require("https");
	const urllib$3 = __require("url");
	const zlib = __require("zlib");
	const PassThrough$3 = __require("stream").PassThrough;
	const Cookies = require_cookies();
	const packageData = require_package();
	const net$4 = __require("net");
	const MAX_REDIRECTS = 5;
	module.exports = function(url, options) {
		return nmfetch(url, options);
	};
	module.exports.Cookies = Cookies;
	function nmfetch(url, options) {
		options = options || {};
		options.fetchRes = options.fetchRes || new PassThrough$3();
		options.cookies = options.cookies || new Cookies();
		options.redirects = options.redirects || 0;
		options.maxRedirects = isNaN(options.maxRedirects) ? MAX_REDIRECTS : options.maxRedirects;
		if (options.cookie) {
			[].concat(options.cookie || []).forEach((cookie) => {
				options.cookies.set(cookie, url);
			});
			options.cookie = false;
		}
		let fetchRes = options.fetchRes;
		let parsed = urllib$3.parse(url);
		let method = (options.method || "").toString().trim().toUpperCase() || "GET";
		let finished = false;
		let cookies;
		let body;
		let handler = parsed.protocol === "https:" ? https : http;
		let headers = {
			"accept-encoding": "gzip,deflate",
			"user-agent": "nodemailer/" + packageData.version
		};
		Object.keys(options.headers || {}).forEach((key) => {
			headers[key.toLowerCase().trim()] = options.headers[key];
		});
		if (options.userAgent) headers["user-agent"] = options.userAgent;
		if (parsed.auth) headers.Authorization = "Basic " + Buffer.from(parsed.auth).toString("base64");
		if (cookies = options.cookies.get(url)) headers.cookie = cookies;
		if (options.body) {
			if (options.contentType !== false) headers["Content-Type"] = options.contentType || "application/x-www-form-urlencoded";
			if (typeof options.body.pipe === "function") {
				headers["Transfer-Encoding"] = "chunked";
				body = options.body;
				body.on("error", (err) => {
					if (finished) return;
					finished = true;
					err.type = "FETCH";
					err.sourceUrl = url;
					fetchRes.emit("error", err);
				});
			} else {
				if (options.body instanceof Buffer) body = options.body;
				else if (typeof options.body === "object") try {
					body = Buffer.from(Object.keys(options.body).map((key) => {
						let value = options.body[key].toString().trim();
						return encodeURIComponent(key) + "=" + encodeURIComponent(value);
					}).join("&"));
				} catch (E) {
					if (finished) return;
					finished = true;
					E.type = "FETCH";
					E.sourceUrl = url;
					fetchRes.emit("error", E);
					return;
				}
				else body = Buffer.from(options.body.toString().trim());
				headers["Content-Type"] = options.contentType || "application/x-www-form-urlencoded";
				headers["Content-Length"] = body.length;
			}
			method = (options.method || "").toString().trim().toUpperCase() || "POST";
		}
		let req;
		let reqOptions = {
			method,
			host: parsed.hostname,
			path: parsed.path,
			port: parsed.port ? parsed.port : parsed.protocol === "https:" ? 443 : 80,
			headers,
			rejectUnauthorized: false,
			agent: false
		};
		if (options.tls) Object.keys(options.tls).forEach((key) => {
			reqOptions[key] = options.tls[key];
		});
		if (parsed.protocol === "https:" && parsed.hostname && parsed.hostname !== reqOptions.host && !net$4.isIP(parsed.hostname) && !reqOptions.servername) reqOptions.servername = parsed.hostname;
		try {
			req = handler.request(reqOptions);
		} catch (E) {
			finished = true;
			setImmediate(() => {
				E.type = "FETCH";
				E.sourceUrl = url;
				fetchRes.emit("error", E);
			});
			return fetchRes;
		}
		if (options.timeout) req.setTimeout(options.timeout, () => {
			if (finished) return;
			finished = true;
			req.abort();
			let err = /* @__PURE__ */ new Error("Request Timeout");
			err.type = "FETCH";
			err.sourceUrl = url;
			fetchRes.emit("error", err);
		});
		req.on("error", (err) => {
			if (finished) return;
			finished = true;
			err.type = "FETCH";
			err.sourceUrl = url;
			fetchRes.emit("error", err);
		});
		req.on("response", (res) => {
			let inflate;
			if (finished) return;
			switch (res.headers["content-encoding"]) {
				case "gzip":
				case "deflate":
					inflate = zlib.createUnzip();
					break;
			}
			if (res.headers["set-cookie"]) [].concat(res.headers["set-cookie"] || []).forEach((cookie) => {
				options.cookies.set(cookie, url);
			});
			if ([
				301,
				302,
				303,
				307,
				308
			].includes(res.statusCode) && res.headers.location) {
				options.redirects++;
				if (options.redirects > options.maxRedirects) {
					finished = true;
					let err = /* @__PURE__ */ new Error("Maximum redirect count exceeded");
					err.type = "FETCH";
					err.sourceUrl = url;
					fetchRes.emit("error", err);
					req.abort();
					return;
				}
				options.method = "GET";
				options.body = false;
				return nmfetch(urllib$3.resolve(url, res.headers.location), options);
			}
			fetchRes.statusCode = res.statusCode;
			fetchRes.headers = res.headers;
			if (res.statusCode >= 300 && !options.allowErrorResponse) {
				finished = true;
				let err = /* @__PURE__ */ new Error("Invalid status code " + res.statusCode);
				err.type = "FETCH";
				err.sourceUrl = url;
				fetchRes.emit("error", err);
				req.abort();
				return;
			}
			res.on("error", (err) => {
				if (finished) return;
				finished = true;
				err.type = "FETCH";
				err.sourceUrl = url;
				fetchRes.emit("error", err);
				req.abort();
			});
			if (inflate) {
				res.pipe(inflate).pipe(fetchRes);
				inflate.on("error", (err) => {
					if (finished) return;
					finished = true;
					err.type = "FETCH";
					err.sourceUrl = url;
					fetchRes.emit("error", err);
					req.abort();
				});
			} else res.pipe(fetchRes);
		});
		setImmediate(() => {
			if (body) try {
				if (typeof body.pipe === "function") return body.pipe(req);
				else req.write(body);
			} catch (err) {
				finished = true;
				err.type = "FETCH";
				err.sourceUrl = url;
				fetchRes.emit("error", err);
				return;
			}
			req.end();
		});
		return fetchRes;
	}
}));
//#endregion
//#region node_modules/nodemailer/lib/shared/index.js
var require_shared = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const urllib$2 = __require("url");
	const util$1 = __require("util");
	const fs$2 = __require("fs");
	const nmfetch = require_fetch();
	const dns$1 = __require("dns");
	const net$3 = __require("net");
	const os$1 = __require("os");
	const DNS_TTL = 300 * 1e3;
	const CACHE_CLEANUP_INTERVAL = 30 * 1e3;
	const MAX_CACHE_SIZE = 1e3;
	let lastCacheCleanup = 0;
	module.exports._lastCacheCleanup = () => lastCacheCleanup;
	module.exports._resetCacheCleanup = () => {
		lastCacheCleanup = 0;
	};
	let networkInterfaces;
	try {
		networkInterfaces = os$1.networkInterfaces();
	} catch (_err) {}
	module.exports.networkInterfaces = networkInterfaces;
	const isFamilySupported = (family, allowInternal) => {
		let networkInterfaces = module.exports.networkInterfaces;
		if (!networkInterfaces) return true;
		return Object.keys(networkInterfaces).map((key) => networkInterfaces[key]).reduce((acc, val) => acc.concat(val), []).filter((i) => !i.internal || allowInternal).filter((i) => i.family === "IPv" + family || i.family === family).length > 0;
	};
	const resolver = (family, hostname, options, callback) => {
		options = options || {};
		if (!isFamilySupported(family, options.allowInternalNetworkInterfaces)) return callback(null, []);
		(dns$1.Resolver ? new dns$1.Resolver(options) : dns$1)["resolve" + family](hostname, (err, addresses) => {
			if (err) {
				switch (err.code) {
					case dns$1.NODATA:
					case dns$1.NOTFOUND:
					case dns$1.NOTIMP:
					case dns$1.SERVFAIL:
					case dns$1.CONNREFUSED:
					case dns$1.REFUSED:
					case "EAI_AGAIN": return callback(null, []);
				}
				return callback(err);
			}
			return callback(null, Array.isArray(addresses) ? addresses : [].concat(addresses || []));
		});
	};
	const dnsCache = module.exports.dnsCache = /* @__PURE__ */ new Map();
	const formatDNSValue = (value, extra) => {
		if (!value) return Object.assign({}, extra || {});
		return Object.assign({
			servername: value.servername,
			host: !value.addresses || !value.addresses.length ? null : value.addresses.length === 1 ? value.addresses[0] : value.addresses[Math.floor(Math.random() * value.addresses.length)]
		}, extra || {});
	};
	module.exports.resolveHostname = (options, callback) => {
		options = options || {};
		if (!options.host && options.servername) options.host = options.servername;
		if (!options.host || net$3.isIP(options.host)) return callback(null, formatDNSValue({
			addresses: [options.host],
			servername: options.servername || false
		}, { cached: false }));
		let cached;
		if (dnsCache.has(options.host)) {
			cached = dnsCache.get(options.host);
			const now = Date.now();
			if (now - lastCacheCleanup > CACHE_CLEANUP_INTERVAL) {
				lastCacheCleanup = now;
				for (const [host, entry] of dnsCache.entries()) if (entry.expires && entry.expires < now) dnsCache.delete(host);
				if (dnsCache.size > MAX_CACHE_SIZE) {
					const toDelete = Math.floor(MAX_CACHE_SIZE * .1);
					Array.from(dnsCache.keys()).slice(0, toDelete).forEach((key) => dnsCache.delete(key));
				}
			}
			if (!cached.expires || cached.expires >= now) return callback(null, formatDNSValue(cached.value, { cached: true }));
		}
		resolver(4, options.host, options, (err, addresses) => {
			if (err) {
				if (cached) {
					dnsCache.set(options.host, {
						value: cached.value,
						expires: Date.now() + (options.dnsTtl || DNS_TTL)
					});
					return callback(null, formatDNSValue(cached.value, {
						cached: true,
						error: err
					}));
				}
				return callback(err);
			}
			if (addresses && addresses.length) {
				let value = {
					addresses,
					servername: options.servername || options.host
				};
				dnsCache.set(options.host, {
					value,
					expires: Date.now() + (options.dnsTtl || DNS_TTL)
				});
				return callback(null, formatDNSValue(value, { cached: false }));
			}
			resolver(6, options.host, options, (err, addresses) => {
				if (err) {
					if (cached) {
						dnsCache.set(options.host, {
							value: cached.value,
							expires: Date.now() + (options.dnsTtl || DNS_TTL)
						});
						return callback(null, formatDNSValue(cached.value, {
							cached: true,
							error: err
						}));
					}
					return callback(err);
				}
				if (addresses && addresses.length) {
					let value = {
						addresses,
						servername: options.servername || options.host
					};
					dnsCache.set(options.host, {
						value,
						expires: Date.now() + (options.dnsTtl || DNS_TTL)
					});
					return callback(null, formatDNSValue(value, { cached: false }));
				}
				try {
					dns$1.lookup(options.host, { all: true }, (err, addresses) => {
						if (err) {
							if (cached) {
								dnsCache.set(options.host, {
									value: cached.value,
									expires: Date.now() + (options.dnsTtl || DNS_TTL)
								});
								return callback(null, formatDNSValue(cached.value, {
									cached: true,
									error: err
								}));
							}
							return callback(err);
						}
						let address = addresses ? addresses.filter((addr) => isFamilySupported(addr.family)).map((addr) => addr.address).shift() : false;
						if (addresses && addresses.length && !address) console.warn(`Failed to resolve IPv${addresses[0].family} addresses with current network`);
						if (!address && cached) return callback(null, formatDNSValue(cached.value, { cached: true }));
						let value = {
							addresses: address ? [address] : [options.host],
							servername: options.servername || options.host
						};
						dnsCache.set(options.host, {
							value,
							expires: Date.now() + (options.dnsTtl || DNS_TTL)
						});
						return callback(null, formatDNSValue(value, { cached: false }));
					});
				} catch (_err) {
					if (cached) {
						dnsCache.set(options.host, {
							value: cached.value,
							expires: Date.now() + (options.dnsTtl || DNS_TTL)
						});
						return callback(null, formatDNSValue(cached.value, {
							cached: true,
							error: err
						}));
					}
					return callback(err);
				}
			});
		});
	};
	/**
	* Parses connection url to a structured configuration object
	*
	* @param {String} str Connection url
	* @return {Object} Configuration object
	*/
	module.exports.parseConnectionUrl = (str) => {
		str = str || "";
		let options = {};
		[urllib$2.parse(str, true)].forEach((url) => {
			let auth;
			switch (url.protocol) {
				case "smtp:":
					options.secure = false;
					break;
				case "smtps:":
					options.secure = true;
					break;
				case "direct:":
					options.direct = true;
					break;
			}
			if (!isNaN(url.port) && Number(url.port)) options.port = Number(url.port);
			if (url.hostname) options.host = url.hostname;
			if (url.auth) {
				auth = url.auth.split(":");
				if (!options.auth) options.auth = {};
				options.auth.user = auth.shift();
				options.auth.pass = auth.join(":");
			}
			Object.keys(url.query || {}).forEach((key) => {
				let obj = options;
				let lKey = key;
				let value = url.query[key];
				if (!isNaN(value)) value = Number(value);
				switch (value) {
					case "true":
						value = true;
						break;
					case "false":
						value = false;
						break;
				}
				if (key.indexOf("tls.") === 0) {
					lKey = key.substr(4);
					if (!options.tls) options.tls = {};
					obj = options.tls;
				} else if (key.indexOf(".") >= 0) return;
				if (!(lKey in obj)) obj[lKey] = value;
			});
		});
		return options;
	};
	module.exports._logFunc = (logger, level, defaults, data, message, ...args) => {
		let entry = {};
		Object.keys(defaults || {}).forEach((key) => {
			if (key !== "level") entry[key] = defaults[key];
		});
		Object.keys(data || {}).forEach((key) => {
			if (key !== "level") entry[key] = data[key];
		});
		logger[level](entry, message, ...args);
	};
	/**
	* Returns a bunyan-compatible logger interface. Uses either provided logger or
	* creates a default console logger
	*
	* @param {Object} [options] Options object that might include 'logger' value
	* @return {Object} bunyan compatible logger
	*/
	module.exports.getLogger = (options, defaults) => {
		options = options || {};
		let response = {};
		let levels = [
			"trace",
			"debug",
			"info",
			"warn",
			"error",
			"fatal"
		];
		if (!options.logger) {
			levels.forEach((level) => {
				response[level] = () => false;
			});
			return response;
		}
		let logger = options.logger;
		if (options.logger === true) logger = createDefaultLogger(levels);
		levels.forEach((level) => {
			response[level] = (data, message, ...args) => {
				module.exports._logFunc(logger, level, defaults, data, message, ...args);
			};
		});
		return response;
	};
	/**
	* Wrapper for creating a callback that either resolves or rejects a promise
	* based on input
	*
	* @param {Function} resolve Function to run if callback is called
	* @param {Function} reject Function to run if callback ends with an error
	*/
	module.exports.callbackPromise = (resolve, reject) => function() {
		let args = Array.from(arguments);
		let err = args.shift();
		if (err) reject(err);
		else resolve(...args);
	};
	module.exports.parseDataURI = (uri) => {
		if (typeof uri !== "string") return null;
		if (!uri.startsWith("data:")) return null;
		const commaPos = uri.indexOf(",");
		if (commaPos === -1) return null;
		const data = uri.substring(commaPos + 1);
		const metaStr = uri.substring(5, commaPos);
		let encoding;
		const metaEntries = metaStr.split(";");
		if (metaEntries.length > 0) {
			const lastEntry = metaEntries[metaEntries.length - 1].toLowerCase().trim();
			if ([
				"base64",
				"utf8",
				"utf-8"
			].includes(lastEntry) && lastEntry.indexOf("=") === -1) {
				encoding = lastEntry;
				metaEntries.pop();
			}
		}
		const contentType = metaEntries.length > 0 ? metaEntries.shift() : "application/octet-stream";
		const params = {};
		for (let i = 0; i < metaEntries.length; i++) {
			const entry = metaEntries[i];
			const sepPos = entry.indexOf("=");
			if (sepPos > 0) {
				const key = entry.substring(0, sepPos).trim();
				const value = entry.substring(sepPos + 1).trim();
				if (key) params[key] = value;
			}
		}
		let bufferData;
		try {
			if (encoding === "base64") bufferData = Buffer.from(data, "base64");
			else try {
				bufferData = Buffer.from(decodeURIComponent(data));
			} catch (_decodeError) {
				bufferData = Buffer.from(data);
			}
		} catch (_bufferError) {
			bufferData = Buffer.alloc(0);
		}
		return {
			data: bufferData,
			encoding: encoding || null,
			contentType: contentType || "application/octet-stream",
			params
		};
	};
	/**
	* Resolves a String or a Buffer value for content value. Useful if the value
	* is a Stream or a file or an URL. If the value is a Stream, overwrites
	* the stream object with the resolved value (you can't stream a value twice).
	*
	* This is useful when you want to create a plugin that needs a content value,
	* for example the `html` or `text` value as a String or a Buffer but not as
	* a file path or an URL.
	*
	* @param {Object} data An object or an Array you want to resolve an element for
	* @param {String|Number} key Property name or an Array index
	* @param {Function} callback Callback function with (err, value)
	*/
	module.exports.resolveContent = (data, key, callback) => {
		let promise;
		if (!callback) promise = new Promise((resolve, reject) => {
			callback = module.exports.callbackPromise(resolve, reject);
		});
		let content = data && data[key] && data[key].content || data[key];
		let contentStream;
		let encoding = (typeof data[key] === "object" && data[key].encoding || "utf8").toString().toLowerCase().replace(/[-_\s]/g, "");
		if (!content) return callback(null, content);
		if (typeof content === "object") {
			if (typeof content.pipe === "function") return resolveStream(content, (err, value) => {
				if (err) return callback(err);
				if (data[key].content) data[key].content = value;
				else data[key] = value;
				callback(null, value);
			});
			else if (/^https?:\/\//i.test(content.path || content.href)) {
				contentStream = nmfetch(content.path || content.href);
				return resolveStream(contentStream, callback);
			} else if (/^data:/i.test(content.path || content.href)) {
				let parsedDataUri = module.exports.parseDataURI(content.path || content.href);
				if (!parsedDataUri || !parsedDataUri.data) return callback(null, Buffer.from(0));
				return callback(null, parsedDataUri.data);
			} else if (content.path) return resolveStream(fs$2.createReadStream(content.path), callback);
		}
		if (typeof data[key].content === "string" && ![
			"utf8",
			"usascii",
			"ascii"
		].includes(encoding)) content = Buffer.from(data[key].content, encoding);
		setImmediate(() => callback(null, content));
		return promise;
	};
	/**
	* Copies properties from source objects to target objects
	*/
	module.exports.assign = function() {
		let args = Array.from(arguments);
		let target = args.shift() || {};
		args.forEach((source) => {
			Object.keys(source || {}).forEach((key) => {
				if (["tls", "auth"].includes(key) && source[key] && typeof source[key] === "object") {
					if (!target[key]) target[key] = {};
					Object.keys(source[key]).forEach((subKey) => {
						target[key][subKey] = source[key][subKey];
					});
				} else target[key] = source[key];
			});
		});
		return target;
	};
	module.exports.encodeXText = (str) => {
		if (!/[^\x21-\x2A\x2C-\x3C\x3E-\x7E]/.test(str)) return str;
		let buf = Buffer.from(str);
		let result = "";
		for (let i = 0, len = buf.length; i < len; i++) {
			let c = buf[i];
			if (c < 33 || c > 126 || c === 43 || c === 61) result += "+" + (c < 16 ? "0" : "") + c.toString(16).toUpperCase();
			else result += String.fromCharCode(c);
		}
		return result;
	};
	/**
	* Streams a stream value into a Buffer
	*
	* @param {Object} stream Readable stream
	* @param {Function} callback Callback function with (err, value)
	*/
	function resolveStream(stream, callback) {
		let responded = false;
		let chunks = [];
		let chunklen = 0;
		stream.on("error", (err) => {
			if (responded) return;
			responded = true;
			callback(err);
		});
		stream.on("readable", () => {
			let chunk;
			while ((chunk = stream.read()) !== null) {
				chunks.push(chunk);
				chunklen += chunk.length;
			}
		});
		stream.on("end", () => {
			if (responded) return;
			responded = true;
			let value;
			try {
				value = Buffer.concat(chunks, chunklen);
			} catch (E) {
				return callback(E);
			}
			callback(null, value);
		});
	}
	/**
	* Generates a bunyan-like logger that prints to console
	*
	* @returns {Object} Bunyan logger instance
	*/
	function createDefaultLogger(levels) {
		let levelMaxLen = 0;
		let levelNames = /* @__PURE__ */ new Map();
		levels.forEach((level) => {
			if (level.length > levelMaxLen) levelMaxLen = level.length;
		});
		levels.forEach((level) => {
			let levelName = level.toUpperCase();
			if (levelName.length < levelMaxLen) levelName += " ".repeat(levelMaxLen - levelName.length);
			levelNames.set(level, levelName);
		});
		let print = (level, entry, message, ...args) => {
			let prefix = "";
			if (entry) {
				if (entry.tnx === "server") prefix = "S: ";
				else if (entry.tnx === "client") prefix = "C: ";
				if (entry.sid) prefix = "[" + entry.sid + "] " + prefix;
				if (entry.cid) prefix = "[#" + entry.cid + "] " + prefix;
			}
			message = util$1.format(message, ...args);
			message.split(/\r?\n/).forEach((line) => {
				console.log("[%s] %s %s", (/* @__PURE__ */ new Date()).toISOString().substr(0, 19).replace(/T/, " "), levelNames.get(level), prefix + line);
			});
		};
		let logger = {};
		levels.forEach((level) => {
			logger[level] = print.bind(null, level);
		});
		return logger;
	}
}));
//#endregion
//#region node_modules/nodemailer/lib/mime-funcs/mime-types.js
var require_mime_types = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const path$1 = __require("path");
	const defaultMimeType = "application/octet-stream";
	const defaultExtension = "bin";
	const mimeTypes = new Map([
		["application/acad", "dwg"],
		["application/applixware", "aw"],
		["application/arj", "arj"],
		["application/atom+xml", "xml"],
		["application/atomcat+xml", "atomcat"],
		["application/atomsvc+xml", "atomsvc"],
		["application/base64", ["mm", "mme"]],
		["application/binhex", "hqx"],
		["application/binhex4", "hqx"],
		["application/book", ["book", "boo"]],
		["application/ccxml+xml,", "ccxml"],
		["application/cdf", "cdf"],
		["application/cdmi-capability", "cdmia"],
		["application/cdmi-container", "cdmic"],
		["application/cdmi-domain", "cdmid"],
		["application/cdmi-object", "cdmio"],
		["application/cdmi-queue", "cdmiq"],
		["application/clariscad", "ccad"],
		["application/commonground", "dp"],
		["application/cu-seeme", "cu"],
		["application/davmount+xml", "davmount"],
		["application/drafting", "drw"],
		["application/dsptype", "tsp"],
		["application/dssc+der", "dssc"],
		["application/dssc+xml", "xdssc"],
		["application/dxf", "dxf"],
		["application/ecmascript", ["js", "es"]],
		["application/emma+xml", "emma"],
		["application/envoy", "evy"],
		["application/epub+zip", "epub"],
		["application/excel", [
			"xls",
			"xl",
			"xla",
			"xlb",
			"xlc",
			"xld",
			"xlk",
			"xll",
			"xlm",
			"xlt",
			"xlv",
			"xlw"
		]],
		["application/exi", "exi"],
		["application/font-tdpfr", "pfr"],
		["application/fractals", "fif"],
		["application/freeloader", "frl"],
		["application/futuresplash", "spl"],
		["application/geo+json", "geojson"],
		["application/gnutar", "tgz"],
		["application/groupwise", "vew"],
		["application/hlp", "hlp"],
		["application/hta", "hta"],
		["application/hyperstudio", "stk"],
		["application/i-deas", "unv"],
		["application/iges", ["iges", "igs"]],
		["application/inf", "inf"],
		["application/internet-property-stream", "acx"],
		["application/ipfix", "ipfix"],
		["application/java", "class"],
		["application/java-archive", "jar"],
		["application/java-byte-code", "class"],
		["application/java-serialized-object", "ser"],
		["application/java-vm", "class"],
		["application/javascript", "js"],
		["application/json", "json"],
		["application/lha", "lha"],
		["application/lzx", "lzx"],
		["application/mac-binary", "bin"],
		["application/mac-binhex", "hqx"],
		["application/mac-binhex40", "hqx"],
		["application/mac-compactpro", "cpt"],
		["application/macbinary", "bin"],
		["application/mads+xml", "mads"],
		["application/marc", "mrc"],
		["application/marcxml+xml", "mrcx"],
		["application/mathematica", "ma"],
		["application/mathml+xml", "mathml"],
		["application/mbedlet", "mbd"],
		["application/mbox", "mbox"],
		["application/mcad", "mcd"],
		["application/mediaservercontrol+xml", "mscml"],
		["application/metalink4+xml", "meta4"],
		["application/mets+xml", "mets"],
		["application/mime", "aps"],
		["application/mods+xml", "mods"],
		["application/mp21", "m21"],
		["application/mp4", "mp4"],
		["application/mspowerpoint", [
			"ppt",
			"pot",
			"pps",
			"ppz"
		]],
		["application/msword", [
			"doc",
			"dot",
			"w6w",
			"wiz",
			"word"
		]],
		["application/mswrite", "wri"],
		["application/mxf", "mxf"],
		["application/netmc", "mcp"],
		["application/octet-stream", ["*"]],
		["application/oda", "oda"],
		["application/oebps-package+xml", "opf"],
		["application/ogg", "ogx"],
		["application/olescript", "axs"],
		["application/onenote", "onetoc"],
		["application/patch-ops-error+xml", "xer"],
		["application/pdf", "pdf"],
		["application/pgp-encrypted", "asc"],
		["application/pgp-signature", "pgp"],
		["application/pics-rules", "prf"],
		["application/pkcs-12", "p12"],
		["application/pkcs-crl", "crl"],
		["application/pkcs10", "p10"],
		["application/pkcs7-mime", ["p7c", "p7m"]],
		["application/pkcs7-signature", "p7s"],
		["application/pkcs8", "p8"],
		["application/pkix-attr-cert", "ac"],
		["application/pkix-cert", ["cer", "crt"]],
		["application/pkix-crl", "crl"],
		["application/pkix-pkipath", "pkipath"],
		["application/pkixcmp", "pki"],
		["application/plain", "text"],
		["application/pls+xml", "pls"],
		["application/postscript", [
			"ps",
			"ai",
			"eps"
		]],
		["application/powerpoint", "ppt"],
		["application/pro_eng", ["part", "prt"]],
		["application/prs.cww", "cww"],
		["application/pskc+xml", "pskcxml"],
		["application/rdf+xml", "rdf"],
		["application/reginfo+xml", "rif"],
		["application/relax-ng-compact-syntax", "rnc"],
		["application/resource-lists+xml", "rl"],
		["application/resource-lists-diff+xml", "rld"],
		["application/ringing-tones", "rng"],
		["application/rls-services+xml", "rs"],
		["application/rsd+xml", "rsd"],
		["application/rss+xml", "xml"],
		["application/rtf", ["rtf", "rtx"]],
		["application/sbml+xml", "sbml"],
		["application/scvp-cv-request", "scq"],
		["application/scvp-cv-response", "scs"],
		["application/scvp-vp-request", "spq"],
		["application/scvp-vp-response", "spp"],
		["application/sdp", "sdp"],
		["application/sea", "sea"],
		["application/set", "set"],
		["application/set-payment-initiation", "setpay"],
		["application/set-registration-initiation", "setreg"],
		["application/shf+xml", "shf"],
		["application/sla", "stl"],
		["application/smil", ["smi", "smil"]],
		["application/smil+xml", "smi"],
		["application/solids", "sol"],
		["application/sounder", "sdr"],
		["application/sparql-query", "rq"],
		["application/sparql-results+xml", "srx"],
		["application/srgs", "gram"],
		["application/srgs+xml", "grxml"],
		["application/sru+xml", "sru"],
		["application/ssml+xml", "ssml"],
		["application/step", ["step", "stp"]],
		["application/streamingmedia", "ssm"],
		["application/tei+xml", "tei"],
		["application/thraud+xml", "tfi"],
		["application/timestamped-data", "tsd"],
		["application/toolbook", "tbk"],
		["application/vda", "vda"],
		["application/vnd.3gpp.pic-bw-large", "plb"],
		["application/vnd.3gpp.pic-bw-small", "psb"],
		["application/vnd.3gpp.pic-bw-var", "pvb"],
		["application/vnd.3gpp2.tcap", "tcap"],
		["application/vnd.3m.post-it-notes", "pwn"],
		["application/vnd.accpac.simply.aso", "aso"],
		["application/vnd.accpac.simply.imp", "imp"],
		["application/vnd.acucobol", "acu"],
		["application/vnd.acucorp", "atc"],
		["application/vnd.adobe.air-application-installer-package+zip", "air"],
		["application/vnd.adobe.fxp", "fxp"],
		["application/vnd.adobe.xdp+xml", "xdp"],
		["application/vnd.adobe.xfdf", "xfdf"],
		["application/vnd.ahead.space", "ahead"],
		["application/vnd.airzip.filesecure.azf", "azf"],
		["application/vnd.airzip.filesecure.azs", "azs"],
		["application/vnd.amazon.ebook", "azw"],
		["application/vnd.americandynamics.acc", "acc"],
		["application/vnd.amiga.ami", "ami"],
		["application/vnd.android.package-archive", "apk"],
		["application/vnd.anser-web-certificate-issue-initiation", "cii"],
		["application/vnd.anser-web-funds-transfer-initiation", "fti"],
		["application/vnd.antix.game-component", "atx"],
		["application/vnd.apple.installer+xml", "mpkg"],
		["application/vnd.apple.mpegurl", "m3u8"],
		["application/vnd.aristanetworks.swi", "swi"],
		["application/vnd.audiograph", "aep"],
		["application/vnd.blueice.multipass", "mpm"],
		["application/vnd.bmi", "bmi"],
		["application/vnd.businessobjects", "rep"],
		["application/vnd.chemdraw+xml", "cdxml"],
		["application/vnd.chipnuts.karaoke-mmd", "mmd"],
		["application/vnd.cinderella", "cdy"],
		["application/vnd.claymore", "cla"],
		["application/vnd.cloanto.rp9", "rp9"],
		["application/vnd.clonk.c4group", "c4g"],
		["application/vnd.cluetrust.cartomobile-config", "c11amc"],
		["application/vnd.cluetrust.cartomobile-config-pkg", "c11amz"],
		["application/vnd.commonspace", "csp"],
		["application/vnd.contact.cmsg", "cdbcmsg"],
		["application/vnd.cosmocaller", "cmc"],
		["application/vnd.crick.clicker", "clkx"],
		["application/vnd.crick.clicker.keyboard", "clkk"],
		["application/vnd.crick.clicker.palette", "clkp"],
		["application/vnd.crick.clicker.template", "clkt"],
		["application/vnd.crick.clicker.wordbank", "clkw"],
		["application/vnd.criticaltools.wbs+xml", "wbs"],
		["application/vnd.ctc-posml", "pml"],
		["application/vnd.cups-ppd", "ppd"],
		["application/vnd.curl.car", "car"],
		["application/vnd.curl.pcurl", "pcurl"],
		["application/vnd.data-vision.rdz", "rdz"],
		["application/vnd.denovo.fcselayout-link", "fe_launch"],
		["application/vnd.dna", "dna"],
		["application/vnd.dolby.mlp", "mlp"],
		["application/vnd.dpgraph", "dpg"],
		["application/vnd.dreamfactory", "dfac"],
		["application/vnd.dvb.ait", "ait"],
		["application/vnd.dvb.service", "svc"],
		["application/vnd.dynageo", "geo"],
		["application/vnd.ecowin.chart", "mag"],
		["application/vnd.enliven", "nml"],
		["application/vnd.epson.esf", "esf"],
		["application/vnd.epson.msf", "msf"],
		["application/vnd.epson.quickanime", "qam"],
		["application/vnd.epson.salt", "slt"],
		["application/vnd.epson.ssf", "ssf"],
		["application/vnd.eszigno3+xml", "es3"],
		["application/vnd.ezpix-album", "ez2"],
		["application/vnd.ezpix-package", "ez3"],
		["application/vnd.fdf", "fdf"],
		["application/vnd.fdsn.seed", "seed"],
		["application/vnd.flographit", "gph"],
		["application/vnd.fluxtime.clip", "ftc"],
		["application/vnd.framemaker", "fm"],
		["application/vnd.frogans.fnc", "fnc"],
		["application/vnd.frogans.ltf", "ltf"],
		["application/vnd.fsc.weblaunch", "fsc"],
		["application/vnd.fujitsu.oasys", "oas"],
		["application/vnd.fujitsu.oasys2", "oa2"],
		["application/vnd.fujitsu.oasys3", "oa3"],
		["application/vnd.fujitsu.oasysgp", "fg5"],
		["application/vnd.fujitsu.oasysprs", "bh2"],
		["application/vnd.fujixerox.ddd", "ddd"],
		["application/vnd.fujixerox.docuworks", "xdw"],
		["application/vnd.fujixerox.docuworks.binder", "xbd"],
		["application/vnd.fuzzysheet", "fzs"],
		["application/vnd.genomatix.tuxedo", "txd"],
		["application/vnd.geogebra.file", "ggb"],
		["application/vnd.geogebra.tool", "ggt"],
		["application/vnd.geometry-explorer", "gex"],
		["application/vnd.geonext", "gxt"],
		["application/vnd.geoplan", "g2w"],
		["application/vnd.geospace", "g3w"],
		["application/vnd.gmx", "gmx"],
		["application/vnd.google-earth.kml+xml", "kml"],
		["application/vnd.google-earth.kmz", "kmz"],
		["application/vnd.grafeq", "gqf"],
		["application/vnd.groove-account", "gac"],
		["application/vnd.groove-help", "ghf"],
		["application/vnd.groove-identity-message", "gim"],
		["application/vnd.groove-injector", "grv"],
		["application/vnd.groove-tool-message", "gtm"],
		["application/vnd.groove-tool-template", "tpl"],
		["application/vnd.groove-vcard", "vcg"],
		["application/vnd.hal+xml", "hal"],
		["application/vnd.handheld-entertainment+xml", "zmm"],
		["application/vnd.hbci", "hbci"],
		["application/vnd.hhe.lesson-player", "les"],
		["application/vnd.hp-hpgl", [
			"hgl",
			"hpg",
			"hpgl"
		]],
		["application/vnd.hp-hpid", "hpid"],
		["application/vnd.hp-hps", "hps"],
		["application/vnd.hp-jlyt", "jlt"],
		["application/vnd.hp-pcl", "pcl"],
		["application/vnd.hp-pclxl", "pclxl"],
		["application/vnd.hydrostatix.sof-data", "sfd-hdstx"],
		["application/vnd.hzn-3d-crossword", "x3d"],
		["application/vnd.ibm.minipay", "mpy"],
		["application/vnd.ibm.modcap", "afp"],
		["application/vnd.ibm.rights-management", "irm"],
		["application/vnd.ibm.secure-container", "sc"],
		["application/vnd.iccprofile", "icc"],
		["application/vnd.igloader", "igl"],
		["application/vnd.immervision-ivp", "ivp"],
		["application/vnd.immervision-ivu", "ivu"],
		["application/vnd.insors.igm", "igm"],
		["application/vnd.intercon.formnet", "xpw"],
		["application/vnd.intergeo", "i2g"],
		["application/vnd.intu.qbo", "qbo"],
		["application/vnd.intu.qfx", "qfx"],
		["application/vnd.ipunplugged.rcprofile", "rcprofile"],
		["application/vnd.irepository.package+xml", "irp"],
		["application/vnd.is-xpr", "xpr"],
		["application/vnd.isac.fcs", "fcs"],
		["application/vnd.jam", "jam"],
		["application/vnd.jcp.javame.midlet-rms", "rms"],
		["application/vnd.jisp", "jisp"],
		["application/vnd.joost.joda-archive", "joda"],
		["application/vnd.kahootz", "ktz"],
		["application/vnd.kde.karbon", "karbon"],
		["application/vnd.kde.kchart", "chrt"],
		["application/vnd.kde.kformula", "kfo"],
		["application/vnd.kde.kivio", "flw"],
		["application/vnd.kde.kontour", "kon"],
		["application/vnd.kde.kpresenter", "kpr"],
		["application/vnd.kde.kspread", "ksp"],
		["application/vnd.kde.kword", "kwd"],
		["application/vnd.kenameaapp", "htke"],
		["application/vnd.kidspiration", "kia"],
		["application/vnd.kinar", "kne"],
		["application/vnd.koan", "skp"],
		["application/vnd.kodak-descriptor", "sse"],
		["application/vnd.las.las+xml", "lasxml"],
		["application/vnd.llamagraphics.life-balance.desktop", "lbd"],
		["application/vnd.llamagraphics.life-balance.exchange+xml", "lbe"],
		["application/vnd.lotus-1-2-3", "123"],
		["application/vnd.lotus-approach", "apr"],
		["application/vnd.lotus-freelance", "pre"],
		["application/vnd.lotus-notes", "nsf"],
		["application/vnd.lotus-organizer", "org"],
		["application/vnd.lotus-screencam", "scm"],
		["application/vnd.lotus-wordpro", "lwp"],
		["application/vnd.macports.portpkg", "portpkg"],
		["application/vnd.mcd", "mcd"],
		["application/vnd.medcalcdata", "mc1"],
		["application/vnd.mediastation.cdkey", "cdkey"],
		["application/vnd.mfer", "mwf"],
		["application/vnd.mfmp", "mfm"],
		["application/vnd.micrografx.flo", "flo"],
		["application/vnd.micrografx.igx", "igx"],
		["application/vnd.mif", "mif"],
		["application/vnd.mobius.daf", "daf"],
		["application/vnd.mobius.dis", "dis"],
		["application/vnd.mobius.mbk", "mbk"],
		["application/vnd.mobius.mqy", "mqy"],
		["application/vnd.mobius.msl", "msl"],
		["application/vnd.mobius.plc", "plc"],
		["application/vnd.mobius.txf", "txf"],
		["application/vnd.mophun.application", "mpn"],
		["application/vnd.mophun.certificate", "mpc"],
		["application/vnd.mozilla.xul+xml", "xul"],
		["application/vnd.ms-artgalry", "cil"],
		["application/vnd.ms-cab-compressed", "cab"],
		["application/vnd.ms-excel", [
			"xls",
			"xla",
			"xlc",
			"xlm",
			"xlt",
			"xlw",
			"xlb",
			"xll"
		]],
		["application/vnd.ms-excel.addin.macroenabled.12", "xlam"],
		["application/vnd.ms-excel.sheet.binary.macroenabled.12", "xlsb"],
		["application/vnd.ms-excel.sheet.macroenabled.12", "xlsm"],
		["application/vnd.ms-excel.template.macroenabled.12", "xltm"],
		["application/vnd.ms-fontobject", "eot"],
		["application/vnd.ms-htmlhelp", "chm"],
		["application/vnd.ms-ims", "ims"],
		["application/vnd.ms-lrm", "lrm"],
		["application/vnd.ms-officetheme", "thmx"],
		["application/vnd.ms-outlook", "msg"],
		["application/vnd.ms-pki.certstore", "sst"],
		["application/vnd.ms-pki.pko", "pko"],
		["application/vnd.ms-pki.seccat", "cat"],
		["application/vnd.ms-pki.stl", "stl"],
		["application/vnd.ms-pkicertstore", "sst"],
		["application/vnd.ms-pkiseccat", "cat"],
		["application/vnd.ms-pkistl", "stl"],
		["application/vnd.ms-powerpoint", [
			"ppt",
			"pot",
			"pps",
			"ppa",
			"pwz"
		]],
		["application/vnd.ms-powerpoint.addin.macroenabled.12", "ppam"],
		["application/vnd.ms-powerpoint.presentation.macroenabled.12", "pptm"],
		["application/vnd.ms-powerpoint.slide.macroenabled.12", "sldm"],
		["application/vnd.ms-powerpoint.slideshow.macroenabled.12", "ppsm"],
		["application/vnd.ms-powerpoint.template.macroenabled.12", "potm"],
		["application/vnd.ms-project", "mpp"],
		["application/vnd.ms-word.document.macroenabled.12", "docm"],
		["application/vnd.ms-word.template.macroenabled.12", "dotm"],
		["application/vnd.ms-works", [
			"wks",
			"wcm",
			"wdb",
			"wps"
		]],
		["application/vnd.ms-wpl", "wpl"],
		["application/vnd.ms-xpsdocument", "xps"],
		["application/vnd.mseq", "mseq"],
		["application/vnd.musician", "mus"],
		["application/vnd.muvee.style", "msty"],
		["application/vnd.neurolanguage.nlu", "nlu"],
		["application/vnd.noblenet-directory", "nnd"],
		["application/vnd.noblenet-sealer", "nns"],
		["application/vnd.noblenet-web", "nnw"],
		["application/vnd.nokia.configuration-message", "ncm"],
		["application/vnd.nokia.n-gage.data", "ngdat"],
		["application/vnd.nokia.n-gage.symbian.install", "n-gage"],
		["application/vnd.nokia.radio-preset", "rpst"],
		["application/vnd.nokia.radio-presets", "rpss"],
		["application/vnd.nokia.ringing-tone", "rng"],
		["application/vnd.novadigm.edm", "edm"],
		["application/vnd.novadigm.edx", "edx"],
		["application/vnd.novadigm.ext", "ext"],
		["application/vnd.oasis.opendocument.chart", "odc"],
		["application/vnd.oasis.opendocument.chart-template", "otc"],
		["application/vnd.oasis.opendocument.database", "odb"],
		["application/vnd.oasis.opendocument.formula", "odf"],
		["application/vnd.oasis.opendocument.formula-template", "odft"],
		["application/vnd.oasis.opendocument.graphics", "odg"],
		["application/vnd.oasis.opendocument.graphics-template", "otg"],
		["application/vnd.oasis.opendocument.image", "odi"],
		["application/vnd.oasis.opendocument.image-template", "oti"],
		["application/vnd.oasis.opendocument.presentation", "odp"],
		["application/vnd.oasis.opendocument.presentation-template", "otp"],
		["application/vnd.oasis.opendocument.spreadsheet", "ods"],
		["application/vnd.oasis.opendocument.spreadsheet-template", "ots"],
		["application/vnd.oasis.opendocument.text", "odt"],
		["application/vnd.oasis.opendocument.text-master", "odm"],
		["application/vnd.oasis.opendocument.text-template", "ott"],
		["application/vnd.oasis.opendocument.text-web", "oth"],
		["application/vnd.olpc-sugar", "xo"],
		["application/vnd.oma.dd2+xml", "dd2"],
		["application/vnd.openofficeorg.extension", "oxt"],
		["application/vnd.openxmlformats-officedocument.presentationml.presentation", "pptx"],
		["application/vnd.openxmlformats-officedocument.presentationml.slide", "sldx"],
		["application/vnd.openxmlformats-officedocument.presentationml.slideshow", "ppsx"],
		["application/vnd.openxmlformats-officedocument.presentationml.template", "potx"],
		["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xlsx"],
		["application/vnd.openxmlformats-officedocument.spreadsheetml.template", "xltx"],
		["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx"],
		["application/vnd.openxmlformats-officedocument.wordprocessingml.template", "dotx"],
		["application/vnd.osgeo.mapguide.package", "mgp"],
		["application/vnd.osgi.dp", "dp"],
		["application/vnd.palm", "pdb"],
		["application/vnd.pawaafile", "paw"],
		["application/vnd.pg.format", "str"],
		["application/vnd.pg.osasli", "ei6"],
		["application/vnd.picsel", "efif"],
		["application/vnd.pmi.widget", "wg"],
		["application/vnd.pocketlearn", "plf"],
		["application/vnd.powerbuilder6", "pbd"],
		["application/vnd.previewsystems.box", "box"],
		["application/vnd.proteus.magazine", "mgz"],
		["application/vnd.publishare-delta-tree", "qps"],
		["application/vnd.pvi.ptid1", "ptid"],
		["application/vnd.quark.quarkxpress", "qxd"],
		["application/vnd.realvnc.bed", "bed"],
		["application/vnd.recordare.musicxml", "mxl"],
		["application/vnd.recordare.musicxml+xml", "musicxml"],
		["application/vnd.rig.cryptonote", "cryptonote"],
		["application/vnd.rim.cod", "cod"],
		["application/vnd.rn-realmedia", "rm"],
		["application/vnd.rn-realplayer", "rnx"],
		["application/vnd.route66.link66+xml", "link66"],
		["application/vnd.sailingtracker.track", "st"],
		["application/vnd.seemail", "see"],
		["application/vnd.sema", "sema"],
		["application/vnd.semd", "semd"],
		["application/vnd.semf", "semf"],
		["application/vnd.shana.informed.formdata", "ifm"],
		["application/vnd.shana.informed.formtemplate", "itp"],
		["application/vnd.shana.informed.interchange", "iif"],
		["application/vnd.shana.informed.package", "ipk"],
		["application/vnd.simtech-mindmapper", "twd"],
		["application/vnd.smaf", "mmf"],
		["application/vnd.smart.teacher", "teacher"],
		["application/vnd.solent.sdkm+xml", "sdkm"],
		["application/vnd.spotfire.dxp", "dxp"],
		["application/vnd.spotfire.sfs", "sfs"],
		["application/vnd.stardivision.calc", "sdc"],
		["application/vnd.stardivision.draw", "sda"],
		["application/vnd.stardivision.impress", "sdd"],
		["application/vnd.stardivision.math", "smf"],
		["application/vnd.stardivision.writer", "sdw"],
		["application/vnd.stardivision.writer-global", "sgl"],
		["application/vnd.stepmania.stepchart", "sm"],
		["application/vnd.sun.xml.calc", "sxc"],
		["application/vnd.sun.xml.calc.template", "stc"],
		["application/vnd.sun.xml.draw", "sxd"],
		["application/vnd.sun.xml.draw.template", "std"],
		["application/vnd.sun.xml.impress", "sxi"],
		["application/vnd.sun.xml.impress.template", "sti"],
		["application/vnd.sun.xml.math", "sxm"],
		["application/vnd.sun.xml.writer", "sxw"],
		["application/vnd.sun.xml.writer.global", "sxg"],
		["application/vnd.sun.xml.writer.template", "stw"],
		["application/vnd.sus-calendar", "sus"],
		["application/vnd.svd", "svd"],
		["application/vnd.symbian.install", "sis"],
		["application/vnd.syncml+xml", "xsm"],
		["application/vnd.syncml.dm+wbxml", "bdm"],
		["application/vnd.syncml.dm+xml", "xdm"],
		["application/vnd.tao.intent-module-archive", "tao"],
		["application/vnd.tmobile-livetv", "tmo"],
		["application/vnd.trid.tpt", "tpt"],
		["application/vnd.triscape.mxs", "mxs"],
		["application/vnd.trueapp", "tra"],
		["application/vnd.ufdl", "ufd"],
		["application/vnd.uiq.theme", "utz"],
		["application/vnd.umajin", "umj"],
		["application/vnd.unity", "unityweb"],
		["application/vnd.uoml+xml", "uoml"],
		["application/vnd.vcx", "vcx"],
		["application/vnd.visio", "vsd"],
		["application/vnd.visionary", "vis"],
		["application/vnd.vsf", "vsf"],
		["application/vnd.wap.wbxml", "wbxml"],
		["application/vnd.wap.wmlc", "wmlc"],
		["application/vnd.wap.wmlscriptc", "wmlsc"],
		["application/vnd.webturbo", "wtb"],
		["application/vnd.wolfram.player", "nbp"],
		["application/vnd.wordperfect", "wpd"],
		["application/vnd.wqd", "wqd"],
		["application/vnd.wt.stf", "stf"],
		["application/vnd.xara", ["web", "xar"]],
		["application/vnd.xfdl", "xfdl"],
		["application/vnd.yamaha.hv-dic", "hvd"],
		["application/vnd.yamaha.hv-script", "hvs"],
		["application/vnd.yamaha.hv-voice", "hvp"],
		["application/vnd.yamaha.openscoreformat", "osf"],
		["application/vnd.yamaha.openscoreformat.osfpvg+xml", "osfpvg"],
		["application/vnd.yamaha.smaf-audio", "saf"],
		["application/vnd.yamaha.smaf-phrase", "spf"],
		["application/vnd.yellowriver-custom-menu", "cmp"],
		["application/vnd.zul", "zir"],
		["application/vnd.zzazz.deck+xml", "zaz"],
		["application/vocaltec-media-desc", "vmd"],
		["application/vocaltec-media-file", "vmf"],
		["application/voicexml+xml", "vxml"],
		["application/widget", "wgt"],
		["application/winhlp", "hlp"],
		["application/wordperfect", [
			"wp",
			"wp5",
			"wp6",
			"wpd"
		]],
		["application/wordperfect6.0", ["w60", "wp5"]],
		["application/wordperfect6.1", "w61"],
		["application/wsdl+xml", "wsdl"],
		["application/wspolicy+xml", "wspolicy"],
		["application/x-123", "wk1"],
		["application/x-7z-compressed", "7z"],
		["application/x-abiword", "abw"],
		["application/x-ace-compressed", "ace"],
		["application/x-aim", "aim"],
		["application/x-authorware-bin", "aab"],
		["application/x-authorware-map", "aam"],
		["application/x-authorware-seg", "aas"],
		["application/x-bcpio", "bcpio"],
		["application/x-binary", "bin"],
		["application/x-binhex40", "hqx"],
		["application/x-bittorrent", "torrent"],
		["application/x-bsh", [
			"bsh",
			"sh",
			"shar"
		]],
		["application/x-bytecode.elisp", "elc"],
		["application/x-bytecode.python", "pyc"],
		["application/x-bzip", "bz"],
		["application/x-bzip2", ["boz", "bz2"]],
		["application/x-cdf", "cdf"],
		["application/x-cdlink", "vcd"],
		["application/x-chat", ["cha", "chat"]],
		["application/x-chess-pgn", "pgn"],
		["application/x-cmu-raster", "ras"],
		["application/x-cocoa", "cco"],
		["application/x-compactpro", "cpt"],
		["application/x-compress", "z"],
		["application/x-compressed", [
			"tgz",
			"gz",
			"z",
			"zip"
		]],
		["application/x-conference", "nsc"],
		["application/x-cpio", "cpio"],
		["application/x-cpt", "cpt"],
		["application/x-csh", "csh"],
		["application/x-debian-package", "deb"],
		["application/x-deepv", "deepv"],
		["application/x-director", [
			"dir",
			"dcr",
			"dxr"
		]],
		["application/x-doom", "wad"],
		["application/x-dtbncx+xml", "ncx"],
		["application/x-dtbook+xml", "dtb"],
		["application/x-dtbresource+xml", "res"],
		["application/x-dvi", "dvi"],
		["application/x-elc", "elc"],
		["application/x-envoy", ["env", "evy"]],
		["application/x-esrehber", "es"],
		["application/x-excel", [
			"xls",
			"xla",
			"xlb",
			"xlc",
			"xld",
			"xlk",
			"xll",
			"xlm",
			"xlt",
			"xlv",
			"xlw"
		]],
		["application/x-font-bdf", "bdf"],
		["application/x-font-ghostscript", "gsf"],
		["application/x-font-linux-psf", "psf"],
		["application/x-font-otf", "otf"],
		["application/x-font-pcf", "pcf"],
		["application/x-font-snf", "snf"],
		["application/x-font-ttf", "ttf"],
		["application/x-font-type1", "pfa"],
		["application/x-font-woff", "woff"],
		["application/x-frame", "mif"],
		["application/x-freelance", "pre"],
		["application/x-futuresplash", "spl"],
		["application/x-gnumeric", "gnumeric"],
		["application/x-gsp", "gsp"],
		["application/x-gss", "gss"],
		["application/x-gtar", "gtar"],
		["application/x-gzip", ["gz", "gzip"]],
		["application/x-hdf", "hdf"],
		["application/x-helpfile", ["help", "hlp"]],
		["application/x-httpd-imap", "imap"],
		["application/x-ima", "ima"],
		["application/x-internet-signup", ["ins", "isp"]],
		["application/x-internett-signup", "ins"],
		["application/x-inventor", "iv"],
		["application/x-ip2", "ip"],
		["application/x-iphone", "iii"],
		["application/x-java-class", "class"],
		["application/x-java-commerce", "jcm"],
		["application/x-java-jnlp-file", "jnlp"],
		["application/x-javascript", "js"],
		["application/x-koan", [
			"skd",
			"skm",
			"skp",
			"skt"
		]],
		["application/x-ksh", "ksh"],
		["application/x-latex", ["latex", "ltx"]],
		["application/x-lha", "lha"],
		["application/x-lisp", "lsp"],
		["application/x-livescreen", "ivy"],
		["application/x-lotus", "wq1"],
		["application/x-lotusscreencam", "scm"],
		["application/x-lzh", "lzh"],
		["application/x-lzx", "lzx"],
		["application/x-mac-binhex40", "hqx"],
		["application/x-macbinary", "bin"],
		["application/x-magic-cap-package-1.0", "mc$"],
		["application/x-mathcad", "mcd"],
		["application/x-meme", "mm"],
		["application/x-midi", ["mid", "midi"]],
		["application/x-mif", "mif"],
		["application/x-mix-transfer", "nix"],
		["application/x-mobipocket-ebook", "prc"],
		["application/x-mplayer2", "asx"],
		["application/x-ms-application", "application"],
		["application/x-ms-wmd", "wmd"],
		["application/x-ms-wmz", "wmz"],
		["application/x-ms-xbap", "xbap"],
		["application/x-msaccess", "mdb"],
		["application/x-msbinder", "obd"],
		["application/x-mscardfile", "crd"],
		["application/x-msclip", "clp"],
		["application/x-msdownload", ["exe", "dll"]],
		["application/x-msexcel", [
			"xls",
			"xla",
			"xlw"
		]],
		["application/x-msmediaview", [
			"mvb",
			"m13",
			"m14"
		]],
		["application/x-msmetafile", "wmf"],
		["application/x-msmoney", "mny"],
		["application/x-mspowerpoint", "ppt"],
		["application/x-mspublisher", "pub"],
		["application/x-msschedule", "scd"],
		["application/x-msterminal", "trm"],
		["application/x-mswrite", "wri"],
		["application/x-navi-animation", "ani"],
		["application/x-navidoc", "nvd"],
		["application/x-navimap", "map"],
		["application/x-navistyle", "stl"],
		["application/x-netcdf", ["cdf", "nc"]],
		["application/x-newton-compatible-pkg", "pkg"],
		["application/x-nokia-9000-communicator-add-on-software", "aos"],
		["application/x-omc", "omc"],
		["application/x-omcdatamaker", "omcd"],
		["application/x-omcregerator", "omcr"],
		["application/x-pagemaker", ["pm4", "pm5"]],
		["application/x-pcl", "pcl"],
		["application/x-perfmon", [
			"pma",
			"pmc",
			"pml",
			"pmr",
			"pmw"
		]],
		["application/x-pixclscript", "plx"],
		["application/x-pkcs10", "p10"],
		["application/x-pkcs12", ["p12", "pfx"]],
		["application/x-pkcs7-certificates", ["p7b", "spc"]],
		["application/x-pkcs7-certreqresp", "p7r"],
		["application/x-pkcs7-mime", ["p7m", "p7c"]],
		["application/x-pkcs7-signature", ["p7s", "p7a"]],
		["application/x-pointplus", "css"],
		["application/x-portable-anymap", "pnm"],
		["application/x-project", [
			"mpc",
			"mpt",
			"mpv",
			"mpx"
		]],
		["application/x-qpro", "wb1"],
		["application/x-rar-compressed", "rar"],
		["application/x-rtf", "rtf"],
		["application/x-sdp", "sdp"],
		["application/x-sea", "sea"],
		["application/x-seelogo", "sl"],
		["application/x-sh", "sh"],
		["application/x-shar", ["shar", "sh"]],
		["application/x-shockwave-flash", "swf"],
		["application/x-silverlight-app", "xap"],
		["application/x-sit", "sit"],
		["application/x-sprite", ["spr", "sprite"]],
		["application/x-stuffit", "sit"],
		["application/x-stuffitx", "sitx"],
		["application/x-sv4cpio", "sv4cpio"],
		["application/x-sv4crc", "sv4crc"],
		["application/x-tar", "tar"],
		["application/x-tbook", ["sbk", "tbk"]],
		["application/x-tcl", "tcl"],
		["application/x-tex", "tex"],
		["application/x-tex-tfm", "tfm"],
		["application/x-texinfo", ["texi", "texinfo"]],
		["application/x-troff", [
			"roff",
			"t",
			"tr"
		]],
		["application/x-troff-man", "man"],
		["application/x-troff-me", "me"],
		["application/x-troff-ms", "ms"],
		["application/x-troff-msvideo", "avi"],
		["application/x-ustar", "ustar"],
		["application/x-visio", [
			"vsd",
			"vst",
			"vsw"
		]],
		["application/x-vnd.audioexplosion.mzz", "mzz"],
		["application/x-vnd.ls-xpix", "xpix"],
		["application/x-vrml", "vrml"],
		["application/x-wais-source", ["src", "wsrc"]],
		["application/x-winhelp", "hlp"],
		["application/x-wintalk", "wtk"],
		["application/x-world", ["wrl", "svr"]],
		["application/x-wpwin", "wpd"],
		["application/x-wri", "wri"],
		["application/x-x509-ca-cert", [
			"cer",
			"crt",
			"der"
		]],
		["application/x-x509-user-cert", "crt"],
		["application/x-xfig", "fig"],
		["application/x-xpinstall", "xpi"],
		["application/x-zip-compressed", "zip"],
		["application/xcap-diff+xml", "xdf"],
		["application/xenc+xml", "xenc"],
		["application/xhtml+xml", "xhtml"],
		["application/xml", "xml"],
		["application/xml-dtd", "dtd"],
		["application/xop+xml", "xop"],
		["application/xslt+xml", "xslt"],
		["application/xspf+xml", "xspf"],
		["application/xv+xml", "mxml"],
		["application/yang", "yang"],
		["application/yin+xml", "yin"],
		["application/ynd.ms-pkipko", "pko"],
		["application/zip", "zip"],
		["audio/adpcm", "adp"],
		["audio/aiff", [
			"aiff",
			"aif",
			"aifc"
		]],
		["audio/basic", ["snd", "au"]],
		["audio/it", "it"],
		["audio/make", [
			"funk",
			"my",
			"pfunk"
		]],
		["audio/make.my.funk", "pfunk"],
		["audio/mid", ["mid", "rmi"]],
		["audio/midi", [
			"midi",
			"kar",
			"mid"
		]],
		["audio/mod", "mod"],
		["audio/mp4", "mp4a"],
		["audio/mpeg", [
			"mpga",
			"mp3",
			"m2a",
			"mp2",
			"mpa",
			"mpg"
		]],
		["audio/mpeg3", "mp3"],
		["audio/nspaudio", ["la", "lma"]],
		["audio/ogg", "oga"],
		["audio/s3m", "s3m"],
		["audio/tsp-audio", "tsi"],
		["audio/tsplayer", "tsp"],
		["audio/vnd.dece.audio", "uva"],
		["audio/vnd.digital-winds", "eol"],
		["audio/vnd.dra", "dra"],
		["audio/vnd.dts", "dts"],
		["audio/vnd.dts.hd", "dtshd"],
		["audio/vnd.lucent.voice", "lvp"],
		["audio/vnd.ms-playready.media.pya", "pya"],
		["audio/vnd.nuera.ecelp4800", "ecelp4800"],
		["audio/vnd.nuera.ecelp7470", "ecelp7470"],
		["audio/vnd.nuera.ecelp9600", "ecelp9600"],
		["audio/vnd.qcelp", "qcp"],
		["audio/vnd.rip", "rip"],
		["audio/voc", "voc"],
		["audio/voxware", "vox"],
		["audio/wav", "wav"],
		["audio/webm", "weba"],
		["audio/x-aac", "aac"],
		["audio/x-adpcm", "snd"],
		["audio/x-aiff", [
			"aiff",
			"aif",
			"aifc"
		]],
		["audio/x-au", "au"],
		["audio/x-gsm", ["gsd", "gsm"]],
		["audio/x-jam", "jam"],
		["audio/x-liveaudio", "lam"],
		["audio/x-mid", ["mid", "midi"]],
		["audio/x-midi", ["midi", "mid"]],
		["audio/x-mod", "mod"],
		["audio/x-mpeg", "mp2"],
		["audio/x-mpeg-3", "mp3"],
		["audio/x-mpegurl", "m3u"],
		["audio/x-mpequrl", "m3u"],
		["audio/x-ms-wax", "wax"],
		["audio/x-ms-wma", "wma"],
		["audio/x-nspaudio", ["la", "lma"]],
		["audio/x-pn-realaudio", [
			"ra",
			"ram",
			"rm",
			"rmm",
			"rmp"
		]],
		["audio/x-pn-realaudio-plugin", [
			"ra",
			"rmp",
			"rpm"
		]],
		["audio/x-psid", "sid"],
		["audio/x-realaudio", "ra"],
		["audio/x-twinvq", "vqf"],
		["audio/x-twinvq-plugin", ["vqe", "vql"]],
		["audio/x-vnd.audioexplosion.mjuicemediafile", "mjf"],
		["audio/x-voc", "voc"],
		["audio/x-wav", "wav"],
		["audio/xm", "xm"],
		["chemical/x-cdx", "cdx"],
		["chemical/x-cif", "cif"],
		["chemical/x-cmdf", "cmdf"],
		["chemical/x-cml", "cml"],
		["chemical/x-csml", "csml"],
		["chemical/x-pdb", ["pdb", "xyz"]],
		["chemical/x-xyz", "xyz"],
		["drawing/x-dwf", "dwf"],
		["i-world/i-vrml", "ivr"],
		["image/bmp", ["bmp", "bm"]],
		["image/cgm", "cgm"],
		["image/cis-cod", "cod"],
		["image/cmu-raster", ["ras", "rast"]],
		["image/fif", "fif"],
		["image/florian", ["flo", "turbot"]],
		["image/g3fax", "g3"],
		["image/gif", "gif"],
		["image/ief", ["ief", "iefs"]],
		["image/jpeg", [
			"jpeg",
			"jpe",
			"jpg",
			"jfif",
			"jfif-tbnl"
		]],
		["image/jutvision", "jut"],
		["image/ktx", "ktx"],
		["image/naplps", ["nap", "naplps"]],
		["image/pict", ["pic", "pict"]],
		["image/pipeg", "jfif"],
		["image/pjpeg", [
			"jfif",
			"jpe",
			"jpeg",
			"jpg"
		]],
		["image/png", ["png", "x-png"]],
		["image/prs.btif", "btif"],
		["image/svg+xml", "svg"],
		["image/tiff", ["tif", "tiff"]],
		["image/vasa", "mcf"],
		["image/vnd.adobe.photoshop", "psd"],
		["image/vnd.dece.graphic", "uvi"],
		["image/vnd.djvu", "djvu"],
		["image/vnd.dvb.subtitle", "sub"],
		["image/vnd.dwg", [
			"dwg",
			"dxf",
			"svf"
		]],
		["image/vnd.dxf", "dxf"],
		["image/vnd.fastbidsheet", "fbs"],
		["image/vnd.fpx", "fpx"],
		["image/vnd.fst", "fst"],
		["image/vnd.fujixerox.edmics-mmr", "mmr"],
		["image/vnd.fujixerox.edmics-rlc", "rlc"],
		["image/vnd.ms-modi", "mdi"],
		["image/vnd.net-fpx", ["fpx", "npx"]],
		["image/vnd.rn-realflash", "rf"],
		["image/vnd.rn-realpix", "rp"],
		["image/vnd.wap.wbmp", "wbmp"],
		["image/vnd.xiff", "xif"],
		["image/webp", "webp"],
		["image/x-cmu-raster", "ras"],
		["image/x-cmx", "cmx"],
		["image/x-dwg", [
			"dwg",
			"dxf",
			"svf"
		]],
		["image/x-freehand", "fh"],
		["image/x-icon", "ico"],
		["image/x-jg", "art"],
		["image/x-jps", "jps"],
		["image/x-niff", ["niff", "nif"]],
		["image/x-pcx", "pcx"],
		["image/x-pict", ["pct", "pic"]],
		["image/x-portable-anymap", "pnm"],
		["image/x-portable-bitmap", "pbm"],
		["image/x-portable-graymap", "pgm"],
		["image/x-portable-greymap", "pgm"],
		["image/x-portable-pixmap", "ppm"],
		["image/x-quicktime", [
			"qif",
			"qti",
			"qtif"
		]],
		["image/x-rgb", "rgb"],
		["image/x-tiff", ["tif", "tiff"]],
		["image/x-windows-bmp", "bmp"],
		["image/x-xbitmap", "xbm"],
		["image/x-xbm", "xbm"],
		["image/x-xpixmap", ["xpm", "pm"]],
		["image/x-xwd", "xwd"],
		["image/x-xwindowdump", "xwd"],
		["image/xbm", "xbm"],
		["image/xpm", "xpm"],
		["message/rfc822", [
			"eml",
			"mht",
			"mhtml",
			"nws",
			"mime"
		]],
		["model/iges", ["iges", "igs"]],
		["model/mesh", "msh"],
		["model/vnd.collada+xml", "dae"],
		["model/vnd.dwf", "dwf"],
		["model/vnd.gdl", "gdl"],
		["model/vnd.gtw", "gtw"],
		["model/vnd.mts", "mts"],
		["model/vnd.vtu", "vtu"],
		["model/vrml", [
			"vrml",
			"wrl",
			"wrz"
		]],
		["model/x-pov", "pov"],
		["multipart/x-gzip", "gzip"],
		["multipart/x-ustar", "ustar"],
		["multipart/x-zip", "zip"],
		["music/crescendo", ["mid", "midi"]],
		["music/x-karaoke", "kar"],
		["paleovu/x-pv", "pvu"],
		["text/asp", "asp"],
		["text/calendar", "ics"],
		["text/css", "css"],
		["text/csv", "csv"],
		["text/ecmascript", "js"],
		["text/h323", "323"],
		["text/html", [
			"html",
			"htm",
			"stm",
			"acgi",
			"htmls",
			"htx",
			"shtml"
		]],
		["text/iuls", "uls"],
		["text/javascript", "js"],
		["text/mcf", "mcf"],
		["text/n3", "n3"],
		["text/pascal", "pas"],
		["text/plain", [
			"txt",
			"bas",
			"c",
			"h",
			"c++",
			"cc",
			"com",
			"conf",
			"cxx",
			"def",
			"f",
			"f90",
			"for",
			"g",
			"hh",
			"idc",
			"jav",
			"java",
			"list",
			"log",
			"lst",
			"m",
			"mar",
			"pl",
			"sdml",
			"text"
		]],
		["text/plain-bas", "par"],
		["text/prs.lines.tag", "dsc"],
		["text/richtext", [
			"rtx",
			"rt",
			"rtf"
		]],
		["text/scriplet", "wsc"],
		["text/scriptlet", "sct"],
		["text/sgml", ["sgm", "sgml"]],
		["text/tab-separated-values", "tsv"],
		["text/troff", "t"],
		["text/turtle", "ttl"],
		["text/uri-list", [
			"uni",
			"unis",
			"uri",
			"uris"
		]],
		["text/vnd.abc", "abc"],
		["text/vnd.curl", "curl"],
		["text/vnd.curl.dcurl", "dcurl"],
		["text/vnd.curl.mcurl", "mcurl"],
		["text/vnd.curl.scurl", "scurl"],
		["text/vnd.fly", "fly"],
		["text/vnd.fmi.flexstor", "flx"],
		["text/vnd.graphviz", "gv"],
		["text/vnd.in3d.3dml", "3dml"],
		["text/vnd.in3d.spot", "spot"],
		["text/vnd.rn-realtext", "rt"],
		["text/vnd.sun.j2me.app-descriptor", "jad"],
		["text/vnd.wap.wml", "wml"],
		["text/vnd.wap.wmlscript", "wmls"],
		["text/webviewhtml", "htt"],
		["text/x-asm", ["asm", "s"]],
		["text/x-audiosoft-intra", "aip"],
		["text/x-c", [
			"c",
			"cc",
			"cpp"
		]],
		["text/x-component", "htc"],
		["text/x-fortran", [
			"for",
			"f",
			"f77",
			"f90"
		]],
		["text/x-h", ["h", "hh"]],
		["text/x-java-source", ["java", "jav"]],
		["text/x-java-source,java", "java"],
		["text/x-la-asf", "lsx"],
		["text/x-m", "m"],
		["text/x-pascal", "p"],
		["text/x-script", "hlb"],
		["text/x-script.csh", "csh"],
		["text/x-script.elisp", "el"],
		["text/x-script.guile", "scm"],
		["text/x-script.ksh", "ksh"],
		["text/x-script.lisp", "lsp"],
		["text/x-script.perl", "pl"],
		["text/x-script.perl-module", "pm"],
		["text/x-script.phyton", "py"],
		["text/x-script.rexx", "rexx"],
		["text/x-script.scheme", "scm"],
		["text/x-script.sh", "sh"],
		["text/x-script.tcl", "tcl"],
		["text/x-script.tcsh", "tcsh"],
		["text/x-script.zsh", "zsh"],
		["text/x-server-parsed-html", ["shtml", "ssi"]],
		["text/x-setext", "etx"],
		["text/x-sgml", ["sgm", "sgml"]],
		["text/x-speech", ["spc", "talk"]],
		["text/x-uil", "uil"],
		["text/x-uuencode", ["uu", "uue"]],
		["text/x-vcalendar", "vcs"],
		["text/x-vcard", "vcf"],
		["text/xml", "xml"],
		["video/3gpp", "3gp"],
		["video/3gpp2", "3g2"],
		["video/animaflex", "afl"],
		["video/avi", "avi"],
		["video/avs-video", "avs"],
		["video/dl", "dl"],
		["video/fli", "fli"],
		["video/gl", "gl"],
		["video/h261", "h261"],
		["video/h263", "h263"],
		["video/h264", "h264"],
		["video/jpeg", "jpgv"],
		["video/jpm", "jpm"],
		["video/mj2", "mj2"],
		["video/mp4", "mp4"],
		["video/mpeg", [
			"mpeg",
			"mp2",
			"mpa",
			"mpe",
			"mpg",
			"mpv2",
			"m1v",
			"m2v",
			"mp3"
		]],
		["video/msvideo", "avi"],
		["video/ogg", "ogv"],
		["video/quicktime", [
			"mov",
			"qt",
			"moov"
		]],
		["video/vdo", "vdo"],
		["video/vivo", ["viv", "vivo"]],
		["video/vnd.dece.hd", "uvh"],
		["video/vnd.dece.mobile", "uvm"],
		["video/vnd.dece.pd", "uvp"],
		["video/vnd.dece.sd", "uvs"],
		["video/vnd.dece.video", "uvv"],
		["video/vnd.fvt", "fvt"],
		["video/vnd.mpegurl", "mxu"],
		["video/vnd.ms-playready.media.pyv", "pyv"],
		["video/vnd.rn-realvideo", "rv"],
		["video/vnd.uvvu.mp4", "uvu"],
		["video/vnd.vivo", ["viv", "vivo"]],
		["video/vosaic", "vos"],
		["video/webm", "webm"],
		["video/x-amt-demorun", "xdr"],
		["video/x-amt-showrun", "xsr"],
		["video/x-atomic3d-feature", "fmf"],
		["video/x-dl", "dl"],
		["video/x-dv", ["dif", "dv"]],
		["video/x-f4v", "f4v"],
		["video/x-fli", "fli"],
		["video/x-flv", "flv"],
		["video/x-gl", "gl"],
		["video/x-isvideo", "isu"],
		["video/x-la-asf", ["lsf", "lsx"]],
		["video/x-m4v", "m4v"],
		["video/x-motion-jpeg", "mjpg"],
		["video/x-mpeg", ["mp3", "mp2"]],
		["video/x-mpeq2a", "mp2"],
		["video/x-ms-asf", [
			"asf",
			"asr",
			"asx"
		]],
		["video/x-ms-asf-plugin", "asx"],
		["video/x-ms-wm", "wm"],
		["video/x-ms-wmv", "wmv"],
		["video/x-ms-wmx", "wmx"],
		["video/x-ms-wvx", "wvx"],
		["video/x-msvideo", "avi"],
		["video/x-qtc", "qtc"],
		["video/x-scm", "scm"],
		["video/x-sgi-movie", ["movie", "mv"]],
		["windows/metafile", "wmf"],
		["www/mime", "mime"],
		["x-conference/x-cooltalk", "ice"],
		["x-music/x-midi", ["mid", "midi"]],
		["x-world/x-3dmf", [
			"3dm",
			"3dmf",
			"qd3",
			"qd3d"
		]],
		["x-world/x-svr", "svr"],
		["x-world/x-vrml", [
			"flr",
			"vrml",
			"wrl",
			"wrz",
			"xaf",
			"xof"
		]],
		["x-world/x-vrt", "vrt"],
		["xgl/drawing", "xgz"],
		["xgl/movie", "xmz"]
	]);
	const extensions = new Map([
		["123", "application/vnd.lotus-1-2-3"],
		["323", "text/h323"],
		["*", "application/octet-stream"],
		["3dm", "x-world/x-3dmf"],
		["3dmf", "x-world/x-3dmf"],
		["3dml", "text/vnd.in3d.3dml"],
		["3g2", "video/3gpp2"],
		["3gp", "video/3gpp"],
		["7z", "application/x-7z-compressed"],
		["a", "application/octet-stream"],
		["aab", "application/x-authorware-bin"],
		["aac", "audio/x-aac"],
		["aam", "application/x-authorware-map"],
		["aas", "application/x-authorware-seg"],
		["abc", "text/vnd.abc"],
		["abw", "application/x-abiword"],
		["ac", "application/pkix-attr-cert"],
		["acc", "application/vnd.americandynamics.acc"],
		["ace", "application/x-ace-compressed"],
		["acgi", "text/html"],
		["acu", "application/vnd.acucobol"],
		["acx", "application/internet-property-stream"],
		["adp", "audio/adpcm"],
		["aep", "application/vnd.audiograph"],
		["afl", "video/animaflex"],
		["afp", "application/vnd.ibm.modcap"],
		["ahead", "application/vnd.ahead.space"],
		["ai", "application/postscript"],
		["aif", ["audio/aiff", "audio/x-aiff"]],
		["aifc", ["audio/aiff", "audio/x-aiff"]],
		["aiff", ["audio/aiff", "audio/x-aiff"]],
		["aim", "application/x-aim"],
		["aip", "text/x-audiosoft-intra"],
		["air", "application/vnd.adobe.air-application-installer-package+zip"],
		["ait", "application/vnd.dvb.ait"],
		["ami", "application/vnd.amiga.ami"],
		["ani", "application/x-navi-animation"],
		["aos", "application/x-nokia-9000-communicator-add-on-software"],
		["apk", "application/vnd.android.package-archive"],
		["application", "application/x-ms-application"],
		["apr", "application/vnd.lotus-approach"],
		["aps", "application/mime"],
		["arc", "application/octet-stream"],
		["arj", ["application/arj", "application/octet-stream"]],
		["art", "image/x-jg"],
		["asf", "video/x-ms-asf"],
		["asm", "text/x-asm"],
		["aso", "application/vnd.accpac.simply.aso"],
		["asp", "text/asp"],
		["asr", "video/x-ms-asf"],
		["asx", [
			"video/x-ms-asf",
			"application/x-mplayer2",
			"video/x-ms-asf-plugin"
		]],
		["atc", "application/vnd.acucorp"],
		["atomcat", "application/atomcat+xml"],
		["atomsvc", "application/atomsvc+xml"],
		["atx", "application/vnd.antix.game-component"],
		["au", ["audio/basic", "audio/x-au"]],
		["avi", [
			"video/avi",
			"video/msvideo",
			"application/x-troff-msvideo",
			"video/x-msvideo"
		]],
		["avs", "video/avs-video"],
		["aw", "application/applixware"],
		["axs", "application/olescript"],
		["azf", "application/vnd.airzip.filesecure.azf"],
		["azs", "application/vnd.airzip.filesecure.azs"],
		["azw", "application/vnd.amazon.ebook"],
		["bas", "text/plain"],
		["bcpio", "application/x-bcpio"],
		["bdf", "application/x-font-bdf"],
		["bdm", "application/vnd.syncml.dm+wbxml"],
		["bed", "application/vnd.realvnc.bed"],
		["bh2", "application/vnd.fujitsu.oasysprs"],
		["bin", [
			"application/octet-stream",
			"application/mac-binary",
			"application/macbinary",
			"application/x-macbinary",
			"application/x-binary"
		]],
		["bm", "image/bmp"],
		["bmi", "application/vnd.bmi"],
		["bmp", ["image/bmp", "image/x-windows-bmp"]],
		["boo", "application/book"],
		["book", "application/book"],
		["box", "application/vnd.previewsystems.box"],
		["boz", "application/x-bzip2"],
		["bsh", "application/x-bsh"],
		["btif", "image/prs.btif"],
		["bz", "application/x-bzip"],
		["bz2", "application/x-bzip2"],
		["c", ["text/plain", "text/x-c"]],
		["c++", "text/plain"],
		["c11amc", "application/vnd.cluetrust.cartomobile-config"],
		["c11amz", "application/vnd.cluetrust.cartomobile-config-pkg"],
		["c4g", "application/vnd.clonk.c4group"],
		["cab", "application/vnd.ms-cab-compressed"],
		["car", "application/vnd.curl.car"],
		["cat", ["application/vnd.ms-pkiseccat", "application/vnd.ms-pki.seccat"]],
		["cc", ["text/plain", "text/x-c"]],
		["ccad", "application/clariscad"],
		["cco", "application/x-cocoa"],
		["ccxml", "application/ccxml+xml,"],
		["cdbcmsg", "application/vnd.contact.cmsg"],
		["cdf", [
			"application/cdf",
			"application/x-cdf",
			"application/x-netcdf"
		]],
		["cdkey", "application/vnd.mediastation.cdkey"],
		["cdmia", "application/cdmi-capability"],
		["cdmic", "application/cdmi-container"],
		["cdmid", "application/cdmi-domain"],
		["cdmio", "application/cdmi-object"],
		["cdmiq", "application/cdmi-queue"],
		["cdx", "chemical/x-cdx"],
		["cdxml", "application/vnd.chemdraw+xml"],
		["cdy", "application/vnd.cinderella"],
		["cer", ["application/pkix-cert", "application/x-x509-ca-cert"]],
		["cgm", "image/cgm"],
		["cha", "application/x-chat"],
		["chat", "application/x-chat"],
		["chm", "application/vnd.ms-htmlhelp"],
		["chrt", "application/vnd.kde.kchart"],
		["cif", "chemical/x-cif"],
		["cii", "application/vnd.anser-web-certificate-issue-initiation"],
		["cil", "application/vnd.ms-artgalry"],
		["cla", "application/vnd.claymore"],
		["class", [
			"application/octet-stream",
			"application/java",
			"application/java-byte-code",
			"application/java-vm",
			"application/x-java-class"
		]],
		["clkk", "application/vnd.crick.clicker.keyboard"],
		["clkp", "application/vnd.crick.clicker.palette"],
		["clkt", "application/vnd.crick.clicker.template"],
		["clkw", "application/vnd.crick.clicker.wordbank"],
		["clkx", "application/vnd.crick.clicker"],
		["clp", "application/x-msclip"],
		["cmc", "application/vnd.cosmocaller"],
		["cmdf", "chemical/x-cmdf"],
		["cml", "chemical/x-cml"],
		["cmp", "application/vnd.yellowriver-custom-menu"],
		["cmx", "image/x-cmx"],
		["cod", ["image/cis-cod", "application/vnd.rim.cod"]],
		["com", ["application/octet-stream", "text/plain"]],
		["conf", "text/plain"],
		["cpio", "application/x-cpio"],
		["cpp", "text/x-c"],
		["cpt", [
			"application/mac-compactpro",
			"application/x-compactpro",
			"application/x-cpt"
		]],
		["crd", "application/x-mscardfile"],
		["crl", ["application/pkix-crl", "application/pkcs-crl"]],
		["crt", [
			"application/pkix-cert",
			"application/x-x509-user-cert",
			"application/x-x509-ca-cert"
		]],
		["cryptonote", "application/vnd.rig.cryptonote"],
		["csh", ["text/x-script.csh", "application/x-csh"]],
		["csml", "chemical/x-csml"],
		["csp", "application/vnd.commonspace"],
		["css", ["text/css", "application/x-pointplus"]],
		["csv", "text/csv"],
		["cu", "application/cu-seeme"],
		["curl", "text/vnd.curl"],
		["cww", "application/prs.cww"],
		["cxx", "text/plain"],
		["dae", "model/vnd.collada+xml"],
		["daf", "application/vnd.mobius.daf"],
		["davmount", "application/davmount+xml"],
		["dcr", "application/x-director"],
		["dcurl", "text/vnd.curl.dcurl"],
		["dd2", "application/vnd.oma.dd2+xml"],
		["ddd", "application/vnd.fujixerox.ddd"],
		["deb", "application/x-debian-package"],
		["deepv", "application/x-deepv"],
		["def", "text/plain"],
		["der", "application/x-x509-ca-cert"],
		["dfac", "application/vnd.dreamfactory"],
		["dif", "video/x-dv"],
		["dir", "application/x-director"],
		["dis", "application/vnd.mobius.dis"],
		["djvu", "image/vnd.djvu"],
		["dl", ["video/dl", "video/x-dl"]],
		["dll", "application/x-msdownload"],
		["dms", "application/octet-stream"],
		["dna", "application/vnd.dna"],
		["doc", "application/msword"],
		["docm", "application/vnd.ms-word.document.macroenabled.12"],
		["docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
		["dot", "application/msword"],
		["dotm", "application/vnd.ms-word.template.macroenabled.12"],
		["dotx", "application/vnd.openxmlformats-officedocument.wordprocessingml.template"],
		["dp", ["application/commonground", "application/vnd.osgi.dp"]],
		["dpg", "application/vnd.dpgraph"],
		["dra", "audio/vnd.dra"],
		["drw", "application/drafting"],
		["dsc", "text/prs.lines.tag"],
		["dssc", "application/dssc+der"],
		["dtb", "application/x-dtbook+xml"],
		["dtd", "application/xml-dtd"],
		["dts", "audio/vnd.dts"],
		["dtshd", "audio/vnd.dts.hd"],
		["dump", "application/octet-stream"],
		["dv", "video/x-dv"],
		["dvi", "application/x-dvi"],
		["dwf", ["model/vnd.dwf", "drawing/x-dwf"]],
		["dwg", [
			"application/acad",
			"image/vnd.dwg",
			"image/x-dwg"
		]],
		["dxf", [
			"application/dxf",
			"image/vnd.dwg",
			"image/vnd.dxf",
			"image/x-dwg"
		]],
		["dxp", "application/vnd.spotfire.dxp"],
		["dxr", "application/x-director"],
		["ecelp4800", "audio/vnd.nuera.ecelp4800"],
		["ecelp7470", "audio/vnd.nuera.ecelp7470"],
		["ecelp9600", "audio/vnd.nuera.ecelp9600"],
		["edm", "application/vnd.novadigm.edm"],
		["edx", "application/vnd.novadigm.edx"],
		["efif", "application/vnd.picsel"],
		["ei6", "application/vnd.pg.osasli"],
		["el", "text/x-script.elisp"],
		["elc", ["application/x-elc", "application/x-bytecode.elisp"]],
		["eml", "message/rfc822"],
		["emma", "application/emma+xml"],
		["env", "application/x-envoy"],
		["eol", "audio/vnd.digital-winds"],
		["eot", "application/vnd.ms-fontobject"],
		["eps", "application/postscript"],
		["epub", "application/epub+zip"],
		["es", ["application/ecmascript", "application/x-esrehber"]],
		["es3", "application/vnd.eszigno3+xml"],
		["esf", "application/vnd.epson.esf"],
		["etx", "text/x-setext"],
		["evy", ["application/envoy", "application/x-envoy"]],
		["exe", ["application/octet-stream", "application/x-msdownload"]],
		["exi", "application/exi"],
		["ext", "application/vnd.novadigm.ext"],
		["ez2", "application/vnd.ezpix-album"],
		["ez3", "application/vnd.ezpix-package"],
		["f", ["text/plain", "text/x-fortran"]],
		["f4v", "video/x-f4v"],
		["f77", "text/x-fortran"],
		["f90", ["text/plain", "text/x-fortran"]],
		["fbs", "image/vnd.fastbidsheet"],
		["fcs", "application/vnd.isac.fcs"],
		["fdf", "application/vnd.fdf"],
		["fe_launch", "application/vnd.denovo.fcselayout-link"],
		["fg5", "application/vnd.fujitsu.oasysgp"],
		["fh", "image/x-freehand"],
		["fif", ["application/fractals", "image/fif"]],
		["fig", "application/x-xfig"],
		["fli", ["video/fli", "video/x-fli"]],
		["flo", ["image/florian", "application/vnd.micrografx.flo"]],
		["flr", "x-world/x-vrml"],
		["flv", "video/x-flv"],
		["flw", "application/vnd.kde.kivio"],
		["flx", "text/vnd.fmi.flexstor"],
		["fly", "text/vnd.fly"],
		["fm", "application/vnd.framemaker"],
		["fmf", "video/x-atomic3d-feature"],
		["fnc", "application/vnd.frogans.fnc"],
		["for", ["text/plain", "text/x-fortran"]],
		["fpx", ["image/vnd.fpx", "image/vnd.net-fpx"]],
		["frl", "application/freeloader"],
		["fsc", "application/vnd.fsc.weblaunch"],
		["fst", "image/vnd.fst"],
		["ftc", "application/vnd.fluxtime.clip"],
		["fti", "application/vnd.anser-web-funds-transfer-initiation"],
		["funk", "audio/make"],
		["fvt", "video/vnd.fvt"],
		["fxp", "application/vnd.adobe.fxp"],
		["fzs", "application/vnd.fuzzysheet"],
		["g", "text/plain"],
		["g2w", "application/vnd.geoplan"],
		["g3", "image/g3fax"],
		["g3w", "application/vnd.geospace"],
		["gac", "application/vnd.groove-account"],
		["gdl", "model/vnd.gdl"],
		["geo", "application/vnd.dynageo"],
		["geojson", "application/geo+json"],
		["gex", "application/vnd.geometry-explorer"],
		["ggb", "application/vnd.geogebra.file"],
		["ggt", "application/vnd.geogebra.tool"],
		["ghf", "application/vnd.groove-help"],
		["gif", "image/gif"],
		["gim", "application/vnd.groove-identity-message"],
		["gl", ["video/gl", "video/x-gl"]],
		["gmx", "application/vnd.gmx"],
		["gnumeric", "application/x-gnumeric"],
		["gph", "application/vnd.flographit"],
		["gqf", "application/vnd.grafeq"],
		["gram", "application/srgs"],
		["grv", "application/vnd.groove-injector"],
		["grxml", "application/srgs+xml"],
		["gsd", "audio/x-gsm"],
		["gsf", "application/x-font-ghostscript"],
		["gsm", "audio/x-gsm"],
		["gsp", "application/x-gsp"],
		["gss", "application/x-gss"],
		["gtar", "application/x-gtar"],
		["gtm", "application/vnd.groove-tool-message"],
		["gtw", "model/vnd.gtw"],
		["gv", "text/vnd.graphviz"],
		["gxt", "application/vnd.geonext"],
		["gz", ["application/x-gzip", "application/x-compressed"]],
		["gzip", ["multipart/x-gzip", "application/x-gzip"]],
		["h", ["text/plain", "text/x-h"]],
		["h261", "video/h261"],
		["h263", "video/h263"],
		["h264", "video/h264"],
		["hal", "application/vnd.hal+xml"],
		["hbci", "application/vnd.hbci"],
		["hdf", "application/x-hdf"],
		["help", "application/x-helpfile"],
		["hgl", "application/vnd.hp-hpgl"],
		["hh", ["text/plain", "text/x-h"]],
		["hlb", "text/x-script"],
		["hlp", [
			"application/winhlp",
			"application/hlp",
			"application/x-helpfile",
			"application/x-winhelp"
		]],
		["hpg", "application/vnd.hp-hpgl"],
		["hpgl", "application/vnd.hp-hpgl"],
		["hpid", "application/vnd.hp-hpid"],
		["hps", "application/vnd.hp-hps"],
		["hqx", [
			"application/mac-binhex40",
			"application/binhex",
			"application/binhex4",
			"application/mac-binhex",
			"application/x-binhex40",
			"application/x-mac-binhex40"
		]],
		["hta", "application/hta"],
		["htc", "text/x-component"],
		["htke", "application/vnd.kenameaapp"],
		["htm", "text/html"],
		["html", "text/html"],
		["htmls", "text/html"],
		["htt", "text/webviewhtml"],
		["htx", "text/html"],
		["hvd", "application/vnd.yamaha.hv-dic"],
		["hvp", "application/vnd.yamaha.hv-voice"],
		["hvs", "application/vnd.yamaha.hv-script"],
		["i2g", "application/vnd.intergeo"],
		["icc", "application/vnd.iccprofile"],
		["ice", "x-conference/x-cooltalk"],
		["ico", "image/x-icon"],
		["ics", "text/calendar"],
		["idc", "text/plain"],
		["ief", "image/ief"],
		["iefs", "image/ief"],
		["ifm", "application/vnd.shana.informed.formdata"],
		["iges", ["application/iges", "model/iges"]],
		["igl", "application/vnd.igloader"],
		["igm", "application/vnd.insors.igm"],
		["igs", ["application/iges", "model/iges"]],
		["igx", "application/vnd.micrografx.igx"],
		["iif", "application/vnd.shana.informed.interchange"],
		["iii", "application/x-iphone"],
		["ima", "application/x-ima"],
		["imap", "application/x-httpd-imap"],
		["imp", "application/vnd.accpac.simply.imp"],
		["ims", "application/vnd.ms-ims"],
		["inf", "application/inf"],
		["ins", ["application/x-internet-signup", "application/x-internett-signup"]],
		["ip", "application/x-ip2"],
		["ipfix", "application/ipfix"],
		["ipk", "application/vnd.shana.informed.package"],
		["irm", "application/vnd.ibm.rights-management"],
		["irp", "application/vnd.irepository.package+xml"],
		["isp", "application/x-internet-signup"],
		["isu", "video/x-isvideo"],
		["it", "audio/it"],
		["itp", "application/vnd.shana.informed.formtemplate"],
		["iv", "application/x-inventor"],
		["ivp", "application/vnd.immervision-ivp"],
		["ivr", "i-world/i-vrml"],
		["ivu", "application/vnd.immervision-ivu"],
		["ivy", "application/x-livescreen"],
		["jad", "text/vnd.sun.j2me.app-descriptor"],
		["jam", ["application/vnd.jam", "audio/x-jam"]],
		["jar", "application/java-archive"],
		["jav", ["text/plain", "text/x-java-source"]],
		["java", [
			"text/plain",
			"text/x-java-source,java",
			"text/x-java-source"
		]],
		["jcm", "application/x-java-commerce"],
		["jfif", [
			"image/pipeg",
			"image/jpeg",
			"image/pjpeg"
		]],
		["jfif-tbnl", "image/jpeg"],
		["jisp", "application/vnd.jisp"],
		["jlt", "application/vnd.hp-jlyt"],
		["jnlp", "application/x-java-jnlp-file"],
		["joda", "application/vnd.joost.joda-archive"],
		["jpe", ["image/jpeg", "image/pjpeg"]],
		["jpeg", ["image/jpeg", "image/pjpeg"]],
		["jpg", ["image/jpeg", "image/pjpeg"]],
		["jpgv", "video/jpeg"],
		["jpm", "video/jpm"],
		["jps", "image/x-jps"],
		["js", [
			"application/javascript",
			"application/ecmascript",
			"text/javascript",
			"text/ecmascript",
			"application/x-javascript"
		]],
		["json", "application/json"],
		["jut", "image/jutvision"],
		["kar", ["audio/midi", "music/x-karaoke"]],
		["karbon", "application/vnd.kde.karbon"],
		["kfo", "application/vnd.kde.kformula"],
		["kia", "application/vnd.kidspiration"],
		["kml", "application/vnd.google-earth.kml+xml"],
		["kmz", "application/vnd.google-earth.kmz"],
		["kne", "application/vnd.kinar"],
		["kon", "application/vnd.kde.kontour"],
		["kpr", "application/vnd.kde.kpresenter"],
		["ksh", ["application/x-ksh", "text/x-script.ksh"]],
		["ksp", "application/vnd.kde.kspread"],
		["ktx", "image/ktx"],
		["ktz", "application/vnd.kahootz"],
		["kwd", "application/vnd.kde.kword"],
		["la", ["audio/nspaudio", "audio/x-nspaudio"]],
		["lam", "audio/x-liveaudio"],
		["lasxml", "application/vnd.las.las+xml"],
		["latex", "application/x-latex"],
		["lbd", "application/vnd.llamagraphics.life-balance.desktop"],
		["lbe", "application/vnd.llamagraphics.life-balance.exchange+xml"],
		["les", "application/vnd.hhe.lesson-player"],
		["lha", [
			"application/octet-stream",
			"application/lha",
			"application/x-lha"
		]],
		["lhx", "application/octet-stream"],
		["link66", "application/vnd.route66.link66+xml"],
		["list", "text/plain"],
		["lma", ["audio/nspaudio", "audio/x-nspaudio"]],
		["log", "text/plain"],
		["lrm", "application/vnd.ms-lrm"],
		["lsf", "video/x-la-asf"],
		["lsp", ["application/x-lisp", "text/x-script.lisp"]],
		["lst", "text/plain"],
		["lsx", ["video/x-la-asf", "text/x-la-asf"]],
		["ltf", "application/vnd.frogans.ltf"],
		["ltx", "application/x-latex"],
		["lvp", "audio/vnd.lucent.voice"],
		["lwp", "application/vnd.lotus-wordpro"],
		["lzh", ["application/octet-stream", "application/x-lzh"]],
		["lzx", [
			"application/lzx",
			"application/octet-stream",
			"application/x-lzx"
		]],
		["m", ["text/plain", "text/x-m"]],
		["m13", "application/x-msmediaview"],
		["m14", "application/x-msmediaview"],
		["m1v", "video/mpeg"],
		["m21", "application/mp21"],
		["m2a", "audio/mpeg"],
		["m2v", "video/mpeg"],
		["m3u", ["audio/x-mpegurl", "audio/x-mpequrl"]],
		["m3u8", "application/vnd.apple.mpegurl"],
		["m4v", "video/x-m4v"],
		["ma", "application/mathematica"],
		["mads", "application/mads+xml"],
		["mag", "application/vnd.ecowin.chart"],
		["man", "application/x-troff-man"],
		["map", "application/x-navimap"],
		["mar", "text/plain"],
		["mathml", "application/mathml+xml"],
		["mbd", "application/mbedlet"],
		["mbk", "application/vnd.mobius.mbk"],
		["mbox", "application/mbox"],
		["mc$", "application/x-magic-cap-package-1.0"],
		["mc1", "application/vnd.medcalcdata"],
		["mcd", [
			"application/mcad",
			"application/vnd.mcd",
			"application/x-mathcad"
		]],
		["mcf", ["image/vasa", "text/mcf"]],
		["mcp", "application/netmc"],
		["mcurl", "text/vnd.curl.mcurl"],
		["mdb", "application/x-msaccess"],
		["mdi", "image/vnd.ms-modi"],
		["me", "application/x-troff-me"],
		["meta4", "application/metalink4+xml"],
		["mets", "application/mets+xml"],
		["mfm", "application/vnd.mfmp"],
		["mgp", "application/vnd.osgeo.mapguide.package"],
		["mgz", "application/vnd.proteus.magazine"],
		["mht", "message/rfc822"],
		["mhtml", "message/rfc822"],
		["mid", [
			"audio/mid",
			"audio/midi",
			"music/crescendo",
			"x-music/x-midi",
			"audio/x-midi",
			"application/x-midi",
			"audio/x-mid"
		]],
		["midi", [
			"audio/midi",
			"music/crescendo",
			"x-music/x-midi",
			"audio/x-midi",
			"application/x-midi",
			"audio/x-mid"
		]],
		["mif", [
			"application/vnd.mif",
			"application/x-mif",
			"application/x-frame"
		]],
		["mime", ["message/rfc822", "www/mime"]],
		["mj2", "video/mj2"],
		["mjf", "audio/x-vnd.audioexplosion.mjuicemediafile"],
		["mjpg", "video/x-motion-jpeg"],
		["mlp", "application/vnd.dolby.mlp"],
		["mm", ["application/base64", "application/x-meme"]],
		["mmd", "application/vnd.chipnuts.karaoke-mmd"],
		["mme", "application/base64"],
		["mmf", "application/vnd.smaf"],
		["mmr", "image/vnd.fujixerox.edmics-mmr"],
		["mny", "application/x-msmoney"],
		["mod", ["audio/mod", "audio/x-mod"]],
		["mods", "application/mods+xml"],
		["moov", "video/quicktime"],
		["mov", "video/quicktime"],
		["movie", "video/x-sgi-movie"],
		["mp2", [
			"video/mpeg",
			"audio/mpeg",
			"video/x-mpeg",
			"audio/x-mpeg",
			"video/x-mpeq2a"
		]],
		["mp3", [
			"audio/mpeg",
			"audio/mpeg3",
			"video/mpeg",
			"audio/x-mpeg-3",
			"video/x-mpeg"
		]],
		["mp4", ["video/mp4", "application/mp4"]],
		["mp4a", "audio/mp4"],
		["mpa", ["video/mpeg", "audio/mpeg"]],
		["mpc", ["application/vnd.mophun.certificate", "application/x-project"]],
		["mpe", "video/mpeg"],
		["mpeg", "video/mpeg"],
		["mpg", ["video/mpeg", "audio/mpeg"]],
		["mpga", "audio/mpeg"],
		["mpkg", "application/vnd.apple.installer+xml"],
		["mpm", "application/vnd.blueice.multipass"],
		["mpn", "application/vnd.mophun.application"],
		["mpp", "application/vnd.ms-project"],
		["mpt", "application/x-project"],
		["mpv", "application/x-project"],
		["mpv2", "video/mpeg"],
		["mpx", "application/x-project"],
		["mpy", "application/vnd.ibm.minipay"],
		["mqy", "application/vnd.mobius.mqy"],
		["mrc", "application/marc"],
		["mrcx", "application/marcxml+xml"],
		["ms", "application/x-troff-ms"],
		["mscml", "application/mediaservercontrol+xml"],
		["mseq", "application/vnd.mseq"],
		["msf", "application/vnd.epson.msf"],
		["msg", "application/vnd.ms-outlook"],
		["msh", "model/mesh"],
		["msl", "application/vnd.mobius.msl"],
		["msty", "application/vnd.muvee.style"],
		["mts", "model/vnd.mts"],
		["mus", "application/vnd.musician"],
		["musicxml", "application/vnd.recordare.musicxml+xml"],
		["mv", "video/x-sgi-movie"],
		["mvb", "application/x-msmediaview"],
		["mwf", "application/vnd.mfer"],
		["mxf", "application/mxf"],
		["mxl", "application/vnd.recordare.musicxml"],
		["mxml", "application/xv+xml"],
		["mxs", "application/vnd.triscape.mxs"],
		["mxu", "video/vnd.mpegurl"],
		["my", "audio/make"],
		["mzz", "application/x-vnd.audioexplosion.mzz"],
		["n-gage", "application/vnd.nokia.n-gage.symbian.install"],
		["n3", "text/n3"],
		["nap", "image/naplps"],
		["naplps", "image/naplps"],
		["nbp", "application/vnd.wolfram.player"],
		["nc", "application/x-netcdf"],
		["ncm", "application/vnd.nokia.configuration-message"],
		["ncx", "application/x-dtbncx+xml"],
		["ngdat", "application/vnd.nokia.n-gage.data"],
		["nif", "image/x-niff"],
		["niff", "image/x-niff"],
		["nix", "application/x-mix-transfer"],
		["nlu", "application/vnd.neurolanguage.nlu"],
		["nml", "application/vnd.enliven"],
		["nnd", "application/vnd.noblenet-directory"],
		["nns", "application/vnd.noblenet-sealer"],
		["nnw", "application/vnd.noblenet-web"],
		["npx", "image/vnd.net-fpx"],
		["nsc", "application/x-conference"],
		["nsf", "application/vnd.lotus-notes"],
		["nvd", "application/x-navidoc"],
		["nws", "message/rfc822"],
		["o", "application/octet-stream"],
		["oa2", "application/vnd.fujitsu.oasys2"],
		["oa3", "application/vnd.fujitsu.oasys3"],
		["oas", "application/vnd.fujitsu.oasys"],
		["obd", "application/x-msbinder"],
		["oda", "application/oda"],
		["odb", "application/vnd.oasis.opendocument.database"],
		["odc", "application/vnd.oasis.opendocument.chart"],
		["odf", "application/vnd.oasis.opendocument.formula"],
		["odft", "application/vnd.oasis.opendocument.formula-template"],
		["odg", "application/vnd.oasis.opendocument.graphics"],
		["odi", "application/vnd.oasis.opendocument.image"],
		["odm", "application/vnd.oasis.opendocument.text-master"],
		["odp", "application/vnd.oasis.opendocument.presentation"],
		["ods", "application/vnd.oasis.opendocument.spreadsheet"],
		["odt", "application/vnd.oasis.opendocument.text"],
		["oga", "audio/ogg"],
		["ogv", "video/ogg"],
		["ogx", "application/ogg"],
		["omc", "application/x-omc"],
		["omcd", "application/x-omcdatamaker"],
		["omcr", "application/x-omcregerator"],
		["onetoc", "application/onenote"],
		["opf", "application/oebps-package+xml"],
		["org", "application/vnd.lotus-organizer"],
		["osf", "application/vnd.yamaha.openscoreformat"],
		["osfpvg", "application/vnd.yamaha.openscoreformat.osfpvg+xml"],
		["otc", "application/vnd.oasis.opendocument.chart-template"],
		["otf", "application/x-font-otf"],
		["otg", "application/vnd.oasis.opendocument.graphics-template"],
		["oth", "application/vnd.oasis.opendocument.text-web"],
		["oti", "application/vnd.oasis.opendocument.image-template"],
		["otp", "application/vnd.oasis.opendocument.presentation-template"],
		["ots", "application/vnd.oasis.opendocument.spreadsheet-template"],
		["ott", "application/vnd.oasis.opendocument.text-template"],
		["oxt", "application/vnd.openofficeorg.extension"],
		["p", "text/x-pascal"],
		["p10", ["application/pkcs10", "application/x-pkcs10"]],
		["p12", ["application/pkcs-12", "application/x-pkcs12"]],
		["p7a", "application/x-pkcs7-signature"],
		["p7b", "application/x-pkcs7-certificates"],
		["p7c", ["application/pkcs7-mime", "application/x-pkcs7-mime"]],
		["p7m", ["application/pkcs7-mime", "application/x-pkcs7-mime"]],
		["p7r", "application/x-pkcs7-certreqresp"],
		["p7s", ["application/pkcs7-signature", "application/x-pkcs7-signature"]],
		["p8", "application/pkcs8"],
		["par", "text/plain-bas"],
		["part", "application/pro_eng"],
		["pas", "text/pascal"],
		["paw", "application/vnd.pawaafile"],
		["pbd", "application/vnd.powerbuilder6"],
		["pbm", "image/x-portable-bitmap"],
		["pcf", "application/x-font-pcf"],
		["pcl", ["application/vnd.hp-pcl", "application/x-pcl"]],
		["pclxl", "application/vnd.hp-pclxl"],
		["pct", "image/x-pict"],
		["pcurl", "application/vnd.curl.pcurl"],
		["pcx", "image/x-pcx"],
		["pdb", ["application/vnd.palm", "chemical/x-pdb"]],
		["pdf", "application/pdf"],
		["pfa", "application/x-font-type1"],
		["pfr", "application/font-tdpfr"],
		["pfunk", ["audio/make", "audio/make.my.funk"]],
		["pfx", "application/x-pkcs12"],
		["pgm", ["image/x-portable-graymap", "image/x-portable-greymap"]],
		["pgn", "application/x-chess-pgn"],
		["pgp", "application/pgp-signature"],
		["pic", ["image/pict", "image/x-pict"]],
		["pict", "image/pict"],
		["pkg", "application/x-newton-compatible-pkg"],
		["pki", "application/pkixcmp"],
		["pkipath", "application/pkix-pkipath"],
		["pko", ["application/ynd.ms-pkipko", "application/vnd.ms-pki.pko"]],
		["pl", ["text/plain", "text/x-script.perl"]],
		["plb", "application/vnd.3gpp.pic-bw-large"],
		["plc", "application/vnd.mobius.plc"],
		["plf", "application/vnd.pocketlearn"],
		["pls", "application/pls+xml"],
		["plx", "application/x-pixclscript"],
		["pm", ["text/x-script.perl-module", "image/x-xpixmap"]],
		["pm4", "application/x-pagemaker"],
		["pm5", "application/x-pagemaker"],
		["pma", "application/x-perfmon"],
		["pmc", "application/x-perfmon"],
		["pml", ["application/vnd.ctc-posml", "application/x-perfmon"]],
		["pmr", "application/x-perfmon"],
		["pmw", "application/x-perfmon"],
		["png", "image/png"],
		["pnm", ["application/x-portable-anymap", "image/x-portable-anymap"]],
		["portpkg", "application/vnd.macports.portpkg"],
		["pot", ["application/vnd.ms-powerpoint", "application/mspowerpoint"]],
		["potm", "application/vnd.ms-powerpoint.template.macroenabled.12"],
		["potx", "application/vnd.openxmlformats-officedocument.presentationml.template"],
		["pov", "model/x-pov"],
		["ppa", "application/vnd.ms-powerpoint"],
		["ppam", "application/vnd.ms-powerpoint.addin.macroenabled.12"],
		["ppd", "application/vnd.cups-ppd"],
		["ppm", "image/x-portable-pixmap"],
		["pps", ["application/vnd.ms-powerpoint", "application/mspowerpoint"]],
		["ppsm", "application/vnd.ms-powerpoint.slideshow.macroenabled.12"],
		["ppsx", "application/vnd.openxmlformats-officedocument.presentationml.slideshow"],
		["ppt", [
			"application/vnd.ms-powerpoint",
			"application/mspowerpoint",
			"application/powerpoint",
			"application/x-mspowerpoint"
		]],
		["pptm", "application/vnd.ms-powerpoint.presentation.macroenabled.12"],
		["pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
		["ppz", "application/mspowerpoint"],
		["prc", "application/x-mobipocket-ebook"],
		["pre", ["application/vnd.lotus-freelance", "application/x-freelance"]],
		["prf", "application/pics-rules"],
		["prt", "application/pro_eng"],
		["ps", "application/postscript"],
		["psb", "application/vnd.3gpp.pic-bw-small"],
		["psd", ["application/octet-stream", "image/vnd.adobe.photoshop"]],
		["psf", "application/x-font-linux-psf"],
		["pskcxml", "application/pskc+xml"],
		["ptid", "application/vnd.pvi.ptid1"],
		["pub", "application/x-mspublisher"],
		["pvb", "application/vnd.3gpp.pic-bw-var"],
		["pvu", "paleovu/x-pv"],
		["pwn", "application/vnd.3m.post-it-notes"],
		["pwz", "application/vnd.ms-powerpoint"],
		["py", "text/x-script.phyton"],
		["pya", "audio/vnd.ms-playready.media.pya"],
		["pyc", "application/x-bytecode.python"],
		["pyv", "video/vnd.ms-playready.media.pyv"],
		["qam", "application/vnd.epson.quickanime"],
		["qbo", "application/vnd.intu.qbo"],
		["qcp", "audio/vnd.qcelp"],
		["qd3", "x-world/x-3dmf"],
		["qd3d", "x-world/x-3dmf"],
		["qfx", "application/vnd.intu.qfx"],
		["qif", "image/x-quicktime"],
		["qps", "application/vnd.publishare-delta-tree"],
		["qt", "video/quicktime"],
		["qtc", "video/x-qtc"],
		["qti", "image/x-quicktime"],
		["qtif", "image/x-quicktime"],
		["qxd", "application/vnd.quark.quarkxpress"],
		["ra", [
			"audio/x-realaudio",
			"audio/x-pn-realaudio",
			"audio/x-pn-realaudio-plugin"
		]],
		["ram", "audio/x-pn-realaudio"],
		["rar", "application/x-rar-compressed"],
		["ras", [
			"image/cmu-raster",
			"application/x-cmu-raster",
			"image/x-cmu-raster"
		]],
		["rast", "image/cmu-raster"],
		["rcprofile", "application/vnd.ipunplugged.rcprofile"],
		["rdf", "application/rdf+xml"],
		["rdz", "application/vnd.data-vision.rdz"],
		["rep", "application/vnd.businessobjects"],
		["res", "application/x-dtbresource+xml"],
		["rexx", "text/x-script.rexx"],
		["rf", "image/vnd.rn-realflash"],
		["rgb", "image/x-rgb"],
		["rif", "application/reginfo+xml"],
		["rip", "audio/vnd.rip"],
		["rl", "application/resource-lists+xml"],
		["rlc", "image/vnd.fujixerox.edmics-rlc"],
		["rld", "application/resource-lists-diff+xml"],
		["rm", ["application/vnd.rn-realmedia", "audio/x-pn-realaudio"]],
		["rmi", "audio/mid"],
		["rmm", "audio/x-pn-realaudio"],
		["rmp", ["audio/x-pn-realaudio-plugin", "audio/x-pn-realaudio"]],
		["rms", "application/vnd.jcp.javame.midlet-rms"],
		["rnc", "application/relax-ng-compact-syntax"],
		["rng", ["application/ringing-tones", "application/vnd.nokia.ringing-tone"]],
		["rnx", "application/vnd.rn-realplayer"],
		["roff", "application/x-troff"],
		["rp", "image/vnd.rn-realpix"],
		["rp9", "application/vnd.cloanto.rp9"],
		["rpm", "audio/x-pn-realaudio-plugin"],
		["rpss", "application/vnd.nokia.radio-presets"],
		["rpst", "application/vnd.nokia.radio-preset"],
		["rq", "application/sparql-query"],
		["rs", "application/rls-services+xml"],
		["rsd", "application/rsd+xml"],
		["rt", ["text/richtext", "text/vnd.rn-realtext"]],
		["rtf", [
			"application/rtf",
			"text/richtext",
			"application/x-rtf"
		]],
		["rtx", ["text/richtext", "application/rtf"]],
		["rv", "video/vnd.rn-realvideo"],
		["s", "text/x-asm"],
		["s3m", "audio/s3m"],
		["saf", "application/vnd.yamaha.smaf-audio"],
		["saveme", "application/octet-stream"],
		["sbk", "application/x-tbook"],
		["sbml", "application/sbml+xml"],
		["sc", "application/vnd.ibm.secure-container"],
		["scd", "application/x-msschedule"],
		["scm", [
			"application/vnd.lotus-screencam",
			"video/x-scm",
			"text/x-script.guile",
			"application/x-lotusscreencam",
			"text/x-script.scheme"
		]],
		["scq", "application/scvp-cv-request"],
		["scs", "application/scvp-cv-response"],
		["sct", "text/scriptlet"],
		["scurl", "text/vnd.curl.scurl"],
		["sda", "application/vnd.stardivision.draw"],
		["sdc", "application/vnd.stardivision.calc"],
		["sdd", "application/vnd.stardivision.impress"],
		["sdkm", "application/vnd.solent.sdkm+xml"],
		["sdml", "text/plain"],
		["sdp", ["application/sdp", "application/x-sdp"]],
		["sdr", "application/sounder"],
		["sdw", "application/vnd.stardivision.writer"],
		["sea", ["application/sea", "application/x-sea"]],
		["see", "application/vnd.seemail"],
		["seed", "application/vnd.fdsn.seed"],
		["sema", "application/vnd.sema"],
		["semd", "application/vnd.semd"],
		["semf", "application/vnd.semf"],
		["ser", "application/java-serialized-object"],
		["set", "application/set"],
		["setpay", "application/set-payment-initiation"],
		["setreg", "application/set-registration-initiation"],
		["sfd-hdstx", "application/vnd.hydrostatix.sof-data"],
		["sfs", "application/vnd.spotfire.sfs"],
		["sgl", "application/vnd.stardivision.writer-global"],
		["sgm", ["text/sgml", "text/x-sgml"]],
		["sgml", ["text/sgml", "text/x-sgml"]],
		["sh", [
			"application/x-shar",
			"application/x-bsh",
			"application/x-sh",
			"text/x-script.sh"
		]],
		["shar", ["application/x-bsh", "application/x-shar"]],
		["shf", "application/shf+xml"],
		["shtml", ["text/html", "text/x-server-parsed-html"]],
		["sid", "audio/x-psid"],
		["sis", "application/vnd.symbian.install"],
		["sit", ["application/x-stuffit", "application/x-sit"]],
		["sitx", "application/x-stuffitx"],
		["skd", "application/x-koan"],
		["skm", "application/x-koan"],
		["skp", ["application/vnd.koan", "application/x-koan"]],
		["skt", "application/x-koan"],
		["sl", "application/x-seelogo"],
		["sldm", "application/vnd.ms-powerpoint.slide.macroenabled.12"],
		["sldx", "application/vnd.openxmlformats-officedocument.presentationml.slide"],
		["slt", "application/vnd.epson.salt"],
		["sm", "application/vnd.stepmania.stepchart"],
		["smf", "application/vnd.stardivision.math"],
		["smi", ["application/smil", "application/smil+xml"]],
		["smil", "application/smil"],
		["snd", ["audio/basic", "audio/x-adpcm"]],
		["snf", "application/x-font-snf"],
		["sol", "application/solids"],
		["spc", ["text/x-speech", "application/x-pkcs7-certificates"]],
		["spf", "application/vnd.yamaha.smaf-phrase"],
		["spl", ["application/futuresplash", "application/x-futuresplash"]],
		["spot", "text/vnd.in3d.spot"],
		["spp", "application/scvp-vp-response"],
		["spq", "application/scvp-vp-request"],
		["spr", "application/x-sprite"],
		["sprite", "application/x-sprite"],
		["src", "application/x-wais-source"],
		["sru", "application/sru+xml"],
		["srx", "application/sparql-results+xml"],
		["sse", "application/vnd.kodak-descriptor"],
		["ssf", "application/vnd.epson.ssf"],
		["ssi", "text/x-server-parsed-html"],
		["ssm", "application/streamingmedia"],
		["ssml", "application/ssml+xml"],
		["sst", ["application/vnd.ms-pkicertstore", "application/vnd.ms-pki.certstore"]],
		["st", "application/vnd.sailingtracker.track"],
		["stc", "application/vnd.sun.xml.calc.template"],
		["std", "application/vnd.sun.xml.draw.template"],
		["step", "application/step"],
		["stf", "application/vnd.wt.stf"],
		["sti", "application/vnd.sun.xml.impress.template"],
		["stk", "application/hyperstudio"],
		["stl", [
			"application/vnd.ms-pkistl",
			"application/sla",
			"application/vnd.ms-pki.stl",
			"application/x-navistyle"
		]],
		["stm", "text/html"],
		["stp", "application/step"],
		["str", "application/vnd.pg.format"],
		["stw", "application/vnd.sun.xml.writer.template"],
		["sub", "image/vnd.dvb.subtitle"],
		["sus", "application/vnd.sus-calendar"],
		["sv4cpio", "application/x-sv4cpio"],
		["sv4crc", "application/x-sv4crc"],
		["svc", "application/vnd.dvb.service"],
		["svd", "application/vnd.svd"],
		["svf", ["image/vnd.dwg", "image/x-dwg"]],
		["svg", "image/svg+xml"],
		["svr", ["x-world/x-svr", "application/x-world"]],
		["swf", "application/x-shockwave-flash"],
		["swi", "application/vnd.aristanetworks.swi"],
		["sxc", "application/vnd.sun.xml.calc"],
		["sxd", "application/vnd.sun.xml.draw"],
		["sxg", "application/vnd.sun.xml.writer.global"],
		["sxi", "application/vnd.sun.xml.impress"],
		["sxm", "application/vnd.sun.xml.math"],
		["sxw", "application/vnd.sun.xml.writer"],
		["t", ["text/troff", "application/x-troff"]],
		["talk", "text/x-speech"],
		["tao", "application/vnd.tao.intent-module-archive"],
		["tar", "application/x-tar"],
		["tbk", ["application/toolbook", "application/x-tbook"]],
		["tcap", "application/vnd.3gpp2.tcap"],
		["tcl", ["text/x-script.tcl", "application/x-tcl"]],
		["tcsh", "text/x-script.tcsh"],
		["teacher", "application/vnd.smart.teacher"],
		["tei", "application/tei+xml"],
		["tex", "application/x-tex"],
		["texi", "application/x-texinfo"],
		["texinfo", "application/x-texinfo"],
		["text", ["application/plain", "text/plain"]],
		["tfi", "application/thraud+xml"],
		["tfm", "application/x-tex-tfm"],
		["tgz", ["application/gnutar", "application/x-compressed"]],
		["thmx", "application/vnd.ms-officetheme"],
		["tif", ["image/tiff", "image/x-tiff"]],
		["tiff", ["image/tiff", "image/x-tiff"]],
		["tmo", "application/vnd.tmobile-livetv"],
		["torrent", "application/x-bittorrent"],
		["tpl", "application/vnd.groove-tool-template"],
		["tpt", "application/vnd.trid.tpt"],
		["tr", "application/x-troff"],
		["tra", "application/vnd.trueapp"],
		["trm", "application/x-msterminal"],
		["tsd", "application/timestamped-data"],
		["tsi", "audio/tsp-audio"],
		["tsp", ["application/dsptype", "audio/tsplayer"]],
		["tsv", "text/tab-separated-values"],
		["ttf", "application/x-font-ttf"],
		["ttl", "text/turtle"],
		["turbot", "image/florian"],
		["twd", "application/vnd.simtech-mindmapper"],
		["txd", "application/vnd.genomatix.tuxedo"],
		["txf", "application/vnd.mobius.txf"],
		["txt", "text/plain"],
		["ufd", "application/vnd.ufdl"],
		["uil", "text/x-uil"],
		["uls", "text/iuls"],
		["umj", "application/vnd.umajin"],
		["uni", "text/uri-list"],
		["unis", "text/uri-list"],
		["unityweb", "application/vnd.unity"],
		["unv", "application/i-deas"],
		["uoml", "application/vnd.uoml+xml"],
		["uri", "text/uri-list"],
		["uris", "text/uri-list"],
		["ustar", ["application/x-ustar", "multipart/x-ustar"]],
		["utz", "application/vnd.uiq.theme"],
		["uu", ["application/octet-stream", "text/x-uuencode"]],
		["uue", "text/x-uuencode"],
		["uva", "audio/vnd.dece.audio"],
		["uvh", "video/vnd.dece.hd"],
		["uvi", "image/vnd.dece.graphic"],
		["uvm", "video/vnd.dece.mobile"],
		["uvp", "video/vnd.dece.pd"],
		["uvs", "video/vnd.dece.sd"],
		["uvu", "video/vnd.uvvu.mp4"],
		["uvv", "video/vnd.dece.video"],
		["vcd", "application/x-cdlink"],
		["vcf", "text/x-vcard"],
		["vcg", "application/vnd.groove-vcard"],
		["vcs", "text/x-vcalendar"],
		["vcx", "application/vnd.vcx"],
		["vda", "application/vda"],
		["vdo", "video/vdo"],
		["vew", "application/groupwise"],
		["vis", "application/vnd.visionary"],
		["viv", ["video/vivo", "video/vnd.vivo"]],
		["vivo", ["video/vivo", "video/vnd.vivo"]],
		["vmd", "application/vocaltec-media-desc"],
		["vmf", "application/vocaltec-media-file"],
		["voc", ["audio/voc", "audio/x-voc"]],
		["vos", "video/vosaic"],
		["vox", "audio/voxware"],
		["vqe", "audio/x-twinvq-plugin"],
		["vqf", "audio/x-twinvq"],
		["vql", "audio/x-twinvq-plugin"],
		["vrml", [
			"model/vrml",
			"x-world/x-vrml",
			"application/x-vrml"
		]],
		["vrt", "x-world/x-vrt"],
		["vsd", ["application/vnd.visio", "application/x-visio"]],
		["vsf", "application/vnd.vsf"],
		["vst", "application/x-visio"],
		["vsw", "application/x-visio"],
		["vtu", "model/vnd.vtu"],
		["vxml", "application/voicexml+xml"],
		["w60", "application/wordperfect6.0"],
		["w61", "application/wordperfect6.1"],
		["w6w", "application/msword"],
		["wad", "application/x-doom"],
		["wav", ["audio/wav", "audio/x-wav"]],
		["wax", "audio/x-ms-wax"],
		["wb1", "application/x-qpro"],
		["wbmp", "image/vnd.wap.wbmp"],
		["wbs", "application/vnd.criticaltools.wbs+xml"],
		["wbxml", "application/vnd.wap.wbxml"],
		["wcm", "application/vnd.ms-works"],
		["wdb", "application/vnd.ms-works"],
		["web", "application/vnd.xara"],
		["weba", "audio/webm"],
		["webm", "video/webm"],
		["webp", "image/webp"],
		["wg", "application/vnd.pmi.widget"],
		["wgt", "application/widget"],
		["wiz", "application/msword"],
		["wk1", "application/x-123"],
		["wks", "application/vnd.ms-works"],
		["wm", "video/x-ms-wm"],
		["wma", "audio/x-ms-wma"],
		["wmd", "application/x-ms-wmd"],
		["wmf", ["windows/metafile", "application/x-msmetafile"]],
		["wml", "text/vnd.wap.wml"],
		["wmlc", "application/vnd.wap.wmlc"],
		["wmls", "text/vnd.wap.wmlscript"],
		["wmlsc", "application/vnd.wap.wmlscriptc"],
		["wmv", "video/x-ms-wmv"],
		["wmx", "video/x-ms-wmx"],
		["wmz", "application/x-ms-wmz"],
		["woff", "application/x-font-woff"],
		["word", "application/msword"],
		["wp", "application/wordperfect"],
		["wp5", ["application/wordperfect", "application/wordperfect6.0"]],
		["wp6", "application/wordperfect"],
		["wpd", [
			"application/wordperfect",
			"application/vnd.wordperfect",
			"application/x-wpwin"
		]],
		["wpl", "application/vnd.ms-wpl"],
		["wps", "application/vnd.ms-works"],
		["wq1", "application/x-lotus"],
		["wqd", "application/vnd.wqd"],
		["wri", [
			"application/mswrite",
			"application/x-wri",
			"application/x-mswrite"
		]],
		["wrl", [
			"model/vrml",
			"x-world/x-vrml",
			"application/x-world"
		]],
		["wrz", ["model/vrml", "x-world/x-vrml"]],
		["wsc", "text/scriplet"],
		["wsdl", "application/wsdl+xml"],
		["wspolicy", "application/wspolicy+xml"],
		["wsrc", "application/x-wais-source"],
		["wtb", "application/vnd.webturbo"],
		["wtk", "application/x-wintalk"],
		["wvx", "video/x-ms-wvx"],
		["x-png", "image/png"],
		["x3d", "application/vnd.hzn-3d-crossword"],
		["xaf", "x-world/x-vrml"],
		["xap", "application/x-silverlight-app"],
		["xar", "application/vnd.xara"],
		["xbap", "application/x-ms-xbap"],
		["xbd", "application/vnd.fujixerox.docuworks.binder"],
		["xbm", [
			"image/xbm",
			"image/x-xbm",
			"image/x-xbitmap"
		]],
		["xdf", "application/xcap-diff+xml"],
		["xdm", "application/vnd.syncml.dm+xml"],
		["xdp", "application/vnd.adobe.xdp+xml"],
		["xdr", "video/x-amt-demorun"],
		["xdssc", "application/dssc+xml"],
		["xdw", "application/vnd.fujixerox.docuworks"],
		["xenc", "application/xenc+xml"],
		["xer", "application/patch-ops-error+xml"],
		["xfdf", "application/vnd.adobe.xfdf"],
		["xfdl", "application/vnd.xfdl"],
		["xgz", "xgl/drawing"],
		["xhtml", "application/xhtml+xml"],
		["xif", "image/vnd.xiff"],
		["xl", "application/excel"],
		["xla", [
			"application/vnd.ms-excel",
			"application/excel",
			"application/x-msexcel",
			"application/x-excel"
		]],
		["xlam", "application/vnd.ms-excel.addin.macroenabled.12"],
		["xlb", [
			"application/excel",
			"application/vnd.ms-excel",
			"application/x-excel"
		]],
		["xlc", [
			"application/vnd.ms-excel",
			"application/excel",
			"application/x-excel"
		]],
		["xld", ["application/excel", "application/x-excel"]],
		["xlk", ["application/excel", "application/x-excel"]],
		["xll", [
			"application/excel",
			"application/vnd.ms-excel",
			"application/x-excel"
		]],
		["xlm", [
			"application/vnd.ms-excel",
			"application/excel",
			"application/x-excel"
		]],
		["xls", [
			"application/vnd.ms-excel",
			"application/excel",
			"application/x-msexcel",
			"application/x-excel"
		]],
		["xlsb", "application/vnd.ms-excel.sheet.binary.macroenabled.12"],
		["xlsm", "application/vnd.ms-excel.sheet.macroenabled.12"],
		["xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
		["xlt", [
			"application/vnd.ms-excel",
			"application/excel",
			"application/x-excel"
		]],
		["xltm", "application/vnd.ms-excel.template.macroenabled.12"],
		["xltx", "application/vnd.openxmlformats-officedocument.spreadsheetml.template"],
		["xlv", ["application/excel", "application/x-excel"]],
		["xlw", [
			"application/vnd.ms-excel",
			"application/excel",
			"application/x-msexcel",
			"application/x-excel"
		]],
		["xm", "audio/xm"],
		["xml", [
			"application/xml",
			"text/xml",
			"application/atom+xml",
			"application/rss+xml"
		]],
		["xmz", "xgl/movie"],
		["xo", "application/vnd.olpc-sugar"],
		["xof", "x-world/x-vrml"],
		["xop", "application/xop+xml"],
		["xpi", "application/x-xpinstall"],
		["xpix", "application/x-vnd.ls-xpix"],
		["xpm", ["image/xpm", "image/x-xpixmap"]],
		["xpr", "application/vnd.is-xpr"],
		["xps", "application/vnd.ms-xpsdocument"],
		["xpw", "application/vnd.intercon.formnet"],
		["xslt", "application/xslt+xml"],
		["xsm", "application/vnd.syncml+xml"],
		["xspf", "application/xspf+xml"],
		["xsr", "video/x-amt-showrun"],
		["xul", "application/vnd.mozilla.xul+xml"],
		["xwd", ["image/x-xwd", "image/x-xwindowdump"]],
		["xyz", ["chemical/x-xyz", "chemical/x-pdb"]],
		["yang", "application/yang"],
		["yin", "application/yin+xml"],
		["z", ["application/x-compressed", "application/x-compress"]],
		["zaz", "application/vnd.zzazz.deck+xml"],
		["zip", [
			"application/zip",
			"multipart/x-zip",
			"application/x-zip-compressed",
			"application/x-compressed"
		]],
		["zir", "application/vnd.zul"],
		["zmm", "application/vnd.handheld-entertainment+xml"],
		["zoo", "application/octet-stream"],
		["zsh", "text/x-script.zsh"]
	]);
	module.exports = {
		detectMimeType(filename) {
			if (!filename) return defaultMimeType;
			let parsed = path$1.parse(filename);
			let extension = (parsed.ext.substr(1) || parsed.name || "").split("?").shift().trim().toLowerCase();
			let value = defaultMimeType;
			if (extensions.has(extension)) value = extensions.get(extension);
			if (Array.isArray(value)) return value[0];
			return value;
		},
		detectExtension(mimeType) {
			if (!mimeType) return defaultExtension;
			let parts = (mimeType || "").toLowerCase().trim().split("/");
			let rootType = parts.shift().trim();
			let subType = parts.join("/").trim();
			if (mimeTypes.has(rootType + "/" + subType)) {
				let value = mimeTypes.get(rootType + "/" + subType);
				if (Array.isArray(value)) return value[0];
				return value;
			}
			switch (rootType) {
				case "text": return "txt";
				default: return "bin";
			}
		}
	};
}));
//#endregion
//#region node_modules/nodemailer/lib/punycode/index.js
var require_punycode = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	/** Highest positive signed 32-bit float value */
	const maxInt = 2147483647;
	/** Bootstring parameters */
	const base = 36;
	const tMin = 1;
	const tMax = 26;
	const skew = 38;
	const damp = 700;
	const initialBias = 72;
	const initialN = 128;
	const delimiter = "-";
	/** Regular expressions */
	const regexPunycode = /^xn--/;
	const regexNonASCII = /[^\0-\x7F]/;
	const regexSeparators = /[\x2E\u3002\uFF0E\uFF61]/g;
	/** Error messages */
	const errors = {
		overflow: "Overflow: input needs wider integers to process",
		"not-basic": "Illegal input >= 0x80 (not a basic code point)",
		"invalid-input": "Invalid input"
	};
	/** Convenience shortcuts */
	const baseMinusTMin = base - tMin;
	const floor = Math.floor;
	const stringFromCharCode = String.fromCharCode;
	/**
	* A generic error utility function.
	* @private
	* @param {String} type The error type.
	* @returns {Error} Throws a `RangeError` with the applicable error message.
	*/
	function error(type) {
		throw new RangeError(errors[type]);
	}
	/**
	* A generic `Array#map` utility function.
	* @private
	* @param {Array} array The array to iterate over.
	* @param {Function} callback The function that gets called for every array
	* item.
	* @returns {Array} A new array of values returned by the callback function.
	*/
	function map(array, callback) {
		const result = [];
		let length = array.length;
		while (length--) result[length] = callback(array[length]);
		return result;
	}
	/**
	* A simple `Array#map`-like wrapper to work with domain name strings or email
	* addresses.
	* @private
	* @param {String} domain The domain name or email address.
	* @param {Function} callback The function that gets called for every
	* character.
	* @returns {String} A new string of characters returned by the callback
	* function.
	*/
	function mapDomain(domain, callback) {
		const parts = domain.split("@");
		let result = "";
		if (parts.length > 1) {
			result = parts[0] + "@";
			domain = parts[1];
		}
		domain = domain.replace(regexSeparators, ".");
		const encoded = map(domain.split("."), callback).join(".");
		return result + encoded;
	}
	/**
	* Creates an array containing the numeric code points of each Unicode
	* character in the string. While JavaScript uses UCS-2 internally,
	* this function will convert a pair of surrogate halves (each of which
	* UCS-2 exposes as separate characters) into a single code point,
	* matching UTF-16.
	* @see `punycode.ucs2.encode`
	* @see <https://mathiasbynens.be/notes/javascript-encoding>
	* @memberOf punycode.ucs2
	* @name decode
	* @param {String} string The Unicode input string (UCS-2).
	* @returns {Array} The new array of code points.
	*/
	function ucs2decode(string) {
		const output = [];
		let counter = 0;
		const length = string.length;
		while (counter < length) {
			const value = string.charCodeAt(counter++);
			if (value >= 55296 && value <= 56319 && counter < length) {
				const extra = string.charCodeAt(counter++);
				if ((extra & 64512) == 56320) output.push(((value & 1023) << 10) + (extra & 1023) + 65536);
				else {
					output.push(value);
					counter--;
				}
			} else output.push(value);
		}
		return output;
	}
	/**
	* Creates a string based on an array of numeric code points.
	* @see `punycode.ucs2.decode`
	* @memberOf punycode.ucs2
	* @name encode
	* @param {Array} codePoints The array of numeric code points.
	* @returns {String} The new Unicode string (UCS-2).
	*/
	const ucs2encode = (codePoints) => String.fromCodePoint(...codePoints);
	/**
	* Converts a basic code point into a digit/integer.
	* @see `digitToBasic()`
	* @private
	* @param {Number} codePoint The basic numeric code point value.
	* @returns {Number} The numeric value of a basic code point (for use in
	* representing integers) in the range `0` to `base - 1`, or `base` if
	* the code point does not represent a value.
	*/
	const basicToDigit = function(codePoint) {
		if (codePoint >= 48 && codePoint < 58) return 26 + (codePoint - 48);
		if (codePoint >= 65 && codePoint < 91) return codePoint - 65;
		if (codePoint >= 97 && codePoint < 123) return codePoint - 97;
		return base;
	};
	/**
	* Converts a digit/integer into a basic code point.
	* @see `basicToDigit()`
	* @private
	* @param {Number} digit The numeric value of a basic code point.
	* @returns {Number} The basic code point whose value (when used for
	* representing integers) is `digit`, which needs to be in the range
	* `0` to `base - 1`. If `flag` is non-zero, the uppercase form is
	* used; else, the lowercase form is used. The behavior is undefined
	* if `flag` is non-zero and `digit` has no uppercase form.
	*/
	const digitToBasic = function(digit, flag) {
		return digit + 22 + 75 * (digit < 26) - ((flag != 0) << 5);
	};
	/**
	* Bias adaptation function as per section 3.4 of RFC 3492.
	* https://tools.ietf.org/html/rfc3492#section-3.4
	* @private
	*/
	const adapt = function(delta, numPoints, firstTime) {
		let k = 0;
		delta = firstTime ? floor(delta / damp) : delta >> 1;
		delta += floor(delta / numPoints);
		for (; delta > 455; k += base) delta = floor(delta / baseMinusTMin);
		return floor(k + 36 * delta / (delta + skew));
	};
	/**
	* Converts a Punycode string of ASCII-only symbols to a string of Unicode
	* symbols.
	* @memberOf punycode
	* @param {String} input The Punycode string of ASCII-only symbols.
	* @returns {String} The resulting string of Unicode symbols.
	*/
	const decode = function(input) {
		const output = [];
		const inputLength = input.length;
		let i = 0;
		let n = initialN;
		let bias = initialBias;
		let basic = input.lastIndexOf(delimiter);
		if (basic < 0) basic = 0;
		for (let j = 0; j < basic; ++j) {
			if (input.charCodeAt(j) >= 128) error("not-basic");
			output.push(input.charCodeAt(j));
		}
		for (let index = basic > 0 ? basic + 1 : 0; index < inputLength;) {
			const oldi = i;
			for (let w = 1, k = base;; k += base) {
				if (index >= inputLength) error("invalid-input");
				const digit = basicToDigit(input.charCodeAt(index++));
				if (digit >= base) error("invalid-input");
				if (digit > floor((maxInt - i) / w)) error("overflow");
				i += digit * w;
				const t = k <= bias ? tMin : k >= bias + tMax ? tMax : k - bias;
				if (digit < t) break;
				const baseMinusT = base - t;
				if (w > floor(maxInt / baseMinusT)) error("overflow");
				w *= baseMinusT;
			}
			const out = output.length + 1;
			bias = adapt(i - oldi, out, oldi == 0);
			if (floor(i / out) > maxInt - n) error("overflow");
			n += floor(i / out);
			i %= out;
			output.splice(i++, 0, n);
		}
		return String.fromCodePoint(...output);
	};
	/**
	* Converts a string of Unicode symbols (e.g. a domain name label) to a
	* Punycode string of ASCII-only symbols.
	* @memberOf punycode
	* @param {String} input The string of Unicode symbols.
	* @returns {String} The resulting Punycode string of ASCII-only symbols.
	*/
	const encode = function(input) {
		const output = [];
		input = ucs2decode(input);
		const inputLength = input.length;
		let n = initialN;
		let delta = 0;
		let bias = initialBias;
		for (const currentValue of input) if (currentValue < 128) output.push(stringFromCharCode(currentValue));
		const basicLength = output.length;
		let handledCPCount = basicLength;
		if (basicLength) output.push(delimiter);
		while (handledCPCount < inputLength) {
			let m = maxInt;
			for (const currentValue of input) if (currentValue >= n && currentValue < m) m = currentValue;
			const handledCPCountPlusOne = handledCPCount + 1;
			if (m - n > floor((maxInt - delta) / handledCPCountPlusOne)) error("overflow");
			delta += (m - n) * handledCPCountPlusOne;
			n = m;
			for (const currentValue of input) {
				if (currentValue < n && ++delta > maxInt) error("overflow");
				if (currentValue === n) {
					let q = delta;
					for (let k = base;; k += base) {
						const t = k <= bias ? tMin : k >= bias + tMax ? tMax : k - bias;
						if (q < t) break;
						const qMinusT = q - t;
						const baseMinusT = base - t;
						output.push(stringFromCharCode(digitToBasic(t + qMinusT % baseMinusT, 0)));
						q = floor(qMinusT / baseMinusT);
					}
					output.push(stringFromCharCode(digitToBasic(q, 0)));
					bias = adapt(delta, handledCPCountPlusOne, handledCPCount === basicLength);
					delta = 0;
					++handledCPCount;
				}
			}
			++delta;
			++n;
		}
		return output.join("");
	};
	/**
	* Converts a Punycode string representing a domain name or an email address
	* to Unicode. Only the Punycoded parts of the input will be converted, i.e.
	* it doesn't matter if you call it on a string that has already been
	* converted to Unicode.
	* @memberOf punycode
	* @param {String} input The Punycoded domain name or email address to
	* convert to Unicode.
	* @returns {String} The Unicode representation of the given Punycode
	* string.
	*/
	const toUnicode = function(input) {
		return mapDomain(input, function(string) {
			return regexPunycode.test(string) ? decode(string.slice(4).toLowerCase()) : string;
		});
	};
	/**
	* Converts a Unicode string representing a domain name or an email address to
	* Punycode. Only the non-ASCII parts of the domain name will be converted,
	* i.e. it doesn't matter if you call it with a domain that's already in
	* ASCII.
	* @memberOf punycode
	* @param {String} input The domain name or email address to convert, as a
	* Unicode string.
	* @returns {String} The Punycode representation of the given domain name or
	* email address.
	*/
	const toASCII = function(input) {
		return mapDomain(input, function(string) {
			return regexNonASCII.test(string) ? "xn--" + encode(string) : string;
		});
	};
	module.exports = {
		/**
		* A string representing the current Punycode.js version number.
		* @memberOf punycode
		* @type String
		*/
		version: "2.3.1",
		/**
		* An object of methods to convert from JavaScript's internal character
		* representation (UCS-2) to Unicode code points, and back.
		* @see <https://mathiasbynens.be/notes/javascript-encoding>
		* @memberOf punycode
		* @type Object
		*/
		ucs2: {
			decode: ucs2decode,
			encode: ucs2encode
		},
		decode,
		encode,
		toASCII,
		toUnicode
	};
}));
//#endregion
//#region node_modules/nodemailer/lib/base64/index.js
var require_base64 = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const Transform$7 = __require("stream").Transform;
	/**
	* Encodes a Buffer into a base64 encoded string
	*
	* @param {Buffer} buffer Buffer to convert
	* @returns {String} base64 encoded string
	*/
	function encode(buffer) {
		if (typeof buffer === "string") buffer = Buffer.from(buffer, "utf-8");
		return buffer.toString("base64");
	}
	/**
	* Adds soft line breaks to a base64 string
	*
	* @param {String} str base64 encoded string that might need line wrapping
	* @param {Number} [lineLength=76] Maximum allowed length for a line
	* @returns {String} Soft-wrapped base64 encoded string
	*/
	function wrap(str, lineLength) {
		str = (str || "").toString();
		lineLength = lineLength || 76;
		if (str.length <= lineLength) return str;
		let result = [];
		let pos = 0;
		let chunkLength = lineLength * 1024;
		while (pos < str.length) {
			let wrappedLines = str.substr(pos, chunkLength).replace(new RegExp(".{" + lineLength + "}", "g"), "$&\r\n");
			result.push(wrappedLines);
			pos += chunkLength;
		}
		return result.join("");
	}
	/**
	* Creates a transform stream for encoding data to base64 encoding
	*
	* @constructor
	* @param {Object} options Stream options
	* @param {Number} [options.lineLength=76] Maximum length for lines, set to false to disable wrapping
	*/
	var Encoder = class extends Transform$7 {
		constructor(options) {
			super();
			this.options = options || {};
			if (this.options.lineLength !== false) this.options.lineLength = this.options.lineLength || 76;
			this._curLine = "";
			this._remainingBytes = false;
			this.inputBytes = 0;
			this.outputBytes = 0;
		}
		_transform(chunk, encoding, done) {
			if (encoding !== "buffer") chunk = Buffer.from(chunk, encoding);
			if (!chunk || !chunk.length) return setImmediate(done);
			this.inputBytes += chunk.length;
			if (this._remainingBytes && this._remainingBytes.length) {
				chunk = Buffer.concat([this._remainingBytes, chunk], this._remainingBytes.length + chunk.length);
				this._remainingBytes = false;
			}
			if (chunk.length % 3) {
				this._remainingBytes = chunk.slice(chunk.length - chunk.length % 3);
				chunk = chunk.slice(0, chunk.length - chunk.length % 3);
			} else this._remainingBytes = false;
			let b64 = this._curLine + encode(chunk);
			if (this.options.lineLength) {
				b64 = wrap(b64, this.options.lineLength);
				let lastLF = b64.lastIndexOf("\n");
				if (lastLF < 0) {
					this._curLine = b64;
					b64 = "";
				} else {
					this._curLine = b64.substring(lastLF + 1);
					b64 = b64.substring(0, lastLF + 1);
					if (b64 && !b64.endsWith("\r\n")) b64 += "\r\n";
				}
			} else this._curLine = "";
			if (b64) {
				this.outputBytes += b64.length;
				this.push(Buffer.from(b64, "ascii"));
			}
			setImmediate(done);
		}
		_flush(done) {
			if (this._remainingBytes && this._remainingBytes.length) this._curLine += encode(this._remainingBytes);
			if (this._curLine) {
				this.outputBytes += this._curLine.length;
				this.push(Buffer.from(this._curLine, "ascii"));
				this._curLine = "";
			}
			done();
		}
	};
	module.exports = {
		encode,
		wrap,
		Encoder
	};
}));
//#endregion
//#region node_modules/nodemailer/lib/qp/index.js
var require_qp = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const Transform$6 = __require("stream").Transform;
	/**
	* Encodes a Buffer into a Quoted-Printable encoded string
	*
	* @param {Buffer} buffer Buffer to convert
	* @returns {String} Quoted-Printable encoded string
	*/
	function encode(buffer) {
		if (typeof buffer === "string") buffer = Buffer.from(buffer, "utf-8");
		let ranges = [
			[9],
			[10],
			[13],
			[32, 60],
			[62, 126]
		];
		let result = "";
		let ord;
		for (let i = 0, len = buffer.length; i < len; i++) {
			ord = buffer[i];
			if (checkRanges(ord, ranges) && !((ord === 32 || ord === 9) && (i === len - 1 || buffer[i + 1] === 10 || buffer[i + 1] === 13))) {
				result += String.fromCharCode(ord);
				continue;
			}
			result += "=" + (ord < 16 ? "0" : "") + ord.toString(16).toUpperCase();
		}
		return result;
	}
	/**
	* Adds soft line breaks to a Quoted-Printable string
	*
	* @param {String} str Quoted-Printable encoded string that might need line wrapping
	* @param {Number} [lineLength=76] Maximum allowed length for a line
	* @returns {String} Soft-wrapped Quoted-Printable encoded string
	*/
	function wrap(str, lineLength) {
		str = (str || "").toString();
		lineLength = lineLength || 76;
		if (str.length <= lineLength) return str;
		let pos = 0;
		let len = str.length;
		let match, code, line;
		let lineMargin = Math.floor(lineLength / 3);
		let result = "";
		while (pos < len) {
			line = str.substr(pos, lineLength);
			if (match = line.match(/\r\n/)) {
				line = line.substr(0, match.index + match[0].length);
				result += line;
				pos += line.length;
				continue;
			}
			if (line.substr(-1) === "\n") {
				result += line;
				pos += line.length;
				continue;
			} else if (match = line.substr(-lineMargin).match(/\n.*?$/)) {
				line = line.substr(0, line.length - (match[0].length - 1));
				result += line;
				pos += line.length;
				continue;
			} else if (line.length > lineLength - lineMargin && (match = line.substr(-lineMargin).match(/[ \t.,!?][^ \t.,!?]*$/))) line = line.substr(0, line.length - (match[0].length - 1));
			else if (line.match(/[=][\da-f]{0,2}$/i)) {
				if (match = line.match(/[=][\da-f]{0,1}$/i)) line = line.substr(0, line.length - match[0].length);
				while (line.length > 3 && line.length < len - pos && !line.match(/^(?:=[\da-f]{2}){1,4}$/i) && (match = line.match(/[=][\da-f]{2}$/gi))) {
					code = parseInt(match[0].substr(1, 2), 16);
					if (code < 128) break;
					line = line.substr(0, line.length - 3);
					if (code >= 192) break;
				}
			}
			if (pos + line.length < len && line.substr(-1) !== "\n") {
				if (line.length === lineLength && line.match(/[=][\da-f]{2}$/i)) line = line.substr(0, line.length - 3);
				else if (line.length === lineLength) line = line.substr(0, line.length - 1);
				pos += line.length;
				line += "=\r\n";
			} else pos += line.length;
			result += line;
		}
		return result;
	}
	/**
	* Helper function to check if a number is inside provided ranges
	*
	* @param {Number} nr Number to check for
	* @param {Array} ranges An Array of allowed values
	* @returns {Boolean} True if the value was found inside allowed ranges, false otherwise
	*/
	function checkRanges(nr, ranges) {
		for (let i = ranges.length - 1; i >= 0; i--) {
			if (!ranges[i].length) continue;
			if (ranges[i].length === 1 && nr === ranges[i][0]) return true;
			if (ranges[i].length === 2 && nr >= ranges[i][0] && nr <= ranges[i][1]) return true;
		}
		return false;
	}
	/**
	* Creates a transform stream for encoding data to Quoted-Printable encoding
	*
	* @constructor
	* @param {Object} options Stream options
	* @param {Number} [options.lineLength=76] Maximum length for lines, set to false to disable wrapping
	*/
	var Encoder = class extends Transform$6 {
		constructor(options) {
			super();
			this.options = options || {};
			if (this.options.lineLength !== false) this.options.lineLength = this.options.lineLength || 76;
			this._curLine = "";
			this.inputBytes = 0;
			this.outputBytes = 0;
		}
		_transform(chunk, encoding, done) {
			let qp;
			if (encoding !== "buffer") chunk = Buffer.from(chunk, encoding);
			if (!chunk || !chunk.length) return done();
			this.inputBytes += chunk.length;
			if (this.options.lineLength) {
				qp = this._curLine + encode(chunk);
				qp = wrap(qp, this.options.lineLength);
				qp = qp.replace(/(^|\n)([^\n]*)$/, (match, lineBreak, lastLine) => {
					this._curLine = lastLine;
					return lineBreak;
				});
				if (qp) {
					this.outputBytes += qp.length;
					this.push(qp);
				}
			} else {
				qp = encode(chunk);
				this.outputBytes += qp.length;
				this.push(qp, "ascii");
			}
			done();
		}
		_flush(done) {
			if (this._curLine) {
				this.outputBytes += this._curLine.length;
				this.push(this._curLine, "ascii");
			}
			done();
		}
	};
	module.exports = {
		encode,
		wrap,
		Encoder
	};
}));
//#endregion
//#region node_modules/nodemailer/lib/mime-funcs/index.js
var require_mime_funcs = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const base64 = require_base64();
	const qp = require_qp();
	const mimeTypes = require_mime_types();
	module.exports = {
		/**
		* Checks if a value is plaintext string (uses only printable 7bit chars)
		*
		* @param {String} value String to be tested
		* @returns {Boolean} true if it is a plaintext string
		*/
		isPlainText(value, isParam) {
			if (typeof value !== "string" || (isParam ? /[\x00-\x08\x0b\x0c\x0e-\x1f"\u0080-\uFFFF]/ : /[\x00-\x08\x0b\x0c\x0e-\x1f\u0080-\uFFFF]/).test(value)) return false;
			else return true;
		},
		/**
		* Checks if a multi line string containes lines longer than the selected value.
		*
		* Useful when detecting if a mail message needs any processing at all –
		* if only plaintext characters are used and lines are short, then there is
		* no need to encode the values in any way. If the value is plaintext but has
		* longer lines then allowed, then use format=flowed
		*
		* @param {Number} lineLength Max line length to check for
		* @returns {Boolean} Returns true if there is at least one line longer than lineLength chars
		*/
		hasLongerLines(str, lineLength) {
			if (str.length > 128 * 1024) return true;
			return new RegExp("^.{" + (lineLength + 1) + ",}", "m").test(str);
		},
		/**
		* Encodes a string or an Buffer to an UTF-8 MIME Word (rfc2047)
		*
		* @param {String|Buffer} data String to be encoded
		* @param {String} mimeWordEncoding='Q' Encoding for the mime word, either Q or B
		* @param {Number} [maxLength=0] If set, split mime words into several chunks if needed
		* @return {String} Single or several mime words joined together
		*/
		encodeWord(data, mimeWordEncoding, maxLength) {
			mimeWordEncoding = (mimeWordEncoding || "Q").toString().toUpperCase().trim().charAt(0);
			maxLength = maxLength || 0;
			let encodedStr;
			if (maxLength && maxLength > 12) maxLength -= 12;
			if (mimeWordEncoding === "Q") encodedStr = qp.encode(data).replace(/[^a-z0-9!*+\-/=]/gi, (chr) => {
				let ord = chr.charCodeAt(0).toString(16).toUpperCase();
				if (chr === " ") return "_";
				else return "=" + (ord.length === 1 ? "0" + ord : ord);
			});
			else if (mimeWordEncoding === "B") {
				encodedStr = typeof data === "string" ? data : base64.encode(data);
				maxLength = maxLength ? Math.max(3, (maxLength - maxLength % 4) / 4 * 3) : 0;
			}
			if (maxLength && (mimeWordEncoding !== "B" ? encodedStr : base64.encode(data)).length > maxLength) if (mimeWordEncoding === "Q") encodedStr = this.splitMimeEncodedString(encodedStr, maxLength).join("?= =?UTF-8?" + mimeWordEncoding + "?");
			else {
				let parts = [];
				let lpart = "";
				for (let i = 0, len = encodedStr.length; i < len; i++) {
					let chr = encodedStr.charAt(i);
					if (/[\ud83c\ud83d\ud83e]/.test(chr) && i < len - 1) chr += encodedStr.charAt(++i);
					if (Buffer.byteLength(lpart + chr) <= maxLength || i === 0) lpart += chr;
					else {
						parts.push(base64.encode(lpart));
						lpart = chr;
					}
				}
				if (lpart) parts.push(base64.encode(lpart));
				if (parts.length > 1) encodedStr = parts.join("?= =?UTF-8?" + mimeWordEncoding + "?");
				else encodedStr = parts.join("");
			}
			else if (mimeWordEncoding === "B") encodedStr = base64.encode(data);
			return "=?UTF-8?" + mimeWordEncoding + "?" + encodedStr + (encodedStr.substr(-2) === "?=" ? "" : "?=");
		},
		/**
		* Finds word sequences with non ascii text and converts these to mime words
		*
		* @param {String} value String to be encoded
		* @param {String} mimeWordEncoding='Q' Encoding for the mime word, either Q or B
		* @param {Number} [maxLength=0] If set, split mime words into several chunks if needed
		* @param {Boolean} [encodeAll=false] If true and the value needs encoding then encodes entire string, not just the smallest match
		* @return {String} String with possible mime words
		*/
		encodeWords(value, mimeWordEncoding, maxLength, encodeAll) {
			maxLength = maxLength || 0;
			let encodedValue;
			let firstMatch = value.match(/(?:^|\s)([^\s]*["\u0080-\uFFFF])/);
			if (!firstMatch) return value;
			if (encodeAll) return this.encodeWord(value, mimeWordEncoding, maxLength);
			let lastMatch = value.match(/(["\u0080-\uFFFF][^\s]*)[^"\u0080-\uFFFF]*$/);
			if (!lastMatch) return value;
			let startIndex = firstMatch.index + (firstMatch[0].match(/[^\s]/) || { index: 0 }).index;
			let endIndex = lastMatch.index + (lastMatch[1] || "").length;
			encodedValue = (startIndex ? value.substr(0, startIndex) : "") + this.encodeWord(value.substring(startIndex, endIndex), mimeWordEncoding || "Q", maxLength) + (endIndex < value.length ? value.substr(endIndex) : "");
			return encodedValue;
		},
		/**
		* Joins parsed header value together as 'value; param1=value1; param2=value2'
		* PS: We are following RFC 822 for the list of special characters that we need to keep in quotes.
		*      Refer: https://www.w3.org/Protocols/rfc1341/4_Content-Type.html
		* @param {Object} structured Parsed header value
		* @return {String} joined header value
		*/
		buildHeaderValue(structured) {
			let paramsArray = [];
			Object.keys(structured.params || {}).forEach((param) => {
				let value = structured.params[param];
				if (!this.isPlainText(value, true) || value.length >= 75) this.buildHeaderParam(param, value, 50).forEach((encodedParam) => {
					if (!/[\s"\\;:/=(),<>@[\]?]|^[-']|'$/.test(encodedParam.value) || encodedParam.key.substr(-1) === "*") paramsArray.push(encodedParam.key + "=" + encodedParam.value);
					else paramsArray.push(encodedParam.key + "=" + JSON.stringify(encodedParam.value));
				});
				else if (/[\s'"\\;:/=(),<>@[\]?]|^-/.test(value)) paramsArray.push(param + "=" + JSON.stringify(value));
				else paramsArray.push(param + "=" + value);
			});
			return structured.value + (paramsArray.length ? "; " + paramsArray.join("; ") : "");
		},
		/**
		* Encodes a string or an Buffer to an UTF-8 Parameter Value Continuation encoding (rfc2231)
		* Useful for splitting long parameter values.
		*
		* For example
		*      title="unicode string"
		* becomes
		*     title*0*=utf-8''unicode
		*     title*1*=%20string
		*
		* @param {String|Buffer} data String to be encoded
		* @param {Number} [maxLength=50] Max length for generated chunks
		* @param {String} [fromCharset='UTF-8'] Source sharacter set
		* @return {Array} A list of encoded keys and headers
		*/
		buildHeaderParam(key, data, maxLength) {
			let list = [];
			let encodedStr = typeof data === "string" ? data : (data || "").toString();
			let encodedStrArr;
			let chr, ord;
			let line;
			let startPos = 0;
			let i, len;
			maxLength = maxLength || 50;
			if (this.isPlainText(data, true)) {
				if (encodedStr.length <= maxLength) return [{
					key,
					value: encodedStr
				}];
				encodedStr = encodedStr.replace(new RegExp(".{" + maxLength + "}", "g"), (str) => {
					list.push({ line: str });
					return "";
				});
				if (encodedStr) list.push({ line: encodedStr });
			} else {
				if (/[\uD800-\uDBFF]/.test(encodedStr)) {
					encodedStrArr = [];
					for (i = 0, len = encodedStr.length; i < len; i++) {
						chr = encodedStr.charAt(i);
						ord = chr.charCodeAt(0);
						if (ord >= 55296 && ord <= 56319 && i < len - 1) {
							chr += encodedStr.charAt(i + 1);
							encodedStrArr.push(chr);
							i++;
						} else encodedStrArr.push(chr);
					}
					encodedStr = encodedStrArr;
				}
				line = "utf-8''";
				let encoded = true;
				startPos = 0;
				for (i = 0, len = encodedStr.length; i < len; i++) {
					chr = encodedStr[i];
					if (encoded) chr = this.safeEncodeURIComponent(chr);
					else {
						chr = chr === " " ? chr : this.safeEncodeURIComponent(chr);
						if (chr !== encodedStr[i]) if ((this.safeEncodeURIComponent(line) + chr).length >= maxLength) {
							list.push({
								line,
								encoded
							});
							line = "";
							startPos = i - 1;
						} else {
							encoded = true;
							i = startPos;
							line = "";
							continue;
						}
					}
					if ((line + chr).length >= maxLength) {
						list.push({
							line,
							encoded
						});
						line = chr = encodedStr[i] === " " ? " " : this.safeEncodeURIComponent(encodedStr[i]);
						if (chr === encodedStr[i]) {
							encoded = false;
							startPos = i - 1;
						} else encoded = true;
					} else line += chr;
				}
				if (line) list.push({
					line,
					encoded
				});
			}
			return list.map((item, i) => ({
				key: key + "*" + i + (item.encoded ? "*" : ""),
				value: item.line
			}));
		},
		/**
		* Parses a header value with key=value arguments into a structured
		* object.
		*
		*   parseHeaderValue('content-type: text/plain; CHARSET='UTF-8'') ->
		*   {
		*     'value': 'text/plain',
		*     'params': {
		*       'charset': 'UTF-8'
		*     }
		*   }
		*
		* @param {String} str Header value
		* @return {Object} Header value as a parsed structure
		*/
		parseHeaderValue(str) {
			let response = {
				value: false,
				params: {}
			};
			let key = false;
			let value = "";
			let type = "value";
			let quote = false;
			let escaped = false;
			let chr;
			for (let i = 0, len = str.length; i < len; i++) {
				chr = str.charAt(i);
				if (type === "key") {
					if (chr === "=") {
						key = value.trim().toLowerCase();
						type = "value";
						value = "";
						continue;
					}
					value += chr;
				} else {
					if (escaped) value += chr;
					else if (chr === "\\") {
						escaped = true;
						continue;
					} else if (quote && chr === quote) quote = false;
					else if (!quote && chr === "\"") quote = chr;
					else if (!quote && chr === ";") {
						if (key === false) response.value = value.trim();
						else response.params[key] = value.trim();
						type = "key";
						value = "";
					} else value += chr;
					escaped = false;
				}
			}
			if (type === "value") if (key === false) response.value = value.trim();
			else response.params[key] = value.trim();
			else if (value.trim()) response.params[value.trim().toLowerCase()] = "";
			Object.keys(response.params).forEach((key) => {
				let actualKey, nr, match, value;
				if (match = key.match(/(\*(\d+)|\*(\d+)\*|\*)$/)) {
					actualKey = key.substr(0, match.index);
					nr = Number(match[2] || match[3]) || 0;
					if (!response.params[actualKey] || typeof response.params[actualKey] !== "object") response.params[actualKey] = {
						charset: false,
						values: []
					};
					value = response.params[key];
					if (nr === 0 && match[0].substr(-1) === "*" && (match = value.match(/^([^']*)'[^']*'(.*)$/))) {
						response.params[actualKey].charset = match[1] || "iso-8859-1";
						value = match[2];
					}
					response.params[actualKey].values[nr] = value;
					delete response.params[key];
				}
			});
			Object.keys(response.params).forEach((key) => {
				let value;
				if (response.params[key] && Array.isArray(response.params[key].values)) {
					value = response.params[key].values.map((val) => val || "").join("");
					if (response.params[key].charset) response.params[key] = "=?" + response.params[key].charset + "?Q?" + value.replace(/[=?_\s]/g, (s) => {
						let c = s.charCodeAt(0).toString(16);
						if (s === " ") return "_";
						else return "%" + (c.length < 2 ? "0" : "") + c;
					}).replace(/%/g, "=") + "?=";
					else response.params[key] = value;
				}
			});
			return response;
		},
		/**
		* Returns file extension for a content type string. If no suitable extensions
		* are found, 'bin' is used as the default extension
		*
		* @param {String} mimeType Content type to be checked for
		* @return {String} File extension
		*/
		detectExtension: (mimeType) => mimeTypes.detectExtension(mimeType),
		/**
		* Returns content type for a file extension. If no suitable content types
		* are found, 'application/octet-stream' is used as the default content type
		*
		* @param {String} extension Extension to be checked for
		* @return {String} File extension
		*/
		detectMimeType: (extension) => mimeTypes.detectMimeType(extension),
		/**
		* Folds long lines, useful for folding header lines (afterSpace=false) and
		* flowed text (afterSpace=true)
		*
		* @param {String} str String to be folded
		* @param {Number} [lineLength=76] Maximum length of a line
		* @param {Boolean} afterSpace If true, leave a space in th end of a line
		* @return {String} String with folded lines
		*/
		foldLines(str, lineLength, afterSpace) {
			str = (str || "").toString();
			lineLength = lineLength || 76;
			let pos = 0, len = str.length, result = "", line, match;
			while (pos < len) {
				line = str.substr(pos, lineLength);
				if (line.length < lineLength) {
					result += line;
					break;
				}
				if (match = line.match(/^[^\n\r]*(\r?\n|\r)/)) {
					line = match[0];
					result += line;
					pos += line.length;
					continue;
				} else if ((match = line.match(/(\s+)[^\s]*$/)) && match[0].length - (afterSpace ? (match[1] || "").length : 0) < line.length) line = line.substr(0, line.length - (match[0].length - (afterSpace ? (match[1] || "").length : 0)));
				else if (match = str.substr(pos + line.length).match(/^[^\s]+(\s*)/)) line = line + match[0].substr(0, match[0].length - (!afterSpace ? (match[1] || "").length : 0));
				result += line;
				pos += line.length;
				if (pos < len) result += "\r\n";
			}
			return result;
		},
		/**
		* Splits a mime encoded string. Needed for dividing mime words into smaller chunks
		*
		* @param {String} str Mime encoded string to be split up
		* @param {Number} maxlen Maximum length of characters for one part (minimum 12)
		* @return {Array} Split string
		*/
		splitMimeEncodedString: (str, maxlen) => {
			let curLine, match, chr, done, lines = [];
			maxlen = Math.max(maxlen || 0, 12);
			while (str.length) {
				curLine = str.substr(0, maxlen);
				if (match = curLine.match(/[=][0-9A-F]?$/i)) curLine = curLine.substr(0, match.index);
				done = false;
				while (!done) {
					done = true;
					if (match = str.substr(curLine.length).match(/^[=]([0-9A-F]{2})/i)) {
						chr = parseInt(match[1], 16);
						if (chr < 194 && chr > 127) {
							curLine = curLine.substr(0, curLine.length - 3);
							done = false;
						}
					}
				}
				if (curLine.length) lines.push(curLine);
				str = str.substr(curLine.length);
			}
			return lines;
		},
		encodeURICharComponent: (chr) => {
			let res = "";
			let ord = chr.charCodeAt(0).toString(16).toUpperCase();
			if (ord.length % 2) ord = "0" + ord;
			if (ord.length > 2) for (let i = 0, len = ord.length / 2; i < len; i++) res += "%" + ord.substr(i, 2);
			else res += "%" + ord;
			return res;
		},
		safeEncodeURIComponent(str) {
			str = (str || "").toString();
			try {
				str = encodeURIComponent(str);
			} catch (_E) {
				return str.replace(/[^\x00-\x1F *'()<>@,;:\\"[\]?=\u007F-\uFFFF]+/g, "");
			}
			return str.replace(/[\x00-\x1F *'()<>@,;:\\"[\]?=\u007F-\uFFFF]/g, (chr) => this.encodeURICharComponent(chr));
		}
	};
}));
//#endregion
//#region node_modules/nodemailer/lib/addressparser/index.js
var require_addressparser = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	/**
	* Converts tokens for a single address into an address object
	*
	* @param {Array} tokens Tokens object
	* @param {Number} depth Current recursion depth for nested group protection
	* @return {Object} Address object
	*/
	function _handleAddress(tokens, depth) {
		let isGroup = false;
		let state = "text";
		let address;
		let addresses = [];
		let data = {
			address: [],
			comment: [],
			group: [],
			text: [],
			textWasQuoted: []
		};
		let i;
		let len;
		let insideQuotes = false;
		for (i = 0, len = tokens.length; i < len; i++) {
			let token = tokens[i];
			let prevToken = i ? tokens[i - 1] : null;
			if (token.type === "operator") switch (token.value) {
				case "<":
					state = "address";
					insideQuotes = false;
					break;
				case "(":
					state = "comment";
					insideQuotes = false;
					break;
				case ":":
					state = "group";
					isGroup = true;
					insideQuotes = false;
					break;
				case "\"":
					insideQuotes = !insideQuotes;
					state = "text";
					break;
				default:
					state = "text";
					insideQuotes = false;
					break;
			}
			else if (token.value) {
				if (state === "address") token.value = token.value.replace(/^[^<]*<\s*/, "");
				if (prevToken && prevToken.noBreak && data[state].length) {
					data[state][data[state].length - 1] += token.value;
					if (state === "text" && insideQuotes) data.textWasQuoted[data.textWasQuoted.length - 1] = true;
				} else {
					data[state].push(token.value);
					if (state === "text") data.textWasQuoted.push(insideQuotes);
				}
			}
		}
		if (!data.text.length && data.comment.length) {
			data.text = data.comment;
			data.comment = [];
		}
		if (isGroup) {
			data.text = data.text.join(" ");
			let groupMembers = [];
			if (data.group.length) addressparser(data.group.join(","), { _depth: depth + 1 }).forEach((member) => {
				if (member.group) groupMembers = groupMembers.concat(member.group);
				else groupMembers.push(member);
			});
			addresses.push({
				name: data.text || address && address.name,
				group: groupMembers
			});
		} else {
			if (!data.address.length && data.text.length) {
				for (i = data.text.length - 1; i >= 0; i--) if (!data.textWasQuoted[i] && data.text[i].match(/^[^@\s]+@[^@\s]+$/)) {
					data.address = data.text.splice(i, 1);
					data.textWasQuoted.splice(i, 1);
					break;
				}
				let _regexHandler = function(address) {
					if (!data.address.length) {
						data.address = [address.trim()];
						return " ";
					} else return address;
				};
				if (!data.address.length) {
					for (i = data.text.length - 1; i >= 0; i--) if (!data.textWasQuoted[i]) {
						data.text[i] = data.text[i].replace(/\s*\b[^@\s]+@[^\s]+\b\s*/, _regexHandler).trim();
						if (data.address.length) break;
					}
				}
			}
			if (!data.text.length && data.comment.length) {
				data.text = data.comment;
				data.comment = [];
			}
			if (data.address.length > 1) data.text = data.text.concat(data.address.splice(1));
			data.text = data.text.join(" ");
			data.address = data.address.join(" ");
			if (!data.address && isGroup) return [];
			else {
				address = {
					address: data.address || data.text || "",
					name: data.text || data.address || ""
				};
				if (address.address === address.name) if ((address.address || "").match(/@/)) address.name = "";
				else address.address = "";
				addresses.push(address);
			}
		}
		return addresses;
	}
	/**
	* Creates a Tokenizer object for tokenizing address field strings
	*
	* @constructor
	* @param {String} str Address field string
	*/
	var Tokenizer = class {
		constructor(str) {
			this.str = (str || "").toString();
			this.operatorCurrent = "";
			this.operatorExpecting = "";
			this.node = null;
			this.escaped = false;
			this.list = [];
			/**
			* Operator tokens and which tokens are expected to end the sequence
			*/
			this.operators = {
				"\"": "\"",
				"(": ")",
				"<": ">",
				",": "",
				":": ";",
				";": ""
			};
		}
		/**
		* Tokenizes the original input string
		*
		* @return {Array} An array of operator|text tokens
		*/
		tokenize() {
			let list = [];
			for (let i = 0, len = this.str.length; i < len; i++) {
				let chr = this.str.charAt(i);
				let nextChr = i < len - 1 ? this.str.charAt(i + 1) : null;
				this.checkChar(chr, nextChr);
			}
			this.list.forEach((node) => {
				node.value = (node.value || "").toString().trim();
				if (node.value) list.push(node);
			});
			return list;
		}
		/**
		* Checks if a character is an operator or text and acts accordingly
		*
		* @param {String} chr Character from the address field
		*/
		checkChar(chr, nextChr) {
			if (this.escaped) {} else if (chr === this.operatorExpecting) {
				this.node = {
					type: "operator",
					value: chr
				};
				if (nextChr && ![
					" ",
					"	",
					"\r",
					"\n",
					",",
					";"
				].includes(nextChr)) this.node.noBreak = true;
				this.list.push(this.node);
				this.node = null;
				this.operatorExpecting = "";
				this.escaped = false;
				return;
			} else if (!this.operatorExpecting && chr in this.operators) {
				this.node = {
					type: "operator",
					value: chr
				};
				this.list.push(this.node);
				this.node = null;
				this.operatorExpecting = this.operators[chr];
				this.escaped = false;
				return;
			} else if (["\"", "'"].includes(this.operatorExpecting) && chr === "\\") {
				this.escaped = true;
				return;
			}
			if (!this.node) {
				this.node = {
					type: "text",
					value: ""
				};
				this.list.push(this.node);
			}
			if (chr === "\n") chr = " ";
			if (chr.charCodeAt(0) >= 33 || [" ", "	"].includes(chr)) this.node.value += chr;
			this.escaped = false;
		}
	};
	/**
	* Maximum recursion depth for parsing nested groups.
	* RFC 5322 doesn't allow nested groups, so this is a safeguard against
	* malicious input that could cause stack overflow.
	*/
	const MAX_NESTED_GROUP_DEPTH = 50;
	/**
	* Parses structured e-mail addresses from an address field
	*
	* Example:
	*
	*    'Name <address@domain>'
	*
	* will be converted to
	*
	*     [{name: 'Name', address: 'address@domain'}]
	*
	* @param {String} str Address field
	* @param {Object} options Optional options object
	* @param {Number} options._depth Internal recursion depth counter (do not set manually)
	* @return {Array} An array of address objects
	*/
	function addressparser(str, options) {
		options = options || {};
		let depth = options._depth || 0;
		if (depth > MAX_NESTED_GROUP_DEPTH) return [];
		let tokens = new Tokenizer(str).tokenize();
		let addresses = [];
		let address = [];
		let parsedAddresses = [];
		tokens.forEach((token) => {
			if (token.type === "operator" && (token.value === "," || token.value === ";")) {
				if (address.length) addresses.push(address);
				address = [];
			} else address.push(token);
		});
		if (address.length) addresses.push(address);
		addresses.forEach((address) => {
			address = _handleAddress(address, depth);
			if (address.length) parsedAddresses = parsedAddresses.concat(address);
		});
		if (options.flatten) {
			let addresses = [];
			let walkAddressList = (list) => {
				list.forEach((address) => {
					if (address.group) return walkAddressList(address.group);
					else addresses.push(address);
				});
			};
			walkAddressList(parsedAddresses);
			return addresses;
		}
		return parsedAddresses;
	}
	module.exports = addressparser;
}));
//#endregion
//#region node_modules/nodemailer/lib/mime-node/last-newline.js
var require_last_newline = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const Transform$5 = __require("stream").Transform;
	var LastNewline = class extends Transform$5 {
		constructor() {
			super();
			this.lastByte = false;
		}
		_transform(chunk, encoding, done) {
			if (chunk.length) this.lastByte = chunk[chunk.length - 1];
			this.push(chunk);
			done();
		}
		_flush(done) {
			if (this.lastByte === 10) return done();
			if (this.lastByte === 13) {
				this.push(Buffer.from("\n"));
				return done();
			}
			this.push(Buffer.from("\r\n"));
			return done();
		}
	};
	module.exports = LastNewline;
}));
//#endregion
//#region node_modules/nodemailer/lib/mime-node/le-windows.js
var require_le_windows = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const Transform$4 = __require("stream").Transform;
	/**
	* Ensures that only <CR><LF> sequences are used for linebreaks
	*
	* @param {Object} options Stream options
	*/
	var LeWindows = class extends Transform$4 {
		constructor(options) {
			super(options);
			this.options = options || {};
			this.lastByte = false;
		}
		/**
		* Escapes dots
		*/
		_transform(chunk, encoding, done) {
			let buf;
			let lastPos = 0;
			for (let i = 0, len = chunk.length; i < len; i++) if (chunk[i] === 10) {
				if (i && chunk[i - 1] !== 13 || !i && this.lastByte !== 13) {
					if (i > lastPos) {
						buf = chunk.slice(lastPos, i);
						this.push(buf);
					}
					this.push(Buffer.from("\r\n"));
					lastPos = i + 1;
				}
			}
			if (lastPos && lastPos < chunk.length) {
				buf = chunk.slice(lastPos);
				this.push(buf);
			} else if (!lastPos) this.push(chunk);
			this.lastByte = chunk[chunk.length - 1];
			done();
		}
	};
	module.exports = LeWindows;
}));
//#endregion
//#region node_modules/nodemailer/lib/mime-node/le-unix.js
var require_le_unix = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const Transform$3 = __require("stream").Transform;
	/**
	* Ensures that only <LF> is used for linebreaks
	*
	* @param {Object} options Stream options
	*/
	var LeWindows = class extends Transform$3 {
		constructor(options) {
			super(options);
			this.options = options || {};
		}
		/**
		* Escapes dots
		*/
		_transform(chunk, encoding, done) {
			let buf;
			let lastPos = 0;
			for (let i = 0, len = chunk.length; i < len; i++) if (chunk[i] === 13) {
				buf = chunk.slice(lastPos, i);
				lastPos = i + 1;
				this.push(buf);
			}
			if (lastPos && lastPos < chunk.length) {
				buf = chunk.slice(lastPos);
				this.push(buf);
			} else if (!lastPos) this.push(chunk);
			done();
		}
	};
	module.exports = LeWindows;
}));
//#endregion
//#region node_modules/nodemailer/lib/mime-node/index.js
var require_mime_node = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const crypto$6 = __require("crypto");
	const fs$1 = __require("fs");
	const punycode = require_punycode();
	const PassThrough$2 = __require("stream").PassThrough;
	const shared = require_shared();
	const mimeFuncs = require_mime_funcs();
	const qp = require_qp();
	const base64 = require_base64();
	const addressparser = require_addressparser();
	const nmfetch = require_fetch();
	const LastNewline = require_last_newline();
	const LeWindows = require_le_windows();
	const LeUnix = require_le_unix();
	module.exports = class MimeNode {
		constructor(contentType, options) {
			this.nodeCounter = 0;
			options = options || {};
			/**
			* shared part of the unique multipart boundary
			*/
			this.baseBoundary = options.baseBoundary || crypto$6.randomBytes(8).toString("hex");
			this.boundaryPrefix = options.boundaryPrefix || "--_NmP";
			this.disableFileAccess = !!options.disableFileAccess;
			this.disableUrlAccess = !!options.disableUrlAccess;
			this.normalizeHeaderKey = options.normalizeHeaderKey;
			/**
			* If date headers is missing and current node is the root, this value is used instead
			*/
			this.date = /* @__PURE__ */ new Date();
			/**
			* Root node for current mime tree
			*/
			this.rootNode = options.rootNode || this;
			/**
			* If true include Bcc in generated headers (if available)
			*/
			this.keepBcc = !!options.keepBcc;
			/**
			* If filename is specified but contentType is not (probably an attachment)
			* detect the content type from filename extension
			*/
			if (options.filename) {
				/**
				* Filename for this node. Useful with attachments
				*/
				this.filename = options.filename;
				if (!contentType) contentType = mimeFuncs.detectMimeType(this.filename.split(".").pop());
			}
			/**
			* Indicates which encoding should be used for header strings: "Q" or "B"
			*/
			this.textEncoding = (options.textEncoding || "").toString().trim().charAt(0).toUpperCase();
			/**
			* Immediate parent for this node (or undefined if not set)
			*/
			this.parentNode = options.parentNode;
			/**
			* Hostname for default message-id values
			*/
			this.hostname = options.hostname;
			/**
			* If set to 'win' then uses \r\n, if 'linux' then \n. If not set (or `raw` is used) then newlines are kept as is.
			*/
			this.newline = options.newline;
			/**
			* An array for possible child nodes
			*/
			this.childNodes = [];
			/**
			* Used for generating unique boundaries (prepended to the shared base)
			*/
			this._nodeId = ++this.rootNode.nodeCounter;
			/**
			* A list of header values for this node in the form of [{key:'', value:''}]
			*/
			this._headers = [];
			/**
			* True if the content only uses ASCII printable characters
			* @type {Boolean}
			*/
			this._isPlainText = false;
			/**
			* True if the content is plain text but has longer lines than allowed
			* @type {Boolean}
			*/
			this._hasLongLines = false;
			/**
			* If set, use instead this value for envelopes instead of generating one
			* @type {Boolean}
			*/
			this._envelope = false;
			/**
			* If set then use this value as the stream content instead of building it
			* @type {String|Buffer|Stream}
			*/
			this._raw = false;
			/**
			* Additional transform streams that the message will be piped before
			* exposing by createReadStream
			* @type {Array}
			*/
			this._transforms = [];
			/**
			* Additional process functions that the message will be piped through before
			* exposing by createReadStream. These functions are run after transforms
			* @type {Array}
			*/
			this._processFuncs = [];
			/**
			* If content type is set (or derived from the filename) add it to headers
			*/
			if (contentType) this.setHeader("Content-Type", contentType);
		}
		/**
		* Creates and appends a child node.Arguments provided are passed to MimeNode constructor
		*
		* @param {String} [contentType] Optional content type
		* @param {Object} [options] Optional options object
		* @return {Object} Created node object
		*/
		createChild(contentType, options) {
			if (!options && typeof contentType === "object") {
				options = contentType;
				contentType = void 0;
			}
			let node = new MimeNode(contentType, options);
			this.appendChild(node);
			return node;
		}
		/**
		* Appends an existing node to the mime tree. Removes the node from an existing
		* tree if needed
		*
		* @param {Object} childNode node to be appended
		* @return {Object} Appended node object
		*/
		appendChild(childNode) {
			if (childNode.rootNode !== this.rootNode) {
				childNode.rootNode = this.rootNode;
				childNode._nodeId = ++this.rootNode.nodeCounter;
			}
			childNode.parentNode = this;
			this.childNodes.push(childNode);
			return childNode;
		}
		/**
		* Replaces current node with another node
		*
		* @param {Object} node Replacement node
		* @return {Object} Replacement node
		*/
		replace(node) {
			if (node === this) return this;
			this.parentNode.childNodes.forEach((childNode, i) => {
				if (childNode === this) {
					node.rootNode = this.rootNode;
					node.parentNode = this.parentNode;
					node._nodeId = this._nodeId;
					this.rootNode = this;
					this.parentNode = void 0;
					node.parentNode.childNodes[i] = node;
				}
			});
			return node;
		}
		/**
		* Removes current node from the mime tree
		*
		* @return {Object} removed node
		*/
		remove() {
			if (!this.parentNode) return this;
			for (let i = this.parentNode.childNodes.length - 1; i >= 0; i--) if (this.parentNode.childNodes[i] === this) {
				this.parentNode.childNodes.splice(i, 1);
				this.parentNode = void 0;
				this.rootNode = this;
				return this;
			}
		}
		/**
		* Sets a header value. If the value for selected key exists, it is overwritten.
		* You can set multiple values as well by using [{key:'', value:''}] or
		* {key: 'value'} as the first argument.
		*
		* @param {String|Array|Object} key Header key or a list of key value pairs
		* @param {String} value Header value
		* @return {Object} current node
		*/
		setHeader(key, value) {
			let added = false, headerValue;
			if (!value && key && typeof key === "object") {
				if (key.key && "value" in key) this.setHeader(key.key, key.value);
				else if (Array.isArray(key)) key.forEach((i) => {
					this.setHeader(i.key, i.value);
				});
				else Object.keys(key).forEach((i) => {
					this.setHeader(i, key[i]);
				});
				return this;
			}
			key = this._normalizeHeaderKey(key);
			headerValue = {
				key,
				value
			};
			for (let i = 0, len = this._headers.length; i < len; i++) if (this._headers[i].key === key) if (!added) {
				this._headers[i] = headerValue;
				added = true;
			} else {
				this._headers.splice(i, 1);
				i--;
				len--;
			}
			if (!added) this._headers.push(headerValue);
			return this;
		}
		/**
		* Adds a header value. If the value for selected key exists, the value is appended
		* as a new field and old one is not touched.
		* You can set multiple values as well by using [{key:'', value:''}] or
		* {key: 'value'} as the first argument.
		*
		* @param {String|Array|Object} key Header key or a list of key value pairs
		* @param {String} value Header value
		* @return {Object} current node
		*/
		addHeader(key, value) {
			if (!value && key && typeof key === "object") {
				if (key.key && key.value) this.addHeader(key.key, key.value);
				else if (Array.isArray(key)) key.forEach((i) => {
					this.addHeader(i.key, i.value);
				});
				else Object.keys(key).forEach((i) => {
					this.addHeader(i, key[i]);
				});
				return this;
			} else if (Array.isArray(value)) {
				value.forEach((val) => {
					this.addHeader(key, val);
				});
				return this;
			}
			this._headers.push({
				key: this._normalizeHeaderKey(key),
				value
			});
			return this;
		}
		/**
		* Retrieves the first mathcing value of a selected key
		*
		* @param {String} key Key to search for
		* @retun {String} Value for the key
		*/
		getHeader(key) {
			key = this._normalizeHeaderKey(key);
			for (let i = 0, len = this._headers.length; i < len; i++) if (this._headers[i].key === key) return this._headers[i].value;
		}
		/**
		* Sets body content for current node. If the value is a string, charset is added automatically
		* to Content-Type (if it is text/*). If the value is a Buffer, you need to specify
		* the charset yourself
		*
		* @param (String|Buffer) content Body content
		* @return {Object} current node
		*/
		setContent(content) {
			this.content = content;
			if (typeof this.content.pipe === "function") {
				this._contentErrorHandler = (err) => {
					this.content.removeListener("error", this._contentErrorHandler);
					this.content = err;
				};
				this.content.once("error", this._contentErrorHandler);
			} else if (typeof this.content === "string") {
				this._isPlainText = mimeFuncs.isPlainText(this.content);
				if (this._isPlainText && mimeFuncs.hasLongerLines(this.content, 76)) this._hasLongLines = true;
			}
			return this;
		}
		build(callback) {
			let promise;
			if (!callback) promise = new Promise((resolve, reject) => {
				callback = shared.callbackPromise(resolve, reject);
			});
			let stream = this.createReadStream();
			let buf = [];
			let buflen = 0;
			let returned = false;
			stream.on("readable", () => {
				let chunk;
				while ((chunk = stream.read()) !== null) {
					buf.push(chunk);
					buflen += chunk.length;
				}
			});
			stream.once("error", (err) => {
				if (returned) return;
				returned = true;
				return callback(err);
			});
			stream.once("end", (chunk) => {
				if (returned) return;
				returned = true;
				if (chunk && chunk.length) {
					buf.push(chunk);
					buflen += chunk.length;
				}
				return callback(null, Buffer.concat(buf, buflen));
			});
			return promise;
		}
		getTransferEncoding() {
			let transferEncoding = false;
			let contentType = (this.getHeader("Content-Type") || "").toString().toLowerCase().trim();
			if (this.content) {
				transferEncoding = (this.getHeader("Content-Transfer-Encoding") || "").toString().toLowerCase().trim();
				if (!transferEncoding || !["base64", "quoted-printable"].includes(transferEncoding)) {
					if (/^text\//i.test(contentType)) if (this._isPlainText && !this._hasLongLines) transferEncoding = "7bit";
					else if (typeof this.content === "string" || this.content instanceof Buffer) transferEncoding = this._getTextEncoding(this.content) === "Q" ? "quoted-printable" : "base64";
					else transferEncoding = this.textEncoding === "B" ? "base64" : "quoted-printable";
					else if (!/^(multipart|message)\//i.test(contentType)) transferEncoding = transferEncoding || "base64";
				}
			}
			return transferEncoding;
		}
		/**
		* Builds the header block for the mime node. Append \r\n\r\n before writing the content
		*
		* @returns {String} Headers
		*/
		buildHeaders() {
			let transferEncoding = this.getTransferEncoding();
			let headers = [];
			if (transferEncoding) this.setHeader("Content-Transfer-Encoding", transferEncoding);
			if (this.filename && !this.getHeader("Content-Disposition")) this.setHeader("Content-Disposition", "attachment");
			if (this.rootNode === this) {
				if (!this.getHeader("Date")) this.setHeader("Date", this.date.toUTCString().replace(/GMT/, "+0000"));
				this.messageId();
				if (!this.getHeader("MIME-Version")) this.setHeader("MIME-Version", "1.0");
				for (let i = this._headers.length - 2; i >= 0; i--) {
					let header = this._headers[i];
					if (header.key === "Content-Type") {
						this._headers.splice(i, 1);
						this._headers.push(header);
					}
				}
			}
			this._headers.forEach((header) => {
				let key = header.key;
				let value = header.value;
				let structured;
				let param;
				let options = {};
				if (value && typeof value === "object" && ![
					"From",
					"Sender",
					"To",
					"Cc",
					"Bcc",
					"Reply-To",
					"Date",
					"References"
				].includes(key)) {
					Object.keys(value).forEach((key) => {
						if (key !== "value") options[key] = value[key];
					});
					value = (value.value || "").toString();
					if (!value.trim()) return;
				}
				if (options.prepared) {
					if (options.foldLines) headers.push(mimeFuncs.foldLines(key + ": " + value));
					else headers.push(key + ": " + value);
					return;
				}
				switch (header.key) {
					case "Content-Disposition":
						structured = mimeFuncs.parseHeaderValue(value);
						if (this.filename) structured.params.filename = this.filename;
						value = mimeFuncs.buildHeaderValue(structured);
						break;
					case "Content-Type":
						structured = mimeFuncs.parseHeaderValue(value);
						this._handleContentType(structured);
						if (structured.value.match(/^text\/plain\b/) && typeof this.content === "string" && /[\u0080-\uFFFF]/.test(this.content)) structured.params.charset = "utf-8";
						value = mimeFuncs.buildHeaderValue(structured);
						if (this.filename) {
							param = this._encodeWords(this.filename);
							if (param !== this.filename || /[\s'"\\;:/=(),<>@[\]?]|^-/.test(param)) param = "\"" + param + "\"";
							value += "; name=" + param;
						}
						break;
					case "Bcc":
						if (!this.keepBcc) return;
						break;
				}
				value = this._encodeHeaderValue(key, value);
				if (!(value || "").toString().trim()) return;
				if (typeof this.normalizeHeaderKey === "function") {
					let normalized = this.normalizeHeaderKey(key, value);
					if (normalized && typeof normalized === "string" && normalized.length) key = normalized;
				}
				headers.push(mimeFuncs.foldLines(key + ": " + value, 76));
			});
			return headers.join("\r\n");
		}
		/**
		* Streams the rfc2822 message from the current node. If this is a root node,
		* mandatory header fields are set if missing (Date, Message-Id, MIME-Version)
		*
		* @return {String} Compiled message
		*/
		createReadStream(options) {
			options = options || {};
			let stream = new PassThrough$2(options);
			let outputStream = stream;
			let transform;
			this.stream(stream, options, (err) => {
				if (err) {
					outputStream.emit("error", err);
					return;
				}
				stream.end();
			});
			for (let i = 0, len = this._transforms.length; i < len; i++) {
				transform = typeof this._transforms[i] === "function" ? this._transforms[i]() : this._transforms[i];
				outputStream.once("error", (err) => {
					transform.emit("error", err);
				});
				outputStream = outputStream.pipe(transform);
			}
			transform = new LastNewline();
			outputStream.once("error", (err) => {
				transform.emit("error", err);
			});
			outputStream = outputStream.pipe(transform);
			for (let i = 0, len = this._processFuncs.length; i < len; i++) {
				transform = this._processFuncs[i];
				outputStream = transform(outputStream);
			}
			if (this.newline) {
				const newlineTransform = [
					"win",
					"windows",
					"dos",
					"\r\n"
				].includes(this.newline.toString().toLowerCase()) ? new LeWindows() : new LeUnix();
				const stream = outputStream.pipe(newlineTransform);
				outputStream.on("error", (err) => stream.emit("error", err));
				return stream;
			}
			return outputStream;
		}
		/**
		* Appends a transform stream object to the transforms list. Final output
		* is passed through this stream before exposing
		*
		* @param {Object} transform Read-Write stream
		*/
		transform(transform) {
			this._transforms.push(transform);
		}
		/**
		* Appends a post process function. The functon is run after transforms and
		* uses the following syntax
		*
		*   processFunc(input) -> outputStream
		*
		* @param {Object} processFunc Read-Write stream
		*/
		processFunc(processFunc) {
			this._processFuncs.push(processFunc);
		}
		stream(outputStream, options, done) {
			let transferEncoding = this.getTransferEncoding();
			let contentStream;
			let localStream;
			let returned = false;
			let callback = (err) => {
				if (returned) return;
				returned = true;
				done(err);
			};
			let finalize = () => {
				let childId = 0;
				let processChildNode = () => {
					if (childId >= this.childNodes.length) {
						outputStream.write("\r\n--" + this.boundary + "--\r\n");
						return callback();
					}
					let child = this.childNodes[childId++];
					outputStream.write((childId > 1 ? "\r\n" : "") + "--" + this.boundary + "\r\n");
					child.stream(outputStream, options, (err) => {
						if (err) return callback(err);
						setImmediate(processChildNode);
					});
				};
				if (this.multipart) setImmediate(processChildNode);
				else return callback();
			};
			let sendContent = () => {
				if (this.content) {
					if (Object.prototype.toString.call(this.content) === "[object Error]") return callback(this.content);
					if (typeof this.content.pipe === "function") {
						this.content.removeListener("error", this._contentErrorHandler);
						this._contentErrorHandler = (err) => callback(err);
						this.content.once("error", this._contentErrorHandler);
					}
					let createStream = () => {
						if (["quoted-printable", "base64"].includes(transferEncoding)) {
							contentStream = new (transferEncoding === "base64" ? base64 : qp).Encoder(options);
							contentStream.pipe(outputStream, { end: false });
							contentStream.once("end", finalize);
							contentStream.once("error", (err) => callback(err));
							localStream = this._getStream(this.content);
							localStream.pipe(contentStream);
						} else {
							localStream = this._getStream(this.content);
							localStream.pipe(outputStream, { end: false });
							localStream.once("end", finalize);
						}
						localStream.once("error", (err) => callback(err));
					};
					if (this.content._resolve) {
						let chunks = [];
						let chunklen = 0;
						let returned = false;
						let sourceStream = this._getStream(this.content);
						sourceStream.on("error", (err) => {
							if (returned) return;
							returned = true;
							callback(err);
						});
						sourceStream.on("readable", () => {
							let chunk;
							while ((chunk = sourceStream.read()) !== null) {
								chunks.push(chunk);
								chunklen += chunk.length;
							}
						});
						sourceStream.on("end", () => {
							if (returned) return;
							returned = true;
							this.content._resolve = false;
							this.content._resolvedValue = Buffer.concat(chunks, chunklen);
							setImmediate(createStream);
						});
					} else setImmediate(createStream);
					return;
				} else return setImmediate(finalize);
			};
			if (this._raw) setImmediate(() => {
				if (Object.prototype.toString.call(this._raw) === "[object Error]") return callback(this._raw);
				if (typeof this._raw.pipe === "function") this._raw.removeListener("error", this._contentErrorHandler);
				let raw = this._getStream(this._raw);
				raw.pipe(outputStream, { end: false });
				raw.on("error", (err) => outputStream.emit("error", err));
				raw.on("end", finalize);
			});
			else {
				outputStream.write(this.buildHeaders() + "\r\n\r\n");
				setImmediate(sendContent);
			}
		}
		/**
		* Sets envelope to be used instead of the generated one
		*
		* @return {Object} SMTP envelope in the form of {from: 'from@example.com', to: ['to@example.com']}
		*/
		setEnvelope(envelope) {
			let list;
			this._envelope = {
				from: false,
				to: []
			};
			if (envelope.from) {
				list = [];
				this._convertAddresses(this._parseAddresses(envelope.from), list);
				list = list.filter((address) => address && address.address);
				if (list.length && list[0]) this._envelope.from = list[0].address;
			}
			[
				"to",
				"cc",
				"bcc"
			].forEach((key) => {
				if (envelope[key]) this._convertAddresses(this._parseAddresses(envelope[key]), this._envelope.to);
			});
			this._envelope.to = this._envelope.to.map((to) => to.address).filter((address) => address);
			let standardFields = [
				"to",
				"cc",
				"bcc",
				"from"
			];
			Object.keys(envelope).forEach((key) => {
				if (!standardFields.includes(key)) this._envelope[key] = envelope[key];
			});
			return this;
		}
		/**
		* Generates and returns an object with parsed address fields
		*
		* @return {Object} Address object
		*/
		getAddresses() {
			let addresses = {};
			this._headers.forEach((header) => {
				let key = header.key.toLowerCase();
				if ([
					"from",
					"sender",
					"reply-to",
					"to",
					"cc",
					"bcc"
				].includes(key)) {
					if (!Array.isArray(addresses[key])) addresses[key] = [];
					this._convertAddresses(this._parseAddresses(header.value), addresses[key]);
				}
			});
			return addresses;
		}
		/**
		* Generates and returns SMTP envelope with the sender address and a list of recipients addresses
		*
		* @return {Object} SMTP envelope in the form of {from: 'from@example.com', to: ['to@example.com']}
		*/
		getEnvelope() {
			if (this._envelope) return this._envelope;
			let envelope = {
				from: false,
				to: []
			};
			this._headers.forEach((header) => {
				let list = [];
				if (header.key === "From" || !envelope.from && ["Reply-To", "Sender"].includes(header.key)) {
					this._convertAddresses(this._parseAddresses(header.value), list);
					if (list.length && list[0]) envelope.from = list[0].address;
				} else if ([
					"To",
					"Cc",
					"Bcc"
				].includes(header.key)) this._convertAddresses(this._parseAddresses(header.value), envelope.to);
			});
			envelope.to = envelope.to.map((to) => to.address);
			return envelope;
		}
		/**
		* Returns Message-Id value. If it does not exist, then creates one
		*
		* @return {String} Message-Id value
		*/
		messageId() {
			let messageId = this.getHeader("Message-ID");
			if (!messageId) {
				messageId = this._generateMessageId();
				this.setHeader("Message-ID", messageId);
			}
			return messageId;
		}
		/**
		* Sets pregenerated content that will be used as the output of this node
		*
		* @param {String|Buffer|Stream} Raw MIME contents
		*/
		setRaw(raw) {
			this._raw = raw;
			if (this._raw && typeof this._raw.pipe === "function") {
				this._contentErrorHandler = (err) => {
					this._raw.removeListener("error", this._contentErrorHandler);
					this._raw = err;
				};
				this._raw.once("error", this._contentErrorHandler);
			}
			return this;
		}
		/**
		* Detects and returns handle to a stream related with the content.
		*
		* @param {Mixed} content Node content
		* @returns {Object} Stream object
		*/
		_getStream(content) {
			let contentStream;
			if (content._resolvedValue) {
				contentStream = new PassThrough$2();
				setImmediate(() => {
					try {
						contentStream.end(content._resolvedValue);
					} catch (_err) {
						contentStream.emit("error", _err);
					}
				});
				return contentStream;
			} else if (typeof content.pipe === "function") return content;
			else if (content && typeof content.path === "string" && !content.href) {
				if (this.disableFileAccess) {
					contentStream = new PassThrough$2();
					setImmediate(() => contentStream.emit("error", /* @__PURE__ */ new Error("File access rejected for " + content.path)));
					return contentStream;
				}
				return fs$1.createReadStream(content.path);
			} else if (content && typeof content.href === "string") {
				if (this.disableUrlAccess) {
					contentStream = new PassThrough$2();
					setImmediate(() => contentStream.emit("error", /* @__PURE__ */ new Error("Url access rejected for " + content.href)));
					return contentStream;
				}
				return nmfetch(content.href, { headers: content.httpHeaders });
			} else {
				contentStream = new PassThrough$2();
				setImmediate(() => {
					try {
						contentStream.end(content || "");
					} catch (_err) {
						contentStream.emit("error", _err);
					}
				});
				return contentStream;
			}
		}
		/**
		* Parses addresses. Takes in a single address or an array or an
		* array of address arrays (eg. To: [[first group], [second group],...])
		*
		* @param {Mixed} addresses Addresses to be parsed
		* @return {Array} An array of address objects
		*/
		_parseAddresses(addresses) {
			return [].concat.apply([], [].concat(addresses).map((address) => {
				if (address && address.address) {
					address.address = this._normalizeAddress(address.address);
					address.name = address.name || "";
					return [address];
				}
				return addressparser(address);
			}));
		}
		/**
		* Normalizes a header key, uses Camel-Case form, except for uppercase MIME-
		*
		* @param {String} key Key to be normalized
		* @return {String} key in Camel-Case form
		*/
		_normalizeHeaderKey(key) {
			key = (key || "").toString().replace(/\r?\n|\r/g, " ").trim().toLowerCase().replace(/^X-SMTPAPI$|^(MIME|DKIM|ARC|BIMI)\b|^[a-z]|-(SPF|FBL|ID|MD5)$|-[a-z]/gi, (c) => c.toUpperCase()).replace(/^Content-Features$/i, "Content-features");
			return key;
		}
		/**
		* Checks if the content type is multipart and defines boundary if needed.
		* Doesn't return anything, modifies object argument instead.
		*
		* @param {Object} structured Parsed header value for 'Content-Type' key
		*/
		_handleContentType(structured) {
			this.contentType = structured.value.trim().toLowerCase();
			this.multipart = /^multipart\//i.test(this.contentType) ? this.contentType.substr(this.contentType.indexOf("/") + 1) : false;
			if (this.multipart) this.boundary = structured.params.boundary = structured.params.boundary || this.boundary || this._generateBoundary();
			else this.boundary = false;
		}
		/**
		* Generates a multipart boundary value
		*
		* @return {String} boundary value
		*/
		_generateBoundary() {
			return this.rootNode.boundaryPrefix + "-" + this.rootNode.baseBoundary + "-Part_" + this._nodeId;
		}
		/**
		* Encodes a header value for use in the generated rfc2822 email.
		*
		* @param {String} key Header key
		* @param {String} value Header value
		*/
		_encodeHeaderValue(key, value) {
			key = this._normalizeHeaderKey(key);
			switch (key) {
				case "From":
				case "Sender":
				case "To":
				case "Cc":
				case "Bcc":
				case "Reply-To": return this._convertAddresses(this._parseAddresses(value));
				case "Message-ID":
				case "In-Reply-To":
				case "Content-Id":
					value = (value || "").toString().replace(/\r?\n|\r/g, " ");
					if (value.charAt(0) !== "<") value = "<" + value;
					if (value.charAt(value.length - 1) !== ">") value = value + ">";
					return value;
				case "References":
					value = [].concat.apply([], [].concat(value || "").map((elm) => {
						elm = (elm || "").toString().replace(/\r?\n|\r/g, " ").trim();
						return elm.replace(/<[^>]*>/g, (str) => str.replace(/\s/g, "")).split(/\s+/);
					})).map((elm) => {
						if (elm.charAt(0) !== "<") elm = "<" + elm;
						if (elm.charAt(elm.length - 1) !== ">") elm = elm + ">";
						return elm;
					});
					return value.join(" ").trim();
				case "Date":
					if (Object.prototype.toString.call(value) === "[object Date]") return value.toUTCString().replace(/GMT/, "+0000");
					value = (value || "").toString().replace(/\r?\n|\r/g, " ");
					return this._encodeWords(value);
				case "Content-Type":
				case "Content-Disposition": return (value || "").toString().replace(/\r?\n|\r/g, " ");
				default:
					value = (value || "").toString().replace(/\r?\n|\r/g, " ");
					return this._encodeWords(value);
			}
		}
		/**
		* Rebuilds address object using punycode and other adjustments
		*
		* @param {Array} addresses An array of address objects
		* @param {Array} [uniqueList] An array to be populated with addresses
		* @return {String} address string
		*/
		_convertAddresses(addresses, uniqueList) {
			let values = [];
			uniqueList = uniqueList || [];
			[].concat(addresses || []).forEach((address) => {
				if (address.address) {
					address.address = this._normalizeAddress(address.address);
					if (!address.name) values.push(address.address.indexOf(" ") >= 0 ? `<${address.address}>` : `${address.address}`);
					else if (address.name) values.push(`${this._encodeAddressName(address.name)} <${address.address}>`);
					if (address.address) {
						if (!uniqueList.filter((a) => a.address === address.address).length) uniqueList.push(address);
					}
				} else if (address.group) {
					let groupListAddresses = (address.group.length ? this._convertAddresses(address.group, uniqueList) : "").trim();
					values.push(`${this._encodeAddressName(address.name)}:${groupListAddresses};`);
				}
			});
			return values.join(", ");
		}
		/**
		* Normalizes an email address
		*
		* @param {Array} address An array of address objects
		* @return {String} address string
		*/
		_normalizeAddress(address) {
			address = (address || "").toString().replace(/[\x00-\x1F<>]+/g, " ").trim();
			let lastAt = address.lastIndexOf("@");
			if (lastAt < 0) return address;
			let user = address.substr(0, lastAt);
			let domain = address.substr(lastAt + 1);
			let encodedDomain;
			try {
				encodedDomain = punycode.toASCII(domain.toLowerCase());
			} catch (_err) {}
			if (user.indexOf(" ") >= 0) {
				if (user.charAt(0) !== "\"") user = "\"" + user;
				if (user.substr(-1) !== "\"") user = user + "\"";
			}
			return `${user}@${encodedDomain}`;
		}
		/**
		* If needed, mime encodes the name part
		*
		* @param {String} name Name part of an address
		* @returns {String} Mime word encoded string if needed
		*/
		_encodeAddressName(name) {
			if (!/^[\w ]*$/.test(name)) if (/^[\x20-\x7e]*$/.test(name)) return "\"" + name.replace(/([\\"])/g, "\\$1") + "\"";
			else return mimeFuncs.encodeWord(name, this._getTextEncoding(name), 52);
			return name;
		}
		/**
		* If needed, mime encodes the name part
		*
		* @param {String} name Name part of an address
		* @returns {String} Mime word encoded string if needed
		*/
		_encodeWords(value) {
			return mimeFuncs.encodeWords(value, this._getTextEncoding(value), 52, true);
		}
		/**
		* Detects best mime encoding for a text value
		*
		* @param {String} value Value to check for
		* @return {String} either 'Q' or 'B'
		*/
		_getTextEncoding(value) {
			value = (value || "").toString();
			let encoding = this.textEncoding;
			let latinLen;
			let nonLatinLen;
			if (!encoding) {
				nonLatinLen = (value.match(/[\x00-\x08\x0B\x0C\x0E-\x1F\u0080-\uFFFF]/g) || []).length;
				latinLen = (value.match(/[a-z]/gi) || []).length;
				encoding = nonLatinLen < latinLen ? "Q" : "B";
			}
			return encoding;
		}
		/**
		* Generates a message id
		*
		* @return {String} Random Message-ID value
		*/
		_generateMessageId() {
			return "<" + [
				2,
				2,
				2,
				6
			].reduce((prev, len) => prev + "-" + crypto$6.randomBytes(len).toString("hex"), crypto$6.randomBytes(4).toString("hex")) + "@" + (this.getEnvelope().from || this.hostname || "localhost").split("@").pop() + ">";
		}
	};
}));
//#endregion
//#region node_modules/nodemailer/lib/mail-composer/index.js
var require_mail_composer = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const MimeNode = require_mime_node();
	const mimeFuncs = require_mime_funcs();
	const parseDataURI = require_shared().parseDataURI;
	/**
	* Creates the object for composing a MimeNode instance out from the mail options
	*
	* @constructor
	* @param {Object} mail Mail options
	*/
	var MailComposer = class {
		constructor(mail) {
			this.mail = mail || {};
			this.message = false;
		}
		/**
		* Builds MimeNode instance
		*/
		compile() {
			this._alternatives = this.getAlternatives();
			this._htmlNode = this._alternatives.filter((alternative) => /^text\/html\b/i.test(alternative.contentType)).pop();
			this._attachments = this.getAttachments(!!this._htmlNode);
			this._useRelated = !!(this._htmlNode && this._attachments.related.length);
			this._useAlternative = this._alternatives.length > 1;
			this._useMixed = this._attachments.attached.length > 1 || this._alternatives.length && this._attachments.attached.length === 1;
			if (this.mail.raw) this.message = new MimeNode("message/rfc822", { newline: this.mail.newline }).setRaw(this.mail.raw);
			else if (this._useMixed) this.message = this._createMixed();
			else if (this._useAlternative) this.message = this._createAlternative();
			else if (this._useRelated) this.message = this._createRelated();
			else this.message = this._createContentNode(false, [].concat(this._alternatives || []).concat(this._attachments.attached || []).shift() || {
				contentType: "text/plain",
				content: ""
			});
			if (this.mail.headers) this.message.addHeader(this.mail.headers);
			[
				"from",
				"sender",
				"to",
				"cc",
				"bcc",
				"reply-to",
				"in-reply-to",
				"references",
				"subject",
				"message-id",
				"date"
			].forEach((header) => {
				let key = header.replace(/-(\w)/g, (o, c) => c.toUpperCase());
				if (this.mail[key]) this.message.setHeader(header, this.mail[key]);
			});
			if (this.mail.envelope) this.message.setEnvelope(this.mail.envelope);
			this.message.messageId();
			return this.message;
		}
		/**
		* List all attachments. Resulting attachment objects can be used as input for MimeNode nodes
		*
		* @param {Boolean} findRelated If true separate related attachments from attached ones
		* @returns {Object} An object of arrays (`related` and `attached`)
		*/
		getAttachments(findRelated) {
			let icalEvent, eventObject;
			let attachments = [].concat(this.mail.attachments || []).map((attachment, i) => {
				let data;
				if (/^data:/i.test(attachment.path || attachment.href)) attachment = this._processDataUrl(attachment);
				let contentType = attachment.contentType || mimeFuncs.detectMimeType(attachment.filename || attachment.path || attachment.href || "bin");
				let isImage = /^image\//i.test(contentType);
				let isMessageNode = /^message\//i.test(contentType);
				let contentDisposition = attachment.contentDisposition || (isMessageNode || isImage && attachment.cid ? "inline" : "attachment");
				let contentTransferEncoding;
				if ("contentTransferEncoding" in attachment) contentTransferEncoding = attachment.contentTransferEncoding;
				else if (isMessageNode) contentTransferEncoding = "8bit";
				else contentTransferEncoding = "base64";
				data = {
					contentType,
					contentDisposition,
					contentTransferEncoding
				};
				if (attachment.filename) data.filename = attachment.filename;
				else if (!isMessageNode && attachment.filename !== false) {
					data.filename = (attachment.path || attachment.href || "").split("/").pop().split("?").shift() || "attachment-" + (i + 1);
					if (data.filename.indexOf(".") < 0) data.filename += "." + mimeFuncs.detectExtension(data.contentType);
				}
				if (/^https?:\/\//i.test(attachment.path)) {
					attachment.href = attachment.path;
					attachment.path = void 0;
				}
				if (attachment.cid) data.cid = attachment.cid;
				if (attachment.raw) data.raw = attachment.raw;
				else if (attachment.path) data.content = { path: attachment.path };
				else if (attachment.href) data.content = {
					href: attachment.href,
					httpHeaders: attachment.httpHeaders
				};
				else data.content = attachment.content || "";
				if (attachment.encoding) data.encoding = attachment.encoding;
				if (attachment.headers) data.headers = attachment.headers;
				return data;
			});
			if (this.mail.icalEvent) {
				if (typeof this.mail.icalEvent === "object" && (this.mail.icalEvent.content || this.mail.icalEvent.path || this.mail.icalEvent.href || this.mail.icalEvent.raw)) icalEvent = this.mail.icalEvent;
				else icalEvent = { content: this.mail.icalEvent };
				eventObject = {};
				Object.keys(icalEvent).forEach((key) => {
					eventObject[key] = icalEvent[key];
				});
				eventObject.contentType = "application/ics";
				if (!eventObject.headers) eventObject.headers = {};
				eventObject.filename = eventObject.filename || "invite.ics";
				eventObject.headers["Content-Disposition"] = "attachment";
				eventObject.headers["Content-Transfer-Encoding"] = "base64";
			}
			if (!findRelated) return {
				attached: attachments.concat(eventObject || []),
				related: []
			};
			else return {
				attached: attachments.filter((attachment) => !attachment.cid).concat(eventObject || []),
				related: attachments.filter((attachment) => !!attachment.cid)
			};
		}
		/**
		* List alternatives. Resulting objects can be used as input for MimeNode nodes
		*
		* @returns {Array} An array of alternative elements. Includes the `text` and `html` values as well
		*/
		getAlternatives() {
			let alternatives = [], text, html, watchHtml, amp, icalEvent, eventObject;
			if (this.mail.text) {
				if (typeof this.mail.text === "object" && (this.mail.text.content || this.mail.text.path || this.mail.text.href || this.mail.text.raw)) text = this.mail.text;
				else text = { content: this.mail.text };
				text.contentType = "text/plain; charset=utf-8";
			}
			if (this.mail.watchHtml) {
				if (typeof this.mail.watchHtml === "object" && (this.mail.watchHtml.content || this.mail.watchHtml.path || this.mail.watchHtml.href || this.mail.watchHtml.raw)) watchHtml = this.mail.watchHtml;
				else watchHtml = { content: this.mail.watchHtml };
				watchHtml.contentType = "text/watch-html; charset=utf-8";
			}
			if (this.mail.amp) {
				if (typeof this.mail.amp === "object" && (this.mail.amp.content || this.mail.amp.path || this.mail.amp.href || this.mail.amp.raw)) amp = this.mail.amp;
				else amp = { content: this.mail.amp };
				amp.contentType = "text/x-amp-html; charset=utf-8";
			}
			if (this.mail.icalEvent) {
				if (typeof this.mail.icalEvent === "object" && (this.mail.icalEvent.content || this.mail.icalEvent.path || this.mail.icalEvent.href || this.mail.icalEvent.raw)) icalEvent = this.mail.icalEvent;
				else icalEvent = { content: this.mail.icalEvent };
				eventObject = {};
				Object.keys(icalEvent).forEach((key) => {
					eventObject[key] = icalEvent[key];
				});
				if (eventObject.content && typeof eventObject.content === "object") eventObject.content._resolve = true;
				eventObject.filename = false;
				eventObject.contentType = "text/calendar; charset=utf-8; method=" + (eventObject.method || "PUBLISH").toString().trim().toUpperCase();
				if (!eventObject.headers) eventObject.headers = {};
			}
			if (this.mail.html) {
				if (typeof this.mail.html === "object" && (this.mail.html.content || this.mail.html.path || this.mail.html.href || this.mail.html.raw)) html = this.mail.html;
				else html = { content: this.mail.html };
				html.contentType = "text/html; charset=utf-8";
			}
			[].concat(text || []).concat(watchHtml || []).concat(amp || []).concat(html || []).concat(eventObject || []).concat(this.mail.alternatives || []).forEach((alternative) => {
				let data;
				if (/^data:/i.test(alternative.path || alternative.href)) alternative = this._processDataUrl(alternative);
				data = {
					contentType: alternative.contentType || mimeFuncs.detectMimeType(alternative.filename || alternative.path || alternative.href || "txt"),
					contentTransferEncoding: alternative.contentTransferEncoding
				};
				if (alternative.filename) data.filename = alternative.filename;
				if (/^https?:\/\//i.test(alternative.path)) {
					alternative.href = alternative.path;
					alternative.path = void 0;
				}
				if (alternative.raw) data.raw = alternative.raw;
				else if (alternative.path) data.content = { path: alternative.path };
				else if (alternative.href) data.content = { href: alternative.href };
				else data.content = alternative.content || "";
				if (alternative.encoding) data.encoding = alternative.encoding;
				if (alternative.headers) data.headers = alternative.headers;
				alternatives.push(data);
			});
			return alternatives;
		}
		/**
		* Builds multipart/mixed node. It should always contain different type of elements on the same level
		* eg. text + attachments
		*
		* @param {Object} parentNode Parent for this note. If it does not exist, a root node is created
		* @returns {Object} MimeNode node element
		*/
		_createMixed(parentNode) {
			let node;
			if (!parentNode) node = new MimeNode("multipart/mixed", {
				baseBoundary: this.mail.baseBoundary,
				textEncoding: this.mail.textEncoding,
				boundaryPrefix: this.mail.boundaryPrefix,
				disableUrlAccess: this.mail.disableUrlAccess,
				disableFileAccess: this.mail.disableFileAccess,
				normalizeHeaderKey: this.mail.normalizeHeaderKey,
				newline: this.mail.newline
			});
			else node = parentNode.createChild("multipart/mixed", {
				disableUrlAccess: this.mail.disableUrlAccess,
				disableFileAccess: this.mail.disableFileAccess,
				normalizeHeaderKey: this.mail.normalizeHeaderKey,
				newline: this.mail.newline
			});
			if (this._useAlternative) this._createAlternative(node);
			else if (this._useRelated) this._createRelated(node);
			[].concat(!this._useAlternative && this._alternatives || []).concat(this._attachments.attached || []).forEach((element) => {
				if (!this._useRelated || element !== this._htmlNode) this._createContentNode(node, element);
			});
			return node;
		}
		/**
		* Builds multipart/alternative node. It should always contain same type of elements on the same level
		* eg. text + html view of the same data
		*
		* @param {Object} parentNode Parent for this note. If it does not exist, a root node is created
		* @returns {Object} MimeNode node element
		*/
		_createAlternative(parentNode) {
			let node;
			if (!parentNode) node = new MimeNode("multipart/alternative", {
				baseBoundary: this.mail.baseBoundary,
				textEncoding: this.mail.textEncoding,
				boundaryPrefix: this.mail.boundaryPrefix,
				disableUrlAccess: this.mail.disableUrlAccess,
				disableFileAccess: this.mail.disableFileAccess,
				normalizeHeaderKey: this.mail.normalizeHeaderKey,
				newline: this.mail.newline
			});
			else node = parentNode.createChild("multipart/alternative", {
				disableUrlAccess: this.mail.disableUrlAccess,
				disableFileAccess: this.mail.disableFileAccess,
				normalizeHeaderKey: this.mail.normalizeHeaderKey,
				newline: this.mail.newline
			});
			this._alternatives.forEach((alternative) => {
				if (this._useRelated && this._htmlNode === alternative) this._createRelated(node);
				else this._createContentNode(node, alternative);
			});
			return node;
		}
		/**
		* Builds multipart/related node. It should always contain html node with related attachments
		*
		* @param {Object} parentNode Parent for this note. If it does not exist, a root node is created
		* @returns {Object} MimeNode node element
		*/
		_createRelated(parentNode) {
			let node;
			if (!parentNode) node = new MimeNode("multipart/related; type=\"text/html\"", {
				baseBoundary: this.mail.baseBoundary,
				textEncoding: this.mail.textEncoding,
				boundaryPrefix: this.mail.boundaryPrefix,
				disableUrlAccess: this.mail.disableUrlAccess,
				disableFileAccess: this.mail.disableFileAccess,
				normalizeHeaderKey: this.mail.normalizeHeaderKey,
				newline: this.mail.newline
			});
			else node = parentNode.createChild("multipart/related; type=\"text/html\"", {
				disableUrlAccess: this.mail.disableUrlAccess,
				disableFileAccess: this.mail.disableFileAccess,
				normalizeHeaderKey: this.mail.normalizeHeaderKey,
				newline: this.mail.newline
			});
			this._createContentNode(node, this._htmlNode);
			this._attachments.related.forEach((alternative) => this._createContentNode(node, alternative));
			return node;
		}
		/**
		* Creates a regular node with contents
		*
		* @param {Object} parentNode Parent for this note. If it does not exist, a root node is created
		* @param {Object} element Node data
		* @returns {Object} MimeNode node element
		*/
		_createContentNode(parentNode, element) {
			element = element || {};
			element.content = element.content || "";
			let node;
			let encoding = (element.encoding || "utf8").toString().toLowerCase().replace(/[-_\s]/g, "");
			if (!parentNode) node = new MimeNode(element.contentType, {
				filename: element.filename,
				baseBoundary: this.mail.baseBoundary,
				textEncoding: this.mail.textEncoding,
				boundaryPrefix: this.mail.boundaryPrefix,
				disableUrlAccess: this.mail.disableUrlAccess,
				disableFileAccess: this.mail.disableFileAccess,
				normalizeHeaderKey: this.mail.normalizeHeaderKey,
				newline: this.mail.newline
			});
			else node = parentNode.createChild(element.contentType, {
				filename: element.filename,
				textEncoding: this.mail.textEncoding,
				disableUrlAccess: this.mail.disableUrlAccess,
				disableFileAccess: this.mail.disableFileAccess,
				normalizeHeaderKey: this.mail.normalizeHeaderKey,
				newline: this.mail.newline
			});
			if (element.headers) node.addHeader(element.headers);
			if (element.cid) node.setHeader("Content-Id", "<" + element.cid.replace(/[<>]/g, "") + ">");
			if (element.contentTransferEncoding) node.setHeader("Content-Transfer-Encoding", element.contentTransferEncoding);
			else if (this.mail.encoding && /^text\//i.test(element.contentType)) node.setHeader("Content-Transfer-Encoding", this.mail.encoding);
			if (!/^text\//i.test(element.contentType) || element.contentDisposition) node.setHeader("Content-Disposition", element.contentDisposition || (element.cid && /^image\//i.test(element.contentType) ? "inline" : "attachment"));
			if (typeof element.content === "string" && ![
				"utf8",
				"usascii",
				"ascii"
			].includes(encoding)) element.content = Buffer.from(element.content, encoding);
			if (element.raw) node.setRaw(element.raw);
			else node.setContent(element.content);
			return node;
		}
		/**
		* Parses data uri and converts it to a Buffer
		*
		* @param {Object} element Content element
		* @return {Object} Parsed element
		*/
		_processDataUrl(element) {
			const dataUrl = element.path || element.href;
			if (!dataUrl || typeof dataUrl !== "string") return element;
			if (!dataUrl.startsWith("data:")) return element;
			if (dataUrl.length > 52428800) {
				let detectedType = "application/octet-stream";
				const commaPos = dataUrl.indexOf(",");
				if (commaPos > 0 && commaPos < 200) {
					const parts = dataUrl.substring(5, commaPos).split(";");
					if (parts[0] && parts[0].includes("/")) detectedType = parts[0].trim();
				}
				return Object.assign({}, element, {
					path: false,
					href: false,
					content: Buffer.alloc(0),
					contentType: element.contentType || detectedType
				});
			}
			let parsedDataUri;
			try {
				parsedDataUri = parseDataURI(dataUrl);
			} catch (_err) {
				return element;
			}
			if (!parsedDataUri) return element;
			element.content = parsedDataUri.data;
			element.contentType = element.contentType || parsedDataUri.contentType;
			if ("path" in element) element.path = false;
			if ("href" in element) element.href = false;
			return element;
		}
	};
	module.exports = MailComposer;
}));
//#endregion
//#region node_modules/nodemailer/lib/dkim/message-parser.js
var require_message_parser = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const Transform$2 = __require("stream").Transform;
	/**
	* MessageParser instance is a transform stream that separates message headers
	* from the rest of the body. Headers are emitted with the 'headers' event. Message
	* body is passed on as the resulting stream.
	*/
	var MessageParser = class extends Transform$2 {
		constructor(options) {
			super(options);
			this.lastBytes = Buffer.alloc(4);
			this.headersParsed = false;
			this.headerBytes = 0;
			this.headerChunks = [];
			this.rawHeaders = false;
			this.bodySize = 0;
		}
		/**
		* Keeps count of the last 4 bytes in order to detect line breaks on chunk boundaries
		*
		* @param {Buffer} data Next data chunk from the stream
		*/
		updateLastBytes(data) {
			let lblen = this.lastBytes.length;
			let nblen = Math.min(data.length, lblen);
			for (let i = 0, len = lblen - nblen; i < len; i++) this.lastBytes[i] = this.lastBytes[i + nblen];
			for (let i = 1; i <= nblen; i++) this.lastBytes[lblen - i] = data[data.length - i];
		}
		/**
		* Finds and removes message headers from the remaining body. We want to keep
		* headers separated until final delivery to be able to modify these
		*
		* @param {Buffer} data Next chunk of data
		* @return {Boolean} Returns true if headers are already found or false otherwise
		*/
		checkHeaders(data) {
			if (this.headersParsed) return true;
			let lblen = this.lastBytes.length;
			let headerPos = 0;
			this.curLinePos = 0;
			for (let i = 0, len = this.lastBytes.length + data.length; i < len; i++) {
				let chr;
				if (i < lblen) chr = this.lastBytes[i];
				else chr = data[i - lblen];
				if (chr === 10 && i) {
					let pr1 = i - 1 < lblen ? this.lastBytes[i - 1] : data[i - 1 - lblen];
					let pr2 = i > 1 ? i - 2 < lblen ? this.lastBytes[i - 2] : data[i - 2 - lblen] : false;
					if (pr1 === 10) {
						this.headersParsed = true;
						headerPos = i - lblen + 1;
						this.headerBytes += headerPos;
						break;
					} else if (pr1 === 13 && pr2 === 10) {
						this.headersParsed = true;
						headerPos = i - lblen + 1;
						this.headerBytes += headerPos;
						break;
					}
				}
			}
			if (this.headersParsed) {
				this.headerChunks.push(data.slice(0, headerPos));
				this.rawHeaders = Buffer.concat(this.headerChunks, this.headerBytes);
				this.headerChunks = null;
				this.emit("headers", this.parseHeaders());
				if (data.length - 1 > headerPos) {
					let chunk = data.slice(headerPos);
					this.bodySize += chunk.length;
					setImmediate(() => this.push(chunk));
				}
				return false;
			} else {
				this.headerBytes += data.length;
				this.headerChunks.push(data);
			}
			this.updateLastBytes(data);
			return false;
		}
		_transform(chunk, encoding, callback) {
			if (!chunk || !chunk.length) return callback();
			if (typeof chunk === "string") chunk = Buffer.from(chunk, encoding);
			let headersFound;
			try {
				headersFound = this.checkHeaders(chunk);
			} catch (E) {
				return callback(E);
			}
			if (headersFound) {
				this.bodySize += chunk.length;
				this.push(chunk);
			}
			setImmediate(callback);
		}
		_flush(callback) {
			if (this.headerChunks) {
				let chunk = Buffer.concat(this.headerChunks, this.headerBytes);
				this.bodySize += chunk.length;
				this.push(chunk);
				this.headerChunks = null;
			}
			callback();
		}
		parseHeaders() {
			let lines = (this.rawHeaders || "").toString().split(/\r?\n/);
			for (let i = lines.length - 1; i > 0; i--) if (/^\s/.test(lines[i])) {
				lines[i - 1] += "\n" + lines[i];
				lines.splice(i, 1);
			}
			return lines.filter((line) => line.trim()).map((line) => ({
				key: line.substr(0, line.indexOf(":")).trim().toLowerCase(),
				line
			}));
		}
	};
	module.exports = MessageParser;
}));
//#endregion
//#region node_modules/nodemailer/lib/dkim/relaxed-body.js
var require_relaxed_body = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const Transform$1 = __require("stream").Transform;
	const crypto$5 = __require("crypto");
	var RelaxedBody = class extends Transform$1 {
		constructor(options) {
			super();
			options = options || {};
			this.chunkBuffer = [];
			this.chunkBufferLen = 0;
			this.bodyHash = crypto$5.createHash(options.hashAlgo || "sha1");
			this.remainder = "";
			this.byteLength = 0;
			this.debug = options.debug;
			this._debugBody = options.debug ? [] : false;
		}
		updateHash(chunk) {
			let bodyStr;
			let nextRemainder = "";
			let state = "file";
			for (let i = chunk.length - 1; i >= 0; i--) {
				let c = chunk[i];
				if (state === "file" && (c === 10 || c === 13)) {} else if (state === "file" && (c === 9 || c === 32)) state = "line";
				else if (state === "line" && (c === 9 || c === 32)) {} else if (state === "file" || state === "line") {
					state = "body";
					if (i === chunk.length - 1) break;
				}
				if (i === 0) {
					if (state === "file" && (!this.remainder || /[\r\n]$/.test(this.remainder)) || state === "line" && (!this.remainder || /[ \t]$/.test(this.remainder))) {
						this.remainder += chunk.toString("binary");
						return;
					} else if (state === "line" || state === "file") {
						nextRemainder = chunk.toString("binary");
						chunk = false;
						break;
					}
				}
				if (state !== "body") continue;
				nextRemainder = chunk.slice(i + 1).toString("binary");
				chunk = chunk.slice(0, i + 1);
				break;
			}
			let needsFixing = !!this.remainder;
			if (chunk && !needsFixing) {
				for (let i = 0, len = chunk.length; i < len; i++) if (i && chunk[i] === 10 && chunk[i - 1] !== 13) {
					needsFixing = true;
					break;
				} else if (i && chunk[i] === 13 && chunk[i - 1] === 32) {
					needsFixing = true;
					break;
				} else if (i && chunk[i] === 32 && chunk[i - 1] === 32) {
					needsFixing = true;
					break;
				} else if (chunk[i] === 9) {
					needsFixing = true;
					break;
				}
			}
			if (needsFixing) {
				bodyStr = this.remainder + (chunk ? chunk.toString("binary") : "");
				this.remainder = nextRemainder;
				bodyStr = bodyStr.replace(/\r?\n/g, "\n").replace(/[ \t]*$/gm, "").replace(/[ \t]+/gm, " ").replace(/\n/g, "\r\n");
				chunk = Buffer.from(bodyStr, "binary");
			} else if (nextRemainder) this.remainder = nextRemainder;
			if (this.debug) this._debugBody.push(chunk);
			this.bodyHash.update(chunk);
		}
		_transform(chunk, encoding, callback) {
			if (!chunk || !chunk.length) return callback();
			if (typeof chunk === "string") chunk = Buffer.from(chunk, encoding);
			this.updateHash(chunk);
			this.byteLength += chunk.length;
			this.push(chunk);
			callback();
		}
		_flush(callback) {
			if (/[\r\n]$/.test(this.remainder) && this.byteLength > 2) this.bodyHash.update(Buffer.from("\r\n"));
			if (!this.byteLength) this.push(Buffer.from("\r\n"));
			this.emit("hash", this.bodyHash.digest("base64"), this.debug ? Buffer.concat(this._debugBody) : false);
			callback();
		}
	};
	module.exports = RelaxedBody;
}));
//#endregion
//#region node_modules/nodemailer/lib/dkim/sign.js
var require_sign = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const punycode = require_punycode();
	const mimeFuncs = require_mime_funcs();
	const crypto$4 = __require("crypto");
	/**
	* Returns DKIM signature header line
	*
	* @param {Object} headers Parsed headers object from MessageParser
	* @param {String} bodyHash Base64 encoded hash of the message
	* @param {Object} options DKIM options
	* @param {String} options.domainName Domain name to be signed for
	* @param {String} options.keySelector DKIM key selector to use
	* @param {String} options.privateKey DKIM private key to use
	* @return {String} Complete header line
	*/
	module.exports = (headers, hashAlgo, bodyHash, options) => {
		options = options || {};
		let canonicalizedHeaderData = relaxedHeaders(headers, options.headerFieldNames || "From:Sender:Reply-To:Subject:Date:Message-ID:To:Cc:MIME-Version:Content-Type:Content-Transfer-Encoding:Content-ID:Content-Description:Resent-Date:Resent-From:Resent-Sender:Resent-To:Resent-Cc:Resent-Message-ID:In-Reply-To:References:List-Id:List-Help:List-Unsubscribe:List-Subscribe:List-Post:List-Owner:List-Archive", options.skipFields);
		let dkimHeader = generateDKIMHeader(options.domainName, options.keySelector, canonicalizedHeaderData.fieldNames, hashAlgo, bodyHash);
		let signer, signature;
		canonicalizedHeaderData.headers += "dkim-signature:" + relaxedHeaderLine(dkimHeader);
		signer = crypto$4.createSign(("rsa-" + hashAlgo).toUpperCase());
		signer.update(canonicalizedHeaderData.headers);
		try {
			signature = signer.sign(options.privateKey, "base64");
		} catch (_E) {
			return false;
		}
		return dkimHeader + signature.replace(/(^.{73}|.{75}(?!\r?\n|\r))/g, "$&\r\n ").trim();
	};
	module.exports.relaxedHeaders = relaxedHeaders;
	function generateDKIMHeader(domainName, keySelector, fieldNames, hashAlgo, bodyHash) {
		let dkim = [
			"v=1",
			"a=rsa-" + hashAlgo,
			"c=relaxed/relaxed",
			"d=" + punycode.toASCII(domainName),
			"q=dns/txt",
			"s=" + keySelector,
			"bh=" + bodyHash,
			"h=" + fieldNames
		].join("; ");
		return mimeFuncs.foldLines("DKIM-Signature: " + dkim, 76) + ";\r\n b=";
	}
	function relaxedHeaders(headers, fieldNames, skipFields) {
		let includedFields = /* @__PURE__ */ new Set();
		let skip = /* @__PURE__ */ new Set();
		let headerFields = /* @__PURE__ */ new Map();
		(skipFields || "").toLowerCase().split(":").forEach((field) => {
			skip.add(field.trim());
		});
		(fieldNames || "").toLowerCase().split(":").filter((field) => !skip.has(field.trim())).forEach((field) => {
			includedFields.add(field.trim());
		});
		for (let i = headers.length - 1; i >= 0; i--) {
			let line = headers[i];
			if (includedFields.has(line.key) && !headerFields.has(line.key)) headerFields.set(line.key, relaxedHeaderLine(line.line));
		}
		let headersList = [];
		let fields = [];
		includedFields.forEach((field) => {
			if (headerFields.has(field)) {
				fields.push(field);
				headersList.push(field + ":" + headerFields.get(field));
			}
		});
		return {
			headers: headersList.join("\r\n") + "\r\n",
			fieldNames: fields.join(":")
		};
	}
	function relaxedHeaderLine(line) {
		return line.substr(line.indexOf(":") + 1).replace(/\r?\n/g, "").replace(/\s+/g, " ").trim();
	}
}));
//#endregion
//#region node_modules/nodemailer/lib/dkim/index.js
var require_dkim = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const MessageParser = require_message_parser();
	const RelaxedBody = require_relaxed_body();
	const sign = require_sign();
	const PassThrough$1 = __require("stream").PassThrough;
	const fs = __require("fs");
	const path = __require("path");
	const crypto$3 = __require("crypto");
	const DKIM_ALGO = "sha256";
	const MAX_MESSAGE_SIZE = 2 * 1024 * 1024;
	var DKIMSigner = class {
		constructor(options, keys, input, output) {
			this.options = options || {};
			this.keys = keys;
			this.cacheTreshold = Number(this.options.cacheTreshold) || MAX_MESSAGE_SIZE;
			this.hashAlgo = this.options.hashAlgo || DKIM_ALGO;
			this.cacheDir = this.options.cacheDir || false;
			this.chunks = [];
			this.chunklen = 0;
			this.readPos = 0;
			this.cachePath = this.cacheDir ? path.join(this.cacheDir, "message." + Date.now() + "-" + crypto$3.randomBytes(14).toString("hex")) : false;
			this.cache = false;
			this.headers = false;
			this.bodyHash = false;
			this.parser = false;
			this.relaxedBody = false;
			this.input = input;
			this.output = output;
			this.output.usingCache = false;
			this.hasErrored = false;
			this.input.on("error", (err) => {
				this.hasErrored = true;
				this.cleanup();
				output.emit("error", err);
			});
		}
		cleanup() {
			if (!this.cache || !this.cachePath) return;
			fs.unlink(this.cachePath, () => false);
		}
		createReadCache() {
			this.cache = fs.createReadStream(this.cachePath);
			this.cache.once("error", (err) => {
				this.cleanup();
				this.output.emit("error", err);
			});
			this.cache.once("close", () => {
				this.cleanup();
			});
			this.cache.pipe(this.output);
		}
		sendNextChunk() {
			if (this.hasErrored) return;
			if (this.readPos >= this.chunks.length) {
				if (!this.cache) return this.output.end();
				return this.createReadCache();
			}
			let chunk = this.chunks[this.readPos++];
			if (this.output.write(chunk) === false) return this.output.once("drain", () => {
				this.sendNextChunk();
			});
			setImmediate(() => this.sendNextChunk());
		}
		sendSignedOutput() {
			let keyPos = 0;
			let signNextKey = () => {
				if (keyPos >= this.keys.length) {
					this.output.write(this.parser.rawHeaders);
					return setImmediate(() => this.sendNextChunk());
				}
				let key = this.keys[keyPos++];
				let dkimField = sign(this.headers, this.hashAlgo, this.bodyHash, {
					domainName: key.domainName,
					keySelector: key.keySelector,
					privateKey: key.privateKey,
					headerFieldNames: this.options.headerFieldNames,
					skipFields: this.options.skipFields
				});
				if (dkimField) this.output.write(Buffer.from(dkimField + "\r\n"));
				return setImmediate(signNextKey);
			};
			if (this.bodyHash && this.headers) return signNextKey();
			this.output.write(this.parser.rawHeaders);
			this.sendNextChunk();
		}
		createWriteCache() {
			this.output.usingCache = true;
			this.cache = fs.createWriteStream(this.cachePath);
			this.cache.once("error", (err) => {
				this.cleanup();
				this.relaxedBody.unpipe(this.cache);
				this.relaxedBody.on("readable", () => {
					while (this.relaxedBody.read() !== null);
				});
				this.hasErrored = true;
				this.output.emit("error", err);
			});
			this.cache.once("close", () => {
				this.sendSignedOutput();
			});
			this.relaxedBody.removeAllListeners("readable");
			this.relaxedBody.pipe(this.cache);
		}
		signStream() {
			this.parser = new MessageParser();
			this.relaxedBody = new RelaxedBody({ hashAlgo: this.hashAlgo });
			this.parser.on("headers", (value) => {
				this.headers = value;
			});
			this.relaxedBody.on("hash", (value) => {
				this.bodyHash = value;
			});
			this.relaxedBody.on("readable", () => {
				let chunk;
				if (this.cache) return;
				while ((chunk = this.relaxedBody.read()) !== null) {
					this.chunks.push(chunk);
					this.chunklen += chunk.length;
					if (this.chunklen >= this.cacheTreshold && this.cachePath) return this.createWriteCache();
				}
			});
			this.relaxedBody.on("end", () => {
				if (this.cache) return;
				this.sendSignedOutput();
			});
			this.parser.pipe(this.relaxedBody);
			setImmediate(() => this.input.pipe(this.parser));
		}
	};
	var DKIM = class {
		constructor(options) {
			this.options = options || {};
			this.keys = [].concat(this.options.keys || {
				domainName: options.domainName,
				keySelector: options.keySelector,
				privateKey: options.privateKey
			});
		}
		sign(input, extraOptions) {
			let output = new PassThrough$1();
			let inputStream = input;
			let writeValue = false;
			if (Buffer.isBuffer(input)) {
				writeValue = input;
				inputStream = new PassThrough$1();
			} else if (typeof input === "string") {
				writeValue = Buffer.from(input);
				inputStream = new PassThrough$1();
			}
			let options = this.options;
			if (extraOptions && Object.keys(extraOptions).length) {
				options = {};
				Object.keys(this.options || {}).forEach((key) => {
					options[key] = this.options[key];
				});
				Object.keys(extraOptions || {}).forEach((key) => {
					if (!(key in options)) options[key] = extraOptions[key];
				});
			}
			let signer = new DKIMSigner(options, this.keys, inputStream, output);
			setImmediate(() => {
				signer.signStream();
				if (writeValue) setImmediate(() => {
					inputStream.end(writeValue);
				});
			});
			return output;
		}
	};
	module.exports = DKIM;
}));
//#endregion
//#region node_modules/nodemailer/lib/smtp-connection/http-proxy-client.js
var require_http_proxy_client = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	/**
	* Minimal HTTP/S proxy client
	*/
	const net$2 = __require("net");
	const tls$1 = __require("tls");
	const urllib$1 = __require("url");
	/**
	* Establishes proxied connection to destinationPort
	*
	* httpProxyClient("http://localhost:3128/", 80, "google.com", function(err, socket){
	*     socket.write("GET / HTTP/1.0\r\n\r\n");
	* });
	*
	* @param {String} proxyUrl proxy configuration, etg "http://proxy.host:3128/"
	* @param {Number} destinationPort Port to open in destination host
	* @param {String} destinationHost Destination hostname
	* @param {Function} callback Callback to run with the rocket object once connection is established
	*/
	function httpProxyClient(proxyUrl, destinationPort, destinationHost, callback) {
		let proxy = urllib$1.parse(proxyUrl);
		let options;
		let connect;
		let socket;
		options = {
			host: proxy.hostname,
			port: Number(proxy.port) ? Number(proxy.port) : proxy.protocol === "https:" ? 443 : 80
		};
		if (proxy.protocol === "https:") {
			options.rejectUnauthorized = false;
			connect = tls$1.connect.bind(tls$1);
		} else connect = net$2.connect.bind(net$2);
		let finished = false;
		let tempSocketErr = (err) => {
			if (finished) return;
			finished = true;
			try {
				socket.destroy();
			} catch (_E) {}
			callback(err);
		};
		let timeoutErr = () => {
			let err = /* @__PURE__ */ new Error("Proxy socket timed out");
			err.code = "ETIMEDOUT";
			tempSocketErr(err);
		};
		socket = connect(options, () => {
			if (finished) return;
			let reqHeaders = {
				Host: destinationHost + ":" + destinationPort,
				Connection: "close"
			};
			if (proxy.auth) reqHeaders["Proxy-Authorization"] = "Basic " + Buffer.from(proxy.auth).toString("base64");
			socket.write("CONNECT " + destinationHost + ":" + destinationPort + " HTTP/1.1\r\n" + Object.keys(reqHeaders).map((key) => key + ": " + reqHeaders[key]).join("\r\n") + "\r\n\r\n");
			let headers = "";
			let onSocketData = (chunk) => {
				let match;
				let remainder;
				if (finished) return;
				headers += chunk.toString("binary");
				if (match = headers.match(/\r\n\r\n/)) {
					socket.removeListener("data", onSocketData);
					remainder = headers.substr(match.index + match[0].length);
					headers = headers.substr(0, match.index);
					if (remainder) socket.unshift(Buffer.from(remainder, "binary"));
					finished = true;
					match = headers.match(/^HTTP\/\d+\.\d+ (\d+)/i);
					if (!match || (match[1] || "").charAt(0) !== "2") {
						try {
							socket.destroy();
						} catch (_E) {}
						return callback(/* @__PURE__ */ new Error("Invalid response from proxy" + (match && ": " + match[1] || "")));
					}
					socket.removeListener("error", tempSocketErr);
					socket.removeListener("timeout", timeoutErr);
					socket.setTimeout(0);
					return callback(null, socket);
				}
			};
			socket.on("data", onSocketData);
		});
		socket.setTimeout(httpProxyClient.timeout || 30 * 1e3);
		socket.on("timeout", timeoutErr);
		socket.once("error", tempSocketErr);
	}
	module.exports = httpProxyClient;
}));
//#endregion
//#region node_modules/nodemailer/lib/mailer/mail-message.js
var require_mail_message = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const shared = require_shared();
	const MimeNode = require_mime_node();
	const mimeFuncs = require_mime_funcs();
	var MailMessage = class {
		constructor(mailer, data) {
			this.mailer = mailer;
			this.data = {};
			this.message = null;
			data = data || {};
			let options = mailer.options || {};
			let defaults = mailer._defaults || {};
			Object.keys(data).forEach((key) => {
				this.data[key] = data[key];
			});
			this.data.headers = this.data.headers || {};
			Object.keys(defaults).forEach((key) => {
				if (!(key in this.data)) this.data[key] = defaults[key];
				else if (key === "headers") Object.keys(defaults.headers).forEach((key) => {
					if (!(key in this.data.headers)) this.data.headers[key] = defaults.headers[key];
				});
			});
			[
				"disableFileAccess",
				"disableUrlAccess",
				"normalizeHeaderKey"
			].forEach((key) => {
				if (key in options) this.data[key] = options[key];
			});
		}
		resolveContent(...args) {
			return shared.resolveContent(...args);
		}
		resolveAll(callback) {
			let keys = [
				[this.data, "html"],
				[this.data, "text"],
				[this.data, "watchHtml"],
				[this.data, "amp"],
				[this.data, "icalEvent"]
			];
			if (this.data.alternatives && this.data.alternatives.length) this.data.alternatives.forEach((alternative, i) => {
				keys.push([this.data.alternatives, i]);
			});
			if (this.data.attachments && this.data.attachments.length) this.data.attachments.forEach((attachment, i) => {
				if (!attachment.filename) {
					attachment.filename = (attachment.path || attachment.href || "").split("/").pop().split("?").shift() || "attachment-" + (i + 1);
					if (attachment.filename.indexOf(".") < 0) attachment.filename += "." + mimeFuncs.detectExtension(attachment.contentType);
				}
				if (!attachment.contentType) attachment.contentType = mimeFuncs.detectMimeType(attachment.filename || attachment.path || attachment.href || "bin");
				keys.push([this.data.attachments, i]);
			});
			let mimeNode = new MimeNode();
			[
				"from",
				"to",
				"cc",
				"bcc",
				"sender",
				"replyTo"
			].forEach((address) => {
				let value;
				if (this.message) value = [].concat(mimeNode._parseAddresses(this.message.getHeader(address === "replyTo" ? "reply-to" : address)) || []);
				else if (this.data[address]) value = [].concat(mimeNode._parseAddresses(this.data[address]) || []);
				if (value && value.length) this.data[address] = value;
				else if (address in this.data) this.data[address] = null;
			});
			["from", "sender"].forEach((address) => {
				if (this.data[address]) this.data[address] = this.data[address].shift();
			});
			let pos = 0;
			let resolveNext = () => {
				if (pos >= keys.length) return callback(null, this.data);
				let args = keys[pos++];
				if (!args[0] || !args[0][args[1]]) return resolveNext();
				shared.resolveContent(...args, (err, value) => {
					if (err) return callback(err);
					let node = { content: value };
					if (args[0][args[1]] && typeof args[0][args[1]] === "object" && !Buffer.isBuffer(args[0][args[1]])) Object.keys(args[0][args[1]]).forEach((key) => {
						if (!(key in node) && ![
							"content",
							"path",
							"href",
							"raw"
						].includes(key)) node[key] = args[0][args[1]][key];
					});
					args[0][args[1]] = node;
					resolveNext();
				});
			};
			setImmediate(() => resolveNext());
		}
		normalize(callback) {
			let envelope = this.data.envelope || this.message.getEnvelope();
			let messageId = this.message.messageId();
			this.resolveAll((err, data) => {
				if (err) return callback(err);
				data.envelope = envelope;
				data.messageId = messageId;
				[
					"html",
					"text",
					"watchHtml",
					"amp"
				].forEach((key) => {
					if (data[key] && data[key].content) {
						if (typeof data[key].content === "string") data[key] = data[key].content;
						else if (Buffer.isBuffer(data[key].content)) data[key] = data[key].content.toString();
					}
				});
				if (data.icalEvent && Buffer.isBuffer(data.icalEvent.content)) {
					data.icalEvent.content = data.icalEvent.content.toString("base64");
					data.icalEvent.encoding = "base64";
				}
				if (data.alternatives && data.alternatives.length) data.alternatives.forEach((alternative) => {
					if (alternative && alternative.content && Buffer.isBuffer(alternative.content)) {
						alternative.content = alternative.content.toString("base64");
						alternative.encoding = "base64";
					}
				});
				if (data.attachments && data.attachments.length) data.attachments.forEach((attachment) => {
					if (attachment && attachment.content && Buffer.isBuffer(attachment.content)) {
						attachment.content = attachment.content.toString("base64");
						attachment.encoding = "base64";
					}
				});
				data.normalizedHeaders = {};
				Object.keys(data.headers || {}).forEach((key) => {
					let value = [].concat(data.headers[key] || []).shift();
					value = value && value.value || value;
					if (value) {
						if ([
							"references",
							"in-reply-to",
							"message-id",
							"content-id"
						].includes(key)) value = this.message._encodeHeaderValue(key, value);
						data.normalizedHeaders[key] = value;
					}
				});
				if (data.list && typeof data.list === "object") this._getListHeaders(data.list).forEach((entry) => {
					data.normalizedHeaders[entry.key] = entry.value.map((val) => val && val.value || val).join(", ");
				});
				if (data.references) data.normalizedHeaders.references = this.message._encodeHeaderValue("references", data.references);
				if (data.inReplyTo) data.normalizedHeaders["in-reply-to"] = this.message._encodeHeaderValue("in-reply-to", data.inReplyTo);
				return callback(null, data);
			});
		}
		setMailerHeader() {
			if (!this.message || !this.data.xMailer) return;
			this.message.setHeader("X-Mailer", this.data.xMailer);
		}
		setPriorityHeaders() {
			if (!this.message || !this.data.priority) return;
			switch ((this.data.priority || "").toString().toLowerCase()) {
				case "high":
					this.message.setHeader("X-Priority", "1 (Highest)");
					this.message.setHeader("X-MSMail-Priority", "High");
					this.message.setHeader("Importance", "High");
					break;
				case "low":
					this.message.setHeader("X-Priority", "5 (Lowest)");
					this.message.setHeader("X-MSMail-Priority", "Low");
					this.message.setHeader("Importance", "Low");
					break;
				default:
			}
		}
		setListHeaders() {
			if (!this.message || !this.data.list || typeof this.data.list !== "object") return;
			if (this.data.list && typeof this.data.list === "object") this._getListHeaders(this.data.list).forEach((listHeader) => {
				listHeader.value.forEach((value) => {
					this.message.addHeader(listHeader.key, value);
				});
			});
		}
		_getListHeaders(listData) {
			return Object.keys(listData).map((key) => ({
				key: "list-" + key.toLowerCase().trim(),
				value: [].concat(listData[key] || []).map((value) => ({
					prepared: true,
					foldLines: true,
					value: [].concat(value || []).map((value) => {
						if (typeof value === "string") value = { url: value };
						if (value && value.url) {
							if (key.toLowerCase().trim() === "id") {
								let comment = value.comment || "";
								if (mimeFuncs.isPlainText(comment)) comment = "\"" + comment + "\"";
								else comment = mimeFuncs.encodeWord(comment);
								return (value.comment ? comment + " " : "") + this._formatListUrl(value.url).replace(/^<[^:]+\/{,2}/, "");
							}
							let comment = value.comment || "";
							if (!mimeFuncs.isPlainText(comment)) comment = mimeFuncs.encodeWord(comment);
							return this._formatListUrl(value.url) + (value.comment ? " (" + comment + ")" : "");
						}
						return "";
					}).filter((value) => value).join(", ")
				}))
			}));
		}
		_formatListUrl(url) {
			url = url.replace(/[\s<]+|[\s>]+/g, "");
			if (/^(https?|mailto|ftp):/.test(url)) return "<" + url + ">";
			if (/^[^@]+@[^@]+$/.test(url)) return "<mailto:" + url + ">";
			return "<http://" + url + ">";
		}
	};
	module.exports = MailMessage;
}));
//#endregion
//#region node_modules/nodemailer/lib/mailer/index.js
var require_mailer = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const EventEmitter$5 = __require("events");
	const shared = require_shared();
	const mimeTypes = require_mime_types();
	const MailComposer = require_mail_composer();
	const DKIM = require_dkim();
	const httpProxyClient = require_http_proxy_client();
	const util = __require("util");
	const urllib = __require("url");
	const packageData = require_package();
	const MailMessage = require_mail_message();
	const net$1 = __require("net");
	const dns = __require("dns");
	const crypto$2 = __require("crypto");
	/**
	* Creates an object for exposing the Mail API
	*
	* @constructor
	* @param {Object} transporter Transport object instance to pass the mails to
	*/
	var Mail = class extends EventEmitter$5 {
		constructor(transporter, options, defaults) {
			super();
			this.options = options || {};
			this._defaults = defaults || {};
			this._defaultPlugins = {
				compile: [(...args) => this._convertDataImages(...args)],
				stream: []
			};
			this._userPlugins = {
				compile: [],
				stream: []
			};
			this.meta = /* @__PURE__ */ new Map();
			this.dkim = this.options.dkim ? new DKIM(this.options.dkim) : false;
			this.transporter = transporter;
			this.transporter.mailer = this;
			this.logger = shared.getLogger(this.options, { component: this.options.component || "mail" });
			this.logger.debug({ tnx: "create" }, "Creating transport: %s", this.getVersionString());
			if (typeof this.transporter.on === "function") {
				this.transporter.on("log", (log) => {
					this.logger.debug({ tnx: "transport" }, "%s: %s", log.type, log.message);
				});
				this.transporter.on("error", (err) => {
					this.logger.error({
						err,
						tnx: "transport"
					}, "Transport Error: %s", err.message);
					this.emit("error", err);
				});
				this.transporter.on("idle", (...args) => {
					this.emit("idle", ...args);
				});
				this.transporter.on("clear", (...args) => {
					this.emit("clear", ...args);
				});
			}
			/**
			* Optional methods passed to the underlying transport object
			*/
			[
				"close",
				"isIdle",
				"verify"
			].forEach((method) => {
				this[method] = (...args) => {
					if (typeof this.transporter[method] === "function") {
						if (method === "verify" && typeof this.getSocket === "function") {
							this.transporter.getSocket = this.getSocket;
							this.getSocket = false;
						}
						return this.transporter[method](...args);
					} else {
						this.logger.warn({
							tnx: "transport",
							methodName: method
						}, "Non existing method %s called for transport", method);
						return false;
					}
				};
			});
			if (this.options.proxy && typeof this.options.proxy === "string") this.setupProxy(this.options.proxy);
		}
		use(step, plugin) {
			step = (step || "").toString();
			if (!this._userPlugins.hasOwnProperty(step)) this._userPlugins[step] = [plugin];
			else this._userPlugins[step].push(plugin);
			return this;
		}
		/**
		* Sends an email using the preselected transport object
		*
		* @param {Object} data E-data description
		* @param {Function?} callback Callback to run once the sending succeeded or failed
		*/
		sendMail(data, callback = null) {
			let promise;
			if (!callback) promise = new Promise((resolve, reject) => {
				callback = shared.callbackPromise(resolve, reject);
			});
			if (typeof this.getSocket === "function") {
				this.transporter.getSocket = this.getSocket;
				this.getSocket = false;
			}
			let mail = new MailMessage(this, data);
			this.logger.debug({
				tnx: "transport",
				name: this.transporter.name,
				version: this.transporter.version,
				action: "send"
			}, "Sending mail using %s/%s", this.transporter.name, this.transporter.version);
			this._processPlugins("compile", mail, (err) => {
				if (err) {
					this.logger.error({
						err,
						tnx: "plugin",
						action: "compile"
					}, "PluginCompile Error: %s", err.message);
					return callback(err);
				}
				mail.message = new MailComposer(mail.data).compile();
				mail.setMailerHeader();
				mail.setPriorityHeaders();
				mail.setListHeaders();
				this._processPlugins("stream", mail, (err) => {
					if (err) {
						this.logger.error({
							err,
							tnx: "plugin",
							action: "stream"
						}, "PluginStream Error: %s", err.message);
						return callback(err);
					}
					if (mail.data.dkim || this.dkim) mail.message.processFunc((input) => {
						let dkim = mail.data.dkim ? new DKIM(mail.data.dkim) : this.dkim;
						this.logger.debug({
							tnx: "DKIM",
							messageId: mail.message.messageId(),
							dkimDomains: dkim.keys.map((key) => key.keySelector + "." + key.domainName).join(", ")
						}, "Signing outgoing message with %s keys", dkim.keys.length);
						return dkim.sign(input, mail.data._dkim);
					});
					this.transporter.send(mail, (...args) => {
						if (args[0]) this.logger.error({
							err: args[0],
							tnx: "transport",
							action: "send"
						}, "Send Error: %s", args[0].message);
						callback(...args);
					});
				});
			});
			return promise;
		}
		getVersionString() {
			return util.format("%s (%s; +%s; %s/%s)", packageData.name, packageData.version, packageData.homepage, this.transporter.name, this.transporter.version);
		}
		_processPlugins(step, mail, callback) {
			step = (step || "").toString();
			if (!this._userPlugins.hasOwnProperty(step)) return callback();
			let userPlugins = this._userPlugins[step] || [];
			let defaultPlugins = this._defaultPlugins[step] || [];
			if (userPlugins.length) this.logger.debug({
				tnx: "transaction",
				pluginCount: userPlugins.length,
				step
			}, "Using %s plugins for %s", userPlugins.length, step);
			if (userPlugins.length + defaultPlugins.length === 0) return callback();
			let pos = 0;
			let block = "default";
			let processPlugins = () => {
				let curplugins = block === "default" ? defaultPlugins : userPlugins;
				if (pos >= curplugins.length) if (block === "default" && userPlugins.length) {
					block = "user";
					pos = 0;
					curplugins = userPlugins;
				} else return callback();
				let plugin = curplugins[pos++];
				plugin(mail, (err) => {
					if (err) return callback(err);
					processPlugins();
				});
			};
			processPlugins();
		}
		/**
		* Sets up proxy handler for a Nodemailer object
		*
		* @param {String} proxyUrl Proxy configuration url
		*/
		setupProxy(proxyUrl) {
			let proxy = urllib.parse(proxyUrl);
			this.getSocket = (options, callback) => {
				let protocol = proxy.protocol.replace(/:$/, "").toLowerCase();
				if (this.meta.has("proxy_handler_" + protocol)) return this.meta.get("proxy_handler_" + protocol)(proxy, options, callback);
				switch (protocol) {
					case "http":
					case "https":
						httpProxyClient(proxy.href, options.port, options.host, (err, socket) => {
							if (err) return callback(err);
							return callback(null, { connection: socket });
						});
						return;
					case "socks":
					case "socks5":
					case "socks4":
					case "socks4a": {
						if (!this.meta.has("proxy_socks_module")) return callback(/* @__PURE__ */ new Error("Socks module not loaded"));
						let connect = (ipaddress) => {
							let proxyV2 = !!this.meta.get("proxy_socks_module").SocksClient;
							let socksClient = proxyV2 ? this.meta.get("proxy_socks_module").SocksClient : this.meta.get("proxy_socks_module");
							let proxyType = Number(proxy.protocol.replace(/\D/g, "")) || 5;
							let connectionOpts = {
								proxy: {
									ipaddress,
									port: Number(proxy.port),
									type: proxyType
								},
								[proxyV2 ? "destination" : "target"]: {
									host: options.host,
									port: options.port
								},
								command: "connect"
							};
							if (proxy.auth) {
								let username = decodeURIComponent(proxy.auth.split(":").shift());
								let password = decodeURIComponent(proxy.auth.split(":").pop());
								if (proxyV2) {
									connectionOpts.proxy.userId = username;
									connectionOpts.proxy.password = password;
								} else if (proxyType === 4) connectionOpts.userid = username;
								else connectionOpts.authentication = {
									username,
									password
								};
							}
							socksClient.createConnection(connectionOpts, (err, info) => {
								if (err) return callback(err);
								return callback(null, { connection: info.socket || info });
							});
						};
						if (net$1.isIP(proxy.hostname)) return connect(proxy.hostname);
						return dns.resolve(proxy.hostname, (err, address) => {
							if (err) return callback(err);
							connect(Array.isArray(address) ? address[0] : address);
						});
					}
				}
				callback(/* @__PURE__ */ new Error("Unknown proxy configuration"));
			};
		}
		_convertDataImages(mail, callback) {
			if (!this.options.attachDataUrls && !mail.data.attachDataUrls || !mail.data.html) return callback();
			mail.resolveContent(mail.data, "html", (err, html) => {
				if (err) return callback(err);
				let cidCounter = 0;
				html = (html || "").toString().replace(/(<img\b[^<>]{0,1024} src\s{0,20}=[\s"']{0,20})(data:([^;]+);[^"'>\s]+)/gi, (match, prefix, dataUri, mimeType) => {
					let cid = crypto$2.randomBytes(10).toString("hex") + "@localhost";
					if (!mail.data.attachments) mail.data.attachments = [];
					if (!Array.isArray(mail.data.attachments)) mail.data.attachments = [].concat(mail.data.attachments || []);
					mail.data.attachments.push({
						path: dataUri,
						cid,
						filename: "image-" + ++cidCounter + "." + mimeTypes.detectExtension(mimeType)
					});
					return prefix + "cid:" + cid;
				});
				mail.data.html = html;
				callback();
			});
		}
		set(key, value) {
			return this.meta.set(key, value);
		}
		get(key) {
			return this.meta.get(key);
		}
	};
	module.exports = Mail;
}));
//#endregion
//#region node_modules/nodemailer/lib/smtp-connection/data-stream.js
var require_data_stream = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const Transform = __require("stream").Transform;
	/**
	* Escapes dots in the beginning of lines. Ends the stream with <CR><LF>.<CR><LF>
	* Also makes sure that only <CR><LF> sequences are used for linebreaks
	*
	* @param {Object} options Stream options
	*/
	var DataStream = class extends Transform {
		constructor(options) {
			super(options);
			this.options = options || {};
			this._curLine = "";
			this.inByteCount = 0;
			this.outByteCount = 0;
			this.lastByte = false;
		}
		/**
		* Escapes dots
		*/
		_transform(chunk, encoding, done) {
			let chunks = [];
			let chunklen = 0;
			let i, len, lastPos = 0;
			let buf;
			if (!chunk || !chunk.length) return done();
			if (typeof chunk === "string") chunk = Buffer.from(chunk);
			this.inByteCount += chunk.length;
			for (i = 0, len = chunk.length; i < len; i++) if (chunk[i] === 46) {
				if (i && chunk[i - 1] === 10 || !i && (!this.lastByte || this.lastByte === 10)) {
					buf = chunk.slice(lastPos, i + 1);
					chunks.push(buf);
					chunks.push(Buffer.from("."));
					chunklen += buf.length + 1;
					lastPos = i + 1;
				}
			} else if (chunk[i] === 10) {
				if (i && chunk[i - 1] !== 13 || !i && this.lastByte !== 13) {
					if (i > lastPos) {
						buf = chunk.slice(lastPos, i);
						chunks.push(buf);
						chunklen += buf.length + 2;
					} else chunklen += 2;
					chunks.push(Buffer.from("\r\n"));
					lastPos = i + 1;
				}
			}
			if (chunklen) {
				if (lastPos < chunk.length) {
					buf = chunk.slice(lastPos);
					chunks.push(buf);
					chunklen += buf.length;
				}
				this.outByteCount += chunklen;
				this.push(Buffer.concat(chunks, chunklen));
			} else {
				this.outByteCount += chunk.length;
				this.push(chunk);
			}
			this.lastByte = chunk[chunk.length - 1];
			done();
		}
		/**
		* Finalizes the stream with a dot on a single line
		*/
		_flush(done) {
			let buf;
			if (this.lastByte === 10) buf = Buffer.from(".\r\n");
			else if (this.lastByte === 13) buf = Buffer.from("\n.\r\n");
			else buf = Buffer.from("\r\n.\r\n");
			this.outByteCount += buf.length;
			this.push(buf);
			done();
		}
	};
	module.exports = DataStream;
}));
//#endregion
//#region node_modules/nodemailer/lib/smtp-connection/index.js
var require_smtp_connection = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const packageInfo = require_package();
	const EventEmitter$4 = __require("events").EventEmitter;
	const net = __require("net");
	const tls = __require("tls");
	const os = __require("os");
	const crypto$1 = __require("crypto");
	const DataStream = require_data_stream();
	const PassThrough = __require("stream").PassThrough;
	const shared = require_shared();
	const CONNECTION_TIMEOUT = 120 * 1e3;
	const SOCKET_TIMEOUT = 600 * 1e3;
	const GREETING_TIMEOUT = 30 * 1e3;
	const DNS_TIMEOUT = 30 * 1e3;
	/**
	* Generates a SMTP connection object
	*
	* Optional options object takes the following possible properties:
	*
	*  * **port** - is the port to connect to (defaults to 587 or 465)
	*  * **host** - is the hostname or IP address to connect to (defaults to 'localhost')
	*  * **secure** - use SSL
	*  * **ignoreTLS** - ignore server support for STARTTLS
	*  * **requireTLS** - forces the client to use STARTTLS
	*  * **name** - the name of the client server
	*  * **localAddress** - outbound address to bind to (see: http://nodejs.org/api/net.html#net_net_connect_options_connectionlistener)
	*  * **greetingTimeout** - Time to wait in ms until greeting message is received from the server (defaults to 10000)
	*  * **connectionTimeout** - how many milliseconds to wait for the connection to establish
	*  * **socketTimeout** - Time of inactivity until the connection is closed (defaults to 1 hour)
	*  * **dnsTimeout** - Time to wait in ms for the DNS requests to be resolved (defaults to 30 seconds)
	*  * **lmtp** - if true, uses LMTP instead of SMTP protocol
	*  * **logger** - bunyan compatible logger interface
	*  * **debug** - if true pass SMTP traffic to the logger
	*  * **tls** - options for createCredentials
	*  * **socket** - existing socket to use instead of creating a new one (see: http://nodejs.org/api/net.html#net_class_net_socket)
	*  * **secured** - boolean indicates that the provided socket has already been upgraded to tls
	*
	* @constructor
	* @namespace SMTP Client module
	* @param {Object} [options] Option properties
	*/
	var SMTPConnection = class extends EventEmitter$4 {
		constructor(options) {
			super(options);
			this.id = crypto$1.randomBytes(8).toString("base64").replace(/\W/g, "");
			this.stage = "init";
			this.options = options || {};
			this.secureConnection = !!this.options.secure;
			this.alreadySecured = !!this.options.secured;
			this.port = Number(this.options.port) || (this.secureConnection ? 465 : 587);
			this.host = this.options.host || "localhost";
			this.servername = this.options.servername ? this.options.servername : !net.isIP(this.host) ? this.host : false;
			this.allowInternalNetworkInterfaces = this.options.allowInternalNetworkInterfaces || false;
			if (typeof this.options.secure === "undefined" && this.port === 465) this.secureConnection = true;
			this.name = this.options.name || this._getHostname();
			this.logger = shared.getLogger(this.options, {
				component: this.options.component || "smtp-connection",
				sid: this.id
			});
			this.customAuth = /* @__PURE__ */ new Map();
			Object.keys(this.options.customAuth || {}).forEach((key) => {
				let mapKey = (key || "").toString().trim().toUpperCase();
				if (!mapKey) return;
				this.customAuth.set(mapKey, this.options.customAuth[key]);
			});
			/**
			* Expose version nr, just for the reference
			* @type {String}
			*/
			this.version = packageInfo.version;
			/**
			* If true, then the user is authenticated
			* @type {Boolean}
			*/
			this.authenticated = false;
			/**
			* If set to true, this instance is no longer active
			* @private
			*/
			this.destroyed = false;
			/**
			* Defines if the current connection is secure or not. If not,
			* STARTTLS can be used if available
			* @private
			*/
			this.secure = !!this.secureConnection;
			/**
			* Store incomplete messages coming from the server
			* @private
			*/
			this._remainder = "";
			/**
			* Unprocessed responses from the server
			* @type {Array}
			*/
			this._responseQueue = [];
			this.lastServerResponse = false;
			/**
			* The socket connecting to the server
			* @public
			*/
			this._socket = false;
			/**
			* Lists supported auth mechanisms
			* @private
			*/
			this._supportedAuth = [];
			/**
			* Set to true, if EHLO response includes "AUTH".
			* If false then authentication is not tried
			*/
			this.allowsAuth = false;
			/**
			* Includes current envelope (from, to)
			* @private
			*/
			this._envelope = false;
			/**
			* Lists supported extensions
			* @private
			*/
			this._supportedExtensions = [];
			/**
			* Defines the maximum allowed size for a single message
			* @private
			*/
			this._maxAllowedSize = 0;
			/**
			* Function queue to run if a data chunk comes from the server
			* @private
			*/
			this._responseActions = [];
			this._recipientQueue = [];
			/**
			* Timeout variable for waiting the greeting
			* @private
			*/
			this._greetingTimeout = false;
			/**
			* Timeout variable for waiting the connection to start
			* @private
			*/
			this._connectionTimeout = false;
			/**
			* If the socket is deemed already closed
			* @private
			*/
			this._destroyed = false;
			/**
			* If the socket is already being closed
			* @private
			*/
			this._closing = false;
			/**
			* Callbacks for socket's listeners
			*/
			this._onSocketData = (chunk) => this._onData(chunk);
			this._onSocketError = (error) => this._onError(error, "ESOCKET", false, "CONN");
			this._onSocketClose = () => this._onClose();
			this._onSocketEnd = () => this._onEnd();
			this._onSocketTimeout = () => this._onTimeout();
		}
		/**
		* Creates a connection to a SMTP server and sets up connection
		* listener
		*/
		connect(connectCallback) {
			if (typeof connectCallback === "function") {
				this.once("connect", () => {
					this.logger.debug({ tnx: "smtp" }, "SMTP handshake finished");
					connectCallback();
				});
				const isDestroyedMessage = this._isDestroyedMessage("connect");
				if (isDestroyedMessage) return connectCallback(this._formatError(isDestroyedMessage, "ECONNECTION", false, "CONN"));
			}
			let opts = {
				port: this.port,
				host: this.host,
				allowInternalNetworkInterfaces: this.allowInternalNetworkInterfaces,
				timeout: this.options.dnsTimeout || DNS_TIMEOUT
			};
			if (this.options.localAddress) opts.localAddress = this.options.localAddress;
			let setupConnectionHandlers = () => {
				this._connectionTimeout = setTimeout(() => {
					this._onError("Connection timeout", "ETIMEDOUT", false, "CONN");
				}, this.options.connectionTimeout || CONNECTION_TIMEOUT);
				this._socket.on("error", this._onSocketError);
			};
			if (this.options.connection) {
				this._socket = this.options.connection;
				setupConnectionHandlers();
				if (this.secureConnection && !this.alreadySecured) setImmediate(() => this._upgradeConnection((err) => {
					if (err) {
						this._onError(/* @__PURE__ */ new Error("Error initiating TLS - " + (err.message || err)), "ETLS", false, "CONN");
						return;
					}
					this._onConnect();
				}));
				else setImmediate(() => this._onConnect());
				return;
			} else if (this.options.socket) {
				this._socket = this.options.socket;
				return shared.resolveHostname(opts, (err, resolved) => {
					if (err) return setImmediate(() => this._onError(err, "EDNS", false, "CONN"));
					this.logger.debug({
						tnx: "dns",
						source: opts.host,
						resolved: resolved.host,
						cached: !!resolved.cached
					}, "Resolved %s as %s [cache %s]", opts.host, resolved.host, resolved.cached ? "hit" : "miss");
					Object.keys(resolved).forEach((key) => {
						if (key.charAt(0) !== "_" && resolved[key]) opts[key] = resolved[key];
					});
					try {
						this._socket.connect(this.port, this.host, () => {
							this._socket.setKeepAlive(true);
							this._onConnect();
						});
						setupConnectionHandlers();
					} catch (E) {
						return setImmediate(() => this._onError(E, "ECONNECTION", false, "CONN"));
					}
				});
			} else if (this.secureConnection) {
				if (this.options.tls) Object.keys(this.options.tls).forEach((key) => {
					opts[key] = this.options.tls[key];
				});
				if (this.servername && !opts.servername) opts.servername = this.servername;
				return shared.resolveHostname(opts, (err, resolved) => {
					if (err) return setImmediate(() => this._onError(err, "EDNS", false, "CONN"));
					this.logger.debug({
						tnx: "dns",
						source: opts.host,
						resolved: resolved.host,
						cached: !!resolved.cached
					}, "Resolved %s as %s [cache %s]", opts.host, resolved.host, resolved.cached ? "hit" : "miss");
					Object.keys(resolved).forEach((key) => {
						if (key.charAt(0) !== "_" && resolved[key]) opts[key] = resolved[key];
					});
					try {
						this._socket = tls.connect(opts, () => {
							this._socket.setKeepAlive(true);
							this._onConnect();
						});
						setupConnectionHandlers();
					} catch (E) {
						return setImmediate(() => this._onError(E, "ECONNECTION", false, "CONN"));
					}
				});
			} else return shared.resolveHostname(opts, (err, resolved) => {
				if (err) return setImmediate(() => this._onError(err, "EDNS", false, "CONN"));
				this.logger.debug({
					tnx: "dns",
					source: opts.host,
					resolved: resolved.host,
					cached: !!resolved.cached
				}, "Resolved %s as %s [cache %s]", opts.host, resolved.host, resolved.cached ? "hit" : "miss");
				Object.keys(resolved).forEach((key) => {
					if (key.charAt(0) !== "_" && resolved[key]) opts[key] = resolved[key];
				});
				try {
					this._socket = net.connect(opts, () => {
						this._socket.setKeepAlive(true);
						this._onConnect();
					});
					setupConnectionHandlers();
				} catch (E) {
					return setImmediate(() => this._onError(E, "ECONNECTION", false, "CONN"));
				}
			});
		}
		/**
		* Sends QUIT
		*/
		quit() {
			this._sendCommand("QUIT");
			this._responseActions.push(this.close);
		}
		/**
		* Closes the connection to the server
		*/
		close() {
			clearTimeout(this._connectionTimeout);
			clearTimeout(this._greetingTimeout);
			this._responseActions = [];
			if (this._closing) return;
			this._closing = true;
			let closeMethod = "end";
			if (this.stage === "init") closeMethod = "destroy";
			this.logger.debug({ tnx: "smtp" }, "Closing connection to the server using \"%s\"", closeMethod);
			let socket = this._socket && this._socket.socket || this._socket;
			if (socket && !socket.destroyed) try {
				socket[closeMethod]();
			} catch (_E) {}
			this._destroy();
		}
		/**
		* Authenticate user
		*/
		login(authData, callback) {
			const isDestroyedMessage = this._isDestroyedMessage("login");
			if (isDestroyedMessage) return callback(this._formatError(isDestroyedMessage, "ECONNECTION", false, "API"));
			this._auth = authData || {};
			this._authMethod = (this._auth.method || "").toString().trim().toUpperCase() || false;
			if (!this._authMethod && this._auth.oauth2 && !this._auth.credentials) this._authMethod = "XOAUTH2";
			else if (!this._authMethod || this._authMethod === "XOAUTH2" && !this._auth.oauth2) this._authMethod = (this._supportedAuth[0] || "PLAIN").toUpperCase().trim();
			if (this._authMethod !== "XOAUTH2" && (!this._auth.credentials || !this._auth.credentials.user || !this._auth.credentials.pass)) if (this._auth.user && this._auth.pass || this.customAuth.has(this._authMethod)) this._auth.credentials = {
				user: this._auth.user,
				pass: this._auth.pass,
				options: this._auth.options
			};
			else return callback(this._formatError("Missing credentials for \"" + this._authMethod + "\"", "EAUTH", false, "API"));
			if (this.customAuth.has(this._authMethod)) {
				let handler = this.customAuth.get(this._authMethod);
				let lastResponse;
				let returned = false;
				let resolve = () => {
					if (returned) return;
					returned = true;
					this.logger.info({
						tnx: "smtp",
						username: this._auth.user,
						action: "authenticated",
						method: this._authMethod
					}, "User %s authenticated", JSON.stringify(this._auth.user));
					this.authenticated = true;
					callback(null, true);
				};
				let reject = (err) => {
					if (returned) return;
					returned = true;
					callback(this._formatError(err, "EAUTH", lastResponse, "AUTH " + this._authMethod));
				};
				let handlerResponse = handler({
					auth: this._auth,
					method: this._authMethod,
					extensions: [].concat(this._supportedExtensions),
					authMethods: [].concat(this._supportedAuth),
					maxAllowedSize: this._maxAllowedSize || false,
					sendCommand: (cmd, done) => {
						let promise;
						if (!done) promise = new Promise((resolve, reject) => {
							done = shared.callbackPromise(resolve, reject);
						});
						this._responseActions.push((str) => {
							lastResponse = str;
							let codes = str.match(/^(\d+)(?:\s(\d+\.\d+\.\d+))?\s/);
							let data = {
								command: cmd,
								response: str
							};
							if (codes) {
								data.status = Number(codes[1]) || 0;
								if (codes[2]) data.code = codes[2];
								data.text = str.substr(codes[0].length);
							} else {
								data.text = str;
								data.status = 0;
							}
							done(null, data);
						});
						setImmediate(() => this._sendCommand(cmd));
						return promise;
					},
					resolve,
					reject
				});
				if (handlerResponse && typeof handlerResponse.catch === "function") handlerResponse.then(resolve).catch(reject);
				return;
			}
			switch (this._authMethod) {
				case "XOAUTH2":
					this._handleXOauth2Token(false, callback);
					return;
				case "LOGIN":
					this._responseActions.push((str) => {
						this._actionAUTH_LOGIN_USER(str, callback);
					});
					this._sendCommand("AUTH LOGIN");
					return;
				case "PLAIN":
					this._responseActions.push((str) => {
						this._actionAUTHComplete(str, callback);
					});
					this._sendCommand("AUTH PLAIN " + Buffer.from("\0" + this._auth.credentials.user + "\0" + this._auth.credentials.pass, "utf-8").toString("base64"), "AUTH PLAIN " + Buffer.from("\0" + this._auth.credentials.user + "\0/* secret */", "utf-8").toString("base64"));
					return;
				case "CRAM-MD5":
					this._responseActions.push((str) => {
						this._actionAUTH_CRAM_MD5(str, callback);
					});
					this._sendCommand("AUTH CRAM-MD5");
					return;
			}
			return callback(this._formatError("Unknown authentication method \"" + this._authMethod + "\"", "EAUTH", false, "API"));
		}
		/**
		* Sends a message
		*
		* @param {Object} envelope Envelope object, {from: addr, to: [addr]}
		* @param {Object} message String, Buffer or a Stream
		* @param {Function} callback Callback to return once sending is completed
		*/
		send(envelope, message, done) {
			if (!message) return done(this._formatError("Empty message", "EMESSAGE", false, "API"));
			const isDestroyedMessage = this._isDestroyedMessage("send message");
			if (isDestroyedMessage) return done(this._formatError(isDestroyedMessage, "ECONNECTION", false, "API"));
			if (this._maxAllowedSize && envelope.size > this._maxAllowedSize) return setImmediate(() => {
				done(this._formatError("Message size larger than allowed " + this._maxAllowedSize, "EMESSAGE", false, "MAIL FROM"));
			});
			let returned = false;
			let callback = function() {
				if (returned) return;
				returned = true;
				done(...arguments);
			};
			if (typeof message.on === "function") message.on("error", (err) => callback(this._formatError(err, "ESTREAM", false, "API")));
			let startTime = Date.now();
			this._setEnvelope(envelope, (err, info) => {
				if (err) {
					let stream = new PassThrough();
					if (typeof message.pipe === "function") message.pipe(stream);
					else {
						stream.write(message);
						stream.end();
					}
					return callback(err);
				}
				let envelopeTime = Date.now();
				let stream = this._createSendStream((err, str) => {
					if (err) return callback(err);
					info.envelopeTime = envelopeTime - startTime;
					info.messageTime = Date.now() - envelopeTime;
					info.messageSize = stream.outByteCount;
					info.response = str;
					return callback(null, info);
				});
				if (typeof message.pipe === "function") message.pipe(stream);
				else {
					stream.write(message);
					stream.end();
				}
			});
		}
		/**
		* Resets connection state
		*
		* @param {Function} callback Callback to return once connection is reset
		*/
		reset(callback) {
			this._sendCommand("RSET");
			this._responseActions.push((str) => {
				if (str.charAt(0) !== "2") return callback(this._formatError("Could not reset session state. response=" + str, "EPROTOCOL", str, "RSET"));
				this._envelope = false;
				return callback(null, true);
			});
		}
		/**
		* Connection listener that is run when the connection to
		* the server is opened
		*
		* @event
		*/
		_onConnect() {
			clearTimeout(this._connectionTimeout);
			this.logger.info({
				tnx: "network",
				localAddress: this._socket.localAddress,
				localPort: this._socket.localPort,
				remoteAddress: this._socket.remoteAddress,
				remotePort: this._socket.remotePort
			}, "%s established to %s:%s", this.secure ? "Secure connection" : "Connection", this._socket.remoteAddress, this._socket.remotePort);
			if (this._destroyed) {
				this.close();
				return;
			}
			this.stage = "connected";
			this._socket.removeListener("data", this._onSocketData);
			this._socket.removeListener("timeout", this._onSocketTimeout);
			this._socket.removeListener("close", this._onSocketClose);
			this._socket.removeListener("end", this._onSocketEnd);
			this._socket.on("data", this._onSocketData);
			this._socket.once("close", this._onSocketClose);
			this._socket.once("end", this._onSocketEnd);
			this._socket.setTimeout(this.options.socketTimeout || SOCKET_TIMEOUT);
			this._socket.on("timeout", this._onSocketTimeout);
			this._greetingTimeout = setTimeout(() => {
				if (this._socket && !this._destroyed && this._responseActions[0] === this._actionGreeting) this._onError("Greeting never received", "ETIMEDOUT", false, "CONN");
			}, this.options.greetingTimeout || GREETING_TIMEOUT);
			this._responseActions.push(this._actionGreeting);
			this._socket.resume();
		}
		/**
		* 'data' listener for data coming from the server
		*
		* @event
		* @param {Buffer} chunk Data chunk coming from the server
		*/
		_onData(chunk) {
			if (this._destroyed || !chunk || !chunk.length) return;
			let data = (chunk || "").toString("binary");
			let lines = (this._remainder + data).split(/\r?\n/);
			let lastline;
			this._remainder = lines.pop();
			for (let i = 0, len = lines.length; i < len; i++) {
				if (this._responseQueue.length) {
					lastline = this._responseQueue[this._responseQueue.length - 1];
					if (/^\d+-/.test(lastline.split("\n").pop())) {
						this._responseQueue[this._responseQueue.length - 1] += "\n" + lines[i];
						continue;
					}
				}
				this._responseQueue.push(lines[i]);
			}
			if (this._responseQueue.length) {
				lastline = this._responseQueue[this._responseQueue.length - 1];
				if (/^\d+-/.test(lastline.split("\n").pop())) return;
			}
			this._processResponse();
		}
		/**
		* 'error' listener for the socket
		*
		* @event
		* @param {Error} err Error object
		* @param {String} type Error name
		*/
		_onError(err, type, data, command) {
			clearTimeout(this._connectionTimeout);
			clearTimeout(this._greetingTimeout);
			if (this._destroyed) return;
			err = this._formatError(err, type, data, command);
			if ([
				"ETIMEDOUT",
				"ESOCKET",
				"ECONNECTION"
			].includes(err.code)) this.logger.warn(data, err.message);
			else this.logger.error(data, err.message);
			this.emit("error", err);
			this.close();
		}
		_formatError(message, type, response, command) {
			let err;
			if (/Error\]$/i.test(Object.prototype.toString.call(message))) err = message;
			else err = new Error(message);
			if (type && type !== "Error") err.code = type;
			if (response) {
				err.response = response;
				err.message += ": " + response;
			}
			let responseCode = typeof response === "string" && Number((response.match(/^\d+/) || [])[0]) || false;
			if (responseCode) err.responseCode = responseCode;
			if (command) err.command = command;
			return err;
		}
		/**
		* 'close' listener for the socket
		*
		* @event
		*/
		_onClose() {
			let serverResponse = false;
			if (this._remainder && this._remainder.trim()) {
				if (this.options.debug || this.options.transactionLog) this.logger.debug({ tnx: "server" }, this._remainder.replace(/\r?\n$/, ""));
				this.lastServerResponse = serverResponse = this._remainder.trim();
			}
			this.logger.info({ tnx: "network" }, "Connection closed");
			if (this.upgrading && !this._destroyed) return this._onError(/* @__PURE__ */ new Error("Connection closed unexpectedly"), "ETLS", serverResponse, "CONN");
			else if (![this._actionGreeting, this.close].includes(this._responseActions[0]) && !this._destroyed) return this._onError(/* @__PURE__ */ new Error("Connection closed unexpectedly"), "ECONNECTION", serverResponse, "CONN");
			else if (/^[45]\d{2}\b/.test(serverResponse)) return this._onError(/* @__PURE__ */ new Error("Connection closed unexpectedly"), "ECONNECTION", serverResponse, "CONN");
			this._destroy();
		}
		/**
		* 'end' listener for the socket
		*
		* @event
		*/
		_onEnd() {
			if (this._socket && !this._socket.destroyed) this._socket.destroy();
		}
		/**
		* 'timeout' listener for the socket
		*
		* @event
		*/
		_onTimeout() {
			return this._onError(/* @__PURE__ */ new Error("Timeout"), "ETIMEDOUT", false, "CONN");
		}
		/**
		* Destroys the client, emits 'end'
		*/
		_destroy() {
			if (this._destroyed) return;
			this._destroyed = true;
			this.emit("end");
		}
		/**
		* Upgrades the connection to TLS
		*
		* @param {Function} callback Callback function to run when the connection
		*        has been secured
		*/
		_upgradeConnection(callback) {
			this._socket.removeListener("data", this._onSocketData);
			this._socket.removeListener("timeout", this._onSocketTimeout);
			let socketPlain = this._socket;
			let opts = {
				socket: this._socket,
				host: this.host
			};
			Object.keys(this.options.tls || {}).forEach((key) => {
				opts[key] = this.options.tls[key];
			});
			if (this.servername && !opts.servername) opts.servername = this.servername;
			this.upgrading = true;
			try {
				this._socket = tls.connect(opts, () => {
					this.secure = true;
					this.upgrading = false;
					this._socket.on("data", this._onSocketData);
					socketPlain.removeListener("close", this._onSocketClose);
					socketPlain.removeListener("end", this._onSocketEnd);
					return callback(null, true);
				});
			} catch (err) {
				return callback(err);
			}
			this._socket.on("error", this._onSocketError);
			this._socket.once("close", this._onSocketClose);
			this._socket.once("end", this._onSocketEnd);
			this._socket.setTimeout(this.options.socketTimeout || SOCKET_TIMEOUT);
			this._socket.on("timeout", this._onSocketTimeout);
			socketPlain.resume();
		}
		/**
		* Processes queued responses from the server
		*
		* @param {Boolean} force If true, ignores _processing flag
		*/
		_processResponse() {
			if (!this._responseQueue.length) return false;
			let str = this.lastServerResponse = (this._responseQueue.shift() || "").toString();
			if (/^\d+-/.test(str.split("\n").pop())) return;
			if (this.options.debug || this.options.transactionLog) this.logger.debug({ tnx: "server" }, str.replace(/\r?\n$/, ""));
			if (!str.trim()) setImmediate(() => this._processResponse());
			let action = this._responseActions.shift();
			if (typeof action === "function") {
				action.call(this, str);
				setImmediate(() => this._processResponse());
			} else return this._onError(/* @__PURE__ */ new Error("Unexpected Response"), "EPROTOCOL", str, "CONN");
		}
		/**
		* Send a command to the server, append \r\n
		*
		* @param {String} str String to be sent to the server
		* @param {String} logStr Optional string to be used for logging instead of the actual string
		*/
		_sendCommand(str, logStr) {
			if (this._destroyed) return;
			if (this._socket.destroyed) return this.close();
			if (this.options.debug || this.options.transactionLog) this.logger.debug({ tnx: "client" }, (logStr || str || "").toString().replace(/\r?\n$/, ""));
			this._socket.write(Buffer.from(str + "\r\n", "utf-8"));
		}
		/**
		* Initiates a new message by submitting envelope data, starting with
		* MAIL FROM: command
		*
		* @param {Object} envelope Envelope object in the form of
		*        {from:'...', to:['...']}
		*        or
		*        {from:{address:'...',name:'...'}, to:[address:'...',name:'...']}
		*/
		_setEnvelope(envelope, callback) {
			let args = [];
			let useSmtpUtf8 = false;
			this._envelope = envelope || {};
			this._envelope.from = (this._envelope.from && this._envelope.from.address || this._envelope.from || "").toString().trim();
			this._envelope.to = [].concat(this._envelope.to || []).map((to) => (to && to.address || to || "").toString().trim());
			if (!this._envelope.to.length) return callback(this._formatError("No recipients defined", "EENVELOPE", false, "API"));
			if (this._envelope.from && /[\r\n<>]/.test(this._envelope.from)) return callback(this._formatError("Invalid sender " + JSON.stringify(this._envelope.from), "EENVELOPE", false, "API"));
			if (/[\x80-\uFFFF]/.test(this._envelope.from)) useSmtpUtf8 = true;
			for (let i = 0, len = this._envelope.to.length; i < len; i++) {
				if (!this._envelope.to[i] || /[\r\n<>]/.test(this._envelope.to[i])) return callback(this._formatError("Invalid recipient " + JSON.stringify(this._envelope.to[i]), "EENVELOPE", false, "API"));
				if (/[\x80-\uFFFF]/.test(this._envelope.to[i])) useSmtpUtf8 = true;
			}
			this._envelope.rcptQueue = JSON.parse(JSON.stringify(this._envelope.to || []));
			this._envelope.rejected = [];
			this._envelope.rejectedErrors = [];
			this._envelope.accepted = [];
			if (this._envelope.dsn) try {
				this._envelope.dsn = this._setDsnEnvelope(this._envelope.dsn);
			} catch (err) {
				return callback(this._formatError("Invalid DSN " + err.message, "EENVELOPE", false, "API"));
			}
			this._responseActions.push((str) => {
				this._actionMAIL(str, callback);
			});
			if (useSmtpUtf8 && this._supportedExtensions.includes("SMTPUTF8")) {
				args.push("SMTPUTF8");
				this._usingSmtpUtf8 = true;
			}
			if (this._envelope.use8BitMime && this._supportedExtensions.includes("8BITMIME")) {
				args.push("BODY=8BITMIME");
				this._using8BitMime = true;
			}
			if (this._envelope.size && this._supportedExtensions.includes("SIZE")) args.push("SIZE=" + this._envelope.size);
			if (this._envelope.dsn && this._supportedExtensions.includes("DSN")) {
				if (this._envelope.dsn.ret) args.push("RET=" + shared.encodeXText(this._envelope.dsn.ret));
				if (this._envelope.dsn.envid) args.push("ENVID=" + shared.encodeXText(this._envelope.dsn.envid));
			}
			if (this._envelope.requireTLSExtensionEnabled) {
				if (!this.secure) return callback(this._formatError("REQUIRETLS can only be used over TLS connections (RFC 8689)", "EREQUIRETLS", false, "MAIL FROM"));
				if (!this._supportedExtensions.includes("REQUIRETLS")) return callback(this._formatError("Server does not support REQUIRETLS extension (RFC 8689)", "EREQUIRETLS", false, "MAIL FROM"));
				args.push("REQUIRETLS");
			}
			this._sendCommand("MAIL FROM:<" + this._envelope.from + ">" + (args.length ? " " + args.join(" ") : ""));
		}
		_setDsnEnvelope(params) {
			let ret = (params.ret || params.return || "").toString().toUpperCase() || null;
			if (ret) switch (ret) {
				case "HDRS":
				case "HEADERS":
					ret = "HDRS";
					break;
				case "FULL":
				case "BODY":
					ret = "FULL";
					break;
			}
			if (ret && !["FULL", "HDRS"].includes(ret)) throw new Error("ret: " + JSON.stringify(ret));
			let envid = (params.envid || params.id || "").toString() || null;
			let notify = params.notify || null;
			if (notify) {
				if (typeof notify === "string") notify = notify.split(",");
				notify = notify.map((n) => n.trim().toUpperCase());
				let validNotify = [
					"NEVER",
					"SUCCESS",
					"FAILURE",
					"DELAY"
				];
				if (notify.filter((n) => !validNotify.includes(n)).length || notify.length > 1 && notify.includes("NEVER")) throw new Error("notify: " + JSON.stringify(notify.join(",")));
				notify = notify.join(",");
			}
			let orcpt = (params.recipient || params.orcpt || "").toString() || null;
			if (orcpt && orcpt.indexOf(";") < 0) orcpt = "rfc822;" + orcpt;
			return {
				ret,
				envid,
				notify,
				orcpt
			};
		}
		_getDsnRcptToArgs() {
			let args = [];
			if (this._envelope.dsn && this._supportedExtensions.includes("DSN")) {
				if (this._envelope.dsn.notify) args.push("NOTIFY=" + shared.encodeXText(this._envelope.dsn.notify));
				if (this._envelope.dsn.orcpt) args.push("ORCPT=" + shared.encodeXText(this._envelope.dsn.orcpt));
			}
			return args.length ? " " + args.join(" ") : "";
		}
		_createSendStream(callback) {
			let dataStream = new DataStream();
			let logStream;
			if (this.options.lmtp) this._envelope.accepted.forEach((recipient, i) => {
				let final = i === this._envelope.accepted.length - 1;
				this._responseActions.push((str) => {
					this._actionLMTPStream(recipient, final, str, callback);
				});
			});
			else this._responseActions.push((str) => {
				this._actionSMTPStream(str, callback);
			});
			dataStream.pipe(this._socket, { end: false });
			if (this.options.debug) {
				logStream = new PassThrough();
				logStream.on("readable", () => {
					let chunk;
					while (chunk = logStream.read()) this.logger.debug({ tnx: "message" }, chunk.toString("binary").replace(/\r?\n$/, ""));
				});
				dataStream.pipe(logStream);
			}
			dataStream.once("end", () => {
				this.logger.info({
					tnx: "message",
					inByteCount: dataStream.inByteCount,
					outByteCount: dataStream.outByteCount
				}, "<%s bytes encoded mime message (source size %s bytes)>", dataStream.outByteCount, dataStream.inByteCount);
			});
			return dataStream;
		}
		/** ACTIONS **/
		/**
		* Will be run after the connection is created and the server sends
		* a greeting. If the incoming message starts with 220 initiate
		* SMTP session by sending EHLO command
		*
		* @param {String} str Message from the server
		*/
		_actionGreeting(str) {
			clearTimeout(this._greetingTimeout);
			if (str.substr(0, 3) !== "220") {
				this._onError(/* @__PURE__ */ new Error("Invalid greeting. response=" + str), "EPROTOCOL", str, "CONN");
				return;
			}
			if (this.options.lmtp) {
				this._responseActions.push(this._actionLHLO);
				this._sendCommand("LHLO " + this.name);
			} else {
				this._responseActions.push(this._actionEHLO);
				this._sendCommand("EHLO " + this.name);
			}
		}
		/**
		* Handles server response for LHLO command. If it yielded in
		* error, emit 'error', otherwise treat this as an EHLO response
		*
		* @param {String} str Message from the server
		*/
		_actionLHLO(str) {
			if (str.charAt(0) !== "2") {
				this._onError(/* @__PURE__ */ new Error("Invalid LHLO. response=" + str), "EPROTOCOL", str, "LHLO");
				return;
			}
			this._actionEHLO(str);
		}
		/**
		* Handles server response for EHLO command. If it yielded in
		* error, try HELO instead, otherwise initiate TLS negotiation
		* if STARTTLS is supported by the server or move into the
		* authentication phase.
		*
		* @param {String} str Message from the server
		*/
		_actionEHLO(str) {
			let match;
			if (str.substr(0, 3) === "421") {
				this._onError(/* @__PURE__ */ new Error("Server terminates connection. response=" + str), "ECONNECTION", str, "EHLO");
				return;
			}
			if (str.charAt(0) !== "2") {
				if (this.options.requireTLS) {
					this._onError(/* @__PURE__ */ new Error("EHLO failed but HELO does not support required STARTTLS. response=" + str), "ECONNECTION", str, "EHLO");
					return;
				}
				this._responseActions.push(this._actionHELO);
				this._sendCommand("HELO " + this.name);
				return;
			}
			this._ehloLines = str.split(/\r?\n/).map((line) => line.replace(/^\d+[ -]/, "").trim()).filter((line) => line).slice(1);
			if (!this.secure && !this.options.ignoreTLS && (/[ -]STARTTLS\b/im.test(str) || this.options.requireTLS)) {
				this._sendCommand("STARTTLS");
				this._responseActions.push(this._actionSTARTTLS);
				return;
			}
			if (/[ -]SMTPUTF8\b/im.test(str)) this._supportedExtensions.push("SMTPUTF8");
			if (/[ -]DSN\b/im.test(str)) this._supportedExtensions.push("DSN");
			if (/[ -]8BITMIME\b/im.test(str)) this._supportedExtensions.push("8BITMIME");
			if (/[ -]REQUIRETLS\b/im.test(str)) this._supportedExtensions.push("REQUIRETLS");
			if (/[ -]PIPELINING\b/im.test(str)) this._supportedExtensions.push("PIPELINING");
			if (/[ -]AUTH\b/i.test(str)) this.allowsAuth = true;
			if (/[ -]AUTH(?:(\s+|=)[^\n]*\s+|\s+|=)PLAIN/i.test(str)) this._supportedAuth.push("PLAIN");
			if (/[ -]AUTH(?:(\s+|=)[^\n]*\s+|\s+|=)LOGIN/i.test(str)) this._supportedAuth.push("LOGIN");
			if (/[ -]AUTH(?:(\s+|=)[^\n]*\s+|\s+|=)CRAM-MD5/i.test(str)) this._supportedAuth.push("CRAM-MD5");
			if (/[ -]AUTH(?:(\s+|=)[^\n]*\s+|\s+|=)XOAUTH2/i.test(str)) this._supportedAuth.push("XOAUTH2");
			if (match = str.match(/[ -]SIZE(?:[ \t]+(\d+))?/im)) {
				this._supportedExtensions.push("SIZE");
				this._maxAllowedSize = Number(match[1]) || 0;
			}
			this.emit("connect");
		}
		/**
		* Handles server response for HELO command. If it yielded in
		* error, emit 'error', otherwise move into the authentication phase.
		*
		* @param {String} str Message from the server
		*/
		_actionHELO(str) {
			if (str.charAt(0) !== "2") {
				this._onError(/* @__PURE__ */ new Error("Invalid HELO. response=" + str), "EPROTOCOL", str, "HELO");
				return;
			}
			this.allowsAuth = true;
			this.emit("connect");
		}
		/**
		* Handles server response for STARTTLS command. If there's an error
		* try HELO instead, otherwise initiate TLS upgrade. If the upgrade
		* succeedes restart the EHLO
		*
		* @param {String} str Message from the server
		*/
		_actionSTARTTLS(str) {
			if (str.charAt(0) !== "2") {
				if (this.options.opportunisticTLS) {
					this.logger.info({ tnx: "smtp" }, "Failed STARTTLS upgrade, continuing unencrypted");
					return this.emit("connect");
				}
				this._onError(/* @__PURE__ */ new Error("Error upgrading connection with STARTTLS"), "ETLS", str, "STARTTLS");
				return;
			}
			this._upgradeConnection((err, secured) => {
				if (err) {
					this._onError(/* @__PURE__ */ new Error("Error initiating TLS - " + (err.message || err)), "ETLS", false, "STARTTLS");
					return;
				}
				this.logger.info({ tnx: "smtp" }, "Connection upgraded with STARTTLS");
				if (secured) if (this.options.lmtp) {
					this._responseActions.push(this._actionLHLO);
					this._sendCommand("LHLO " + this.name);
				} else {
					this._responseActions.push(this._actionEHLO);
					this._sendCommand("EHLO " + this.name);
				}
				else this.emit("connect");
			});
		}
		/**
		* Handle the response for AUTH LOGIN command. We are expecting
		* '334 VXNlcm5hbWU6' (base64 for 'Username:'). Data to be sent as
		* response needs to be base64 encoded username. We do not need
		* exact match but settle with 334 response in general as some
		* hosts invalidly use a longer message than VXNlcm5hbWU6
		*
		* @param {String} str Message from the server
		*/
		_actionAUTH_LOGIN_USER(str, callback) {
			if (!/^334[ -]/.test(str)) {
				callback(this._formatError("Invalid login sequence while waiting for \"334 VXNlcm5hbWU6\"", "EAUTH", str, "AUTH LOGIN"));
				return;
			}
			this._responseActions.push((str) => {
				this._actionAUTH_LOGIN_PASS(str, callback);
			});
			this._sendCommand(Buffer.from(this._auth.credentials.user + "", "utf-8").toString("base64"));
		}
		/**
		* Handle the response for AUTH CRAM-MD5 command. We are expecting
		* '334 <challenge string>'. Data to be sent as response needs to be
		* base64 decoded challenge string, MD5 hashed using the password as
		* a HMAC key, prefixed by the username and a space, and finally all
		* base64 encoded again.
		*
		* @param {String} str Message from the server
		*/
		_actionAUTH_CRAM_MD5(str, callback) {
			let challengeMatch = str.match(/^334\s+(.+)$/);
			let challengeString = "";
			if (!challengeMatch) return callback(this._formatError("Invalid login sequence while waiting for server challenge string", "EAUTH", str, "AUTH CRAM-MD5"));
			else challengeString = challengeMatch[1];
			let base64decoded = Buffer.from(challengeString, "base64").toString("ascii"), hmacMD5 = crypto$1.createHmac("md5", this._auth.credentials.pass);
			hmacMD5.update(base64decoded);
			let prepended = this._auth.credentials.user + " " + hmacMD5.digest("hex");
			this._responseActions.push((str) => {
				this._actionAUTH_CRAM_MD5_PASS(str, callback);
			});
			this._sendCommand(Buffer.from(prepended).toString("base64"), Buffer.from(this._auth.credentials.user + " /* secret */").toString("base64"));
		}
		/**
		* Handles the response to CRAM-MD5 authentication, if there's no error,
		* the user can be considered logged in. Start waiting for a message to send
		*
		* @param {String} str Message from the server
		*/
		_actionAUTH_CRAM_MD5_PASS(str, callback) {
			if (!str.match(/^235\s+/)) return callback(this._formatError("Invalid login sequence while waiting for \"235\"", "EAUTH", str, "AUTH CRAM-MD5"));
			this.logger.info({
				tnx: "smtp",
				username: this._auth.user,
				action: "authenticated",
				method: this._authMethod
			}, "User %s authenticated", JSON.stringify(this._auth.user));
			this.authenticated = true;
			callback(null, true);
		}
		/**
		* Handle the response for AUTH LOGIN command. We are expecting
		* '334 UGFzc3dvcmQ6' (base64 for 'Password:'). Data to be sent as
		* response needs to be base64 encoded password.
		*
		* @param {String} str Message from the server
		*/
		_actionAUTH_LOGIN_PASS(str, callback) {
			if (!/^334[ -]/.test(str)) return callback(this._formatError("Invalid login sequence while waiting for \"334 UGFzc3dvcmQ6\"", "EAUTH", str, "AUTH LOGIN"));
			this._responseActions.push((str) => {
				this._actionAUTHComplete(str, callback);
			});
			this._sendCommand(Buffer.from((this._auth.credentials.pass || "").toString(), "utf-8").toString("base64"), Buffer.from("/* secret */", "utf-8").toString("base64"));
		}
		/**
		* Handles the response for authentication, if there's no error,
		* the user can be considered logged in. Start waiting for a message to send
		*
		* @param {String} str Message from the server
		*/
		_actionAUTHComplete(str, isRetry, callback) {
			if (!callback && typeof isRetry === "function") {
				callback = isRetry;
				isRetry = false;
			}
			if (str.substr(0, 3) === "334") {
				this._responseActions.push((str) => {
					if (isRetry || this._authMethod !== "XOAUTH2") this._actionAUTHComplete(str, true, callback);
					else setImmediate(() => this._handleXOauth2Token(true, callback));
				});
				this._sendCommand("");
				return;
			}
			if (str.charAt(0) !== "2") {
				this.logger.info({
					tnx: "smtp",
					username: this._auth.user,
					action: "authfail",
					method: this._authMethod
				}, "User %s failed to authenticate", JSON.stringify(this._auth.user));
				return callback(this._formatError("Invalid login", "EAUTH", str, "AUTH " + this._authMethod));
			}
			this.logger.info({
				tnx: "smtp",
				username: this._auth.user,
				action: "authenticated",
				method: this._authMethod
			}, "User %s authenticated", JSON.stringify(this._auth.user));
			this.authenticated = true;
			callback(null, true);
		}
		/**
		* Handle response for a MAIL FROM: command
		*
		* @param {String} str Message from the server
		*/
		_actionMAIL(str, callback) {
			let message, curRecipient;
			if (Number(str.charAt(0)) !== 2) {
				if (this._usingSmtpUtf8 && /^550 /.test(str) && /[\x80-\uFFFF]/.test(this._envelope.from)) message = "Internationalized mailbox name not allowed";
				else message = "Mail command failed";
				return callback(this._formatError(message, "EENVELOPE", str, "MAIL FROM"));
			}
			if (!this._envelope.rcptQueue.length) return callback(this._formatError("Can't send mail - no recipients defined", "EENVELOPE", false, "API"));
			else {
				this._recipientQueue = [];
				if (this._supportedExtensions.includes("PIPELINING")) while (this._envelope.rcptQueue.length) {
					curRecipient = this._envelope.rcptQueue.shift();
					this._recipientQueue.push(curRecipient);
					this._responseActions.push((str) => {
						this._actionRCPT(str, callback);
					});
					this._sendCommand("RCPT TO:<" + curRecipient + ">" + this._getDsnRcptToArgs());
				}
				else {
					curRecipient = this._envelope.rcptQueue.shift();
					this._recipientQueue.push(curRecipient);
					this._responseActions.push((str) => {
						this._actionRCPT(str, callback);
					});
					this._sendCommand("RCPT TO:<" + curRecipient + ">" + this._getDsnRcptToArgs());
				}
			}
		}
		/**
		* Handle response for a RCPT TO: command
		*
		* @param {String} str Message from the server
		*/
		_actionRCPT(str, callback) {
			let message, err, curRecipient = this._recipientQueue.shift();
			if (Number(str.charAt(0)) !== 2) {
				if (this._usingSmtpUtf8 && /^553 /.test(str) && /[\x80-\uFFFF]/.test(curRecipient)) message = "Internationalized mailbox name not allowed";
				else message = "Recipient command failed";
				this._envelope.rejected.push(curRecipient);
				err = this._formatError(message, "EENVELOPE", str, "RCPT TO");
				err.recipient = curRecipient;
				this._envelope.rejectedErrors.push(err);
			} else this._envelope.accepted.push(curRecipient);
			if (!this._envelope.rcptQueue.length && !this._recipientQueue.length) if (this._envelope.rejected.length < this._envelope.to.length) {
				this._responseActions.push((str) => {
					this._actionDATA(str, callback);
				});
				this._sendCommand("DATA");
			} else {
				err = this._formatError("Can't send mail - all recipients were rejected", "EENVELOPE", str, "RCPT TO");
				err.rejected = this._envelope.rejected;
				err.rejectedErrors = this._envelope.rejectedErrors;
				return callback(err);
			}
			else if (this._envelope.rcptQueue.length) {
				curRecipient = this._envelope.rcptQueue.shift();
				this._recipientQueue.push(curRecipient);
				this._responseActions.push((str) => {
					this._actionRCPT(str, callback);
				});
				this._sendCommand("RCPT TO:<" + curRecipient + ">" + this._getDsnRcptToArgs());
			}
		}
		/**
		* Handle response for a DATA command
		*
		* @param {String} str Message from the server
		*/
		_actionDATA(str, callback) {
			if (!/^[23]/.test(str)) return callback(this._formatError("Data command failed", "EENVELOPE", str, "DATA"));
			let response = {
				accepted: this._envelope.accepted,
				rejected: this._envelope.rejected
			};
			if (this._ehloLines && this._ehloLines.length) response.ehlo = this._ehloLines;
			if (this._envelope.rejectedErrors.length) response.rejectedErrors = this._envelope.rejectedErrors;
			callback(null, response);
		}
		/**
		* Handle response for a DATA stream when using SMTP
		* We expect a single response that defines if the sending succeeded or failed
		*
		* @param {String} str Message from the server
		*/
		_actionSMTPStream(str, callback) {
			if (Number(str.charAt(0)) !== 2) return callback(this._formatError("Message failed", "EMESSAGE", str, "DATA"));
			else return callback(null, str);
		}
		/**
		* Handle response for a DATA stream
		* We expect a separate response for every recipient. All recipients can either
		* succeed or fail separately
		*
		* @param {String} recipient The recipient this response applies to
		* @param {Boolean} final Is this the final recipient?
		* @param {String} str Message from the server
		*/
		_actionLMTPStream(recipient, final, str, callback) {
			let err;
			if (Number(str.charAt(0)) !== 2) {
				err = this._formatError("Message failed for recipient " + recipient, "EMESSAGE", str, "DATA");
				err.recipient = recipient;
				this._envelope.rejected.push(recipient);
				this._envelope.rejectedErrors.push(err);
				for (let i = 0, len = this._envelope.accepted.length; i < len; i++) if (this._envelope.accepted[i] === recipient) this._envelope.accepted.splice(i, 1);
			}
			if (final) return callback(null, str);
		}
		_handleXOauth2Token(isRetry, callback) {
			this._auth.oauth2.getToken(isRetry, (err, accessToken) => {
				if (err) {
					this.logger.info({
						tnx: "smtp",
						username: this._auth.user,
						action: "authfail",
						method: this._authMethod
					}, "User %s failed to authenticate", JSON.stringify(this._auth.user));
					return callback(this._formatError(err, "EAUTH", false, "AUTH XOAUTH2"));
				}
				this._responseActions.push((str) => {
					this._actionAUTHComplete(str, isRetry, callback);
				});
				this._sendCommand("AUTH XOAUTH2 " + this._auth.oauth2.buildXOAuth2Token(accessToken), "AUTH XOAUTH2 " + this._auth.oauth2.buildXOAuth2Token("/* secret */"));
			});
		}
		/**
		*
		* @param {string} command
		* @private
		*/
		_isDestroyedMessage(command) {
			if (this._destroyed) return "Cannot " + command + " - smtp connection is already destroyed.";
			if (this._socket) {
				if (this._socket.destroyed) return "Cannot " + command + " - smtp connection socket is already destroyed.";
				if (!this._socket.writable) return "Cannot " + command + " - smtp connection socket is already half-closed.";
			}
		}
		_getHostname() {
			let defaultHostname;
			try {
				defaultHostname = os.hostname() || "";
			} catch (_err) {
				defaultHostname = "localhost";
			}
			if (!defaultHostname || defaultHostname.indexOf(".") < 0) defaultHostname = "[127.0.0.1]";
			if (defaultHostname.match(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/)) defaultHostname = "[" + defaultHostname + "]";
			return defaultHostname;
		}
	};
	module.exports = SMTPConnection;
}));
//#endregion
//#region node_modules/nodemailer/lib/xoauth2/index.js
var require_xoauth2 = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const Stream = __require("stream").Stream;
	const nmfetch = require_fetch();
	const crypto = __require("crypto");
	const shared = require_shared();
	/**
	* XOAUTH2 access_token generator for Gmail.
	* Create client ID for web applications in Google API console to use it.
	* See Offline Access for receiving the needed refreshToken for an user
	* https://developers.google.com/accounts/docs/OAuth2WebServer#offline
	*
	* Usage for generating access tokens with a custom method using provisionCallback:
	* provisionCallback(user, renew, callback)
	*   * user is the username to get the token for
	*   * renew is a boolean that if true indicates that existing token failed and needs to be renewed
	*   * callback is the callback to run with (error, accessToken [, expires])
	*     * accessToken is a string
	*     * expires is an optional expire time in milliseconds
	* If provisionCallback is used, then Nodemailer does not try to attempt generating the token by itself
	*
	* @constructor
	* @param {Object} options Client information for token generation
	* @param {String} options.user User e-mail address
	* @param {String} options.clientId Client ID value
	* @param {String} options.clientSecret Client secret value
	* @param {String} options.refreshToken Refresh token for an user
	* @param {String} options.accessUrl Endpoint for token generation, defaults to 'https://accounts.google.com/o/oauth2/token'
	* @param {String} options.accessToken An existing valid accessToken
	* @param {String} options.privateKey Private key for JSW
	* @param {Number} options.expires Optional Access Token expire time in ms
	* @param {Number} options.timeout Optional TTL for Access Token in seconds
	* @param {Function} options.provisionCallback Function to run when a new access token is required
	*/
	var XOAuth2 = class extends Stream {
		constructor(options, logger) {
			super();
			this.options = options || {};
			if (options && options.serviceClient) {
				if (!options.privateKey || !options.user) {
					setImmediate(() => this.emit("error", /* @__PURE__ */ new Error("Options \"privateKey\" and \"user\" are required for service account!")));
					return;
				}
				let serviceRequestTimeout = Math.min(Math.max(Number(this.options.serviceRequestTimeout) || 0, 0), 3600);
				this.options.serviceRequestTimeout = serviceRequestTimeout || 300;
			}
			this.logger = shared.getLogger({ logger }, { component: this.options.component || "OAuth2" });
			this.provisionCallback = typeof this.options.provisionCallback === "function" ? this.options.provisionCallback : false;
			this.options.accessUrl = this.options.accessUrl || "https://accounts.google.com/o/oauth2/token";
			this.options.customHeaders = this.options.customHeaders || {};
			this.options.customParams = this.options.customParams || {};
			this.accessToken = this.options.accessToken || false;
			if (this.options.expires && Number(this.options.expires)) this.expires = this.options.expires;
			else {
				let timeout = Math.max(Number(this.options.timeout) || 0, 0);
				this.expires = timeout && Date.now() + timeout * 1e3 || 0;
			}
			this.renewing = false;
			this.renewalQueue = [];
		}
		/**
		* Returns or generates (if previous has expired) a XOAuth2 token
		*
		* @param {Boolean} renew If false then use cached access token (if available)
		* @param {Function} callback Callback function with error object and token string
		*/
		getToken(renew, callback) {
			if (!renew && this.accessToken && (!this.expires || this.expires > Date.now())) {
				this.logger.debug({
					tnx: "OAUTH2",
					user: this.options.user,
					action: "reuse"
				}, "Reusing existing access token for %s", this.options.user);
				return callback(null, this.accessToken);
			}
			if (!this.provisionCallback && !this.options.refreshToken && !this.options.serviceClient) {
				if (this.accessToken) {
					this.logger.debug({
						tnx: "OAUTH2",
						user: this.options.user,
						action: "reuse"
					}, "Reusing existing access token (no refresh capability) for %s", this.options.user);
					return callback(null, this.accessToken);
				}
				this.logger.error({
					tnx: "OAUTH2",
					user: this.options.user,
					action: "renew"
				}, "Cannot renew access token for %s: No refresh mechanism available", this.options.user);
				return callback(/* @__PURE__ */ new Error("Can't create new access token for user"));
			}
			if (this.renewing) return this.renewalQueue.push({
				renew,
				callback
			});
			this.renewing = true;
			const generateCallback = (err, accessToken) => {
				this.renewalQueue.forEach((item) => item.callback(err, accessToken));
				this.renewalQueue = [];
				this.renewing = false;
				if (err) this.logger.error({
					err,
					tnx: "OAUTH2",
					user: this.options.user,
					action: "renew"
				}, "Failed generating new Access Token for %s", this.options.user);
				else this.logger.info({
					tnx: "OAUTH2",
					user: this.options.user,
					action: "renew"
				}, "Generated new Access Token for %s", this.options.user);
				callback(err, accessToken);
			};
			if (this.provisionCallback) this.provisionCallback(this.options.user, !!renew, (err, accessToken, expires) => {
				if (!err && accessToken) {
					this.accessToken = accessToken;
					this.expires = expires || 0;
				}
				generateCallback(err, accessToken);
			});
			else this.generateToken(generateCallback);
		}
		/**
		* Updates token values
		*
		* @param {String} accessToken New access token
		* @param {Number} timeout Access token lifetime in seconds
		*
		* Emits 'token': { user: User email-address, accessToken: the new accessToken, timeout: TTL in seconds}
		*/
		updateToken(accessToken, timeout) {
			this.accessToken = accessToken;
			timeout = Math.max(Number(timeout) || 0, 0);
			this.expires = timeout && Date.now() + timeout * 1e3 || 0;
			this.emit("token", {
				user: this.options.user,
				accessToken: accessToken || "",
				expires: this.expires
			});
		}
		/**
		* Generates a new XOAuth2 token with the credentials provided at initialization
		*
		* @param {Function} callback Callback function with error object and token string
		*/
		generateToken(callback) {
			let urlOptions;
			let loggedUrlOptions;
			if (this.options.serviceClient) {
				let iat = Math.floor(Date.now() / 1e3);
				let tokenData = {
					iss: this.options.serviceClient,
					scope: this.options.scope || "https://mail.google.com/",
					sub: this.options.user,
					aud: this.options.accessUrl,
					iat,
					exp: iat + this.options.serviceRequestTimeout
				};
				let token;
				try {
					token = this.jwtSignRS256(tokenData);
				} catch (_err) {
					return callback(/* @__PURE__ */ new Error("Can't generate token. Check your auth options"));
				}
				urlOptions = {
					grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
					assertion: token
				};
				loggedUrlOptions = {
					grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
					assertion: tokenData
				};
			} else {
				if (!this.options.refreshToken) return callback(/* @__PURE__ */ new Error("Can't create new access token for user"));
				urlOptions = {
					client_id: this.options.clientId || "",
					client_secret: this.options.clientSecret || "",
					refresh_token: this.options.refreshToken,
					grant_type: "refresh_token"
				};
				loggedUrlOptions = {
					client_id: this.options.clientId || "",
					client_secret: (this.options.clientSecret || "").substr(0, 6) + "...",
					refresh_token: (this.options.refreshToken || "").substr(0, 6) + "...",
					grant_type: "refresh_token"
				};
			}
			Object.keys(this.options.customParams).forEach((key) => {
				urlOptions[key] = this.options.customParams[key];
				loggedUrlOptions[key] = this.options.customParams[key];
			});
			this.logger.debug({
				tnx: "OAUTH2",
				user: this.options.user,
				action: "generate"
			}, "Requesting token using: %s", JSON.stringify(loggedUrlOptions));
			this.postRequest(this.options.accessUrl, urlOptions, this.options, (error, body) => {
				let data;
				if (error) return callback(error);
				try {
					data = JSON.parse(body.toString());
				} catch (E) {
					return callback(E);
				}
				if (!data || typeof data !== "object") {
					this.logger.debug({
						tnx: "OAUTH2",
						user: this.options.user,
						action: "post"
					}, "Response: %s", (body || "").toString());
					return callback(/* @__PURE__ */ new Error("Invalid authentication response"));
				}
				let logData = {};
				Object.keys(data).forEach((key) => {
					if (key !== "access_token") logData[key] = data[key];
					else logData[key] = (data[key] || "").toString().substr(0, 6) + "...";
				});
				this.logger.debug({
					tnx: "OAUTH2",
					user: this.options.user,
					action: "post"
				}, "Response: %s", JSON.stringify(logData));
				if (data.error) {
					let errorMessage = data.error;
					if (data.error_description) errorMessage += ": " + data.error_description;
					if (data.error_uri) errorMessage += " (" + data.error_uri + ")";
					return callback(new Error(errorMessage));
				}
				if (data.access_token) {
					this.updateToken(data.access_token, data.expires_in);
					return callback(null, this.accessToken);
				}
				return callback(/* @__PURE__ */ new Error("No access token"));
			});
		}
		/**
		* Converts an access_token and user id into a base64 encoded XOAuth2 token
		*
		* @param {String} [accessToken] Access token string
		* @return {String} Base64 encoded token for IMAP or SMTP login
		*/
		buildXOAuth2Token(accessToken) {
			let authData = [
				"user=" + (this.options.user || ""),
				"auth=Bearer " + (accessToken || this.accessToken),
				"",
				""
			];
			return Buffer.from(authData.join(""), "utf-8").toString("base64");
		}
		/**
		* Custom POST request handler.
		* This is only needed to keep paths short in Windows – usually this module
		* is a dependency of a dependency and if it tries to require something
		* like the request module the paths get way too long to handle for Windows.
		* As we do only a simple POST request we do not actually require complicated
		* logic support (no redirects, no nothing) anyway.
		*
		* @param {String} url Url to POST to
		* @param {String|Buffer} payload Payload to POST
		* @param {Function} callback Callback function with (err, buff)
		*/
		postRequest(url, payload, params, callback) {
			let returned = false;
			let chunks = [];
			let chunklen = 0;
			let req = nmfetch(url, {
				method: "post",
				headers: params.customHeaders,
				body: payload,
				allowErrorResponse: true
			});
			req.on("readable", () => {
				let chunk;
				while ((chunk = req.read()) !== null) {
					chunks.push(chunk);
					chunklen += chunk.length;
				}
			});
			req.once("error", (err) => {
				if (returned) return;
				returned = true;
				return callback(err);
			});
			req.once("end", () => {
				if (returned) return;
				returned = true;
				return callback(null, Buffer.concat(chunks, chunklen));
			});
		}
		/**
		* Encodes a buffer or a string into Base64url format
		*
		* @param {Buffer|String} data The data to convert
		* @return {String} The encoded string
		*/
		toBase64URL(data) {
			if (typeof data === "string") data = Buffer.from(data);
			return data.toString("base64").replace(/[=]+/g, "").replace(/\+/g, "-").replace(/\//g, "_");
		}
		/**
		* Creates a JSON Web Token signed with RS256 (SHA256 + RSA)
		*
		* @param {Object} payload The payload to include in the generated token
		* @return {String} The generated and signed token
		*/
		jwtSignRS256(payload) {
			payload = ["{\"alg\":\"RS256\",\"typ\":\"JWT\"}", JSON.stringify(payload)].map((val) => this.toBase64URL(val)).join(".");
			let signature = crypto.createSign("RSA-SHA256").update(payload).sign(this.options.privateKey);
			return payload + "." + this.toBase64URL(signature);
		}
	};
	module.exports = XOAuth2;
}));
//#endregion
//#region node_modules/nodemailer/lib/smtp-pool/pool-resource.js
var require_pool_resource = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const SMTPConnection = require_smtp_connection();
	const assign = require_shared().assign;
	const XOAuth2 = require_xoauth2();
	const EventEmitter$3 = __require("events");
	/**
	* Creates an element for the pool
	*
	* @constructor
	* @param {Object} options SMTPPool instance
	*/
	var PoolResource = class extends EventEmitter$3 {
		constructor(pool) {
			super();
			this.pool = pool;
			this.options = pool.options;
			this.logger = this.pool.logger;
			if (this.options.auth) switch ((this.options.auth.type || "").toString().toUpperCase()) {
				case "OAUTH2": {
					let oauth2 = new XOAuth2(this.options.auth, this.logger);
					oauth2.provisionCallback = this.pool.mailer && this.pool.mailer.get("oauth2_provision_cb") || oauth2.provisionCallback;
					this.auth = {
						type: "OAUTH2",
						user: this.options.auth.user,
						oauth2,
						method: "XOAUTH2"
					};
					oauth2.on("token", (token) => this.pool.mailer.emit("token", token));
					oauth2.on("error", (err) => this.emit("error", err));
					break;
				}
				default:
					if (!this.options.auth.user && !this.options.auth.pass) break;
					this.auth = {
						type: (this.options.auth.type || "").toString().toUpperCase() || "LOGIN",
						user: this.options.auth.user,
						credentials: {
							user: this.options.auth.user || "",
							pass: this.options.auth.pass,
							options: this.options.auth.options
						},
						method: (this.options.auth.method || "").trim().toUpperCase() || this.options.authMethod || false
					};
			}
			this._connection = false;
			this._connected = false;
			this.messages = 0;
			this.available = true;
		}
		/**
		* Initiates a connection to the SMTP server
		*
		* @param {Function} callback Callback function to run once the connection is established or failed
		*/
		connect(callback) {
			this.pool.getSocket(this.options, (err, socketOptions) => {
				if (err) return callback(err);
				let returned = false;
				let options = this.options;
				if (socketOptions && socketOptions.connection) {
					this.logger.info({
						tnx: "proxy",
						remoteAddress: socketOptions.connection.remoteAddress,
						remotePort: socketOptions.connection.remotePort,
						destHost: options.host || "",
						destPort: options.port || "",
						action: "connected"
					}, "Using proxied socket from %s:%s to %s:%s", socketOptions.connection.remoteAddress, socketOptions.connection.remotePort, options.host || "", options.port || "");
					options = assign(false, options);
					Object.keys(socketOptions).forEach((key) => {
						options[key] = socketOptions[key];
					});
				}
				this.connection = new SMTPConnection(options);
				this.connection.once("error", (err) => {
					this.emit("error", err);
					if (returned) return;
					returned = true;
					return callback(err);
				});
				this.connection.once("end", () => {
					this.close();
					if (returned) return;
					returned = true;
					let timer = setTimeout(() => {
						if (returned) return;
						let err = /* @__PURE__ */ new Error("Unexpected socket close");
						if (this.connection && this.connection._socket && this.connection._socket.upgrading) err.code = "ETLS";
						callback(err);
					}, 1e3);
					try {
						timer.unref();
					} catch (_E) {}
				});
				this.connection.connect(() => {
					if (returned) return;
					if (this.auth && (this.connection.allowsAuth || options.forceAuth)) this.connection.login(this.auth, (err) => {
						if (returned) return;
						returned = true;
						if (err) {
							this.connection.close();
							this.emit("error", err);
							return callback(err);
						}
						this._connected = true;
						callback(null, true);
					});
					else {
						returned = true;
						this._connected = true;
						return callback(null, true);
					}
				});
			});
		}
		/**
		* Sends an e-mail to be sent using the selected settings
		*
		* @param {Object} mail Mail object
		* @param {Function} callback Callback function
		*/
		send(mail, callback) {
			if (!this._connected) return this.connect((err) => {
				if (err) return callback(err);
				return this.send(mail, callback);
			});
			let envelope = mail.message.getEnvelope();
			let messageId = mail.message.messageId();
			let recipients = [].concat(envelope.to || []);
			if (recipients.length > 3) recipients.push("...and " + recipients.splice(2).length + " more");
			this.logger.info({
				tnx: "send",
				messageId,
				cid: this.id
			}, "Sending message %s using #%s to <%s>", messageId, this.id, recipients.join(", "));
			if (mail.data.dsn) envelope.dsn = mail.data.dsn;
			if (mail.data.requireTLSExtensionEnabled) envelope.requireTLSExtensionEnabled = mail.data.requireTLSExtensionEnabled;
			this.connection.send(envelope, mail.message.createReadStream(), (err, info) => {
				this.messages++;
				if (err) {
					this.connection.close();
					this.emit("error", err);
					return callback(err);
				}
				info.envelope = {
					from: envelope.from,
					to: envelope.to
				};
				info.messageId = messageId;
				setImmediate(() => {
					let err;
					if (this.messages >= this.options.maxMessages) {
						err = /* @__PURE__ */ new Error("Resource exhausted");
						err.code = "EMAXLIMIT";
						this.connection.close();
						this.emit("error", err);
					} else this.pool._checkRateLimit(() => {
						this.available = true;
						this.emit("available");
					});
				});
				callback(null, info);
			});
		}
		/**
		* Closes the connection
		*/
		close() {
			this._connected = false;
			if (this.auth && this.auth.oauth2) this.auth.oauth2.removeAllListeners();
			if (this.connection) this.connection.close();
			this.emit("close");
		}
	};
	module.exports = PoolResource;
}));
//#endregion
//#region node_modules/nodemailer/lib/well-known/services.json
var require_services = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	module.exports = {
		"1und1": {
			"description": "1&1 Mail (German hosting provider)",
			"host": "smtp.1und1.de",
			"port": 465,
			"secure": true,
			"authMethod": "LOGIN"
		},
		"126": {
			"description": "126 Mail (NetEase)",
			"host": "smtp.126.com",
			"port": 465,
			"secure": true
		},
		"163": {
			"description": "163 Mail (NetEase)",
			"host": "smtp.163.com",
			"port": 465,
			"secure": true
		},
		"Aliyun": {
			"description": "Alibaba Cloud Mail",
			"domains": ["aliyun.com"],
			"host": "smtp.aliyun.com",
			"port": 465,
			"secure": true
		},
		"AliyunQiye": {
			"description": "Alibaba Cloud Enterprise Mail",
			"host": "smtp.qiye.aliyun.com",
			"port": 465,
			"secure": true
		},
		"AOL": {
			"description": "AOL Mail",
			"domains": ["aol.com"],
			"host": "smtp.aol.com",
			"port": 587
		},
		"Aruba": {
			"description": "Aruba PEC (Italian email provider)",
			"domains": ["aruba.it", "pec.aruba.it"],
			"aliases": ["Aruba PEC"],
			"host": "smtps.aruba.it",
			"port": 465,
			"secure": true,
			"authMethod": "LOGIN"
		},
		"Bluewin": {
			"description": "Bluewin (Swiss email provider)",
			"host": "smtpauths.bluewin.ch",
			"domains": ["bluewin.ch"],
			"port": 465
		},
		"BOL": {
			"description": "BOL Mail (Brazilian provider)",
			"domains": ["bol.com.br"],
			"host": "smtp.bol.com.br",
			"port": 587,
			"requireTLS": true
		},
		"DebugMail": {
			"description": "DebugMail (email testing service)",
			"host": "debugmail.io",
			"port": 25
		},
		"Disroot": {
			"description": "Disroot (privacy-focused provider)",
			"domains": ["disroot.org"],
			"host": "disroot.org",
			"port": 587,
			"secure": false,
			"authMethod": "LOGIN"
		},
		"DynectEmail": {
			"description": "Dyn Email Delivery",
			"aliases": ["Dynect"],
			"host": "smtp.dynect.net",
			"port": 25
		},
		"ElasticEmail": {
			"description": "Elastic Email",
			"aliases": ["Elastic Email"],
			"host": "smtp.elasticemail.com",
			"port": 465,
			"secure": true
		},
		"Ethereal": {
			"description": "Ethereal Email (email testing service)",
			"aliases": ["ethereal.email"],
			"host": "smtp.ethereal.email",
			"port": 587
		},
		"FastMail": {
			"description": "FastMail",
			"domains": ["fastmail.fm"],
			"host": "smtp.fastmail.com",
			"port": 465,
			"secure": true
		},
		"Feishu Mail": {
			"description": "Feishu Mail (Lark)",
			"aliases": ["Feishu", "FeishuMail"],
			"domains": ["www.feishu.cn"],
			"host": "smtp.feishu.cn",
			"port": 465,
			"secure": true
		},
		"Forward Email": {
			"description": "Forward Email (email forwarding service)",
			"aliases": ["FE", "ForwardEmail"],
			"domains": ["forwardemail.net"],
			"host": "smtp.forwardemail.net",
			"port": 465,
			"secure": true
		},
		"GandiMail": {
			"description": "Gandi Mail",
			"aliases": ["Gandi", "Gandi Mail"],
			"host": "mail.gandi.net",
			"port": 587
		},
		"Gmail": {
			"description": "Gmail",
			"aliases": ["Google Mail"],
			"domains": ["gmail.com", "googlemail.com"],
			"host": "smtp.gmail.com",
			"port": 465,
			"secure": true
		},
		"GMX": {
			"description": "GMX Mail",
			"domains": [
				"gmx.com",
				"gmx.net",
				"gmx.de"
			],
			"host": "mail.gmx.com",
			"port": 587
		},
		"Godaddy": {
			"description": "GoDaddy Email (US)",
			"host": "smtpout.secureserver.net",
			"port": 25
		},
		"GodaddyAsia": {
			"description": "GoDaddy Email (Asia)",
			"host": "smtp.asia.secureserver.net",
			"port": 25
		},
		"GodaddyEurope": {
			"description": "GoDaddy Email (Europe)",
			"host": "smtp.europe.secureserver.net",
			"port": 25
		},
		"hot.ee": {
			"description": "Hot.ee (Estonian email provider)",
			"host": "mail.hot.ee"
		},
		"Hotmail": {
			"description": "Outlook.com / Hotmail",
			"aliases": [
				"Outlook",
				"Outlook.com",
				"Hotmail.com"
			],
			"domains": ["hotmail.com", "outlook.com"],
			"host": "smtp-mail.outlook.com",
			"port": 587
		},
		"iCloud": {
			"description": "iCloud Mail",
			"aliases": ["Me", "Mac"],
			"domains": ["me.com", "mac.com"],
			"host": "smtp.mail.me.com",
			"port": 587
		},
		"Infomaniak": {
			"description": "Infomaniak Mail (Swiss hosting provider)",
			"host": "mail.infomaniak.com",
			"domains": [
				"ik.me",
				"ikmail.com",
				"etik.com"
			],
			"port": 587
		},
		"KolabNow": {
			"description": "KolabNow (secure email service)",
			"domains": ["kolabnow.com"],
			"aliases": ["Kolab"],
			"host": "smtp.kolabnow.com",
			"port": 465,
			"secure": true,
			"authMethod": "LOGIN"
		},
		"Loopia": {
			"description": "Loopia (Swedish hosting provider)",
			"host": "mailcluster.loopia.se",
			"port": 465
		},
		"Loops": {
			"description": "Loops",
			"host": "smtp.loops.so",
			"port": 587
		},
		"mail.ee": {
			"description": "Mail.ee (Estonian email provider)",
			"host": "smtp.mail.ee"
		},
		"Mail.ru": {
			"description": "Mail.ru",
			"host": "smtp.mail.ru",
			"port": 465,
			"secure": true
		},
		"Mailcatch.app": {
			"description": "Mailcatch (email testing service)",
			"host": "sandbox-smtp.mailcatch.app",
			"port": 2525
		},
		"Maildev": {
			"description": "MailDev (local email testing)",
			"port": 1025,
			"ignoreTLS": true
		},
		"MailerSend": {
			"description": "MailerSend",
			"host": "smtp.mailersend.net",
			"port": 587
		},
		"Mailgun": {
			"description": "Mailgun",
			"host": "smtp.mailgun.org",
			"port": 465,
			"secure": true
		},
		"Mailjet": {
			"description": "Mailjet",
			"host": "in.mailjet.com",
			"port": 587
		},
		"Mailosaur": {
			"description": "Mailosaur (email testing service)",
			"host": "mailosaur.io",
			"port": 25
		},
		"Mailtrap": {
			"description": "Mailtrap",
			"host": "live.smtp.mailtrap.io",
			"port": 587
		},
		"Mandrill": {
			"description": "Mandrill (by Mailchimp)",
			"host": "smtp.mandrillapp.com",
			"port": 587
		},
		"Naver": {
			"description": "Naver Mail (Korean email provider)",
			"host": "smtp.naver.com",
			"port": 587
		},
		"OhMySMTP": {
			"description": "OhMySMTP (email delivery service)",
			"host": "smtp.ohmysmtp.com",
			"port": 587,
			"secure": false
		},
		"One": {
			"description": "One.com Email",
			"host": "send.one.com",
			"port": 465,
			"secure": true
		},
		"OpenMailBox": {
			"description": "OpenMailBox",
			"aliases": ["OMB", "openmailbox.org"],
			"host": "smtp.openmailbox.org",
			"port": 465,
			"secure": true
		},
		"Outlook365": {
			"description": "Microsoft 365 / Office 365",
			"host": "smtp.office365.com",
			"port": 587,
			"secure": false
		},
		"Postmark": {
			"description": "Postmark",
			"aliases": ["PostmarkApp"],
			"host": "smtp.postmarkapp.com",
			"port": 2525
		},
		"Proton": {
			"description": "Proton Mail",
			"aliases": [
				"ProtonMail",
				"Proton.me",
				"Protonmail.com",
				"Protonmail.ch"
			],
			"domains": [
				"proton.me",
				"protonmail.com",
				"pm.me",
				"protonmail.ch"
			],
			"host": "smtp.protonmail.ch",
			"port": 587,
			"requireTLS": true
		},
		"qiye.aliyun": {
			"description": "Alibaba Mail Enterprise Edition",
			"host": "smtp.mxhichina.com",
			"port": "465",
			"secure": true
		},
		"QQ": {
			"description": "QQ Mail",
			"domains": ["qq.com"],
			"host": "smtp.qq.com",
			"port": 465,
			"secure": true
		},
		"QQex": {
			"description": "QQ Enterprise Mail",
			"aliases": ["QQ Enterprise"],
			"domains": ["exmail.qq.com"],
			"host": "smtp.exmail.qq.com",
			"port": 465,
			"secure": true
		},
		"Resend": {
			"description": "Resend",
			"host": "smtp.resend.com",
			"port": 465,
			"secure": true
		},
		"Runbox": {
			"description": "Runbox (Norwegian email provider)",
			"domains": ["runbox.com"],
			"host": "smtp.runbox.com",
			"port": 465,
			"secure": true
		},
		"SendCloud": {
			"description": "SendCloud (Chinese email delivery)",
			"host": "smtp.sendcloud.net",
			"port": 2525
		},
		"SendGrid": {
			"description": "SendGrid",
			"host": "smtp.sendgrid.net",
			"port": 587
		},
		"SendinBlue": {
			"description": "Brevo (formerly Sendinblue)",
			"aliases": ["Brevo"],
			"host": "smtp-relay.brevo.com",
			"port": 587
		},
		"SendPulse": {
			"description": "SendPulse",
			"host": "smtp-pulse.com",
			"port": 465,
			"secure": true
		},
		"SES": {
			"description": "AWS SES US East (N. Virginia)",
			"host": "email-smtp.us-east-1.amazonaws.com",
			"port": 465,
			"secure": true
		},
		"SES-AP-NORTHEAST-1": {
			"description": "AWS SES Asia Pacific (Tokyo)",
			"host": "email-smtp.ap-northeast-1.amazonaws.com",
			"port": 465,
			"secure": true
		},
		"SES-AP-NORTHEAST-2": {
			"description": "AWS SES Asia Pacific (Seoul)",
			"host": "email-smtp.ap-northeast-2.amazonaws.com",
			"port": 465,
			"secure": true
		},
		"SES-AP-NORTHEAST-3": {
			"description": "AWS SES Asia Pacific (Osaka)",
			"host": "email-smtp.ap-northeast-3.amazonaws.com",
			"port": 465,
			"secure": true
		},
		"SES-AP-SOUTH-1": {
			"description": "AWS SES Asia Pacific (Mumbai)",
			"host": "email-smtp.ap-south-1.amazonaws.com",
			"port": 465,
			"secure": true
		},
		"SES-AP-SOUTHEAST-1": {
			"description": "AWS SES Asia Pacific (Singapore)",
			"host": "email-smtp.ap-southeast-1.amazonaws.com",
			"port": 465,
			"secure": true
		},
		"SES-AP-SOUTHEAST-2": {
			"description": "AWS SES Asia Pacific (Sydney)",
			"host": "email-smtp.ap-southeast-2.amazonaws.com",
			"port": 465,
			"secure": true
		},
		"SES-CA-CENTRAL-1": {
			"description": "AWS SES Canada (Central)",
			"host": "email-smtp.ca-central-1.amazonaws.com",
			"port": 465,
			"secure": true
		},
		"SES-EU-CENTRAL-1": {
			"description": "AWS SES Europe (Frankfurt)",
			"host": "email-smtp.eu-central-1.amazonaws.com",
			"port": 465,
			"secure": true
		},
		"SES-EU-NORTH-1": {
			"description": "AWS SES Europe (Stockholm)",
			"host": "email-smtp.eu-north-1.amazonaws.com",
			"port": 465,
			"secure": true
		},
		"SES-EU-WEST-1": {
			"description": "AWS SES Europe (Ireland)",
			"host": "email-smtp.eu-west-1.amazonaws.com",
			"port": 465,
			"secure": true
		},
		"SES-EU-WEST-2": {
			"description": "AWS SES Europe (London)",
			"host": "email-smtp.eu-west-2.amazonaws.com",
			"port": 465,
			"secure": true
		},
		"SES-EU-WEST-3": {
			"description": "AWS SES Europe (Paris)",
			"host": "email-smtp.eu-west-3.amazonaws.com",
			"port": 465,
			"secure": true
		},
		"SES-SA-EAST-1": {
			"description": "AWS SES South America (São Paulo)",
			"host": "email-smtp.sa-east-1.amazonaws.com",
			"port": 465,
			"secure": true
		},
		"SES-US-EAST-1": {
			"description": "AWS SES US East (N. Virginia)",
			"host": "email-smtp.us-east-1.amazonaws.com",
			"port": 465,
			"secure": true
		},
		"SES-US-EAST-2": {
			"description": "AWS SES US East (Ohio)",
			"host": "email-smtp.us-east-2.amazonaws.com",
			"port": 465,
			"secure": true
		},
		"SES-US-GOV-EAST-1": {
			"description": "AWS SES GovCloud (US-East)",
			"host": "email-smtp.us-gov-east-1.amazonaws.com",
			"port": 465,
			"secure": true
		},
		"SES-US-GOV-WEST-1": {
			"description": "AWS SES GovCloud (US-West)",
			"host": "email-smtp.us-gov-west-1.amazonaws.com",
			"port": 465,
			"secure": true
		},
		"SES-US-WEST-1": {
			"description": "AWS SES US West (N. California)",
			"host": "email-smtp.us-west-1.amazonaws.com",
			"port": 465,
			"secure": true
		},
		"SES-US-WEST-2": {
			"description": "AWS SES US West (Oregon)",
			"host": "email-smtp.us-west-2.amazonaws.com",
			"port": 465,
			"secure": true
		},
		"Seznam": {
			"description": "Seznam Email (Czech email provider)",
			"aliases": ["Seznam Email"],
			"domains": [
				"seznam.cz",
				"email.cz",
				"post.cz",
				"spoluzaci.cz"
			],
			"host": "smtp.seznam.cz",
			"port": 465,
			"secure": true
		},
		"SMTP2GO": {
			"description": "SMTP2GO",
			"host": "mail.smtp2go.com",
			"port": 2525
		},
		"Sparkpost": {
			"description": "SparkPost",
			"aliases": ["SparkPost", "SparkPost Mail"],
			"domains": ["sparkpost.com"],
			"host": "smtp.sparkpostmail.com",
			"port": 587,
			"secure": false
		},
		"Tipimail": {
			"description": "Tipimail (email delivery service)",
			"host": "smtp.tipimail.com",
			"port": 587
		},
		"Tutanota": {
			"description": "Tutanota (Tuta Mail)",
			"domains": [
				"tutanota.com",
				"tuta.com",
				"tutanota.de",
				"tuta.io"
			],
			"host": "smtp.tutanota.com",
			"port": 465,
			"secure": true
		},
		"Yahoo": {
			"description": "Yahoo Mail",
			"domains": ["yahoo.com"],
			"host": "smtp.mail.yahoo.com",
			"port": 465,
			"secure": true
		},
		"Yandex": {
			"description": "Yandex Mail",
			"domains": ["yandex.ru"],
			"host": "smtp.yandex.ru",
			"port": 465,
			"secure": true
		},
		"Zimbra": {
			"description": "Zimbra Mail Server",
			"aliases": ["Zimbra Collaboration"],
			"host": "smtp.zimbra.com",
			"port": 587,
			"requireTLS": true
		},
		"Zoho": {
			"description": "Zoho Mail",
			"host": "smtp.zoho.com",
			"port": 465,
			"secure": true,
			"authMethod": "LOGIN"
		}
	};
}));
//#endregion
//#region node_modules/nodemailer/lib/well-known/index.js
var require_well_known = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const services = require_services();
	const normalized = {};
	Object.keys(services).forEach((key) => {
		let service = services[key];
		normalized[normalizeKey(key)] = normalizeService(service);
		[].concat(service.aliases || []).forEach((alias) => {
			normalized[normalizeKey(alias)] = normalizeService(service);
		});
		[].concat(service.domains || []).forEach((domain) => {
			normalized[normalizeKey(domain)] = normalizeService(service);
		});
	});
	function normalizeKey(key) {
		return key.replace(/[^a-zA-Z0-9.-]/g, "").toLowerCase();
	}
	function normalizeService(service) {
		let filter = ["domains", "aliases"];
		let response = {};
		Object.keys(service).forEach((key) => {
			if (filter.indexOf(key) < 0) response[key] = service[key];
		});
		return response;
	}
	/**
	* Resolves SMTP config for given key. Key can be a name (like 'Gmail'), alias (like 'Google Mail') or
	* an email address (like 'test@googlemail.com').
	*
	* @param {String} key [description]
	* @returns {Object} SMTP config or false if not found
	*/
	module.exports = function(key) {
		key = normalizeKey(key.split("@").pop());
		return normalized[key] || false;
	};
}));
//#endregion
//#region node_modules/nodemailer/lib/smtp-pool/index.js
var require_smtp_pool = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const EventEmitter$2 = __require("events");
	const PoolResource = require_pool_resource();
	const SMTPConnection = require_smtp_connection();
	const wellKnown = require_well_known();
	const shared = require_shared();
	const packageData = require_package();
	/**
	* Creates a SMTP pool transport object for Nodemailer
	*
	* @constructor
	* @param {Object} options SMTP Connection options
	*/
	var SMTPPool = class extends EventEmitter$2 {
		constructor(options) {
			super();
			options = options || {};
			if (typeof options === "string") options = { url: options };
			let urlData;
			let service = options.service;
			if (typeof options.getSocket === "function") this.getSocket = options.getSocket;
			if (options.url) {
				urlData = shared.parseConnectionUrl(options.url);
				service = service || urlData.service;
			}
			this.options = shared.assign(false, options, urlData, service && wellKnown(service));
			this.options.maxConnections = this.options.maxConnections || 5;
			this.options.maxMessages = this.options.maxMessages || 100;
			this.logger = shared.getLogger(this.options, { component: this.options.component || "smtp-pool" });
			let connection = new SMTPConnection(this.options);
			this.name = "SMTP (pool)";
			this.version = packageData.version + "[client:" + connection.version + "]";
			this._rateLimit = {
				counter: 0,
				timeout: null,
				waiting: [],
				checkpoint: false,
				delta: Number(this.options.rateDelta) || 1e3,
				limit: Number(this.options.rateLimit) || 0
			};
			this._closed = false;
			this._queue = [];
			this._connections = [];
			this._connectionCounter = 0;
			this.idling = true;
			setImmediate(() => {
				if (this.idling) this.emit("idle");
			});
		}
		/**
		* Placeholder function for creating proxy sockets. This method immediatelly returns
		* without a socket
		*
		* @param {Object} options Connection options
		* @param {Function} callback Callback function to run with the socket keys
		*/
		getSocket(options, callback) {
			return setImmediate(() => callback(null, false));
		}
		/**
		* Queues an e-mail to be sent using the selected settings
		*
		* @param {Object} mail Mail object
		* @param {Function} callback Callback function
		*/
		send(mail, callback) {
			if (this._closed) return false;
			this._queue.push({
				mail,
				requeueAttempts: 0,
				callback
			});
			if (this.idling && this._queue.length >= this.options.maxConnections) this.idling = false;
			setImmediate(() => this._processMessages());
			return true;
		}
		/**
		* Closes all connections in the pool. If there is a message being sent, the connection
		* is closed later
		*/
		close() {
			let connection;
			let len = this._connections.length;
			this._closed = true;
			clearTimeout(this._rateLimit.timeout);
			if (!len && !this._queue.length) return;
			for (let i = len - 1; i >= 0; i--) if (this._connections[i] && this._connections[i].available) {
				connection = this._connections[i];
				connection.close();
				this.logger.info({
					tnx: "connection",
					cid: connection.id,
					action: "removed"
				}, "Connection #%s removed", connection.id);
			}
			if (len && !this._connections.length) this.logger.debug({ tnx: "connection" }, "All connections removed");
			if (!this._queue.length) return;
			let invokeCallbacks = () => {
				if (!this._queue.length) {
					this.logger.debug({ tnx: "connection" }, "Pending queue entries cleared");
					return;
				}
				let entry = this._queue.shift();
				if (entry && typeof entry.callback === "function") try {
					entry.callback(/* @__PURE__ */ new Error("Connection pool was closed"));
				} catch (E) {
					this.logger.error({
						err: E,
						tnx: "callback",
						cid: connection.id
					}, "Callback error for #%s: %s", connection.id, E.message);
				}
				setImmediate(invokeCallbacks);
			};
			setImmediate(invokeCallbacks);
		}
		/**
		* Check the queue and available connections. If there is a message to be sent and there is
		* an available connection, then use this connection to send the mail
		*/
		_processMessages() {
			let connection;
			let i, len;
			if (this._closed) return;
			if (!this._queue.length) {
				if (!this.idling) {
					this.idling = true;
					this.emit("idle");
				}
				return;
			}
			for (i = 0, len = this._connections.length; i < len; i++) if (this._connections[i].available) {
				connection = this._connections[i];
				break;
			}
			if (!connection && this._connections.length < this.options.maxConnections) connection = this._createConnection();
			if (!connection) {
				this.idling = false;
				return;
			}
			if (!this.idling && this._queue.length < this.options.maxConnections) {
				this.idling = true;
				this.emit("idle");
			}
			let entry = connection.queueEntry = this._queue.shift();
			entry.messageId = (connection.queueEntry.mail.message.getHeader("message-id") || "").replace(/[<>\s]/g, "");
			connection.available = false;
			this.logger.debug({
				tnx: "pool",
				cid: connection.id,
				messageId: entry.messageId,
				action: "assign"
			}, "Assigned message <%s> to #%s (%s)", entry.messageId, connection.id, connection.messages + 1);
			if (this._rateLimit.limit) {
				this._rateLimit.counter++;
				if (!this._rateLimit.checkpoint) this._rateLimit.checkpoint = Date.now();
			}
			connection.send(entry.mail, (err, info) => {
				if (entry === connection.queueEntry) {
					try {
						entry.callback(err, info);
					} catch (E) {
						this.logger.error({
							err: E,
							tnx: "callback",
							cid: connection.id
						}, "Callback error for #%s: %s", connection.id, E.message);
					}
					connection.queueEntry = false;
				}
			});
		}
		/**
		* Creates a new pool resource
		*/
		_createConnection() {
			let connection = new PoolResource(this);
			connection.id = ++this._connectionCounter;
			this.logger.info({
				tnx: "pool",
				cid: connection.id,
				action: "conection"
			}, "Created new pool resource #%s", connection.id);
			connection.on("available", () => {
				this.logger.debug({
					tnx: "connection",
					cid: connection.id,
					action: "available"
				}, "Connection #%s became available", connection.id);
				if (this._closed) this.close();
				else this._processMessages();
			});
			connection.once("error", (err) => {
				if (err.code !== "EMAXLIMIT") this.logger.warn({
					err,
					tnx: "pool",
					cid: connection.id
				}, "Pool Error for #%s: %s", connection.id, err.message);
				else this.logger.debug({
					tnx: "pool",
					cid: connection.id,
					action: "maxlimit"
				}, "Max messages limit exchausted for #%s", connection.id);
				if (connection.queueEntry) {
					try {
						connection.queueEntry.callback(err);
					} catch (E) {
						this.logger.error({
							err: E,
							tnx: "callback",
							cid: connection.id
						}, "Callback error for #%s: %s", connection.id, E.message);
					}
					connection.queueEntry = false;
				}
				this._removeConnection(connection);
				this._continueProcessing();
			});
			connection.once("close", () => {
				this.logger.info({
					tnx: "connection",
					cid: connection.id,
					action: "closed"
				}, "Connection #%s was closed", connection.id);
				this._removeConnection(connection);
				if (connection.queueEntry) setTimeout(() => {
					if (connection.queueEntry) if (this._shouldRequeuOnConnectionClose(connection.queueEntry)) this._requeueEntryOnConnectionClose(connection);
					else this._failDeliveryOnConnectionClose(connection);
					this._continueProcessing();
				}, 50);
				else {
					if (!this._closed && this.idling && !this._connections.length) this.emit("clear");
					this._continueProcessing();
				}
			});
			this._connections.push(connection);
			return connection;
		}
		_shouldRequeuOnConnectionClose(queueEntry) {
			if (this.options.maxRequeues === void 0 || this.options.maxRequeues < 0) return true;
			return queueEntry.requeueAttempts < this.options.maxRequeues;
		}
		_failDeliveryOnConnectionClose(connection) {
			if (connection.queueEntry && connection.queueEntry.callback) {
				try {
					connection.queueEntry.callback(/* @__PURE__ */ new Error("Reached maximum number of retries after connection was closed"));
				} catch (E) {
					this.logger.error({
						err: E,
						tnx: "callback",
						messageId: connection.queueEntry.messageId,
						cid: connection.id
					}, "Callback error for #%s: %s", connection.id, E.message);
				}
				connection.queueEntry = false;
			}
		}
		_requeueEntryOnConnectionClose(connection) {
			connection.queueEntry.requeueAttempts = connection.queueEntry.requeueAttempts + 1;
			this.logger.debug({
				tnx: "pool",
				cid: connection.id,
				messageId: connection.queueEntry.messageId,
				action: "requeue"
			}, "Re-queued message <%s> for #%s. Attempt: #%s", connection.queueEntry.messageId, connection.id, connection.queueEntry.requeueAttempts);
			this._queue.unshift(connection.queueEntry);
			connection.queueEntry = false;
		}
		/**
		* Continue to process message if the pool hasn't closed
		*/
		_continueProcessing() {
			if (this._closed) this.close();
			else setTimeout(() => this._processMessages(), 100);
		}
		/**
		* Remove resource from pool
		*
		* @param {Object} connection The PoolResource to remove
		*/
		_removeConnection(connection) {
			let index = this._connections.indexOf(connection);
			if (index !== -1) this._connections.splice(index, 1);
		}
		/**
		* Checks if connections have hit current rate limit and if so, queues the availability callback
		*
		* @param {Function} callback Callback function to run once rate limiter has been cleared
		*/
		_checkRateLimit(callback) {
			if (!this._rateLimit.limit) return callback();
			let now = Date.now();
			if (this._rateLimit.counter < this._rateLimit.limit) return callback();
			this._rateLimit.waiting.push(callback);
			if (this._rateLimit.checkpoint <= now - this._rateLimit.delta) return this._clearRateLimit();
			else if (!this._rateLimit.timeout) {
				this._rateLimit.timeout = setTimeout(() => this._clearRateLimit(), this._rateLimit.delta - (now - this._rateLimit.checkpoint));
				this._rateLimit.checkpoint = now;
			}
		}
		/**
		* Clears current rate limit limitation and runs paused callback
		*/
		_clearRateLimit() {
			clearTimeout(this._rateLimit.timeout);
			this._rateLimit.timeout = null;
			this._rateLimit.counter = 0;
			this._rateLimit.checkpoint = false;
			while (this._rateLimit.waiting.length) {
				let cb = this._rateLimit.waiting.shift();
				setImmediate(cb);
			}
		}
		/**
		* Returns true if there are free slots in the queue
		*/
		isIdle() {
			return this.idling;
		}
		/**
		* Verifies SMTP configuration
		*
		* @param {Function} callback Callback function
		*/
		verify(callback) {
			let promise;
			if (!callback) promise = new Promise((resolve, reject) => {
				callback = shared.callbackPromise(resolve, reject);
			});
			let auth = new PoolResource(this).auth;
			this.getSocket(this.options, (err, socketOptions) => {
				if (err) return callback(err);
				let options = this.options;
				if (socketOptions && socketOptions.connection) {
					this.logger.info({
						tnx: "proxy",
						remoteAddress: socketOptions.connection.remoteAddress,
						remotePort: socketOptions.connection.remotePort,
						destHost: options.host || "",
						destPort: options.port || "",
						action: "connected"
					}, "Using proxied socket from %s:%s to %s:%s", socketOptions.connection.remoteAddress, socketOptions.connection.remotePort, options.host || "", options.port || "");
					options = shared.assign(false, options);
					Object.keys(socketOptions).forEach((key) => {
						options[key] = socketOptions[key];
					});
				}
				let connection = new SMTPConnection(options);
				let returned = false;
				connection.once("error", (err) => {
					if (returned) return;
					returned = true;
					connection.close();
					return callback(err);
				});
				connection.once("end", () => {
					if (returned) return;
					returned = true;
					return callback(/* @__PURE__ */ new Error("Connection closed"));
				});
				let finalize = () => {
					if (returned) return;
					returned = true;
					connection.quit();
					return callback(null, true);
				};
				connection.connect(() => {
					if (returned) return;
					if (auth && (connection.allowsAuth || options.forceAuth)) connection.login(auth, (err) => {
						if (returned) return;
						if (err) {
							returned = true;
							connection.close();
							return callback(err);
						}
						finalize();
					});
					else if (!auth && connection.allowsAuth && options.forceAuth) {
						let err = /* @__PURE__ */ new Error("Authentication info was not provided");
						err.code = "NoAuth";
						returned = true;
						connection.close();
						return callback(err);
					} else finalize();
				});
			});
			return promise;
		}
	};
	module.exports = SMTPPool;
}));
//#endregion
//#region node_modules/nodemailer/lib/smtp-transport/index.js
var require_smtp_transport = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const EventEmitter$1 = __require("events");
	const SMTPConnection = require_smtp_connection();
	const wellKnown = require_well_known();
	const shared = require_shared();
	const XOAuth2 = require_xoauth2();
	const packageData = require_package();
	/**
	* Creates a SMTP transport object for Nodemailer
	*
	* @constructor
	* @param {Object} options Connection options
	*/
	var SMTPTransport = class extends EventEmitter$1 {
		constructor(options) {
			super();
			options = options || {};
			if (typeof options === "string") options = { url: options };
			let urlData;
			let service = options.service;
			if (typeof options.getSocket === "function") this.getSocket = options.getSocket;
			if (options.url) {
				urlData = shared.parseConnectionUrl(options.url);
				service = service || urlData.service;
			}
			this.options = shared.assign(false, options, urlData, service && wellKnown(service));
			this.logger = shared.getLogger(this.options, { component: this.options.component || "smtp-transport" });
			let connection = new SMTPConnection(this.options);
			this.name = "SMTP";
			this.version = packageData.version + "[client:" + connection.version + "]";
			if (this.options.auth) this.auth = this.getAuth({});
		}
		/**
		* Placeholder function for creating proxy sockets. This method immediatelly returns
		* without a socket
		*
		* @param {Object} options Connection options
		* @param {Function} callback Callback function to run with the socket keys
		*/
		getSocket(options, callback) {
			return setImmediate(() => callback(null, false));
		}
		getAuth(authOpts) {
			if (!authOpts) return this.auth;
			let hasAuth = false;
			let authData = {};
			if (this.options.auth && typeof this.options.auth === "object") Object.keys(this.options.auth).forEach((key) => {
				hasAuth = true;
				authData[key] = this.options.auth[key];
			});
			if (authOpts && typeof authOpts === "object") Object.keys(authOpts).forEach((key) => {
				hasAuth = true;
				authData[key] = authOpts[key];
			});
			if (!hasAuth) return false;
			switch ((authData.type || "").toString().toUpperCase()) {
				case "OAUTH2": {
					if (!authData.service && !authData.user) return false;
					let oauth2 = new XOAuth2(authData, this.logger);
					oauth2.provisionCallback = this.mailer && this.mailer.get("oauth2_provision_cb") || oauth2.provisionCallback;
					oauth2.on("token", (token) => this.mailer.emit("token", token));
					oauth2.on("error", (err) => this.emit("error", err));
					return {
						type: "OAUTH2",
						user: authData.user,
						oauth2,
						method: "XOAUTH2"
					};
				}
				default: return {
					type: (authData.type || "").toString().toUpperCase() || "LOGIN",
					user: authData.user,
					credentials: {
						user: authData.user || "",
						pass: authData.pass,
						options: authData.options
					},
					method: (authData.method || "").trim().toUpperCase() || this.options.authMethod || false
				};
			}
		}
		/**
		* Sends an e-mail using the selected settings
		*
		* @param {Object} mail Mail object
		* @param {Function} callback Callback function
		*/
		send(mail, callback) {
			this.getSocket(this.options, (err, socketOptions) => {
				if (err) return callback(err);
				let returned = false;
				let options = this.options;
				if (socketOptions && socketOptions.connection) {
					this.logger.info({
						tnx: "proxy",
						remoteAddress: socketOptions.connection.remoteAddress,
						remotePort: socketOptions.connection.remotePort,
						destHost: options.host || "",
						destPort: options.port || "",
						action: "connected"
					}, "Using proxied socket from %s:%s to %s:%s", socketOptions.connection.remoteAddress, socketOptions.connection.remotePort, options.host || "", options.port || "");
					options = shared.assign(false, options);
					Object.keys(socketOptions).forEach((key) => {
						options[key] = socketOptions[key];
					});
				}
				let connection = new SMTPConnection(options);
				connection.once("error", (err) => {
					if (returned) return;
					returned = true;
					connection.close();
					return callback(err);
				});
				connection.once("end", () => {
					if (returned) return;
					let timer = setTimeout(() => {
						if (returned) return;
						returned = true;
						let err = /* @__PURE__ */ new Error("Unexpected socket close");
						if (connection && connection._socket && connection._socket.upgrading) err.code = "ETLS";
						callback(err);
					}, 1e3);
					try {
						timer.unref();
					} catch (_E) {}
				});
				let sendMessage = () => {
					let envelope = mail.message.getEnvelope();
					let messageId = mail.message.messageId();
					let recipients = [].concat(envelope.to || []);
					if (recipients.length > 3) recipients.push("...and " + recipients.splice(2).length + " more");
					if (mail.data.dsn) envelope.dsn = mail.data.dsn;
					if (mail.data.requireTLSExtensionEnabled) envelope.requireTLSExtensionEnabled = mail.data.requireTLSExtensionEnabled;
					this.logger.info({
						tnx: "send",
						messageId
					}, "Sending message %s to <%s>", messageId, recipients.join(", "));
					connection.send(envelope, mail.message.createReadStream(), (err, info) => {
						returned = true;
						connection.close();
						if (err) {
							this.logger.error({
								err,
								tnx: "send"
							}, "Send error for %s: %s", messageId, err.message);
							return callback(err);
						}
						info.envelope = {
							from: envelope.from,
							to: envelope.to
						};
						info.messageId = messageId;
						try {
							return callback(null, info);
						} catch (E) {
							this.logger.error({
								err: E,
								tnx: "callback"
							}, "Callback error for %s: %s", messageId, E.message);
						}
					});
				};
				connection.connect(() => {
					if (returned) return;
					let auth = this.getAuth(mail.data.auth);
					if (auth && (connection.allowsAuth || options.forceAuth)) connection.login(auth, (err) => {
						if (auth && auth !== this.auth && auth.oauth2) auth.oauth2.removeAllListeners();
						if (returned) return;
						if (err) {
							returned = true;
							connection.close();
							return callback(err);
						}
						sendMessage();
					});
					else sendMessage();
				});
			});
		}
		/**
		* Verifies SMTP configuration
		*
		* @param {Function} callback Callback function
		*/
		verify(callback) {
			let promise;
			if (!callback) promise = new Promise((resolve, reject) => {
				callback = shared.callbackPromise(resolve, reject);
			});
			this.getSocket(this.options, (err, socketOptions) => {
				if (err) return callback(err);
				let options = this.options;
				if (socketOptions && socketOptions.connection) {
					this.logger.info({
						tnx: "proxy",
						remoteAddress: socketOptions.connection.remoteAddress,
						remotePort: socketOptions.connection.remotePort,
						destHost: options.host || "",
						destPort: options.port || "",
						action: "connected"
					}, "Using proxied socket from %s:%s to %s:%s", socketOptions.connection.remoteAddress, socketOptions.connection.remotePort, options.host || "", options.port || "");
					options = shared.assign(false, options);
					Object.keys(socketOptions).forEach((key) => {
						options[key] = socketOptions[key];
					});
				}
				let connection = new SMTPConnection(options);
				let returned = false;
				connection.once("error", (err) => {
					if (returned) return;
					returned = true;
					connection.close();
					return callback(err);
				});
				connection.once("end", () => {
					if (returned) return;
					returned = true;
					return callback(/* @__PURE__ */ new Error("Connection closed"));
				});
				let finalize = () => {
					if (returned) return;
					returned = true;
					connection.quit();
					return callback(null, true);
				};
				connection.connect(() => {
					if (returned) return;
					let authData = this.getAuth({});
					if (authData && (connection.allowsAuth || options.forceAuth)) connection.login(authData, (err) => {
						if (returned) return;
						if (err) {
							returned = true;
							connection.close();
							return callback(err);
						}
						finalize();
					});
					else if (!authData && connection.allowsAuth && options.forceAuth) {
						let err = /* @__PURE__ */ new Error("Authentication info was not provided");
						err.code = "NoAuth";
						returned = true;
						connection.close();
						return callback(err);
					} else finalize();
				});
			});
			return promise;
		}
		/**
		* Releases resources
		*/
		close() {
			if (this.auth && this.auth.oauth2) this.auth.oauth2.removeAllListeners();
			this.emit("close");
		}
	};
	module.exports = SMTPTransport;
}));
//#endregion
//#region node_modules/nodemailer/lib/sendmail-transport/index.js
var require_sendmail_transport = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const spawn = __require("child_process").spawn;
	const packageData = require_package();
	const shared = require_shared();
	/**
	* Generates a Transport object for Sendmail
	*
	* Possible options can be the following:
	*
	*  * **path** optional path to sendmail binary
	*  * **newline** either 'windows' or 'unix'
	*  * **args** an array of arguments for the sendmail binary
	*
	* @constructor
	* @param {Object} optional config parameter for Sendmail
	*/
	var SendmailTransport = class {
		constructor(options) {
			options = options || {};
			this._spawn = spawn;
			this.options = options || {};
			this.name = "Sendmail";
			this.version = packageData.version;
			this.path = "sendmail";
			this.args = false;
			this.winbreak = false;
			this.logger = shared.getLogger(this.options, { component: this.options.component || "sendmail" });
			if (options) {
				if (typeof options === "string") this.path = options;
				else if (typeof options === "object") {
					if (options.path) this.path = options.path;
					if (Array.isArray(options.args)) this.args = options.args;
					this.winbreak = [
						"win",
						"windows",
						"dos",
						"\r\n"
					].includes((options.newline || "").toString().toLowerCase());
				}
			}
		}
		/**
		* <p>Compiles a mailcomposer message and forwards it to handler that sends it.</p>
		*
		* @param {Object} emailMessage MailComposer object
		* @param {Function} callback Callback function to run when the sending is completed
		*/
		send(mail, done) {
			mail.message.keepBcc = true;
			let envelope = mail.data.envelope || mail.message.getEnvelope();
			let messageId = mail.message.messageId();
			let args;
			let sendmail;
			let returned;
			if ([].concat(envelope.from || []).concat(envelope.to || []).some((addr) => /^-/.test(addr))) return done(/* @__PURE__ */ new Error("Can not send mail. Invalid envelope addresses."));
			if (this.args) args = ["-i"].concat(this.args).concat(envelope.to);
			else args = ["-i"].concat(envelope.from ? ["-f", envelope.from] : []).concat(envelope.to);
			let callback = (err) => {
				if (returned) return;
				returned = true;
				if (typeof done === "function") if (err) return done(err);
				else return done(null, {
					envelope: mail.data.envelope || mail.message.getEnvelope(),
					messageId,
					response: "Messages queued for delivery"
				});
			};
			try {
				sendmail = this._spawn(this.path, args);
			} catch (E) {
				this.logger.error({
					err: E,
					tnx: "spawn",
					messageId
				}, "Error occurred while spawning sendmail. %s", E.message);
				return callback(E);
			}
			if (sendmail) {
				sendmail.on("error", (err) => {
					this.logger.error({
						err,
						tnx: "spawn",
						messageId
					}, "Error occurred when sending message %s. %s", messageId, err.message);
					callback(err);
				});
				sendmail.once("exit", (code) => {
					if (!code) return callback();
					let err;
					if (code === 127) err = /* @__PURE__ */ new Error("Sendmail command not found, process exited with code " + code);
					else err = /* @__PURE__ */ new Error("Sendmail exited with code " + code);
					this.logger.error({
						err,
						tnx: "stdin",
						messageId
					}, "Error sending message %s to sendmail. %s", messageId, err.message);
					callback(err);
				});
				sendmail.once("close", callback);
				sendmail.stdin.on("error", (err) => {
					this.logger.error({
						err,
						tnx: "stdin",
						messageId
					}, "Error occurred when piping message %s to sendmail. %s", messageId, err.message);
					callback(err);
				});
				let recipients = [].concat(envelope.to || []);
				if (recipients.length > 3) recipients.push("...and " + recipients.splice(2).length + " more");
				this.logger.info({
					tnx: "send",
					messageId
				}, "Sending message %s to <%s>", messageId, recipients.join(", "));
				let sourceStream = mail.message.createReadStream();
				sourceStream.once("error", (err) => {
					this.logger.error({
						err,
						tnx: "stdin",
						messageId
					}, "Error occurred when generating message %s. %s", messageId, err.message);
					sendmail.kill("SIGINT");
					callback(err);
				});
				sourceStream.pipe(sendmail.stdin);
			} else return callback(/* @__PURE__ */ new Error("sendmail was not found"));
		}
	};
	module.exports = SendmailTransport;
}));
//#endregion
//#region node_modules/nodemailer/lib/stream-transport/index.js
var require_stream_transport = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const packageData = require_package();
	const shared = require_shared();
	/**
	* Generates a Transport object for streaming
	*
	* Possible options can be the following:
	*
	*  * **buffer** if true, then returns the message as a Buffer object instead of a stream
	*  * **newline** either 'windows' or 'unix'
	*
	* @constructor
	* @param {Object} optional config parameter
	*/
	var StreamTransport = class {
		constructor(options) {
			options = options || {};
			this.options = options || {};
			this.name = "StreamTransport";
			this.version = packageData.version;
			this.logger = shared.getLogger(this.options, { component: this.options.component || "stream-transport" });
			this.winbreak = [
				"win",
				"windows",
				"dos",
				"\r\n"
			].includes((options.newline || "").toString().toLowerCase());
		}
		/**
		* Compiles a mailcomposer message and forwards it to handler that sends it
		*
		* @param {Object} emailMessage MailComposer object
		* @param {Function} callback Callback function to run when the sending is completed
		*/
		send(mail, done) {
			mail.message.keepBcc = true;
			let envelope = mail.data.envelope || mail.message.getEnvelope();
			let messageId = mail.message.messageId();
			let recipients = [].concat(envelope.to || []);
			if (recipients.length > 3) recipients.push("...and " + recipients.splice(2).length + " more");
			this.logger.info({
				tnx: "send",
				messageId
			}, "Sending message %s to <%s> using %s line breaks", messageId, recipients.join(", "), this.winbreak ? "<CR><LF>" : "<LF>");
			setImmediate(() => {
				let stream;
				try {
					stream = mail.message.createReadStream();
				} catch (E) {
					this.logger.error({
						err: E,
						tnx: "send",
						messageId
					}, "Creating send stream failed for %s. %s", messageId, E.message);
					return done(E);
				}
				if (!this.options.buffer) {
					stream.once("error", (err) => {
						this.logger.error({
							err,
							tnx: "send",
							messageId
						}, "Failed creating message for %s. %s", messageId, err.message);
					});
					return done(null, {
						envelope: mail.data.envelope || mail.message.getEnvelope(),
						messageId,
						message: stream
					});
				}
				let chunks = [];
				let chunklen = 0;
				stream.on("readable", () => {
					let chunk;
					while ((chunk = stream.read()) !== null) {
						chunks.push(chunk);
						chunklen += chunk.length;
					}
				});
				stream.once("error", (err) => {
					this.logger.error({
						err,
						tnx: "send",
						messageId
					}, "Failed creating message for %s. %s", messageId, err.message);
					return done(err);
				});
				stream.on("end", () => done(null, {
					envelope: mail.data.envelope || mail.message.getEnvelope(),
					messageId,
					message: Buffer.concat(chunks, chunklen)
				}));
			});
		}
	};
	module.exports = StreamTransport;
}));
//#endregion
//#region node_modules/nodemailer/lib/json-transport/index.js
var require_json_transport = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const packageData = require_package();
	const shared = require_shared();
	/**
	* Generates a Transport object to generate JSON output
	*
	* @constructor
	* @param {Object} optional config parameter
	*/
	var JSONTransport = class {
		constructor(options) {
			options = options || {};
			this.options = options || {};
			this.name = "JSONTransport";
			this.version = packageData.version;
			this.logger = shared.getLogger(this.options, { component: this.options.component || "json-transport" });
		}
		/**
		* <p>Compiles a mailcomposer message and forwards it to handler that sends it.</p>
		*
		* @param {Object} emailMessage MailComposer object
		* @param {Function} callback Callback function to run when the sending is completed
		*/
		send(mail, done) {
			mail.message.keepBcc = true;
			let envelope = mail.data.envelope || mail.message.getEnvelope();
			let messageId = mail.message.messageId();
			let recipients = [].concat(envelope.to || []);
			if (recipients.length > 3) recipients.push("...and " + recipients.splice(2).length + " more");
			this.logger.info({
				tnx: "send",
				messageId
			}, "Composing JSON structure of %s to <%s>", messageId, recipients.join(", "));
			setImmediate(() => {
				mail.normalize((err, data) => {
					if (err) {
						this.logger.error({
							err,
							tnx: "send",
							messageId
						}, "Failed building JSON structure for %s. %s", messageId, err.message);
						return done(err);
					}
					delete data.envelope;
					delete data.normalizedHeaders;
					return done(null, {
						envelope,
						messageId,
						message: this.options.skipEncoding ? data : JSON.stringify(data)
					});
				});
			});
		}
	};
	module.exports = JSONTransport;
}));
//#endregion
//#region node_modules/nodemailer/lib/ses-transport/index.js
var require_ses_transport = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const EventEmitter = __require("events");
	const packageData = require_package();
	const shared = require_shared();
	const LeWindows = require_le_windows();
	const MimeNode = require_mime_node();
	/**
	* Generates a Transport object for AWS SES
	*
	* @constructor
	* @param {Object} optional config parameter
	*/
	var SESTransport = class extends EventEmitter {
		constructor(options) {
			super();
			options = options || {};
			this.options = options || {};
			this.ses = this.options.SES;
			this.name = "SESTransport";
			this.version = packageData.version;
			this.logger = shared.getLogger(this.options, { component: this.options.component || "ses-transport" });
		}
		getRegion(cb) {
			if (this.ses.sesClient.config && typeof this.ses.sesClient.config.region === "function") return this.ses.sesClient.config.region().then((region) => cb(null, region)).catch((err) => cb(err));
			return cb(null, false);
		}
		/**
		* Compiles a mailcomposer message and forwards it to SES
		*
		* @param {Object} emailMessage MailComposer object
		* @param {Function} callback Callback function to run when the sending is completed
		*/
		send(mail, callback) {
			let statObject = {
				ts: Date.now(),
				pending: true
			};
			let fromHeader = mail.message._headers.find((header) => /^from$/i.test(header.key));
			if (fromHeader) {
				let mimeNode = new MimeNode("text/plain");
				fromHeader = mimeNode._convertAddresses(mimeNode._parseAddresses(fromHeader.value));
			}
			let envelope = mail.data.envelope || mail.message.getEnvelope();
			let messageId = mail.message.messageId();
			let recipients = [].concat(envelope.to || []);
			if (recipients.length > 3) recipients.push("...and " + recipients.splice(2).length + " more");
			this.logger.info({
				tnx: "send",
				messageId
			}, "Sending message %s to <%s>", messageId, recipients.join(", "));
			let getRawMessage = (next) => {
				if (!mail.data._dkim) mail.data._dkim = {};
				if (mail.data._dkim.skipFields && typeof mail.data._dkim.skipFields === "string") mail.data._dkim.skipFields += ":date:message-id";
				else mail.data._dkim.skipFields = "date:message-id";
				let sourceStream = mail.message.createReadStream();
				let stream = sourceStream.pipe(new LeWindows());
				let chunks = [];
				let chunklen = 0;
				stream.on("readable", () => {
					let chunk;
					while ((chunk = stream.read()) !== null) {
						chunks.push(chunk);
						chunklen += chunk.length;
					}
				});
				sourceStream.once("error", (err) => stream.emit("error", err));
				stream.once("error", (err) => {
					next(err);
				});
				stream.once("end", () => next(null, Buffer.concat(chunks, chunklen)));
			};
			setImmediate(() => getRawMessage((err, raw) => {
				if (err) {
					this.logger.error({
						err,
						tnx: "send",
						messageId
					}, "Failed creating message for %s. %s", messageId, err.message);
					statObject.pending = false;
					return callback(err);
				}
				let sesMessage = {
					Content: { Raw: { Data: raw } },
					FromEmailAddress: fromHeader ? fromHeader : envelope.from,
					Destination: { ToAddresses: envelope.to }
				};
				Object.keys(mail.data.ses || {}).forEach((key) => {
					sesMessage[key] = mail.data.ses[key];
				});
				this.getRegion((err, region) => {
					if (err || !region) region = "us-east-1";
					const command = new this.ses.SendEmailCommand(sesMessage);
					this.ses.sesClient.send(command).then((data) => {
						if (region === "us-east-1") region = "email";
						statObject.pending = true;
						callback(null, {
							envelope: {
								from: envelope.from,
								to: envelope.to
							},
							messageId: "<" + data.MessageId + (!/@/.test(data.MessageId) ? "@" + region + ".amazonses.com" : "") + ">",
							response: data.MessageId,
							raw
						});
					}).catch((err) => {
						this.logger.error({
							err,
							tnx: "send"
						}, "Send error for %s: %s", messageId, err.message);
						statObject.pending = false;
						callback(err);
					});
				});
			}));
		}
		/**
		* Verifies SES configuration
		*
		* @param {Function} callback Callback function
		*/
		verify(callback) {
			let promise;
			if (!callback) promise = new Promise((resolve, reject) => {
				callback = shared.callbackPromise(resolve, reject);
			});
			const cb = (err) => {
				if (err && !["InvalidParameterValue", "MessageRejected"].includes(err.code || err.Code || err.name)) return callback(err);
				return callback(null, true);
			};
			const sesMessage = {
				Content: { Raw: { Data: Buffer.from("From: <invalid@invalid>\r\nTo: <invalid@invalid>\r\n Subject: Invalid\r\n\r\nInvalid") } },
				FromEmailAddress: "invalid@invalid",
				Destination: { ToAddresses: ["invalid@invalid"] }
			};
			this.getRegion((err, region) => {
				if (err || !region) region = "us-east-1";
				const command = new this.ses.SendEmailCommand(sesMessage);
				this.ses.sesClient.send(command).then((data) => cb(null, data)).catch((err) => cb(err));
			});
			return promise;
		}
	};
	module.exports = SESTransport;
}));
//#endregion
//#region src/features/smtp.ts
/**
* QQ 邮箱 SMTP 发送砖块：本插件唯一发起网络的模块。
*
* 为什么用 nodemailer：MIME 组装（RFC 2047 中文主题编码、附件分段、点填充）
* 与 SSL 握手细节出错代价高，复用成熟实现；它在构建期被内联进 lib/index.js，
* 因此部署侧依旧是「单文件、零 node_modules」，与同仓库其他插件保持一致。
*
* 本模块的另一条铁律：任何失败都归一化为中文可操作信息（ok:false + 原因 +
* 处置建议），绝不把 stack 抛给模型。
*
* @module @deepseek-ai/dsh-email/features/smtp
*/
var import_nodemailer = (/* @__PURE__ */ __commonJSMin(((exports, module) => {
	const Mailer = require_mailer();
	const shared = require_shared();
	const SMTPPool = require_smtp_pool();
	const SMTPTransport = require_smtp_transport();
	const SendmailTransport = require_sendmail_transport();
	const StreamTransport = require_stream_transport();
	const JSONTransport = require_json_transport();
	const SESTransport = require_ses_transport();
	const nmfetch = require_fetch();
	const packageData = require_package();
	const ETHEREAL_API = (process.env.ETHEREAL_API || "https://api.nodemailer.com").replace(/\/+$/, "");
	const ETHEREAL_WEB = (process.env.ETHEREAL_WEB || "https://ethereal.email").replace(/\/+$/, "");
	const ETHEREAL_API_KEY = (process.env.ETHEREAL_API_KEY || "").replace(/\s*/g, "") || null;
	const ETHEREAL_CACHE = [
		"true",
		"yes",
		"y",
		"1"
	].includes((process.env.ETHEREAL_CACHE || "yes").toString().trim().toLowerCase());
	let testAccount = false;
	module.exports.createTransport = function(transporter, defaults) {
		let urlConfig;
		let options;
		let mailer;
		if (typeof transporter === "object" && typeof transporter.send !== "function" || typeof transporter === "string" && /^(smtps?|direct):/i.test(transporter)) {
			if (urlConfig = typeof transporter === "string" ? transporter : transporter.url) options = shared.parseConnectionUrl(urlConfig);
			else options = transporter;
			if (options.pool) transporter = new SMTPPool(options);
			else if (options.sendmail) transporter = new SendmailTransport(options);
			else if (options.streamTransport) transporter = new StreamTransport(options);
			else if (options.jsonTransport) transporter = new JSONTransport(options);
			else if (options.SES) {
				if (options.SES.ses && options.SES.aws) {
					let error = /* @__PURE__ */ new Error("Using legacy SES configuration, expecting @aws-sdk/client-sesv2, see https://nodemailer.com/transports/ses/");
					error.code = "LegacyConfig";
					throw error;
				}
				transporter = new SESTransport(options);
			} else transporter = new SMTPTransport(options);
		}
		mailer = new Mailer(transporter, options, defaults);
		return mailer;
	};
	module.exports.createTestAccount = function(apiUrl, callback) {
		let promise;
		if (!callback && typeof apiUrl === "function") {
			callback = apiUrl;
			apiUrl = false;
		}
		if (!callback) promise = new Promise((resolve, reject) => {
			callback = shared.callbackPromise(resolve, reject);
		});
		if (ETHEREAL_CACHE && testAccount) {
			setImmediate(() => callback(null, testAccount));
			return promise;
		}
		apiUrl = apiUrl || ETHEREAL_API;
		let chunks = [];
		let chunklen = 0;
		let requestHeaders = {};
		let requestBody = {
			requestor: packageData.name,
			version: packageData.version
		};
		if (ETHEREAL_API_KEY) requestHeaders.Authorization = "Bearer " + ETHEREAL_API_KEY;
		let req = nmfetch(apiUrl + "/user", {
			contentType: "application/json",
			method: "POST",
			headers: requestHeaders,
			body: Buffer.from(JSON.stringify(requestBody))
		});
		req.on("readable", () => {
			let chunk;
			while ((chunk = req.read()) !== null) {
				chunks.push(chunk);
				chunklen += chunk.length;
			}
		});
		req.once("error", (err) => callback(err));
		req.once("end", () => {
			let res = Buffer.concat(chunks, chunklen);
			let data;
			let err;
			try {
				data = JSON.parse(res.toString());
			} catch (E) {
				err = E;
			}
			if (err) return callback(err);
			if (data.status !== "success" || data.error) return callback(new Error(data.error || "Request failed"));
			delete data.status;
			testAccount = data;
			callback(null, testAccount);
		});
		return promise;
	};
	module.exports.getTestMessageUrl = function(info) {
		if (!info || !info.response) return false;
		let infoProps = /* @__PURE__ */ new Map();
		info.response.replace(/\[([^\]]+)\]$/, (m, props) => {
			props.replace(/\b([A-Z0-9]+)=([^\s]+)/g, (m, key, value) => {
				infoProps.set(key, value);
			});
		});
		if (infoProps.has("STATUS") && infoProps.has("MSGID")) return (testAccount.web || ETHEREAL_WEB) + "/message/" + infoProps.get("MSGID");
		return false;
	};
})))();
/**
* 把未知错误收窄为可读的字段集合。
* 只做字段提取，不做类型体操——错误分类靠下面的 describeSmtpError。
* @param error - 捕获到的任意异常。
*/
function asSmtpError(error) {
	if (typeof error === "object" && error !== null) return error;
	return { message: error };
}
/** 取字符串字段，非字符串一律得到空串。 */
function readString(value) {
	return typeof value === "string" ? value : "";
}
/** 把回执中的地址字段（可能是数组，也可能是单个值）规范为字符串数组。 */
function readAddressList(value) {
	if (Array.isArray(value)) return value.map((item) => String(item));
	return [];
}
/**
* 把 SMTP 失败翻译成中文可操作信息。
*
* 分类依据 nodemailer 的 error.code（EAUTH/ECONNECTION/ETIMEDOUT/ESOCKET/
* EENVELOPE 等）与 responseCode（550/553/554），这些才是可据以处置的证据。
* @param error - 捕获到的异常。
*/
function describeSmtpError(error) {
	const shape = asSmtpError(error);
	const code = readString(shape.code);
	const response = readString(shape.response).replace(/\s+/g, " ").trim();
	const detail = response.length > 0 ? `，服务器响应：${response}` : "";
	if (code === "EAUTH") return {
		error: `QQ 邮箱认证失败：授权码被拒绝${detail}`,
		hint: "登录 QQ 邮箱 → 设置 → 账号 → 开启 SMTP 服务后重新生成授权码，更新插件配置的 authCode 字段"
	};
	if (code === "EENVELOPE") return {
		error: `收件人被邮件服务器拒绝${detail}`,
		hint: "确认收件人地址拼写正确，且未被对方的收信限制策略拦截"
	};
	if (code === "ECONNECTION" || code === "ESOCKET" || code === "ETIMEDOUT" || code === "EDNS") return {
		error: `无法连接 QQ 邮箱 SMTP 服务器${detail}`,
		hint: "确认本机可访问 smtp.qq.com:465（SSL），以及网络/防火墙未拦截出站 465 端口"
	};
	if (code === "EMESSAGE") return { error: `邮件内容被服务器拒绝${detail}` };
	const responseCode = typeof shape.responseCode === "number" ? shape.responseCode : 0;
	if (responseCode === 550 || responseCode === 553 || responseCode === 554 || responseCode === 535) return {
		error: `邮件服务器拒绝本次投递（响应码 ${responseCode}）${detail}`,
		hint: responseCode === 535 ? "535 通常是认证失败或发件账号未被 SMTP 服务放行，请核对发件邮箱与授权码是否匹配" : "内容或收件人被拒，请检查收件人地址与邮件内容"
	};
	const message = readString(shape.message);
	return { error: `发送邮件失败${message.length > 0 ? `：${message}` : ""}` };
}
/** 校验 SMTP 与发件人配置，返回 undefined 表示配置可用。 */
function checkSettings(settings) {
	if (settings.host.trim().length === 0) return "SMTP 服务器地址（smtpHost）未配置";
	if (settings.user.trim().length === 0 || !settings.user.includes("@")) return "发件邮箱（sender）未配置或不是合法邮箱";
	if (settings.pass.trim().length === 0) return "SMTP 授权码（authCode）未配置：请在插件配置中填入 QQ 邮箱授权码";
}
/**
* 校验附件：必须存在、是普通文件、且不超过单附件体积上限。
* 附件是本插件唯一读取本地文件的入口，因此体积与存在性在这里一次判清。
*/
function checkAttachments(attachments, maxBytes) {
	for (const path of attachments) {
		let size = 0;
		try {
			const stat = statSync(path);
			if (!stat.isFile()) return `附件不是普通文件：${path}`;
			size = stat.size;
		} catch {
			return `附件不存在或不可读：${path}`;
		}
		if (size > maxBytes) return `附件超过单文件上限 ${Math.round(maxBytes / 1024 / 1024)} MB：${path}（${(size / 1024 / 1024).toFixed(1)} MB）`;
	}
}
/**
* 通过 SMTP 发送一封邮件。
*
* 每次调用新建并关闭连接（不使用连接池）：发信是低频动作，短连接更省心，
* 也不会在进程里留下长期持有的 socket。
*
* @param settings - SMTP 与发件人设置。
* @param message - 已完成组装与校验的邮件内容。
*/
async function sendMail(settings, message) {
	const settingsError = checkSettings(settings);
	if (settingsError !== void 0) return {
		ok: false,
		error: settingsError
	};
	const attachmentError = checkAttachments(message.attachments, settings.maxAttachmentBytes);
	if (attachmentError !== void 0) return {
		ok: false,
		error: attachmentError
	};
	const transporter = (0, import_nodemailer.createTransport)({
		host: settings.host,
		port: settings.port,
		secure: settings.secure,
		auth: {
			user: settings.user,
			pass: settings.pass
		},
		connectionTimeout: settings.timeoutMs,
		greetingTimeout: settings.timeoutMs,
		socketTimeout: settings.timeoutMs,
		tls: { servername: settings.host }
	});
	try {
		const info = await transporter.sendMail({
			from: {
				name: settings.fromName,
				address: settings.user
			},
			to: [...message.to],
			...message.cc.length > 0 ? { cc: [...message.cc] } : {},
			subject: message.subject,
			text: message.text,
			...message.html !== void 0 ? { html: message.html } : {},
			attachments: message.attachments.map((path) => ({ path }))
		});
		return {
			ok: true,
			messageId: readString(info.messageId),
			accepted: readAddressList(info.accepted),
			rejected: readAddressList(info.rejected),
			response: readString(info.response)
		};
	} catch (error) {
		return {
			ok: false,
			...describeSmtpError(error)
		};
	} finally {
		transporter.close();
	}
}
//#endregion
//#region src/index.ts
/** 插件标识，同时作为 Cordis 入口名与注入来源标签。 */
const name = "dsh-email";
const inject = ["tools"];
/** Schemastery 配置模式。 */
const Config = Schema.object({
	smtpHost: Schema.string().default("smtp.qq.com"),
	smtpPort: Schema.number().default(465),
	smtpSecure: Schema.boolean().default(true),
	sender: Schema.string().default(""),
	authCode: Schema.string().default(""),
	senderName: Schema.string().default("DSH 邮件助手"),
	defaultRecipient: Schema.string().default(""),
	timeoutMs: Schema.number().default(2e4),
	maxAttachmentBytes: Schema.number().default(25 * 1024 * 1024),
	injectGuidance: Schema.boolean().default(true)
});
/** 本包注入消息的来源插件标签。 */
const PRODUCER_KIND = "dsh-email";
/** 旧版 V3 会话消息迁移后的 kind；识别它以免升级后的会话重复注入。 */
const MIGRATED_PRODUCER_KIND = `plugin:${PRODUCER_KIND}`;
/** 从工具参数中取字符串：非字符串或缺失一律得到空串。 */
function readOptionalString(value) {
	return typeof value === "string" ? value : void 0;
}
/** 从工具参数中取字符串数组：非数组得到空数组，元素统一转字符串。 */
function readStringArray(value) {
	return Array.isArray(value) ? value.map((item) => String(item)) : [];
}
/** 把插件配置映射为 SMTP 发送设置（契约与实现分离）。 */
function toSmtpSettings(config) {
	return {
		host: config.smtpHost,
		port: config.smtpPort,
		secure: config.smtpSecure,
		user: config.sender,
		pass: config.authCode,
		fromName: config.senderName,
		timeoutMs: config.timeoutMs,
		maxAttachmentBytes: config.maxAttachmentBytes
	};
}
/** 折叠进首个 agent step 的发信引导，让模型不必再向用户索要邮箱信息。 */
function buildGuidance(config) {
	const defaultLine = config.defaultRecipient.length > 0 ? `- 默认收件人：${config.defaultRecipient}。用户没给收件人时省略 to；用户给了新地址就把新地址传给 to（多个用英文逗号分隔）。` : "- 本插件未配置默认收件人：用户未指定收件人时，必须先问清收件人地址再发信。";
	return [
		"【邮件发送】本会话具备 dsh-email 插件能力：",
		`- 工具 email_send(to?, subject, body, html?, cc?, attachments?)：通过 QQ 邮箱（${config.sender}）发送邮件，SMTP 凭证已内置，无需向用户索要账号或授权码。`,
		defaultLine,
		"- 不要询问用户的邮箱密码/授权码，也不要为默认收件人反复确认；用户未要求时不要抄送其他人。",
		`- 附件传本地文件绝对路径数组（最多 10 个），适合把生成的报告/文档直接邮件发出。`
	].join("\n");
}
/** 引导消息是否已存在于会话可见面。 */
function guidanceAlreadyInjected(agent) {
	return agent.session.surface.nodes.some((seq) => {
		const event = agent.session.eventAt(seq);
		if (event?.type !== "user/message") return false;
		const kind = event.data.source.kind;
		return kind === PRODUCER_KIND || kind === MIGRATED_PRODUCER_KIND;
	});
}
/** 把工具返回值以美化 JSON 文本呈现给模型。 */
function renderJson(_args, value) {
	return [{
		type: "text",
		text: JSON.stringify(value, null, 2)
	}];
}
/** 工具调用展示卡片。 */
function presentCall(title, args) {
	return {
		card: "generic",
		title,
		kind: "other",
		rawInput: args
	};
}
/**
* 注册 `email_send` 工具，并按配置注入发信引导。
* @param ctx - 携带工具注册表的注册上下文。
* @param config - 插件配置。
*/
function apply(ctx, config) {
	const tools = { send: defineTool({
		name: "email_send",
		description: `发送邮件：通过 QQ 邮箱（${config.sender}）把消息发给收件人。省略 to 时使用默认收件人${config.defaultRecipient.length > 0 ? `（${config.defaultRecipient}）` : ""}；用户提供了新地址就传 to。SMTP 凭证已内置，无需向用户索取。`,
		parameters: {
			to: {
				type: "string",
				description: `收件人邮箱，多个用英文逗号分隔；省略则使用默认收件人${config.defaultRecipient.length > 0 ? `（${config.defaultRecipient}）` : ""}`
			},
			subject: {
				type: "string",
				description: "邮件主题",
				required: true
			},
			body: {
				type: "string",
				description: "邮件正文（纯文本）；与 html 至少提供一个"
			},
			html: {
				type: "string",
				description: "邮件正文（HTML，可选）；提供后与 body 组成多部分邮件"
			},
			cc: {
				type: "string",
				description: "抄送邮箱，多个用英文逗号分隔（可选）"
			},
			attachments: {
				type: "array",
				items: { type: "string" },
				description: `附件本地绝对路径列表（可选，最多 10 个）`
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true
			},
			render: renderJson
		},
		execute: async (args) => {
			const recipient = resolveRecipients(readOptionalString(args.to), config.defaultRecipient);
			if (!recipient.ok) return {
				ok: false,
				error: recipient.error
			};
			const compiled = compileMail({
				subject: readOptionalString(args.subject),
				body: readOptionalString(args.body),
				html: readOptionalString(args.html),
				cc: readOptionalString(args.cc),
				attachments: readStringArray(args.attachments)
			});
			if (!compiled.ok) return {
				ok: false,
				error: compiled.error
			};
			const outcome = await sendMail(toSmtpSettings(config), {
				to: recipient.recipients,
				cc: compiled.mail.cc,
				subject: compiled.mail.subject,
				text: compiled.mail.text,
				...compiled.mail.html !== void 0 ? { html: compiled.mail.html } : {},
				attachments: compiled.mail.attachments
			});
			if (!outcome.ok) return {
				ok: false,
				recipient: recipient.recipients,
				recipientSource: recipient.source,
				error: outcome.error,
				...outcome.hint !== void 0 ? { hint: outcome.hint } : {}
			};
			return {
				ok: true,
				recipient: recipient.recipients,
				recipientSource: recipient.source,
				cc: compiled.mail.cc,
				subject: compiled.mail.subject,
				attachments: compiled.mail.attachments,
				messageId: outcome.messageId,
				accepted: outcome.accepted,
				rejected: outcome.rejected,
				response: outcome.response
			};
		},
		presentCall: (args) => presentCall("Send an email", args)
	}) };
	for (const tool of Object.values(tools)) ctx.tools.register(tool);
	if (config.injectGuidance) ctx.on("agent/pre-step", async ({ agent, messages, step, signal }, next) => {
		const decision = await next();
		if (decision.kind === "reject" || step === 1 && decision.messages.length === 0) return decision;
		if (guidanceAlreadyInjected(agent)) return decision;
		signal.throwIfAborted();
		const guidance = createUserMessage({
			content: [{
				type: "text",
				text: buildGuidance(config)
			}],
			source: {
				kind: PRODUCER_KIND,
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
//#endregion
export { Config, apply, inject, name };
