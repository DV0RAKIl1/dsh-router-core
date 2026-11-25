import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mock, test } from 'node:test'
import createDeepSeekSupplier from '../examples/suppliers/deepseek-responses.js'

const modelsUrl = 'https://api.deepseek.com/v1/models'

function makeEnv(initial = [['key-1', { name: 'Test key', apiKey: 'test-key' }]]) {
  const values = new Map(initial)
  const env = {
    saved: values,
    logs: [],
    credentials: {
      list: (supplier) => supplier === 'deepseek-responses' ? [...values.keys()] : [],
      get: (supplier, uid) => supplier === 'deepseek-responses' ? values.get(uid) : undefined,
      save: (supplier, uid, data) => values.set(uid, data),
      remove: (supplier, uid) => values.delete(uid),
    },
    store: { get: () => ({ alias: 'deepseek-responses' }) },
    log: (message) => env.logs.push(message),
  }
  return env
}

function setFetch(fetchImpl) {
  const originalFetch = globalThis.fetch
  globalThis.fetch = fetchImpl
  return () => { globalThis.fetch = originalFetch }
}

function responsesRequest({ stream = false, signal, model = 'deepseek-responses/deepseek-flash', rawBody } = {}) {
  return {
    rawBody: rawBody ?? JSON.stringify({ model, input: 'ping' }),
    model,
    stream,
    signal,
  }
}

test('public example has no local paths or credentials', () => {
  const source = readFileSync(new URL('../examples/suppliers/deepseek-responses.js', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /providers\.json|credentials\.sqlite|\/home\/|["']sk-[A-Za-z0-9]/)
  assert.match(source, /api\.deepseek\.com\/responses/)
})

test('Chat Completions uses its endpoint and preserves caller options', async () => {
  const supplier = createDeepSeekSupplier(makeEnv())
  let call
  const restore = setFetch(async (url, init) => {
    call = { url: String(url), init }
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 })
  })
  try {
    const result = await supplier.chatOnce('key-1', 'low', {
      model: 'deepseek-responses/deepseek-flash',
      rawBody: JSON.stringify({
        model: 'deepseek-responses/deepseek-flash',
        messages: [{ role: 'user', content: 'ping' }],
        user: 'client-id',
      }),
      stream: false,
    })
    assert.equal(result.ok, true)
    assert.equal(call.url, 'https://api.deepseek.com/v1/chat/completions')
    const body = JSON.parse(call.init.body)
    assert.equal(body.model, 'deepseek-flash')
    assert.equal(body.stream, false)
    assert.equal(body.reasoning_effort, 'low')
    assert.equal(body.user, 'client-id')
  } finally {
    restore()
  }
})

test('native Responses preserves caller fields and uses the explicit DeepSeek endpoint', async () => {
  const supplier = createDeepSeekSupplier(makeEnv())
  const calls = []
  const restore = setFetch(async (url, init) => {
    calls.push({ url: String(url), init })
    return new Response(JSON.stringify({ id: 'resp_test', status: 'completed' }), { status: 200 })
  })
  try {
    const result = await supplier.responsesOnce('key-1', 'auto', responsesRequest({
      rawBody: JSON.stringify({
        model: 'deepseek-responses/deepseek-flash',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'ping' }] }],
        prompt_cache_key: 'stable-demo-session',
        metadata: { source: 'test' },
      }),
    }))
    assert.equal(result.ok, true)
    assert.equal(calls[0].url, 'https://api.deepseek.com/responses')
    assert.equal(calls[0].init.headers.Authorization, 'Bearer test-key')
    const body = JSON.parse(calls[0].init.body)
    assert.equal(body.model, 'deepseek-flash')
    assert.equal(body.stream, false)
    assert.equal(body.prompt_cache_key, 'stable-demo-session')
    assert.deepEqual(body.metadata, { source: 'test' })
  } finally {
    restore()
  }
})

test('native Responses streams without buffering and removes abort linkage on completion', async () => {
  const supplier = createDeepSeekSupplier(makeEnv())
  const parent = new AbortController()
  let fetchSignal
  const restore = setFetch(async (_url, init) => {
    fetchSignal = init.signal
    return new Response('data: {"type":"response.completed"}\n\n', { status: 200 })
  })
  try {
    const result = await supplier.responsesOnce('key-1', 'auto', responsesRequest({ stream: true, signal: parent.signal }))
    assert.equal(result.ok, true)
    assert.ok(result.ok && 'stream' in result)
    assert.match(await new Response(result.stream).text(), /response\.completed/)
    parent.abort(new Error('client disconnected'))
    assert.equal(fetchSignal.aborted, false)
  } finally {
    restore()
  }
})

