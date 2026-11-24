import test from 'node:test'
import assert from 'node:assert/strict'
import { nativeResponsesBody, requestNativeResponses } from './responses-http.ts'
import type { ResponsesRequest } from '../router/types.ts'
import { stateFromHttpStatus } from './http-state.ts'

function request(overrides: Partial<ResponsesRequest> = {}): ResponsesRequest {
  return {
    model: 'alias/model-x',
    rawBody: JSON.stringify({ model: 'alias/model-x', input: 'hello', metadata: { keep: true }, stream: false }),
    stream: false,
    ...overrides,
  }
}

function stubFetch(implementation: typeof fetch): () => void {
  const original = globalThis.fetch
  globalThis.fetch = implementation
  return () => { globalThis.fetch = original }
}

test('nativeResponsesBody rewrites only the selected model and stream flag', () => {
  const body = JSON.parse(nativeResponsesBody(request(), 'model-x')) as Record<string, unknown>
  assert.deepEqual(body, {
    model: 'model-x',
    input: 'hello',
    metadata: { keep: true },
    stream: false,
  })
})

test('nativeResponsesBody preserves a caller-supplied prompt cache key', () => {
  const body = JSON.parse(nativeResponsesBody(request({
    rawBody: JSON.stringify({ model: 'alias/model-x', input: 'hello', prompt_cache_key: 'caller-key', stream: false }),
  }), 'model-x')) as Record<string, unknown>
  assert.equal(body.prompt_cache_key, 'caller-key')
})

test('requestNativeResponses preserves JSON body/status and forwards provider headers', async () => {
  let capturedUrl = ''
  let capturedInit: RequestInit | undefined
  const restore = stubFetch((async (url, init) => {
    capturedUrl = String(url)
    capturedInit = init
    return new Response('{"id":"resp_test","status":"completed"}', { status: 201 })
  }) as typeof fetch)
  try {
    const result = await requestNativeResponses(
      'https://provider.test/v1/responses',
      { Authorization: 'Bearer test-key', 'X-Provider': 'value' },
      nativeResponsesBody(request(), 'model-x'),
      request(),
      'provider',
      stateFromHttpStatus,
    )
    assert.equal(capturedUrl, 'https://provider.test/v1/responses')
    assert.equal(capturedInit?.method, 'POST')
    assert.equal(new Headers(capturedInit?.headers).get('authorization'), 'Bearer test-key')
    assert.equal(new Headers(capturedInit?.headers).get('x-provider'), 'value')
    assert.deepEqual(JSON.parse(String(capturedInit?.body)), {
      model: 'model-x', input: 'hello', metadata: { keep: true }, stream: false,
    })
    assert.deepEqual(result, { ok: true, status: 201, body: '{"id":"resp_test","status":"completed"}' })
  } finally {
    restore()
  }
})

test('requestNativeResponses maps upstream errors using the existing account state classifier', async () => {
  const restore = stubFetch((async () => new Response('{"error":"busy"}', { status: 429 })) as typeof fetch)
  try {
    const result = await requestNativeResponses(
      'https://provider.test/v1/responses', {}, '{}', request(), 'provider', stateFromHttpStatus,
    )
    assert.deepEqual(result, { ok: false, state: 'rate_limit', message: 'upstream 429: {"error":"busy"}' })
  } finally {
    restore()
  }
})

test('requestNativeResponses forwards caller abort and cancels a returned upstream stream', async () => {
  const parent = new AbortController()
  let fetchSignal: AbortSignal | null | undefined
  let upstreamCancelled = false
  const restore = stubFetch((async (_url, init) => {
    fetchSignal = init?.signal
    const body = new ReadableStream<Uint8Array>({
      cancel() { upstreamCancelled = true },
    })
    return new Response(body, { status: 200 })
  }) as typeof fetch)
  try {
    const result = await requestNativeResponses(
      'https://provider.test/v1/responses', {}, '{}',
      request({ stream: true, signal: parent.signal }), 'provider', stateFromHttpStatus,
    )
    assert.equal(result.ok, true)
    assert.equal(result.ok && 'stream' in result, true)
    assert.ok(fetchSignal)
    assert.notEqual(fetchSignal, parent.signal)
    parent.abort(new Error('client disconnected'))
    assert.equal(fetchSignal?.aborted, true)
    if (result.ok && 'stream' in result) await result.stream.cancel('client disconnected')
    assert.equal(upstreamCancelled, true)
  } finally {
    restore()
  }
})

test('requestNativeResponses classifies fetch failures as transport errors', async () => {
  const restore = stubFetch((async () => { throw new Error('network unavailable') }) as typeof fetch)
  try {
    const result = await requestNativeResponses(
      'https://provider.test/v1/responses', {}, '{}', request(), 'provider', stateFromHttpStatus,
    )
    assert.deepEqual(result, { ok: false, state: 'transport', message: 'network unavailable' })
  } finally {
    restore()
  }
})
