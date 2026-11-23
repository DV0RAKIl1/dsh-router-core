import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Router } from './index.ts'
import { AccountPool } from './account-pool.ts'
import type { Supplier } from './types.ts'
import type { ChatOnceResult, ResponsesOnceResult, SupplierAccountNow } from '../suppliers/contract.ts'

class CaptureResponse extends EventEmitter {
  statusCode = 200
  headersSent = false
  writableEnded = false
  destroyed = false
  private readonly chunks: Buffer[] = []

  writeHead(statusCode: number): this {
    this.statusCode = statusCode
    this.headersSent = true
    return this
  }

  write(chunk: Uint8Array | string): boolean {
    this.headersSent = true
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    return true
  }

  end(chunk?: Uint8Array | string): this {
    if (chunk !== undefined) this.write(chunk)
    this.writableEnded = true
    this.emit('close')
    return this
  }

  destroy(): this {
    this.destroyed = true
    this.emit('close')
    return this
  }

  flushHeaders(): void { this.headersSent = true }
  body(): string { return Buffer.concat(this.chunks).toString('utf8') }
}

class CommitThenThrowResponse extends CaptureResponse {
  override writeHead(statusCode: number): this {
    super.writeHead(statusCode)
    throw new Error('writer failed after commit')
  }
}

function byteStream(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
}

function addNativeSupplier(
  router: Router,
  options: {
    id?: string
    alias?: string
    models?: string[]
    accounts?: SupplierAccountNow[]
    responsesOnce: (uid: string, req: { rawBody: string; signal?: AbortSignal }) => Promise<ResponsesOnceResult>
  },
): AccountPool {
  const id = options.id ?? 'native'
  const models = options.models ?? ['model-1']
  const accounts = options.accounts ?? [{ uid: `${id}-1`, credits: 0, state: 'ok' as const }]
  const supplier = {
    id,
    name: id,
    priority: 0,
    pool: new AccountPool(id),
    status: () => ({ id, name: id, accounts }),
    listModels: () => models.map((modelId) => ({ id: modelId })),
    modelsWithEnabled: () => models.map((modelId) => ({ id: modelId, enabled: true })),
    getAlias: () => options.alias ?? id,
    accounts: () => accounts,
    chatOnce: async () => ({ ok: false as const, state: 'unknown' as const, message: 'not used' }),
    responsesOnce: async (uid: string, _lv: string, req: { rawBody: string; signal?: AbortSignal }) => options.responsesOnce(uid, req),
    dispose: () => {},
  }
  router.add(supplier as unknown as Supplier)
  return supplier.pool
}

function addChatOnlySupplier(
  router: Router,
  options: {
    id?: string
    alias?: string
    models?: string[]
    accounts?: SupplierAccountNow[]
    chatOnce: (uid: string, lv: string, req: Parameters<Supplier['chatOnce']>[2]) => Promise<ChatOnceResult>
    responsesOnce?: (uid: string, req: { rawBody: string; signal?: AbortSignal }) => Promise<ResponsesOnceResult>
  },
): AccountPool {
  const id = options.id ?? 'chat-only'
  const models = options.models ?? ['model-1']
  const accounts = options.accounts ?? [{ uid: `${id}-1`, credits: 0, state: 'ok' as const }]
  const supplier = {
    id,
    name: id,
    priority: 0,
    pool: new AccountPool(id),
    status: () => ({ id, name: id, accounts }),
    listModels: () => models.map((modelId) => ({ id: modelId })),
    modelsWithEnabled: () => models.map((modelId) => ({ id: modelId, enabled: true })),
    getAlias: () => options.alias ?? id,
    accounts: () => accounts,
    chatOnce: options.chatOnce,
    ...(options.responsesOnce === undefined ? {} : {
      responsesOnce: async (uid: string, _lv: string, req: { rawBody: string; signal?: AbortSignal }) => options.responsesOnce!(uid, req),
    }),
    dispose: () => {},
  }
  router.add(supplier as unknown as Supplier)
  return supplier.pool
}

const successfulChatResponse = (body: string): ChatOnceResult => ({ ok: true, status: 200, body })

