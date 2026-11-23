import type { JsonObject } from './types.ts'
import { responsesCodec } from './responses.ts'

const SUPPORTED_FIELDS = new Set([
  'model',
  'input',
  'instructions',
  'tools',
  'max_output_tokens',
  'temperature',
  'top_p',
  'stream',
  'user',
])

export type ResponsesCompatibilityResult =
  | { ok: true; body: JsonObject }
  | { ok: false; error: string }

/**
 * Convert the deliberately small, loss-checked Responses subset to Chat.
 * Native-capable suppliers bypass this helper and continue receiving the original body.
 */
export function responsesToChatCompatible(
  body: JsonObject,
  model: string,
  stream: boolean,
): ResponsesCompatibilityResult {
  for (const key of Object.keys(body)) {
    if (!SUPPORTED_FIELDS.has(key)) {
      return { ok: false, error: `Responses field ${JSON.stringify(key)} is not supported by Chat compatibility mode` }
    }
  }
  if (!Object.hasOwn(body, 'input')) {
    return { ok: false, error: 'Responses field "input" is required by Chat compatibility mode' }
  }
  if (!nonEmptyString(model)) {
    return { ok: false, error: 'Selected Chat model must be a non-empty string' }
  }
  if (body.model !== undefined && !nonEmptyString(body.model)) {
    return { ok: false, error: 'Responses field "model" must be a non-empty string in Chat compatibility mode' }
  }
  if (typeof stream !== 'boolean') {
    return { ok: false, error: 'Chat compatibility stream mode must be a boolean' }
  }
  if (body.stream !== undefined && typeof body.stream !== 'boolean') {
    return { ok: false, error: 'Responses field "stream" must be a boolean in Chat compatibility mode' }
  }
  if (body.instructions !== undefined && typeof body.instructions !== 'string') {
    return { ok: false, error: 'Responses field "instructions" must be a string in Chat compatibility mode' }
  }
  if (body.user !== undefined && typeof body.user !== 'string') {
    return { ok: false, error: 'Responses field "user" must be a string in Chat compatibility mode' }
  }
  if (body.max_output_tokens !== undefined
      && (!Number.isInteger(body.max_output_tokens) || (body.max_output_tokens as number) < 1)) {
    return { ok: false, error: 'Responses field "max_output_tokens" must be a positive integer in Chat compatibility mode' }
  }
  for (const key of ['temperature', 'top_p'] as const) {
    const value = body[key]
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) {
      return { ok: false, error: `Responses field ${JSON.stringify(key)} must be a finite number in Chat compatibility mode` }
    }
  }

  let input: unknown[]
  if (typeof body.input === 'string') {
    input = [{ type: 'message', role: 'user', content: body.input }]
  } else if (Array.isArray(body.input)) {
    input = body.input
  } else {
    return { ok: false, error: 'Responses field "input" must be text or an array in Chat compatibility mode' }
  }
  if (input.length === 0) {
    return { ok: false, error: 'Responses field "input" must not be empty in Chat compatibility mode' }
  }
  const functionCalls = new Set<string>()
  const functionOutputs = new Set<string>()
  const pendingCalls: string[] = []
  let functionPhase: 'idle' | 'calls' | 'outputs' = 'idle'
  for (let i = 0; i < input.length; i++) {
    const item = record(input[i])
    if (item === undefined) return { ok: false, error: `Responses input[${i}] must be an object in Chat compatibility mode` }
    const type = item.type
    if (pendingCalls.length > 0 && (type !== 'function_call' && type !== 'function_call_output'
        || type === 'function_call_output' && item.call_id !== pendingCalls[0])) {
      return { ok: false, error: `Responses input[${i}] interrupts or reorders an unresolved function call sequence` }
    }
    if (functionPhase === 'outputs' && type !== 'function_call_output') {
      return { ok: false, error: `Responses input[${i}] interrupts function_call_output items` }
    }
    if (type === undefined || type === 'message') {
      if (Object.keys(item).some((key) => !['type', 'role', 'content'].includes(key))) {
        return { ok: false, error: `Responses input[${i}] has fields not supported by Chat compatibility mode` }
      }
      const role = item.role === undefined ? 'user' : item.role
      if (typeof role !== 'string' || !['system', 'developer', 'user', 'assistant'].includes(role)) {
        return { ok: false, error: `Responses input[${i}].role is not supported by Chat compatibility mode` }
      }
      if (!Object.hasOwn(item, 'content')) {
        return { ok: false, error: `Responses input[${i}].content is required in Chat compatibility mode` }
      }
      const content = item.content
      if (typeof content === 'string') {
        if (content.length === 0) {
          return { ok: false, error: `Responses input[${i}].content must not be empty in Chat compatibility mode` }
        }
        continue
      }
      if (!Array.isArray(content) || content.length === 0) {
        return { ok: false, error: `Responses input[${i}].content must be non-empty text or text parts in Chat compatibility mode` }
      }
      const textParts: string[] = []
      for (let j = 0; j < content.length; j++) {
        const part = record(content[j])
        if (part === undefined || part.type !== 'input_text' || typeof part.text !== 'string' || part.text.length === 0
            || Object.keys(part).some((key) => !['type', 'text'].includes(key))) {
          return { ok: false, error: `Responses input[${i}].content[${j}] is not a supported input_text part in Chat compatibility mode` }
        }
        textParts.push(part.text)
      }
      if (textParts.length > 1) {
        return { ok: false, error: `Responses input[${i}].content with multiple text parts cannot be represented losslessly in Chat compatibility mode` }
      }
      continue
    }
    if (type === 'function_call') {
      const callId = item.call_id
      if (pendingCalls.length > 0) {
        return { ok: false, error: `Responses input[${i}] contains parallel function calls not representable as one Chat tool-call turn` }
      }
      if (Object.keys(item).some((key) => !['type', 'call_id', 'name', 'arguments'].includes(key))
          || !nonEmptyString(callId) || !nonEmptyString(item.name)
          || typeof item.arguments !== 'string' || functionCalls.has(callId)) {
        return { ok: false, error: `Responses input[${i}] contains fields not representable by Chat or is not a complete, uniquely identified function_call` }
      }
      functionCalls.add(callId)
      pendingCalls.push(callId)
      functionPhase = 'calls'
      continue
    }
    if (type === 'function_call_output') {
      if (Object.keys(item).some((key) => !['type', 'call_id', 'output'].includes(key))
          || !nonEmptyString(item.call_id) || typeof item.output !== 'string'
          || !functionCalls.has(item.call_id) || functionOutputs.has(item.call_id)) {
        return { ok: false, error: `Responses input[${i}] is not a uniquely matched function_call_output item representable by Chat` }
      }
      functionOutputs.add(item.call_id)
      pendingCalls.shift()
      functionPhase = pendingCalls.length === 0 ? 'idle' : 'outputs'
      continue
    }
    return { ok: false, error: `Responses input[${i}].type ${JSON.stringify(type)} is not supported by Chat compatibility mode` }
  }
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools)) return { ok: false, error: 'Responses field "tools" must be an array in Chat compatibility mode' }
    const toolNames = new Set<string>()
    for (let i = 0; i < body.tools.length; i++) {
      const tool = record(body.tools[i])
      const parameters = tool === undefined ? undefined : record(tool.parameters)
      if (tool === undefined || tool.type !== 'function' || !nonEmptyString(tool.name)
          || toolNames.has(tool.name)
          || (tool.description !== undefined && typeof tool.description !== 'string')
          || parameters === undefined || parameters.type !== 'object' || !validJsonSchema(parameters, true)
          || Object.keys(tool).some((key) => !['type', 'name', 'description', 'parameters'].includes(key))) {
        return { ok: false, error: `Responses tools[${i}] is not a unique, supported function tool with a valid object JSON schema` }
      }
      toolNames.add(tool.name)
    }
  }

  const normalized: JsonObject = { ...body, input, model, stream }
  const converted = responsesCodec.toChat(normalized, { model, stream })
  // The router passes the supplier-scoped model and request stream mode separately.
  // Normalize both values so aliases and omitted body fields cannot change routing behavior.
  converted.model = model
  converted.stream = stream
  // The codec intentionally omits empty converted tool lists; preserve an explicit [].
  if (body.tools !== undefined && (body.tools as unknown[]).length === 0) converted.tools = []
  return { ok: true, body: converted }
}

