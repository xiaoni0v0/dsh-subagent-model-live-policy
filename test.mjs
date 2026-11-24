/**
 * Integration test for subagent-model-live-policy.
 *
 * Uses the REAL `SessionProjectionRegistry` from this installation, so the
 * assertions cover the same read path `subagent` and `list_subagent_models` use.
 *
 * Run with ELECTRON_RUN_AS_NODE=1 against the Desktop executable, from a path
 * without spaces.
 */

const ASAR = 'file:///C:/Users/XN/AppData/Local/Programs/DeepSeek%20Harness/resources/app.asar/dsh/node_modules/@deepseek-ai/'
const PLUGIN = new URL('./index.js', import.meta.url).href

const { Context } = await import(ASAR + 'cordis/lib/index.js')
const { SessionProjectionRegistry } = await import(ASAR + 'dsh-session-projection/lib/index.js')
const { z } = await import('file:///C:/Users/XN/AppData/Local/Programs/DeepSeek%20Harness/resources/app.asar/dsh/node_modules/zod/index.js')
const plugin = await import(PLUGIN)

const PROJECTION_KEY = 'subagentModelSelectionPolicy'
const POLICY_EVENT = 'subagent/model-selection-policy'

const results = []
function check(label, condition, detail = '') {
  results.push({ label, ok: Boolean(condition), detail })
}

/** Schemastery-style volatile reference. */
function ref(value) {
  return { get: () => value, set: (next) => { value = next } }
}

/** A Session answering the reads the registry performs. */
function fakeSession(id, events = []) {
  const log = events.map((event, index) => ({ seq: index, time: 0, ...event }))
  return {
    id,
    header: { id, version: 1, createdAt: 0, isSeeded: false },
    inheritedEventCount: 0,
    get seq() { return log.length },
    snapshotEvents(fromSeq = 0, toSeqExclusive = log.length) { return log.slice(fromSeq, toSeqExclusive) },
    eventAt(seq) { return log[seq] },
    append(type, data) {
      const event = { type, data, seq: log.length, time: 0 }
      log.push(event)
      return event
    },
    log,
  }
}

/** The policy owner as DSH renders it. */
function policyService(enabled, allowedModels) {
  return { config: { enabled: ref(enabled), allowedModels: ref(allowedModels) } }
}

/** The projection definition DSH ships, rebuilt fresh (its schema holds functions). */
function freshPolicyDefinition() {
  return {
    key: PROJECTION_KEY,
    stateVersion: 1,
    stateSchema: z.array(z.object({ provider: z.string().min(1), model: z.string().min(1) }).strict()).min(1).nullable(),
    init: () => null,
    apply: (policy, event) => {
      if (policy !== null || event.type !== POLICY_EVENT) return policy
      const { allowedModels } = event.data
      if (!Array.isArray(allowedModels) || allowedModels.length === 0) {
        throw new Error('subagent/model-selection-policy requires at least one route')
      }
      return allowedModels
    },
  }
}

/** An unrelated projection so cross-talk is detectable. */
function freshOtherDefinition() {
  return {
    key: 'someOtherProjection',
    stateVersion: 1,
    stateSchema: z.number(),
    init: () => 0,
    apply: (count, event) => (event.type === 'turn/start' ? count + 1 : count),
  }
}

/**
 * A stand-in for the real tool registry. It mirrors the two methods DSH derives
 * the model-facing list from:
 *
 *  - `definitions()` returns a fresh array of the shared definition objects.
 *  - `schemas()` projects those definitions, like `projectToolSchema`.
 *
 * `describe()` mirrors the native executor's own path, which projects the
 * definitions it is handed rather than calling `schemas()`.
 */
function FakeToolRegistry() {
  this.visible = []
}
FakeToolRegistry.prototype.register = function register(definition) {
  this.visible.push(definition)
  return () => {
    const index = this.visible.indexOf(definition)
    if (index >= 0) this.visible.splice(index, 1)
  }
}
FakeToolRegistry.prototype.definitions = function definitions() {
  return [...this.visible]
}
FakeToolRegistry.prototype.schemas = function schemas() {
  return this.definitions().map(({ name, description, parameters }) => ({ name, description, parameters }))
}
FakeToolRegistry.prototype.describe = function describe(list) {
  return { schemas: list.map(({ name, description, parameters }) => ({ name, description, parameters })) }
}

/**
 * Mount the plugin over a genuine registry.
 */