const request = (overrides: Partial<{ model: string; stream: boolean; rawBody: string; signal: AbortSignal }> = {}) => {
  const model = overrides.model ?? 'native/model-1'
  const stream = overrides.stream ?? true
  return {
    model,
    stream,
    rawBody: overrides.rawBody ?? JSON.stringify({ model, input: 'hello', stream }),
    ...(overrides.signal === undefined ? {} : { signal: overrides.signal }),
  }
}

test('combo skips an unsupported Chat-only leg and reaches later native Responses leg', async () => {
  const router = new Router('')
  let chatCalls = 0
  let nativeCalls = 0
  addChatOnlySupplier(router, {
    id: 'chat',
    alias: 'chat',
    models: ['m'],
    chatOnce: async () => {
      chatCalls++
      return successfulChatResponse('{}')
    },
  })
  addNativeSupplier(router, {
    id: 'native',
    alias: 'native',
    models: ['m'],
    responsesOnce: async (_uid, req) => {
      nativeCalls++
      assert.equal(JSON.parse(req.rawBody).previous_response_id, 'resp_1')
      return { ok: true, status: 200, body: '{"id":"resp_native_combo","status":"completed","output":[]}' }
    },
  })
  assert.equal(router.createCombo('mixed', ['chat,m', 'native,m']).ok, true)
  const res = new CaptureResponse()
  await router.responses(request({
    model: 'mixed', stream: false,
    rawBody: JSON.stringify({ model: 'mixed', input: 'hello', previous_response_id: 'resp_1', stream: false }),
  }), res as never)

  assert.equal(res.statusCode, 200)
  assert.equal(chatCalls, 0)
  assert.equal(nativeCalls, 1)
  assert.equal(JSON.parse(res.body()).id, 'resp_native_combo')
})

test('Responses combo reports availability, not unsupported input, after a native-capable leg fails', async () => {
  const router = new Router('')
  let chatCalls = 0
  addNativeSupplier(router, {
    id: 'native-fails',
    alias: 'native-fails',
    models: ['m'],
    responsesOnce: async () => ({ ok: false, state: 'transport', message: 'native unavailable' }),
  })
  addChatOnlySupplier(router, {
    id: 'chat-later',
    alias: 'chat-later',
    models: ['m'],
    chatOnce: async () => {
      chatCalls++
      return successfulChatResponse('{}')
    },
  })
  assert.equal(router.createCombo('native-then-chat', ['native-fails,m', 'chat-later,m']).ok, true)
  const res = new CaptureResponse()
  await router.responses(request({
    model: 'native-then-chat', stream: false,
    rawBody: JSON.stringify({ model: 'native-then-chat', input: 'hello', previous_response_id: 'resp_1', stream: false }),
  }), res as never)

  assert.equal(res.statusCode, 503)
  assert.equal(JSON.parse(res.body()).error.code, 'no_healthy_supplier')
  assert.equal(chatCalls, 0)
})

test('Responses combo rejects unsupported input only when every candidate is Chat-only', async () => {
  const router = new Router('')
  let chatCalls = 0
  for (const id of ['chat-a', 'chat-b']) {
    addChatOnlySupplier(router, {
      id,
      alias: id,
      models: ['m'],
      chatOnce: async () => {
        chatCalls++
        return successfulChatResponse('{}')
      },
    })
  }
  assert.equal(router.createCombo('chat-only-combo', ['chat-a,m', 'chat-b,m']).ok, true)
  const res = new CaptureResponse()
  await router.responses(request({
    model: 'chat-only-combo', stream: false,
    rawBody: JSON.stringify({ model: 'chat-only-combo', input: 'hello', previous_response_id: 'resp_1', stream: false }),
  }), res as never)

  assert.equal(res.statusCode, 400)
  assert.equal(JSON.parse(res.body()).error.code, 'unsupported_parameter')
  assert.equal(chatCalls, 0)
})