function record(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : undefined
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

const SCHEMA_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])

const STRING_SCHEMA_KEYS = new Set([
  '$schema', '$id', 'id', '$ref', '$anchor', '$dynamicRef', '$dynamicAnchor', '$comment',
  'title', 'description', 'format', 'pattern', 'contentEncoding', 'contentMediaType',
])
const BOOLEAN_SCHEMA_KEYS = new Set(['deprecated', 'readOnly', 'writeOnly', 'uniqueItems'])
const NUMBER_SCHEMA_KEYS = new Set(['multipleOf', 'maximum', 'minimum'])
const EXCLUSIVE_BOUND_KEYS = new Set(['exclusiveMaximum', 'exclusiveMinimum'])
const INTEGER_SCHEMA_KEYS = new Set([
  'maxLength', 'minLength', 'maxItems', 'minItems', 'minContains', 'maxContains', 'maxProperties', 'minProperties',
])
const SCHEMA_MAP_KEYS = new Set([
  '$defs', 'definitions', 'properties', 'patternProperties', 'dependentSchemas',
])
const SCHEMA_ARRAY_KEYS = new Set(['prefixItems', 'allOf', 'anyOf', 'oneOf'])
const SCHEMA_SINGLE_KEYS = new Set([
  'items', 'additionalItems', 'contains', 'additionalProperties', 'unevaluatedItems', 'unevaluatedProperties',
  'propertyNames', 'contentSchema', 'not', 'if', 'then', 'else',
])
const ALL_SCHEMA_KEYWORDS = new Set([
  ...STRING_SCHEMA_KEYS, '$vocabulary', 'type', 'enum', 'const', 'default', 'examples',
  ...BOOLEAN_SCHEMA_KEYS, ...NUMBER_SCHEMA_KEYS, ...EXCLUSIVE_BOUND_KEYS, ...INTEGER_SCHEMA_KEYS,
  'required', ...SCHEMA_MAP_KEYS, ...SCHEMA_ARRAY_KEYS, ...SCHEMA_SINGLE_KEYS,
  'dependencies', 'dependentRequired',
])