test('stream read failures use a fixed error without exposing upstream details', async () => {
  const supplier = createDeepSeekSupplier(makeEnv())
  const restore = setFetch(async () => new Response(new ReadableStream({
    pull() { throw new Error('Bearer test-key stream failed') },
  }), { status: 200 }))
  try {
    const result = await supplier.responsesOnce('key-1', 'auto', responsesRequest({ stream: true }))
    assert.equal(result.ok, true)
    assert.ok(result.ok && 'stream' in result)
    await assert.rejects(new Response(result.stream).text(), /DeepSeek upstream stream error/)
  } finally {
    restore()
  }
})

test('canceling a forwarded stream cancels the upstream body', async () => {
  const supplier = createDeepSeekSupplier(makeEnv())
  let upstreamCancelled = false
  const restore = setFetch(async () => new Response(new ReadableStream({
    cancel() { upstreamCancelled = true },
  }), { status: 200 }))
  try {
    const result = await supplier.responsesOnce('key-1', 'auto', responsesRequest({ stream: true }))
    assert.equal(result.ok, true)
    assert.ok(result.ok && 'stream' in result)
    await result.stream.cancel('client disconnected')
    assert.equal(upstreamCancelled, true)
  } finally {
    restore()
  }
})

test('aborting a streamed response after headers errors its body without leaking the reason', async () => {
  const supplier = createDeepSeekSupplier(makeEnv())
  const parent = new AbortController()
  const restore = setFetch(async (_url, init) => new Response(new ReadableStream({
    start(controller) {
      init.signal.addEventListener('abort', () => controller.error(init.signal.reason), { once: true })
    },
  }), { status: 200 }))
  try {
    const result = await supplier.responsesOnce('key-1', 'auto', responsesRequest({ stream: true, signal: parent.signal }))
    assert.equal(result.ok, true)
    assert.ok(result.ok && 'stream' in result)
    const reading = new Response(result.stream).text()
    parent.abort(new Error('Bearer test-key disconnected'))
    await assert.rejects(reading, (error) => error.message === 'DeepSeek upstream stream error')
  } finally {
    restore()
  }
})

test('HTTP errors map to account state, hide the body, and cancel it', async () => {
  const supplier = createDeepSeekSupplier(makeEnv())
  let bodyCancelled = false
  const restore = setFetch(async () => new Response(new ReadableStream({
    cancel() { bodyCancelled = true },
  }), { status: 429 }))
  try {
    const result = await supplier.responsesOnce('key-1', 'auto', responsesRequest())
    assert.deepEqual(result, {
      ok: false,
      state: 'rate_limit',
      message: 'DeepSeek Responses upstream 429',
    })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(bodyCancelled, true)
  } finally {
    restore()
  }
})

test('HTTP status mapping covers credential, quota, request, and server failures', async () => {
  const supplier = createDeepSeekSupplier(makeEnv())
  const cases = [[401, 'session_dead'], [403, 'session_dead'], [402, 'quota'], [404, 'unavailable'], [400, 'bad_request'], [500, 'unknown']]
  for (const [httpStatus, state] of cases) {
    const restore = setFetch(async () => new Response(null, { status: httpStatus }))
    try {
      const result = await supplier.responsesOnce('key-1', 'auto', responsesRequest())
      assert.equal(result.ok, false)
      assert.equal(result.state, state)
    } finally {
      restore()
    }
  }
})

test('upstream transport failures never expose thrown credential text', async () => {
  const supplier = createDeepSeekSupplier(makeEnv())
  const restore = setFetch(async () => { throw new Error('Bearer test-key leaked by fetch') })
  try {
    const result = await supplier.responsesOnce('key-1', 'auto', responsesRequest())
    assert.deepEqual(result, {
      ok: false,
      state: 'transport',
      message: 'DeepSeek Responses upstream transport error',
    })
    assert.doesNotMatch(result.message, /test-key/)
  } finally {
    restore()
  }
})

test('response-header timeout aborts the upstream request with a fixed error', async () => {
  const supplier = createDeepSeekSupplier(makeEnv())
  const restore = setFetch((_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
  }))
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const pending = supplier.responsesOnce('key-1', 'auto', responsesRequest())
    mock.timers.tick(120000)
    assert.deepEqual(await pending, {
      ok: false,
      state: 'transport',
      message: 'DeepSeek Responses upstream response headers timed out after 120000ms',
    })
  } finally {
    mock.timers.reset()
    restore()
  }
})

test('parent request abort is forwarded and does not expose the abort reason', async () => {
  const supplier = createDeepSeekSupplier(makeEnv())
  const parent = new AbortController()
  let fetchSignal
  const restore = setFetch((_url, init) => new Promise((_resolve, reject) => {
    fetchSignal = init.signal
    init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
  }))
  try {
    const pending = supplier.responsesOnce('key-1', 'auto', responsesRequest({ signal: parent.signal }))
    parent.abort(new Error('Bearer test-key client disconnected'))
    assert.equal(fetchSignal.aborted, true)
    assert.deepEqual(await pending, {
      ok: false,
      state: 'transport',
      message: 'DeepSeek Responses request aborted',
    })
  } finally {
    restore()
  }
})

