import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const clientPath = join(dirname(fileURLToPath(import.meta.url)), '../src/client.js')

function loadClientBundle(contextOverrides = {}) {
  const factories = new Map()
  const sink = {
    load(handoff) {
      factories.set(handoff.id, handoff.factory)
    },
  }
  const context = {
    window: { __ModuleLoader__: sink },
    ...contextOverrides,
  }
  vm.runInNewContext(readFileSync(clientPath, 'utf8'), context)
  return factories
}

function materialize(factory, reactOverrides = {}) {
  const react = {
    createElement(type, props, ...children) {
      return { type, props, children }
    },
    useState(initial) {
      return [typeof initial === 'function' ? initial() : initial, () => {}]
    },
    useCallback(fn) {
      return fn
    },
    useEffect() {},
    ...reactOverrides,
  }
  return factory((spec) => {
    if (spec === 'react') return react
    throw new Error(`unexpected require: ${spec}`)
  })
}

function textContent(value) {
  if (value === null || value === undefined || typeof value === 'boolean') return ''
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  if (Array.isArray(value)) return value.map(textContent).join('')
  if (typeof value === 'object') return textContent(value.children)
  return ''
}

test('client bundle registers dsh-llm-grok via __ModuleLoader__.load', () => {
  const factories = loadClientBundle()
  assert.equal(factories.has('dsh-llm-grok'), true)
  const exported = materialize(factories.get('dsh-llm-grok'))
  assert.equal(typeof exported.apply, 'function')
  assert.deepEqual(Array.from(exported.inject), ['slots', 'connection'])
})

test('apply registers the Grok settings section', () => {
  const exported = materialize(loadClientBundle().get('dsh-llm-grok'))
  const registered = []
  const ctx = {
    get(name) {
      if (name === 'slots') {
        return {
          inject(slot, start) {
            start()
          },
          register(options, render) {
            registered.push({ options, render })
            return () => {}
          },
        }
      }
      if (name === 'connection') {
        return { rpc: { call: async () => ({ ok: true, value: { kind: 'signed-out' } }) } }
      }
      return undefined
    },
  }
  exported.apply(ctx)
  assert.equal(registered.length, 1)
  assert.equal(registered[0].options.name, 'settings.section')
  assert.equal(registered[0].options.id, 'grok')
})

test('initial auth status failures are handled and shown in the settings UI', async () => {
  const hookValues = []
  const effectQueue = []
  let hookIndex = 0
  let render
  let tree
  const react = {
    createElement(type, props, ...children) {
      return { type, props, children }
    },
    useState(initial) {
      const index = hookIndex++
      if (!(index in hookValues)) hookValues[index] = typeof initial === 'function' ? initial() : initial
      return [hookValues[index], (next) => {
        hookValues[index] = typeof next === 'function' ? next(hookValues[index]) : next
        render()
      }]
    },
    useCallback(fn) {
      return fn
    },
    useEffect(effect) {
      effectQueue.push(effect)
    },
  }
  const exported = materialize(loadClientBundle().get('dsh-llm-grok'), react)
  const registered = []
  exported.apply({
    get(name) {
      if (name === 'slots') {
        return {
          inject(_slot, start) { start() },
          register(_options, component) {
            registered.push(component)
            return () => {}
          },
        }
      }
      if (name === 'connection') {
        return { rpc: { call: async () => { throw new Error('status unavailable') } } }
      }
      return undefined
    },
  })
  const element = registered[0]()
  render = () => {
    hookIndex = 0
    tree = element.type(element.props)
  }
  render()
  for (const effect of effectQueue.splice(0)) effect()
  await new Promise(resolve => setImmediate(resolve))
  assert.match(textContent(tree), /status unavailable/)
  assert.doesNotMatch(textContent(tree), /正在读取登录状态/)
})