/** Validate standard JSON Schema keywords recursively while preserving JSON-valued extensions. */
function validJsonSchema(value: unknown, requireObjectRoot = false): boolean {
  if (typeof value === 'boolean') return !requireObjectRoot
  const schema = record(value)
  if (schema === undefined || (requireObjectRoot && schema.type !== 'object')) return false

  for (const [key, child] of Object.entries(schema)) {
    if (key === 'type') {
      const types = typeof child === 'string' ? [child] : child
      if (!Array.isArray(types) || types.length === 0
          || types.some((item) => typeof item !== 'string' || !SCHEMA_TYPES.has(item))
          || new Set(types).size !== types.length) return false
      continue
    }
    if (STRING_SCHEMA_KEYS.has(key)) {
      if (typeof child !== 'string') return false
      continue
    }
    if (key === '$vocabulary') {
      const vocabulary = record(child)
      if (vocabulary === undefined || Object.values(vocabulary).some((required) => typeof required !== 'boolean')) return false
      continue
    }
    if (BOOLEAN_SCHEMA_KEYS.has(key)) {
      if (typeof child !== 'boolean') return false
      continue
    }
    if (NUMBER_SCHEMA_KEYS.has(key)) {
      if (typeof child !== 'number' || !Number.isFinite(child) || (key === 'multipleOf' && child <= 0)) return false
      continue
    }
    if (EXCLUSIVE_BOUND_KEYS.has(key)) {
      // draft-04 uses booleans; draft-06+ uses numeric exclusive bounds.
      if (typeof child !== 'boolean' && (typeof child !== 'number' || !Number.isFinite(child))) return false
      continue
    }
    if (INTEGER_SCHEMA_KEYS.has(key)) {
      if (typeof child !== 'number' || !Number.isInteger(child) || child < 0) return false
      continue
    }
    if (key === 'default' || key === 'const') {
      if (!isJsonValue(child)) return false
      continue
    }
    if (key === 'enum' || key === 'examples') {
      if (!Array.isArray(child) || (key === 'enum' && child.length === 0) || !isJsonValue(child)) return false
      continue
    }
    if (key === 'required') {
      if (!uniqueStringArray(child)) return false
      continue
    }
    if (SCHEMA_MAP_KEYS.has(key)) {
      const map = record(child)
      if (map === undefined || Object.values(map).some((nested) => !validJsonSchema(nested))) return false
      continue
    }
    if (SCHEMA_ARRAY_KEYS.has(key)) {
      if (!Array.isArray(child) || child.some((nested) => !validJsonSchema(nested))) return false
      continue
    }
    if (SCHEMA_SINGLE_KEYS.has(key)) {
      if (typeof child === 'boolean' && ['items', 'additionalItems', 'additionalProperties', 'unevaluatedItems', 'unevaluatedProperties'].includes(key)) continue
      if (!validJsonSchema(child)) return false
      continue
    }
    if (key === 'dependencies' || key === 'dependentRequired') {
      const map = record(child)
      if (map === undefined || Object.values(map).some((dependency) => key === 'dependentRequired'
        ? !uniqueStringArray(dependency)
        : Array.isArray(dependency) ? !uniqueStringArray(dependency) : !validJsonSchema(dependency))) return false
      continue
    }
    // Unknown JSON-valued keywords can be vocabulary extensions and are preserved verbatim.
    // Recognized keywords are all handled above; this guard catches schema-valued typos in them.
    if (ALL_SCHEMA_KEYWORDS.has(key) || !isJsonValue(child)) return false
  }
  return true
}

function uniqueStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    && new Set(value).size === value.length
}

function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJsonValue)
  const object = record(value)
  if (object === undefined) return false
  return Object.entries(object).every(([key, child]) =>
    !['__proto__', 'constructor', 'prototype'].includes(key) && isJsonValue(child))
}
