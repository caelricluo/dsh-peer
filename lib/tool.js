/**
 * Minimal, dependency-free tool-definition compiler for dsh-peer.
 *
 * DSH's own `defineTool` lives in `@deepseek-ai/dsh-tools`, which is bundled
 * inside the harness and is not resolvable from a third-party profile plugin.
 * The registry (`ctx.tools.register`) only requires a registry-ready
 * definition: a name, a description, a raw JSON-Schema parameter object, an
 * output declaration, and an `execute` function. This module builds exactly
 * that shape from the same compact DSL the first-party tools use, and performs
 * its own argument validation before dispatch.
 *
 * @module @caelricluo/dsh-peer/tool
 */

const TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])

/**
 * Error thrown for invalid model-supplied arguments.
 */
export class ToolArgsError extends Error {
  /**
   * @param {string[]} violations human-readable problems
   */
  constructor(violations) {
    super('invalid arguments: ' + violations.join('; '))
    this.name = 'ToolArgsError'
    this.violations = violations
  }
}

/**
 * Compile one value-schema spec into the supported raw JSON Schema subset.
 * Specs may carry the author-only `required` flag at object roots; it is
 * lifted into the enclosing `required` array by {@link compileParameters}
 * or {@link compileObject}.
 * @param {any} spec value-schema spec
 * @param {string} path diagnostic path
 * @returns {any} raw JSON Schema node
 */
export function compileValueSchema(spec, path = 'schema') {
  if (spec === undefined || spec === null) throw new Error(path + ': a schema is required')
  if (typeof spec !== 'object' || Array.isArray(spec)) throw new Error(path + ': schema must be an object')
  const type = spec.type
  if (type !== undefined && !TYPES.has(type)) throw new Error(path + ': unsupported type "' + String(type) + '"')
  if (type === undefined) throw new Error(path + ': schema.type is required')
  /** @type {any} */
  const out = { type }
  if (typeof spec.description === 'string') out.description = spec.description
  if (typeof spec.title === 'string') out.title = spec.title
  if (Array.isArray(spec.enum)) out.enum = spec.enum.map((value) => value)
  if (Object.hasOwn(spec, 'const')) out.const = spec.const
  if (Object.hasOwn(spec, 'default')) out.default = spec.default
  if (Array.isArray(spec.examples)) out.examples = spec.examples
  if (type === 'array') {
    if (spec.items === undefined) throw new Error(path + '.items: array schemas need an items schema')
    out.items = compileValueSchema(spec.items, path + '.items')
  }
  if (type === 'object') {
    const object = compileObject(spec, path)
    Object.assign(out, object.schema)
  }
  if (Array.isArray(spec.oneOf)) {
    out.oneOf = spec.oneOf.map((arm, index) => compileValueSchema(arm, path + '.oneOf[' + index + ']'))
  }
  return out
}

/**
 * Compile an object schema spec, lifting property-level `required` flags.
 * @param {any} spec object-schema spec
 * @param {string} path diagnostic path
 * @returns {{schema: any, required?: string[]}} compiled object schema
 */
export function compileObject(spec, path) {
  /** @type {Record<string, any>} */
  const properties = {}
  /** @type {string[]} */
  const required = []
  const source = spec.properties ?? {}
  if (typeof source !== 'object' || Array.isArray(source)) throw new Error(path + '.properties: must be an object')
  for (const [key, value] of Object.entries(source)) {
    const childPath = path + '.properties.' + key
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(childPath + ': property schema must be an object')
    }
    const { required: isRequired, ...rest } = value
    properties[key] = compileValueSchema(rest, childPath)
    if (isRequired === true) required.push(key)
  }
  const schema = { type: 'object', properties }
  if (required.length > 0) schema.required = required
  if (typeof spec.additionalProperties === 'boolean') schema.additionalProperties = spec.additionalProperties
  else if (spec.additionalProperties !== undefined && Object.prototype.hasOwnProperty.call(spec, 'additionalProperties')) {
    throw new Error(path + '.additionalProperties: only boolean values are supported')
  }
  return required.length > 0 ? { schema, required } : { schema }
}