async function harness({ service, session, tools }) {
  const ctx = new Context()
  ctx.provide('sessions', { list: () => (session === undefined ? [] : [session]) })
  // The registry is a Service: constructing it provides `sessionProjections`.
  const registry = new SessionProjectionRegistry(ctx)
  ctx.provide('tools', tools ?? new FakeToolRegistry())
  if (service !== undefined) ctx.provide('subagentModelSelection', service)
  const policyHandle = await registry.register(freshPolicyDefinition())
  const otherHandle = await registry.register(freshOtherDefinition())
  return { ctx, registry, policyHandle, otherHandle }
}

/** Mount the plugin and let its fiber settle. */
async function mountPlugin(ctx) {
  const fiber = ctx.plugin(plugin)
  await new Promise(resolve => setTimeout(resolve, 60))
  return fiber
}

// ---- 1: the read path is patched on the real registry ----------------------
{
  const session = fakeSession('s1', [{ type: POLICY_EVENT, data: { allowedModels: [{ provider: 'old', model: 'm' }] } }])
  const { ctx, policyHandle } = await harness({ service: policyService(true, [{ provider: 'xai', model: 'grok-4.7' }]), session })
  const before = policyHandle.stateOf(session)
  await mountPlugin(ctx)
  const after = policyHandle.stateOf(session)
  check('the projection unit still folds DSH recorded policy', before?.[0]?.provider === 'old', JSON.stringify(before))
  check('the read now returns the live Settings list', after?.[0]?.provider === 'xai', JSON.stringify(after))
  await ctx.fiber.dispose()
}

// ---- 2: changing the list applies immediately -----------------------------
{
  const session = fakeSession('s2', [{ type: POLICY_EVENT, data: { allowedModels: [{ provider: 'old', model: 'm' }] } }])
  const { ctx, policyHandle } = await harness({ service: policyService(true, [{ provider: 'xai', model: 'grok-4.7' }]), session })
  await mountPlugin(ctx)
  const service = ctx.get('subagentModelSelection')
  check('first read sees the first list', policyHandle.stateOf(session)?.[0]?.model === 'grok-4.7')
  service.config.allowedModels.set([{ provider: 'qodercn', model: 'qfmodel' }])
  check('a changed list is visible on the very next read', policyHandle.stateOf(session)?.[0]?.model === 'qfmodel', JSON.stringify(policyHandle.stateOf(session)))
  service.config.allowedModels.set([
    { provider: 'xai', model: 'grok-4.8' },
    { provider: 'openai-codex', model: 'gpt-6.1-sol' },
  ])
  check('the list can grow', policyHandle.stateOf(session)?.length === 2, JSON.stringify(policyHandle.stateOf(session)))
  await ctx.fiber.dispose()
}

// ---- 3: turning it OFF revokes immediately -------------------------------
{
  const session = fakeSession('s3', [{ type: POLICY_EVENT, data: { allowedModels: [{ provider: 'old', model: 'm' }] } }])
  const { ctx, policyHandle } = await harness({ service: policyService(true, [{ provider: 'xai', model: 'grok-4.7' }]), session })
  await mountPlugin(ctx)
  const service = ctx.get('subagentModelSelection')
  check('enabled read grants the route', policyHandle.stateOf(session)?.[0]?.provider === 'xai')
  service.config.enabled.set(false)
  const off = policyHandle.stateOf(session)
  check('turning the switch off yields no policy', off === null, JSON.stringify(off))
  service.config.enabled.set(true)
  check('turning it back on restores the list', policyHandle.stateOf(session)?.[0]?.provider === 'xai', JSON.stringify(policyHandle.stateOf(session)))
  await ctx.fiber.dispose()
}

// ---- 4: an enabled but empty list grants nothing ------------------------
{
  const session = fakeSession('s4', [{ type: POLICY_EVENT, data: { allowedModels: [{ provider: 'old', model: 'm' }] } }])
  const { ctx, policyHandle } = await harness({ service: policyService(true, []), session })
  await mountPlugin(ctx)
  check('an empty allowlist grants nothing', policyHandle.stateOf(session) === null, JSON.stringify(policyHandle.stateOf(session)))
  await ctx.fiber.dispose()
}

// ---- 5: a Session with no recorded policy -------------------------------
{
  const session = fakeSession('s5')
  const { ctx, policyHandle } = await harness({ service: policyService(true, [{ provider: 'xai', model: 'grok-4.7' }]), session })
  await mountPlugin(ctx)
  check('a Session without a recorded policy reads the live list', policyHandle.stateOf(session)?.[0]?.provider === 'xai', JSON.stringify(policyHandle.stateOf(session)))
  await ctx.fiber.dispose()
}