test('polling auth status failures are handled without an unhandled rejection', async () => {
  const hookValues = []
  const effectQueue = []
  let hookIndex = 0
  let render
  let tree
  let intervalCallback
  const react = {
    createElement(type, props, ...children) {
      return { type, props, children }
    },
    useState(initial) {
      const index = hookIndex++
      if (!(index in hookValues)) hookValues[index] = typeof initial === 'function' ? initial() : initial
      return [hookValues[index], (next) => {
        hookValues[index] = typeof next === 'function' ? next(hookValues[index]) : next
        render()
      }]
    },
    useCallback(fn) {
      hookIndex += 1
      return fn
    },
    useEffect(effect) {
      effectQueue.push(effect)
      hookIndex += 1
    },
  }
  let calls = 0
  const exported = materialize(loadClientBundle({
    setInterval(callback) {
      intervalCallback = callback
      return 1
    },
    clearInterval() {},
  }).get('dsh-llm-grok'), react)
  const registered = []
  exported.apply({
    get(name) {
      if (name === 'slots') {
        return {
          inject(_slot, start) { start() },
          register(_options, component) {
            registered.push(component)
            return () => {}
          },
        }
      }
      if (name === 'connection') {
        return {
          rpc: {
            call: async () => {
              calls += 1
              if (calls === 1) {
                return {
                  ok: true,
                  value: {
                    kind: 'pending',
                    userCode: 'ABCD',
                    verificationUrl: 'https://auth.x.ai/activate',
                  },
                }
              }
              throw new Error('poll status unavailable')
            },
          },
        }
      }
      return undefined
    },
  })
  const element = registered[0]()
  render = () => {
    hookIndex = 0
    tree = element.type(element.props)
  }
  const flushEffects = () => {
    for (const effect of effectQueue.splice(0)) effect()
  }
  render()
  flushEffects()
  await new Promise(resolve => setImmediate(resolve))
  flushEffects()
  assert.equal(typeof intervalCallback, 'function')
  intervalCallback()
  await new Promise(resolve => setImmediate(resolve))
  assert.match(textContent(tree), /poll status unavailable/)
})

