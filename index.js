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

/** Marks a prototype carrying this patch: `{ original, patched, refs }`. */
const PATCH_MARK = Symbol.for('dsh.subagent-model-live-policy')

/** Cordis plugin name shown in loader diagnostics. */
export const name = 'subagent-model-live-policy'

/**
 * The registry whose read path is patched.
 */
export const inject = ['sessionProjections']

/**
 * Install one prototype method patch, reference-counted.
 *
 * A second instance must not assume the first one's patch outlives it: during
 * HMR the old fiber disposes after the new one mounts, so a naive "already
 * patched" early return would leave the survivor believing it is patched while
 * the patch is gone. Each participant therefore holds a reference, and the
 * original is restored only when the last one releases.
 * @param proto - prototype owning the method.
 * @param method - method name to wrap.
 * @param factory - builds the replacement from the current original.
 * @returns a release function.
 */
function patchProto(proto, method, factory) {
  let entry = proto[PATCH_MARK]
  if (entry === undefined) {
    entry = { original: proto[method], patched: undefined, refs: 0 }
    Object.defineProperty(proto, PATCH_MARK, { value: entry, configurable: true })
  }
  if (entry.refs === 0) {
    entry.original = proto[method]
    entry.patched = factory(entry.original)
    proto[method] = entry.patched
  }
  entry.refs += 1
  let released = false
  return () => {
    if (released) return
    released = true
    entry.refs -= 1
    if (entry.refs > 0) return
    if (proto[method] === entry.patched) proto[method] = entry.original
    delete proto[PATCH_MARK]
  }
}

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
 * @param release - installs one counted patch and returns its release.
 * @returns whether the read path is now live, plus a diagnostic.
 */
function installLiveRead(ctx, release) {
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
  release(patchProto(proto, 'cellFor', (original) => function cellFor(registration, session) {
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
  }))
  return { live: true, reason: 'installed' }
}

/**
 * Mount the live read path.
 * @param ctx - plugin context.
 */
export function apply(ctx) {
  const releases = []
  const result = installLiveRead(ctx, (fn) => { releases.push(fn) })
  if (result.live) {
    ctx.logger.info('subagent-model-live-policy: the subagent allowlist is read live from Settings (%s)', result.reason)
  } else {
    ctx.logger.warn(
      'subagent-model-live-policy: not active — %s. Sessions keep the allowlist recorded when they were created.',
      result.reason,
    )
  }
  ctx.effect(() => () => {
    for (const fn of releases.splice(0).reverse()) fn()
  }, 'subagent-model-live-policy: patch')
}