test('failed response reads return a fixed error and clean up', async () => {
  const supplier = createDeepSeekSupplier(makeEnv())
  const restore = setFetch(async () => ({
    ok: true,
    status: 200,
    text: async () => { throw new Error('Bearer test-key read failure') },
  }))
  try {
    assert.deepEqual(await supplier.responsesOnce('key-1', 'auto', responsesRequest()), {
      ok: false,
      state: 'transport',
      message: 'DeepSeek Responses upstream response read error',
    })
  } finally {
    restore()
  }
})

test('model discovery merges accounts, deduplicates ids, and refreshes on every call', async () => {
  const supplier = createDeepSeekSupplier(makeEnv([
    ['key-1', { name: 'First', apiKey: 'first-key' }],
    ['key-2', { name: 'Second', apiKey: 'second-key' }],
  ]))
  const calls = []
  const restore = setFetch(async (url, init) => {
    calls.push({ url: String(url), authorization: init.headers.Authorization })
    const data = init.headers.Authorization === 'Bearer first-key'
      ? [{ id: 'model-a' }, { id: 'shared' }, { id: 42 }, {}]
      : [{ id: 'shared' }, { id: 'model-b' }]
    return new Response(JSON.stringify({ data }), { status: 200 })
  })
  try {
    assert.deepEqual(await supplier.listModels(), [{ id: 'model-a' }, { id: 'shared' }, { id: 'model-b' }])
    assert.deepEqual(await supplier.listModels(true), [{ id: 'model-a' }, { id: 'shared' }, { id: 'model-b' }])
    assert.equal(calls.length, 4)
    assert.ok(calls.every((call) => call.url === modelsUrl))
  } finally {
    restore()
  }
})

test('model discovery tolerates one failed account but throws when every account fails', async () => {
  const supplier = createDeepSeekSupplier(makeEnv([
    ['key-1', { name: 'First', apiKey: 'first-key' }],
    ['key-2', { name: 'Second', apiKey: 'second-key' }],
  ]))
  const restore = setFetch(async (_url, init) => {
    if (init.headers.Authorization === 'Bearer first-key') throw new Error('Bearer first-key network failure')
    return new Response(JSON.stringify({ data: [{ id: 'model-b' }] }), { status: 200 })
  })
  try {
    assert.deepEqual(await supplier.listModels(), [{ id: 'model-b' }])
    globalThis.fetch = async () => { throw new Error('Bearer second-key network failure') }
    await assert.rejects(supplier.listModels(), /model discovery failed for all configured accounts/)
  } finally {
    restore()
  }
})

test('model discovery cancels failed responses and reports invalid catalogs generically', async () => {
  const supplier = createDeepSeekSupplier(makeEnv())
  let bodyCancelled = false
  const restore = setFetch(async () => new Response(new ReadableStream({
    cancel() { bodyCancelled = true },
  }), { status: 503 }))
  try {
    await assert.rejects(supplier.listModels(), /model discovery failed for all configured accounts/)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(bodyCancelled, true)
    globalThis.fetch = async () => new Response('{ "data": [', { status: 200 })
    await assert.rejects(supplier.listModels(), /model discovery failed for all configured accounts/)
  } finally {
    restore()
  }
})

test('invalid Responses JSON is a non-account error', async () => {
  const supplier = createDeepSeekSupplier(makeEnv())
  const result = await supplier.responsesOnce('key-1', 'auto', responsesRequest({ rawBody: '[]' }))
  assert.equal(result.ok, false)
  assert.equal(result.state, 'bad_request')
})

test('addApiKey rejects and cancels an invalid-key response without saving it', async () => {
  const env = makeEnv([])
  const supplier = createDeepSeekSupplier(env)
  let bodyCancelled = false
  const restore = setFetch(async () => new Response(new ReadableStream({
    cancel() { bodyCancelled = true },
  }), { status: 401 }))
  try {
    assert.deepEqual(await supplier.addApiKey({ apiKey: 'rejected-key' }), {
      ok: false,
      error: 'key rejected: 401',
    })
    assert.equal(env.saved.size, 0)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(bodyCancelled, true)
  } finally {
    restore()
  }
})

test('addApiKey validates upstream access and cancels validation response bodies', async () => {
  const env = makeEnv([])
  const supplier = createDeepSeekSupplier(env)
  let bodyCancelled = false
  const restore = setFetch(async (url, init) => {
    assert.equal(url, modelsUrl)
    assert.equal(init.headers.Authorization, 'Bearer new-test-key')
    return new Response(new ReadableStream({
      cancel() { bodyCancelled = true },
    }), { status: 200 })
  })
  try {
    const result = await supplier.addApiKey({ name: 'New key', apiKey: ' new-test-key ' })
    assert.deepEqual(result, { ok: true, account: { uid: 'key-1', nickname: 'New key' } })
    assert.deepEqual(env.saved.get('key-1'), { name: 'New key', apiKey: 'new-test-key' })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(bodyCancelled, true)
  } finally {
    restore()
  }
})