// ---- 6: other projections are untouched --------------------------------
{
  const session = fakeSession('s6')
  const { ctx, otherHandle } = await harness({ service: policyService(true, [{ provider: 'xai', model: 'grok-4.7' }]), session })
  await mountPlugin(ctx)
  session.append('turn/start', { turn: 1 })
  check('an unrelated projection still folds normally', otherHandle.stateOf(session) === 1, String(otherHandle.stateOf(session)))
  await ctx.fiber.dispose()
}

// ---- 7: no preference service mounted ---------------------------------
{
  const session = fakeSession('s7', [{ type: POLICY_EVENT, data: { allowedModels: [{ provider: 'old', model: 'm' }] } }])
  const { ctx, policyHandle } = await harness({ service: undefined, session })
  await mountPlugin(ctx)
  check('without the service DSH recorded policy stands', policyHandle.stateOf(session)?.[0]?.provider === 'old', JSON.stringify(policyHandle.stateOf(session)))
  await ctx.fiber.dispose()
}

// ---- 8: the Session log is never written by this plugin ---------------
{
  const session = fakeSession('s8', [{ type: POLICY_EVENT, data: { allowedModels: [{ provider: 'old', model: 'm' }] } }])
  const { ctx, policyHandle } = await harness({ service: policyService(true, [{ provider: 'xai', model: 'grok-4.7' }]), session })
  await mountPlugin(ctx)
  ctx.get('subagentModelSelection').config.enabled.set(false)
  policyHandle.stateOf(session)
  ctx.get('subagentModelSelection').config.allowedModels.set([{ provider: 'a', model: 'b' }])
  policyHandle.stateOf(session)
  check('no event was appended by the plugin', session.log.length === 1, `log length ${session.log.length}`)
  check('the recorded policy is still the original', session.log[0].data.allowedModels[0].provider === 'old')
  await ctx.fiber.dispose()
}

// ---- 9: unloading restores the original read path ---------------------
{
  const session = fakeSession('s9', [{ type: POLICY_EVENT, data: { allowedModels: [{ provider: 'old', model: 'm' }] } }])
  const { ctx, registry, policyHandle } = await harness({ service: policyService(true, [{ provider: 'xai', model: 'grok-4.7' }]), session })
  const fiber = await mountPlugin(ctx)
  await fiber.dispose()
  await new Promise(resolve => setTimeout(resolve, 60))
  const restored = policyHandle.stateOf(session)
  check('disposing the plugin restores DSH recorded policy', restored?.[0]?.provider === 'old', JSON.stringify(restored))
  const proto = Object.getPrototypeOf(registry)
  check('the patch mark is gone', proto[Symbol.for('dsh.subagent-model-live-policy')] === undefined)
}

// ---- 10: the delegation tools learn to discover routes first ------------
{
  const tools = new FakeToolRegistry()
  tools.visible.push(
    { name: 'subagent', description: 'Delegate a self-contained task.', parameters: { type: 'object' } },
    { name: 'subagent_fork', description: 'Delegate with this conversation.', parameters: { type: 'object' } },
    { name: 'read', description: 'Read a file.', parameters: { type: 'object' } },
  )
  const { ctx } = await harness({ service: policyService(true, [{ provider: 'xai', model: 'grok-4.7' }]), tools })
  await mountPlugin(ctx)
  const schemas = tools.schemas()
  const byName = new Map(schemas.map(schema => [schema.name, schema]))
  check('subagent names the discovery tool', byName.get('subagent').description.includes('list_subagent_models'))
  check('subagent_fork names the discovery tool', byName.get('subagent_fork').description.includes('list_subagent_models'))
  check('the original description is preserved', byName.get('subagent').description.startsWith('Delegate a self-contained task.'))
  check('unrelated tools are untouched', byName.get('read').description === 'Read a file.')
  check('the hint discourages guessing the vendor name', byName.get('subagent').description.includes('not be named after the vendor'))
  check('the hint names the always-safe omission', byName.get('subagent').description.includes('Omitting all three route fields'))
  await ctx.fiber.dispose()
}