test('auth requests use generations and stale responses cannot overwrite the latest action', async () => {
  const hookValues = []
  const effectQueue = []
  let hookIndex = 0
  let render
  let tree
  let effectsStarted = false
  const calls = []
  const statusRequests = []
  let actionRequest
  const defer = () => {
    let resolve
    const promise = new Promise(value => { resolve = value })
    return { promise, resolve }
  }
  const react = {
    createElement(type, props, ...children) {
      return { type, props, children }
    },
    useState(initial) {
      const index = hookIndex++
      if (!(index in hookValues)) hookValues[index] = typeof initial === 'function' ? initial() : initial
      return [hookValues[index], (next) => {
        hookValues[index] = typeof next === 'function' ? next(hookValues[index]) : next
        render()
      }]
    },
    useCallback(fn) {
      return fn
    },
    useEffect(effect) {
      if (!effectsStarted) effectQueue.push(effect)
    },
  }
  const exported = materialize(loadClientBundle().get('dsh-llm-grok'), react)
  const registered = []
  exported.apply({
    get(name) {
      if (name === 'slots') {
        return {
          inject(_slot, start) { start() },
          register(_options, component) {
            registered.push(component)
            return () => {}
          },
        }
      }
      if (name === 'connection') {
        return {
          rpc: {
            call: (channel, endpoint, payload) => {
              calls.push({ channel, endpoint, payload })
              if (endpoint === 'auth/status') {
                const request = defer()
                statusRequests.push(request)
                return request.promise
              }
              actionRequest = defer()
              return actionRequest.promise
            },
          },
        }
      }
      return undefined
    },
  })
  const element = registered[0]()
  render = () => {
    hookIndex = 0
    tree = element.type(element.props)
  }
  const flushEffects = () => {
    effectsStarted = true
    for (const effect of effectQueue.splice(0)) effect()
  }
  const findButton = (value) => {
    if (value === null || value === undefined) return undefined
    if (Array.isArray(value)) {
      for (const child of value) {
        const found = findButton(child)
        if (found !== undefined) return found
      }
      return undefined
    }
    if (typeof value !== 'object') return undefined
    if (value.type === 'button') return value
    return findButton(value.children)
  }

  render()
  flushEffects()
  assert.equal(calls[0].endpoint, 'auth/status')
  assert.equal(calls[0].payload.generation, 0)
  const startButton = findButton(tree)
  startButton.props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls[1].endpoint, 'auth/start')
  assert.equal(calls[1].payload.generation, 1)

  statusRequests[0].resolve({ ok: true, value: { kind: 'signed-out' } })
  await new Promise(resolve => setImmediate(resolve))
  actionRequest.resolve({ ok: true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls[2].endpoint, 'auth/status')
  assert.equal(calls[2].payload.generation, 1)
  statusRequests[1].resolve({
    ok: true,
    value: {
      kind: 'pending',
      userCode: 'ABCD',
      verificationUrl: 'https://auth.x.ai/activate',
    },
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.match(textContent(tree), /等待浏览器完成授权/)
  assert.doesNotMatch(textContent(tree), /未登录/)
})

test('repeating start rebuilds the device polling timer', async () => {
  const hookValues = []
  const hookDeps = []
  const hookCallbacks = []
  const pendingEffects = []
  let hookIndex = 0
  let render
  let tree
  let statusCalls = 0
  let timerId = 0
  let createdTimers = 0
  const clearedTimers = []
  const react = {
    createElement(type, props, ...children) {
      return { type, props, children }
    },
    useState(initial) {
      const index = hookIndex++
      if (!(index in hookValues)) hookValues[index] = typeof initial === 'function' ? initial() : initial
      return [hookValues[index], (next) => {
        hookValues[index] = typeof next === 'function' ? next(hookValues[index]) : next
        render()
      }]
    },
    useCallback(fn, deps) {
      const index = hookIndex++
      const previous = hookDeps[index]
      if (previous === undefined || deps.some((dep, depIndex) => dep !== previous[depIndex])) {
        hookDeps[index] = deps
        hookCallbacks[index] = fn
      }
      return hookCallbacks[index]
    },
    useEffect(effect, deps) {
      const index = hookIndex++
      const previous = hookDeps[index]
      const changed = previous === undefined || deps === undefined || deps.some((dep, depIndex) => dep !== previous[depIndex])
      if (changed) {
        const previousCleanup = hookValues[`cleanup-${index}`]
        if (typeof previousCleanup === 'function') previousCleanup()
        hookDeps[index] = deps
        pendingEffects.push({ index, effect })
      }
    },
  }
  const exported = materialize(loadClientBundle({
    setInterval(callback) {
      const id = ++timerId
      createdTimers += 1
      return id
    },
    clearInterval(id) {
      clearedTimers.push(id)
    },
  }).get('dsh-llm-grok'), react)
  const registered = []
  exported.apply({
    get(name) {
      if (name === 'slots') {
        return {
          inject(_slot, start) { start() },
          register(_options, component) {
            registered.push(component)
            return () => {}
          },
        }
      }
      if (name === 'connection') {
        return {
          rpc: {
            call: async (_channel, endpoint) => {
              if (endpoint !== 'auth/status') return { ok: true }
              statusCalls += 1
              return statusCalls === 1
                ? { ok: true, value: { kind: 'signed-out' } }
                : {
                  ok: true,
                  value: {
                    kind: 'pending',
                    userCode: 'ABCD',
                    verificationUrl: 'https://auth.x.ai/activate',
                  },
                }
            },
          },
        }
      }
      return undefined
    },
  })
  const element = registered[0]()
  render = () => {
    hookIndex = 0
    tree = element.type(element.props)
  }
  const flushEffects = () => {
    while (pendingEffects.length > 0) {
      const { index, effect } = pendingEffects.shift()
      const cleanup = effect()
      if (cleanup !== undefined) hookValues[`cleanup-${index}`] = cleanup
    }
  }
  const findButton = (value) => {
    if (value === null || value === undefined) return undefined
    if (Array.isArray(value)) {
      for (const child of value) {
        const found = findButton(child)
        if (found !== undefined) return found
      }
      return undefined
    }
    if (typeof value !== 'object') return undefined
    if (value.type === 'button') return value
    return findButton(value.children)
  }

  render()
  flushEffects()
  await new Promise(resolve => setImmediate(resolve))
  flushEffects()
  findButton(tree).props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  flushEffects()
  await new Promise(resolve => setImmediate(resolve))
  flushEffects()
  assert.equal(createdTimers, 1)

  findButton(tree).props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  flushEffects()
  await new Promise(resolve => setImmediate(resolve))
  flushEffects()
  assert.equal(createdTimers, 2)
  assert.deepEqual(clearedTimers, [1])
})
