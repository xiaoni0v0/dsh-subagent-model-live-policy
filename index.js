/**
 * subagent-model-live-policy — make the subagent model allowlist live.
 *
 * DSH records the child-LLM allowlist as a write-once Session event and its
 * projection fold accepts only the FIRST one, so a Settings change reaches only
 * Sessions created afterwards: the Settings page shows the new list while
 * `subagent(provider, model)` keeps rejecting it.
 *
 * Instead of appending more events (which the Session-format validator rejects
 * for a revoked list, and which the fold would ignore anyway), this plugin
 * overrides the SINGLE read path every consumer goes through.
 *
 * The `subagent` tool and `list_subagent_models` both read the allowlist via
 * `ProjectionHandle.stateOf(session)`, which is:
 *
 *     stateOf: session => this.cellFor(registration, session).state
 *
 * `cellFor` is a prototype method on the projection registry. Patching it once,
 * guarded by projection key, makes BOTH consumers read the live preference on
 * every call — while leaving the Session log, the fold, and the format
 * validator completely untouched. Turning the setting off yields `null`, which
 * is the projection's own "no policy recorded" state and therefore restricts
 * explicit selection to the parent route, exactly as DSH does for an unset
 * policy.
 *
 * The preference is never duplicated: it is read from the existing
 * `subagentModelSelection` Host service, whose `enabled` and `allowedModels`
 * fields are `volatile()`, so the Settings card updates the running value
 * without remounting anything.
 *
 * Deliberately dependency-free (no imports), so it loads from any directory.
 */

/** Projection key owned by `@deepseek-ai/dsh-tool-subagent`. */
const PROJECTION_KEY = 'subagentModelSelectionPolicy'

/** Marks a prototype that already carries this patch, and holds the original. */
const PATCH_MARK = Symbol.for('dsh.subagent-model-live-policy')

/** Cordis plugin name shown in loader diagnostics. */
export const name = 'subagent-model-live-policy'

/** The registry whose read path is patched. */
export const inject = ['sessionProjections']

/** Read a Schemastery volatile reference, or a plain value. */
function readValue(reference) {
  if (reference === undefined || reference === null) return undefined
  return typeof reference.get === 'function' ? reference.get() : reference
}

/**
 * The allowlist the Settings card currently holds.
 * @param ctx - plugin context; the preference service is resolved live.
 * @returns exact routes, `null` when selection is not granted, or `undefined`
 *   when this plugin must not interfere (no preference service mounted).
 */
function liveRoutes(ctx) {
  const service = ctx.get('subagentModelSelection')
  if (service === undefined || service.config === undefined) return undefined
  if (readValue(service.config.enabled) !== true) return null
  const configured = readValue(service.config.allowedModels)
  // The projection admits a non-empty route array or null; an unset list grants nothing.
  if (!Array.isArray(configured) || configured.length === 0) return null
  return configured.map((route) => ({ provider: route.provider, model: route.model }))
}

/**
 * Install the live read path on the projection registry's prototype.
 * @param ctx - plugin context carrying `sessionProjections`.
 * @returns whether the read path is now live, plus a diagnostic.
 */
function installLiveRead(ctx) {
  const registry = ctx.sessionProjections
  if (registry === undefined || registry === null) {
    return { live: false, reason: 'the sessionProjections service is unavailable' }
  }
  const proto = Object.getPrototypeOf(registry)
  // Patching Object.prototype would affect every object in the process; only a
  // class that owns `cellFor` is the projection registry.
  if (proto === null || !Object.hasOwn(proto, 'cellFor')) {
    return { live: false, reason: 'the projection registry no longer owns a cellFor method' }
  }
  if (proto[PATCH_MARK] !== undefined) return { live: true, reason: 'already live' }
  const original = proto.cellFor
  const patched = function cellFor(registration, session) {
    const cell = original.call(this, registration, session)
    if (registration?.def?.key !== PROJECTION_KEY) return cell
    let live
    try {
      live = liveRoutes(ctx)
    } catch {
      // Reading the preference must never fail a Session read; DSH's recorded
      // policy remains the answer for this call.
      return cell
    }
    // `undefined` means "do not interfere"; anything else replaces the folded
    // state for this read only, leaving the cached cell and the log untouched.
    if (live === undefined) return cell
    return { ...cell, state: live }
  }
  ctx.effect(() => {
    Object.defineProperty(proto, PATCH_MARK, { value: { original, patched }, configurable: true })
    proto.cellFor = patched
    return () => {
      if (proto.cellFor === patched) proto.cellFor = original
      delete proto[PATCH_MARK]
    }
  }, 'subagent-model-live-policy: cellFor')
  return { live: true, reason: 'installed' }
}

