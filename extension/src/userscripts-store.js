export const USERSCRIPT_RECORD_PROTOCOL = "greenways-userscript/1";
export const USERSCRIPTS_APP_ID = "userscripts";
export const USERSCRIPTS_CAPABILITY = "userscripts/manage";
export const USERSCRIPT_LIMITS = Object.freeze({
  scripts: 32,
  matches: 8,
  nameCharacters: 120,
  sourceBytes: 128 * 1024,
});

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const SCRIPT_ID = /^script\/[a-z0-9][a-z0-9._-]{1,62}$/;
// Chrome match patterns: scheme://host/path with an http(s) or wildcard
// scheme, a bare/wildcard host, and a root-anchored path.
const MATCH_PATTERN = /^(https?|\*):\/\/(\*|\*\.[^/*\s]+|[^/*\s]+)(\/[^\s]*)$/;
const RUN_AT = new Set(["document_start", "document_end", "document_idle"]);
const RECORD_KEYS = new Set([
  "protocol",
  "id",
  "name",
  "matches",
  "runAt",
  "enabled",
  "source",
  "digest",
  "createdAt",
  "updatedAt",
]);

const encoder = new TextEncoder();

function plainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object`);
  }
  return value;
}

function closedKeys(value, allowed, label) {
  for (const key of Object.keys(plainObject(value, label))) {
    if (!allowed.has(key)) throw new Error(`${label} contains unsupported field ${key}`);
  }
}

function nonEmptyString(value, label, maximum = 4096) {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  const output = value.trim();
  if (!output) throw new Error(`${label} cannot be empty`);
  if (output.length > maximum) throw new Error(`${label} cannot exceed ${maximum} characters`);
  return output;
}

function canonicalTime(value, label) {
  const output = nonEmptyString(value, label, 80);
  const parsed = Date.parse(output);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== output) {
    throw new Error(`${label} must be a canonical UTC timestamp`);
  }
  return output;
}

function scriptId(value) {
  const output = nonEmptyString(value, "Userscript id", 80);
  if (!SCRIPT_ID.test(output)) throw new Error("Userscript id must be script/<lowercase slug>");
  return output;
}

function matchPatterns(value) {
  if (!Array.isArray(value)) throw new TypeError("Userscript matches must be an array");
  if (!value.length) throw new Error("Userscript matches cannot be empty");
  if (value.length > USERSCRIPT_LIMITS.matches) {
    throw new Error(`Userscript cannot declare more than ${USERSCRIPT_LIMITS.matches} match patterns`);
  }
  const output = value.map((entry, index) => {
    const pattern = nonEmptyString(entry, `Userscript match pattern ${index}`, 512);
    if (!MATCH_PATTERN.test(pattern)) {
      throw new Error(`Userscript match pattern ${index} is not an http(s) Chrome match pattern`);
    }
    return pattern;
  });
  if (new Set(output).size !== output.length) throw new Error("Userscript matches cannot contain duplicates");
  return Object.freeze(output);
}

function scriptSource(value) {
  if (typeof value !== "string") throw new TypeError("Userscript source must be a string");
  if (!value.trim()) throw new Error("Userscript source cannot be empty");
  if (encoder.encode(value).byteLength > USERSCRIPT_LIMITS.sourceBytes) {
    throw new Error(`Userscript source cannot exceed ${USERSCRIPT_LIMITS.sourceBytes} bytes`);
  }
  return value;
}

function sourceDigest(value) {
  const output = nonEmptyString(value, "Userscript digest", 80);
  if (!SHA256.test(output)) throw new Error("Userscript digest must be sha256:<64 lowercase hex characters>");
  return output;
}

export function validateUserscriptRecord(value) {
  const input = plainObject(value, "Userscript record");
  closedKeys(input, RECORD_KEYS, "Userscript record");
  if (input.protocol !== USERSCRIPT_RECORD_PROTOCOL) {
    throw new Error(`Userscript record protocol must be ${USERSCRIPT_RECORD_PROTOCOL}`);
  }
  if (typeof input.enabled !== "boolean") throw new TypeError("Userscript enabled must be a boolean");
  const runAt = nonEmptyString(input.runAt, "Userscript run-at", 32);
  if (!RUN_AT.has(runAt)) throw new Error("Userscript run-at must be document_start, document_end, or document_idle");
  const createdAt = canonicalTime(input.createdAt, "Userscript createdAt");
  const updatedAt = canonicalTime(input.updatedAt, "Userscript updatedAt");
  if (updatedAt < createdAt) throw new Error("Userscript updatedAt cannot precede createdAt");
  return Object.freeze({
    protocol: USERSCRIPT_RECORD_PROTOCOL,
    id: scriptId(input.id),
    name: nonEmptyString(input.name, "Userscript name", USERSCRIPT_LIMITS.nameCharacters),
    matches: matchPatterns(input.matches),
    runAt,
    enabled: input.enabled,
    source: scriptSource(input.source),
    digest: sourceDigest(input.digest),
    createdAt,
    updatedAt,
  });
}

export function validateUserscriptCollection(value) {
  if (!Array.isArray(value)) throw new TypeError("Userscript collection must be an array");
  if (value.length > USERSCRIPT_LIMITS.scripts) {
    throw new Error(`Userscript collection cannot contain more than ${USERSCRIPT_LIMITS.scripts} scripts`);
  }
  const records = value.map((entry, index) => validateUserscriptRecord(entry, `Userscript collection[${index}]`));
  const ids = records.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) throw new Error("Userscript collection ids must be unique");
  return Object.freeze(records);
}

export function userscriptProjectionEntries(records) {
  return validateUserscriptCollection(records).map((record) => [record.id, record]);
}