// ---- 10b: the native executor path sees the hint too -------------------
{
  // The stock native executor builds the model-facing list from
  // `definitions()`, never from `schemas()`; wrapping only `schemas()` left the
  // model with the stock wording while an inspect query looked correct.
  const tools = new FakeToolRegistry()
  tools.visible.push(
    { name: 'subagent', description: 'Delegate a self-contained task.', parameters: { type: 'object' } },
    { name: 'read', description: 'Read a file.', parameters: { type: 'object' } },
  )
  const { ctx } = await harness({ service: policyService(true, [{ provider: 'xai', model: 'grok-4.7' }]), tools })
  await mountPlugin(ctx)

  const viaNative = tools.describe(tools.definitions())
  const byName = new Map(viaNative.schemas.map(schema => [schema.name, schema]))
  check('the native executor path carries the hint', byName.get('subagent').description.includes('list_subagent_models'))
  check('the native path leaves other tools alone', byName.get('read').description === 'Read a file.')

  // The registered definitions must stay pristine: `resolve()` compares them by
  // identity against `view()`, so mutating them in place would break admission.
  const registered = tools.visible.find(definition => definition.name === 'subagent')
  check('the stored definition is not mutated', registered.description === 'Delegate a self-contained task.')
  await ctx.fiber.dispose()
}

// ---- 11: the hint is applied once, not per call ------------------------
{
  const tools = new FakeToolRegistry()
  tools.visible.push({ name: 'subagent', description: 'Delegate.', parameters: { type: 'object' } })
  const { ctx } = await harness({ service: policyService(true, [{ provider: 'xai', model: 'grok-4.7' }]), tools })
  await mountPlugin(ctx)
  const first = tools.schemas()[0].description
  const second = tools.schemas()[0].description
  check('repeated projections do not stack the hint', first === second)
  check('the hint appears exactly once', first.split('list_subagent_models').length - 1 === 1, `${first.split('list_subagent_models').length - 1} occurrences`)
  await ctx.fiber.dispose()
}

// ---- 12: unloading restores the stock schemas -------------------------
{
  const tools = new FakeToolRegistry()
  tools.visible.push({ name: 'subagent', description: 'Delegate.', parameters: { type: 'object' } })
  const { ctx } = await harness({ service: policyService(true, [{ provider: 'xai', model: 'grok-4.7' }]), tools })
  const fiber = await mountPlugin(ctx)
  await fiber.dispose()
  await new Promise(resolve => setTimeout(resolve, 60))
  check('disposing restores the stock description', tools.schemas()[0].description === 'Delegate.')
  check('the schemas mark is gone', Object.getPrototypeOf(tools)[Symbol.for('dsh.subagent-model-live-policy')] === undefined)
}

// ---- 13: two mounted instances share one patch, and the last release wins --
{
  const tools = new FakeToolRegistry()
  tools.visible.push({ name: 'subagent', description: 'Delegate.', parameters: { type: 'object' } })
  const session = fakeSession('s13', [{ type: POLICY_EVENT, data: { allowedModels: [{ provider: 'old', model: 'm' }] } }])
  const { ctx, registry, policyHandle } = await harness({
    service: policyService(true, [{ provider: 'xai', model: 'grok-4.7' }]), session, tools,
  })
  // Two fibers of the same plugin, as HMR briefly produces.
  const first = ctx.plugin(plugin)
  const second = ctx.plugin(plugin)
  await new Promise(resolve => setTimeout(resolve, 80))

  const proto = Object.getPrototypeOf(registry)
  const entry = proto[Symbol.for('dsh.subagent-model-live-policy')]
  check('both instances share one counted patch', entry?.refs === 2, `refs=${entry?.refs}`)
  check('the read path is live with both mounted', policyHandle.stateOf(session)?.[0]?.provider === 'xai', JSON.stringify(policyHandle.stateOf(session)))

  // Disposing one must leave the other working — the bug the counter fixes.
  await first.dispose()
  await new Promise(resolve => setTimeout(resolve, 80))
  check('one disposal keeps the patch alive for the survivor', policyHandle.stateOf(session)?.[0]?.provider === 'xai', JSON.stringify(policyHandle.stateOf(session)))
  check('the survivor still holds a reference', Object.getPrototypeOf(registry)[Symbol.for('dsh.subagent-model-live-policy')]?.refs === 1)
  check('the hint survives too', tools.schemas()[0].description.includes('list_subagent_models'))

  await second.dispose()
  await new Promise(resolve => setTimeout(resolve, 80))
  check('the last disposal restores the recorded policy', policyHandle.stateOf(session)?.[0]?.provider === 'old', JSON.stringify(policyHandle.stateOf(session)))
  check('the mark is gone after the last release', Object.getPrototypeOf(registry)[Symbol.for('dsh.subagent-model-live-policy')] === undefined)
  check('the stock description is back', tools.schemas()[0].description === 'Delegate.')
}

for (const { label, ok, detail } of results) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : `   [${detail}]`}`)
}
const failed = results.filter(result => !result.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exitCode = failed.length === 0 ? 0 : 1