/** Marks a schemas() projection that already carries the delegation hint. */
const SCHEMAS_MARK = Symbol.for('dsh.subagent-model-live-policy.schemas')

/** Tool names whose model-facing description gains the discovery hint. */
const DELEGATION_TOOLS = new Set(['subagent', 'subagent_fork'])

/**
 * The sentence appended to a delegation tool's description.
 *
 * The tool's own `provider`/`model` parameters are free-form strings, so a
 * model that guesses a plausible-but-wrong id (for example `openai` where this
 * profile registers `codex`) only learns the mistake from the rejection the
 * runtime raises after the call. Naming the discovery tool here — on the tool
 * it is needed for — is what stops the guessing.
 */
const DISCOVERY_HINT = ' Before passing `provider` or `model`, call `list_subagent_models`'
  + ' (no arguments for the authorized providers, then `provider` for its models) and copy an'
  + ' exact id from its reply. Those ids are profile-specific: the provider may not be named'
  + ' after the vendor, so do not infer one from a model name. Omitting all three route fields'
  + ' always works and inherits the parent route.'

/**
 * Append the discovery hint to a delegation tool's schema, once.
 * @param schema - projected model-facing schema.
 * @returns the schema, possibly with an amended description.
 */
function withDiscoveryHint(schema) {
  if (!DELEGATION_TOOLS.has(schema?.name)) return schema
  if (typeof schema.description !== 'string' || schema.description.includes('list_subagent_models')) {
    return schema
  }
  return { ...schema, description: schema.description + DISCOVERY_HINT }
}

/**
 * Teach the delegation tools to discover routes before guessing them.
 *
 * `schemas()` is a prototype method that re-projects every visible definition on
 * each call, so wrapping it reaches every model-facing tool list while leaving
 * the registered definitions, execution, and presentation untouched.
 * @param ctx - plugin context carrying the tool registry.
 * @returns whether the projection is now hinted, plus a diagnostic.
 */
function installDiscoveryHint(ctx) {
  const tools = ctx.get('tools')
  if (tools === undefined || tools === null) {
    return { hinted: false, reason: 'the tools service is unavailable' }
  }
  const proto = Object.getPrototypeOf(tools)
  if (proto === null || !Object.hasOwn(proto, 'schemas')) {
    return { hinted: false, reason: 'the tool registry no longer owns a schemas method' }
  }
  if (proto[SCHEMAS_MARK] !== undefined) return { hinted: true, reason: 'already hinted' }
  const original = proto.schemas
  const patched = function schemas(scope, toolSet) {
    const projected = original.call(this, scope, toolSet)
    return Array.isArray(projected) ? projected.map(withDiscoveryHint) : projected
  }
  ctx.effect(() => {
    Object.defineProperty(proto, SCHEMAS_MARK, { value: { original, patched }, configurable: true })
    proto.schemas = patched
    return () => {
      if (proto.schemas === patched) proto.schemas = original
      delete proto[SCHEMAS_MARK]
    }
  }, 'subagent-model-live-policy: schemas')
  return { hinted: true, reason: 'installed' }
}

/**
 * Mount the live read path and the delegation discovery hint.
 * @param ctx - plugin context.
 */
export function apply(ctx) {
  const result = installLiveRead(ctx)
  if (result.live) {
    ctx.logger.info('subagent-model-live-policy: the subagent allowlist is read live from Settings (%s)', result.reason)
  } else {
    ctx.logger.warn(
      'subagent-model-live-policy: allowlist is not live — %s. Sessions keep the allowlist recorded when they were created.',
      result.reason,
    )
  }
  const hint = installDiscoveryHint(ctx)
  if (!hint.hinted) {
    ctx.logger.warn(
      'subagent-model-live-policy: delegation tools keep their stock description — %s',
      hint.reason,
    )
  }
}