test('native Responses stream is passed byte-for-byte without Chat DONE framing', async () => {
  const router = new Router('')
  const chunks = [
    'event: response.created\r\ndata: {"type":"response.created"}\r\n\r\n',
    'event: response.completed\r\ndata: {"type":"response.completed","response":{"id":"resp_1","status":"completed","usage":{"input_tokens":2,"output_tokens":1}}}\r\n\r\n',
  ]
  let receivedBody: Record<string, unknown> | undefined
  addNativeSupplier(router, {
    alias: 'alias',
    responsesOnce: async (_uid, req) => {
      receivedBody = JSON.parse(req.rawBody) as Record<string, unknown>
      return { ok: true, stream: byteStream(...chunks) }
    },
  })
  const res = new CaptureResponse()
  await router.responses(request({ model: 'alias/model-1' }), res as never)
  assert.equal(res.statusCode, 200)
  assert.equal(res.body(), chunks.join(''))
  assert.equal(res.body().includes('[DONE]'), false)
  assert.deepEqual(receivedBody, { model: 'alias/model-1', input: 'hello', stream: true })
  const stats = router.usage.stats('today')
  assert.equal(stats.ok, 1)
  assert.equal(stats.byModel[0]?.name, 'alias/model-1')
})

test('native Responses aggregation accepts CR-only line endings across chunks', async () => {
  const router = new Router('')
  const completed = { id: 'resp_cr', status: 'completed', output: [] }
  const cr = String.fromCharCode(13)
  const frame = ['event: response.completed', `data: ${JSON.stringify({ type: 'response.completed', response: completed })}`, '', ''].join(cr)
  const split = frame.indexOf(cr) + 1
  addNativeSupplier(router, {
    responsesOnce: async () => ({ ok: true, stream: byteStream(frame.slice(0, split), frame.slice(split)) }),
  })
  const res = new CaptureResponse()
  await router.responses(request({ stream: false }), res as never)
  assert.equal(res.statusCode, 200)
  assert.deepEqual(JSON.parse(res.body()), completed)
})