/**
 * Compile the model-facing parameter map into a raw object-rooted JSON Schema.
 * @param {Record<string, any>} spec per-property specs
 * @param {string} [path] diagnostic path
 * @returns {any} JSON Schema object
 */
export function compileParameters(spec = {}, path = 'parameters') {
  const { schema } = compileObject({ type: 'object', properties: spec }, path)
  return schema
}

/**
 * Validate a value against the compiled subset. Path-qualified problems are
 * returned rather than thrown so callers can decide.
 * @param {any} schema compiled JSON Schema node
 * @param {any} value candidate value
 * @param {string} [path] diagnostic path
 * @returns {string[]} violations
 */
export function validateValue(schema, value, path = '') {
  const where = path === '' ? 'arguments' : path
  const violations = []
  if (schema === undefined || schema === null) return violations
  if (schema.oneOf !== undefined) {
    const matches = schema.oneOf.filter((arm) => validateValue(arm, value, path).length === 0)
    if (matches.length !== 1) violations.push(where + ': must match exactly one union arm')
    return violations
  }
  if (schema.type !== undefined) {
    const actual = jsonType(value)
    const expected = schema.type
    // JSON numbers cover both integral and fractional values: an `integer`
    // schema rejects 1.5, while a `number` schema accepts 1.5 and 180 alike.
    const ok =
      expected === 'number'
        ? actual === 'number' || actual === 'integer'
        : expected === 'integer'
          ? actual === 'integer'
          : actual === expected
    if (!ok) {
      violations.push(where + ': expected ' + String(expected) + ', received ' + actual)
      return violations
    }
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => Object.is(candidate, value))) {
    violations.push(where + ': must be one of ' + schema.enum.map((item) => JSON.stringify(item)).join(', '))
  }
  if (schema.type === 'array' && Array.isArray(value)) {
    value.forEach((item, index) => violations.push(...validateValue(schema.items, item, where + '[' + index + ']')))
  }
  if (schema.type === 'object' && value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const required = Array.isArray(schema.required) ? schema.required : []
    for (const key of required) {
      if (!Object.prototype.hasOwnProperty.call(value, key) || value[key] === undefined) {
        violations.push(where + '.' + key + ': required')
      }
    }
    const properties = schema.properties ?? {}
    for (const [key, childSchema] of Object.entries(properties)) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue
      violations.push(...validateValue(childSchema, value[key], where + '.' + key))
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.prototype.hasOwnProperty.call(properties, key)) violations.push(where + '.' + key + ': unknown property')
      }
    }
  }
  return violations
}

/** @param {any} value candidate @returns {string} JSON type name */
function jsonType(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'object') return 'object'
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number'
  return typeof value
}

/**
 * Build a registry-ready tool definition from the compact DSL.
 * Mirrors the observable contract of the first-party `defineTool` for the
 * fields the tool registry actually consumes.
 * @param {{name: string, description: string, parameters?: Record<string, any>,
 *   output: {schema: any, render: (args: any, value: any) => any[]},
 *   timeoutMs?: number, execute: (args: any, exec: any) => any}} options
 * @returns {any} registry-ready definition
 */
export function defineTool(options) {
  if (typeof options?.name !== 'string' || options.name === '') throw new Error('defineTool: name is required')
  if (typeof options.description !== 'string') throw new Error('defineTool(' + options.name + '): description is required')
  const parameters = compileParameters(options.parameters ?? {}, 'parameters')
  const outputSchema = compileValueSchema(options.output?.schema, 'output.schema')
  if (typeof options.output?.render !== 'function') throw new Error('defineTool(' + options.name + '): output.render is required')
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
    throw new Error('defineTool(' + options.name + '): timeoutMs must be a positive finite number')
  }
  const userExecute = options.execute
  return {
    name: options.name,
    description: options.description,
    parameters,
    output: { schema: outputSchema, render: options.output.render },
    ...options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs },
    async execute(args, exec) {
      const violations = validateValue(parameters, args, '')
      if (violations.length > 0) throw new ToolArgsError(violations)
      return userExecute(args, exec)
    },
  }
}