test('native Responses non-stream aggregates only a completed response', async () => {
  const router = new Router('')
  const completed = { id: 'resp_2', status: 'completed', output: [{ type: 'message' }] }
  addNativeSupplier(router, {
    responsesOnce: async () => ({
      ok: true,
      stream: byteStream(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: completed })}\n\n`),
    }),
  })
  const res = new CaptureResponse()
  await router.responses(request({ stream: false }), res as never)
  assert.equal(res.statusCode, 200)
  assert.deepEqual(JSON.parse(res.body()), completed)
})

test('native Responses aborts a supplier that hangs during setup at the first-byte deadline', async () => {
  const budgetMs = 60
  const router = new Router('', undefined, undefined, { firstByteBudgetMs: budgetMs })
  let signal: AbortSignal | undefined
  addNativeSupplier(router, {
    responsesOnce: async (_uid, req) => {
      signal = req.signal
      return new Promise<ResponsesOnceResult>(() => {})
    },
  })
  const res = new CaptureResponse()
  const startedAt = Date.now()
  await router.responses(request(), res as never)
  assert.equal(res.statusCode, 503)
  assert.equal(signal?.aborted, true)
  assert.ok(Date.now() - startedAt < budgetMs + 250)
})

test('native Responses cancels a stream returned after supplier setup timed out', async () => {
  const budgetMs = 50
  const router = new Router('', undefined, undefined, { firstByteBudgetMs: budgetMs })
  let markCancelled!: () => void
  const cancelled = new Promise<void>((resolve) => { markCancelled = resolve })
  addNativeSupplier(router, {
    responsesOnce: async (_uid, req) => new Promise<ResponsesOnceResult>((resolve) => {
      req.signal?.addEventListener('abort', () => {
        setTimeout(() => resolve({ ok: true, stream: new ReadableStream<Uint8Array>({ cancel: markCancelled }) }), 10)
      }, { once: true })
    }),
  })
  const res = new CaptureResponse()
  await router.responses(request(), res as never)
  assert.equal(res.statusCode, 503)
  await Promise.race([cancelled, new Promise((_, reject) => setTimeout(() => reject(new Error('late stream was not cancelled')), 300))])
})

test('native Responses no-account supplier respects the first-byte budget', async () => {
  const budgetMs = 40
  const router = new Router('', undefined, undefined, { firstByteBudgetMs: budgetMs })
  let cancelled = false
  addNativeSupplier(router, {
    accounts: [],
    responsesOnce: async () => {
      await new Promise((resolve) => setTimeout(resolve, budgetMs + 20))
      const stream = new ReadableStream<Uint8Array>({
        pull() { return new Promise(() => {}) },
        cancel() { cancelled = true },
      })
      return { ok: true, stream }
    },
  })
  const res = new CaptureResponse()
  await router.responses(request(), res as never)
  assert.equal(res.statusCode, 503)
  await Promise.race([new Promise<void>((resolve) => {
    const poll = () => cancelled ? resolve() : setTimeout(poll, 5)
    poll()
  }), new Promise((_, reject) => setTimeout(() => reject(new Error('late no-account stream was not cancelled')), 300))])
})

test('native Responses does not restart the first-byte budget after supplier setup', async () => {
  const budgetMs = 350
  const router = new Router('', undefined, undefined, { firstByteBudgetMs: budgetMs })
  let cancelled = false
  addNativeSupplier(router, {
    responsesOnce: async () => {
      await new Promise((resolve) => setTimeout(resolve, budgetMs + 40))
      const stream = new ReadableStream<Uint8Array>({
        pull() { return new Promise(() => {}) },
        cancel() { cancelled = true },
      })
      return { ok: true, stream }
    },
  })
  const res = new CaptureResponse()
  const startedAt = Date.now()
  await router.responses(request(), res as never)
  const elapsed = Date.now() - startedAt
  assert.equal(res.statusCode, 503)
  await Promise.race([new Promise<void>((resolve) => {
    const poll = () => cancelled ? resolve() : setTimeout(poll, 5)
    poll()
  }), new Promise((_, reject) => setTimeout(() => reject(new Error('late stream was not cancelled')), 300))])
  assert.ok(elapsed < budgetMs + 250, `expected deadline not to restart, took ${elapsed}ms`)
})

test('a terminal failure invalidates an earlier completed Responses event', async () => {
  const router = new Router('')
  const good = { id: 'resp_3', status: 'completed' }
  addNativeSupplier(router, {
    responsesOnce: async () => ({
      ok: true,
      stream: byteStream(
        `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: good })}\n\n`,
        'event: response.failed\ndata: {"type":"response.failed"}\n\n',
      ),
    }),
  })
  const res = new CaptureResponse()
  await router.responses(request({ stream: false }), res as never)
  assert.equal(res.statusCode, 503)
  assert.match(res.body(), /no_healthy_supplier/)
  assert.equal(router.usage.stats('today').failed, 1)
})

test('native Responses does not retry another account after the client disconnects before first byte', async () => {
  const router = new Router('', undefined, undefined, { firstByteBudgetMs: 500 })
  const accounts: SupplierAccountNow[] = [
    { uid: 'first', credits: 0, state: 'ok' },
    { uid: 'second', credits: 0, state: 'ok' },
  ]
  const tried: string[] = []
  let started!: () => void
  const supplierStarted = new Promise<void>((resolve) => { started = resolve })
  addNativeSupplier(router, {
    accounts,
    responsesOnce: async (uid) => {
      tried.push(uid)
      started()
      return { ok: true, stream: new ReadableStream<Uint8Array>({ pull() { return new Promise(() => {}) } }) }
    },
  })
  const res = new CaptureResponse()
  const routed = router.responses(request(), res as never)
  await supplierStarted
  await new Promise((resolve) => setTimeout(resolve, 10))
  res.destroy()
  await routed
  assert.deepEqual(tried, ['first'])
  assert.equal(res.statusCode, 200)
  assert.equal(res.body(), '')
})

test('native Responses cancels an active stream and avoids retry after request abort', async () => {
  const router = new Router('', undefined, undefined, { firstByteBudgetMs: 500 })
  const accounts: SupplierAccountNow[] = [
    { uid: 'first', credits: 0, state: 'ok' },
    { uid: 'second', credits: 0, state: 'ok' },
  ]
  const tried: string[] = []
  const controller = new AbortController()
  let started!: () => void
  const supplierStarted = new Promise<void>((resolve) => { started = resolve })
  let cancelled!: () => void
  const streamCancelled = new Promise<void>((resolve) => { cancelled = resolve })
  const pool = addNativeSupplier(router, {
    accounts,
    responsesOnce: async (uid) => {
      tried.push(uid)
      started()
      return { ok: true, stream: new ReadableStream<Uint8Array>({
        pull() { return new Promise<void>(() => {}) },
        cancel: cancelled,
      }) }
    },
  })
  const res = new CaptureResponse()
  const routed = router.responses(request({ signal: controller.signal }), res as never)
  await supplierStarted
  await new Promise((resolve) => setTimeout(resolve, 10))
  controller.abort(new Error('client cancelled during response stream'))
  await routed
  await Promise.race([streamCancelled, new Promise((_, reject) => setTimeout(() => reject(new Error('active upstream stream was not cancelled')), 300))])

  assert.deepEqual(tried, ['first'])
  assert.equal(res.headersSent, false)
  assert.equal(pool.decorate(accounts, 'model-1')[0]?.cooling, false)
})

test('native Responses non-stream aggregation cancels upstream on request abort', async () => {
  const router = new Router('', undefined, undefined, { firstByteBudgetMs: 500 })
  const accounts: SupplierAccountNow[] = [
    { uid: 'first', credits: 0, state: 'ok' },
    { uid: 'second', credits: 0, state: 'ok' },
  ]
  const tried: string[] = []
  const controller = new AbortController()
  let started!: () => void
  const supplierStarted = new Promise<void>((resolve) => { started = resolve })
  let cancelled!: () => void
  const streamCancelled = new Promise<void>((resolve) => { cancelled = resolve })
  const pool = addNativeSupplier(router, {
    accounts,
    responsesOnce: async (uid) => {
      tried.push(uid)
      started()
      return { ok: true, stream: new ReadableStream<Uint8Array>({
        pull() { return new Promise<void>(() => {}) },
        cancel: cancelled,
      }) }
    },
  })
  const res = new CaptureResponse()
  const routed = router.responses(request({ stream: false, signal: controller.signal }), res as never)
  await supplierStarted
  await new Promise((resolve) => setTimeout(resolve, 10))
  controller.abort(new Error('client cancelled aggregated response'))
  await routed
  await Promise.race([streamCancelled, new Promise((_, reject) => setTimeout(() => reject(new Error('aggregated upstream stream was not cancelled')), 300))])

  assert.deepEqual(tried, ['first'])
  assert.equal(res.headersSent, false)
  assert.equal(pool.decorate(accounts, 'model-1')[0]?.cooling, false)
})

test('native Responses records request abort without retry or account cooldown', async () => {
  const router = new Router('', undefined, undefined, { firstByteBudgetMs: 500 })
  const accounts: SupplierAccountNow[] = [
    { uid: 'first', credits: 0, state: 'ok' },
    { uid: 'second', credits: 0, state: 'ok' },
  ]
  const tried: string[] = []
  const controller = new AbortController()
  let started!: () => void
  const supplierStarted = new Promise<void>((resolve) => { started = resolve })
  const pool = addNativeSupplier(router, {
    accounts,
    responsesOnce: async (uid, req) => {
      tried.push(uid)
      started()
      return new Promise<ResponsesOnceResult>((resolve) => {
        req.signal?.addEventListener('abort', () => resolve({
          ok: false, state: 'transport', message: 'supplier observed abort',
        }), { once: true })
      })
    },
  })
  const res = new CaptureResponse()
  const routed = router.responses(request({ signal: controller.signal }), res as never)
  await supplierStarted
  controller.abort(new Error('client cancelled request'))
  await routed

  assert.deepEqual(tried, ['first'])
  assert.equal(res.headersSent, false)
  assert.equal(router.usage.stats('today').failed, 1)
  assert.equal(pool.decorate(accounts, 'model-1')[0]?.cooling, false)
})

test('native Responses does not retry after writer throws after committing headers', async () => {
  const router = new Router('', undefined, undefined, { firstByteBudgetMs: 500 })
  const accounts: SupplierAccountNow[] = [
    { uid: 'first', credits: 0, state: 'ok' },
    { uid: 'second', credits: 0, state: 'ok' },
  ]
  const tried: string[] = []
  addNativeSupplier(router, {
    accounts,
    responsesOnce: async (uid) => {
      tried.push(uid)
      return { ok: true, stream: byteStream('event: response.completed\\ndata: {"type":"response.completed","response":{"status":"completed"}}\\n\\n') }
    },
  })
  const res = new CommitThenThrowResponse()
  await router.responses(request(), res as never)
  assert.deepEqual(tried, ['first'])
  assert.equal(res.headersSent, true)
  assert.equal(res.statusCode, 200)
  assert.equal(res.body(), '')
})

test('native Responses retries another account after a pre-commit transport failure', async () => {
  const router = new Router('', undefined, undefined, { firstByteBudgetMs: 500 })
  const accounts: SupplierAccountNow[] = [
    { uid: 'first', credits: 0, state: 'ok' },
    { uid: 'second', credits: 0, state: 'ok' },
  ]
  const tried: string[] = []
  addNativeSupplier(router, {
    accounts,
    responsesOnce: async (uid) => {
      tried.push(uid)
      if (uid === 'first') throw new Error('socket closed before headers')
      return { ok: true, stream: byteStream('event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n') }
    },
  })
  const res = new CaptureResponse()
  await router.responses(request(), res as never)
  assert.deepEqual(tried, ['first', 'second'])
  assert.match(res.body(), /response.completed/)
  assert.equal(router.usage.stats('today').ok, 1)
})

test('JSON success is converted to SSE only for a completed Responses object', async () => {
  const router = new Router('')
  addNativeSupplier(router, {
    responsesOnce: async () => ({ ok: true, status: 200, body: '{"id":"resp_4","status":"completed"}' }),
  })
  const res = new CaptureResponse()
  await router.responses(request(), res as never)
  assert.match(res.body(), /^event: response\.completed\ndata: /)
  assert.equal(res.body().endsWith('\n\n'), true)
})

test('Chat-only supplier serves supported non-stream Responses JSON through the Chat contract', async () => {
  const router = new Router('')
  let received: Record<string, unknown> | undefined
  addChatOnlySupplier(router, {
    chatOnce: async (_uid, _lv, req) => {
      received = JSON.parse(req.rawBody) as Record<string, unknown>
      return successfulChatResponse(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'hello from Chat' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 7, completion_tokens: 3 },
      }))
    },
  })
  const model = 'chat-only/model-1'
  const res = new CaptureResponse()
  await router.responses(request({
    model,
    stream: false,
    rawBody: JSON.stringify({
      model,
      input: [{ role: 'user', content: 'hello' }],
      instructions: 'Be concise',
      max_output_tokens: 24,
      temperature: 0.2,
      stream: false,
    }),
  }), res as never)

  assert.equal(res.statusCode, 200)
  assert.equal(received?.model, model)
  assert.deepEqual(received?.messages, [
    { role: 'system', content: 'Be concise' },
    { role: 'user', content: 'hello' },
  ])
  assert.equal(received?.max_tokens, 24)
  const response = JSON.parse(res.body()) as {
    status: string
    output: Array<{ type: string; content?: Array<{ text?: string }> }>
    usage: { input_tokens: number; output_tokens: number }
  }
  assert.equal(response.status, 'completed')
  assert.equal(response.output[0]?.content?.[0]?.text, 'hello from Chat')
  assert.deepEqual(response.usage, { input_tokens: 7, output_tokens: 3, total_tokens: 10 })
})

test('Chat-only supplier converts streaming Chat tool calls to Responses SSE with call IDs', async () => {
  const router = new Router('')
  const chatSse = [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_weather_123","type":"function","function":{"name":"get_weather","arguments":""}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"city\\":\\"Paris\\"}"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
    'data: [DONE]\n\n',
  ].join('')
  addChatOnlySupplier(router, {
    chatOnce: async () => ({ ok: true, stream: byteStream(chatSse) }),
  })
  const res = new CaptureResponse()
  await router.responses(request({ model: 'chat-only/model-1' }), res as never)

  assert.equal(res.statusCode, 200)
  assert.match(res.body(), /event: response\.output_item\.added/)
  assert.match(res.body(), /"call_id":"call_weather_123"/)
  assert.match(res.body(), /"name":"get_weather"/)
  assert.match(res.body(), /event: response\.function_call_arguments\.delta/)
  assert.ok(res.body().includes('"delta":"{\\"city\\":\\"Paris\\"}"'))
  assert.match(res.body(), /event: response\.completed/)
})

test('unsupported Responses state is rejected before Chat-only chatOnce is called', async () => {
  const router = new Router('')
  let chatCalls = 0
  addChatOnlySupplier(router, {
    chatOnce: async () => {
      chatCalls++
      return successfulChatResponse('{}')
    },
  })
  const model = 'chat-only/model-1'
  const res = new CaptureResponse()
  await router.responses(request({
    model,
    stream: false,
    rawBody: JSON.stringify({ model, input: 'hello', previous_response_id: 'resp_previous', stream: false }),
  }), res as never)

  assert.equal(chatCalls, 0)
  assert.equal(res.statusCode, 400)
  assert.equal(JSON.parse(res.body()).error.code, 'unsupported_parameter')
})

test('closing the Responses client aborts Chat fallback without account retry or cooldown', async () => {
  const router = new Router('', undefined, undefined, { firstByteBudgetMs: 500 })
  const accounts: SupplierAccountNow[] = [
    { uid: 'first', credits: 0, state: 'ok' },
    { uid: 'second', credits: 0, state: 'ok' },
  ]
  const tried: string[] = []
  let supplierSignal: AbortSignal | undefined
  let started!: () => void
  const chatStarted = new Promise<void>((resolve) => { started = resolve })
  const pool = addChatOnlySupplier(router, {
    accounts,
    chatOnce: async (uid, _lv, req) => {
      tried.push(uid)
      supplierSignal = req.signal
      started()
      return new Promise<ChatOnceResult>(() => {})
    },
  })
  const controller = new AbortController()
  const res = new CaptureResponse()
  const routed = router.responses(request({ model: 'chat-only/model-1', signal: controller.signal }), res as never)
  await chatStarted
  res.destroy()
  await routed

  assert.equal(supplierSignal?.aborted, true)
  assert.deepEqual(tried, ['first'])
  assert.equal(pool.decorate(accounts, 'model-1')[0]?.cooling, false)
  assert.equal(pool.decorate(accounts, 'model-1')[1]?.cooling, false)
})

test('supplier with native Responses and Chat support prefers responsesOnce', async () => {
  const router = new Router('')
  let nativeCalls = 0
  let chatCalls = 0
  const nativeBody = '{"id":"resp_native_preferred","status":"completed","output":[]}'
  addChatOnlySupplier(router, {
    chatOnce: async () => {
      chatCalls++
      return successfulChatResponse('{}')
    },
    responsesOnce: async () => {
      nativeCalls++
      return { ok: true, status: 200, body: nativeBody }
    },
  })
  const res = new CaptureResponse()
  await router.responses(request({ model: 'chat-only/model-1', stream: false }), res as never)

  assert.equal(nativeCalls, 1)
  assert.equal(chatCalls, 0)
  assert.deepEqual(JSON.parse(res.body()), JSON.parse(nativeBody))
})

test('aborting a Chat-only Responses fallback does not retry or cool down its account', async () => {
  const router = new Router('', undefined, undefined, { firstByteBudgetMs: 500 })
  const accounts: SupplierAccountNow[] = [
    { uid: 'first', credits: 0, state: 'ok' },
    { uid: 'second', credits: 0, state: 'ok' },
  ]
  const tried: string[] = []
  const controller = new AbortController()
  let started!: () => void
  const chatStarted = new Promise<void>((resolve) => { started = resolve })
  const pool = addChatOnlySupplier(router, {
    accounts,
    chatOnce: async (uid) => {
      tried.push(uid)
      started()
      return new Promise<ChatOnceResult>((resolve) => {
        controller.signal.addEventListener('abort', () => resolve({
          ok: false, state: 'transport', message: 'Chat supplier observed client abort',
        }), { once: true })
      })
    },
  })
  const res = new CaptureResponse()
  const routed = router.responses(request({ model: 'chat-only/model-1', signal: controller.signal }), res as never)
  const outcome = await Promise.race([
    chatStarted.then(() => 'chat-started' as const),
    routed.then(() => 'route-finished' as const),
  ])
  assert.equal(outcome, 'chat-started', 'Chat-only Responses fallback should invoke chatOnce before route completion')
  controller.abort(new Error('client cancelled Chat-only fallback'))
  await routed

  assert.deepEqual(tried, ['first'])
  assert.equal(res.headersSent, false)
  assert.equal(pool.decorate(accounts, 'model-1')[0]?.cooling, false)
  assert.equal(pool.decorate(accounts, 'model-1')[1]?.cooling, false)
})
