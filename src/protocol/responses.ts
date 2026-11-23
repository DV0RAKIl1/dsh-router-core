/**
 * OpenAI Responses 协议（Codex 用的是它）。
 *
 * ════════════════════════════════════════════════════════════════════
 * 与 Chat Completions 的关键差异
 * ════════════════════════════════════════════════════════════════════
 *  请求  `input` 是**消息数组**（与 messages 同构）而不是 messages 本身
 *        `instructions` 替代 `system` 消息
 *        `max_output_tokens` 替代 `max_tokens`
 *        `tools` 项是扁平的 `{type:'function', name, parameters}`，
 *        没有 `function` 这一层包装
 *  响应  事件名带语义：`response.output_text.delta` / `response.function_call_arguments.delta`
 *        / `response.reasoning_summary_text.delta`，全部带 `sequence_number`
 *        收尾是 `response.completed`（带完整 response 对象），不是 finish_reason
 *
 * 丢弃（明确不做）：
 *   - `previous_response_id` / `store`：服务端会话态。我们的供应商契约是
 *     无状态的（`chatOnce` 一次一请求），转发过去只会拿到错误。
 *   - `reasoning.effort` 之外的 `reasoning.summary`：摘要粒度由上游定，
 *     我们只透传 reasoning 增量。
 *   - `include` / `text.format`（结构化输出）：跨协议没有对应物。
 */
import {
  type ChatEvent,
  type CodecContext,
  type CodecSession,
  type JsonObject,
  type ProtocolCodec,
  arr,
  finishOf,
  num,
  obj,
  str,
} from './types.ts'
import { dataFrame, eventFrame } from './sse.ts'

export const responsesCodec: ProtocolCodec = {
  id: 'responses',

  /** Responses 请求 → Chat Completions 请求。 */
  toChat(body, ctx) {
    const out: JsonObject = { ...body }
    delete out.input
    delete out.instructions
    delete out.tools
    delete out.max_output_tokens
    delete out.previous_response_id
    delete out.store
    delete out.include
    delete out.reasoning

    const messages: unknown[] = []
    const instructions = str(body.instructions)
    if (instructions !== undefined) messages.push({ role: 'system', content: instructions })
    for (const m of arr(body.input) ?? []) messages.push(inputItem(m))
    out.messages = messages
    if (body.max_output_tokens !== undefined) out.max_tokens = body.max_output_tokens
    if (body.temperature !== undefined) out.temperature = body.temperature
    if (body.top_p !== undefined) out.top_p = body.top_p
    const tools = convertTools(body.tools)
    if (tools.length > 0) out.tools = tools
    if (ctx.stream) out.stream = true
    return out
  },

  /** Chat Completions 请求 → Responses 请求。 */
  fromChat(body, ctx) {
    const out: JsonObject = { ...body }
    delete out.messages
    delete out.tools
    delete out.stream
    delete out.max_tokens

    const input: unknown[] = []
    const instructions: string[] = []
    for (const m of arr(body.messages) ?? []) {
      const msg = obj(m)
      if (msg === undefined) continue
      const role = str(msg.role)
      if (role === 'system' || role === 'developer') {
        const t = contentText(msg.content)
        if (t !== '') instructions.push(t)
        continue
      }
      // tool 角色 → `function_call_output`：Chat 把工具结果放在 role:'tool'，
      // Responses 放在一个独立的 input 项里。丢了它上游会以为「工具从没被调用过」，
      // 于是重复发起同一个调用 —— 表现为无限工具循环。
      if (role === 'tool') {
        input.push({
          type: 'function_call_output',
          call_id: str(msg.tool_call_id) ?? '',
          output: contentText(msg.content),
        })
        continue
      }
      const content = responsesMessageContent(msg.content, role === 'assistant' ? 'assistant' : 'user')
      // 文本或图片至少有一种才造 message；只有 tool_calls 的 assistant 不需要空 message。
      if ((typeof content === 'string' && content !== '') || (Array.isArray(content) && content.length > 0)) {
        input.push({
          type: 'message',
          role: role === 'assistant' ? 'assistant' : 'user',
          content,
        })
      }
      // assistant 的 tool_calls → 每个一个 `function_call` 项（Responses 没有
      // 嵌套的 tool_calls，是平铺的独立项）。
      if (role === 'assistant') {
        for (const tc of arr(msg.tool_calls) ?? []) {
          const call = obj(tc)
          const fn = obj(call?.function)
          if (call === undefined || fn === undefined) continue
          const name = str(fn.name)
          if (name === undefined) continue
          input.push({
            type: 'function_call',
            call_id: str(call.id) ?? '',
            name,
            arguments: str(fn.arguments) ?? '{}',
          })
        }
      }
    }
    if (instructions.length > 0) out.instructions = instructions.join('\n\n')
    out.input = input
    if (body.max_tokens !== undefined) out.max_output_tokens = body.max_tokens
    const tools = (body.tools as unknown[] | undefined)?.map(chatToolToResponses).filter((t) => t !== undefined)
    if (tools !== undefined && tools.length > 0) out.tools = tools
    if (ctx.stream) out.stream = true
    return out
  },

  /* ---------------- 响应侧：Responses SSE → ChatEvent ---------------- */

  createSession() {
    return { state: newResponsesState() }
  },

  startFrames(ctx, session) {
    const state = responsesSession(session)
    return [responsesEvent(state, 'response.created', {
      type: 'response.created',
      response: { id: state.responseId, object: 'response', status: 'in_progress', model: ctx.model, output: [] },
    })]
  },

  decodeFrame(frame, event, session) {
    let payload: JsonObject
    try { payload = JSON.parse(frame) as JsonObject } catch { return [] }
    const state = responsesSession(session)
    const response = obj(payload.response)
    const responseId = str(response?.id)
    if (responseId !== undefined) state.responseId = responseId
    switch (event) {
      case 'response.created': return []
      case 'response.output_text.delta': {
        const delta = str(payload.delta)
        return delta === undefined ? [] : [{ type: 'text', text: delta }]
      }
      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_text.delta': {
        const delta = str(payload.delta)
        return delta === undefined ? [] : [{ type: 'reasoning', text: delta }]
      }
      case 'response.function_call_arguments.delta': {
        const delta = str(payload.delta)
        const outputIndex = num(payload.output_index) ?? 0
        const index = state.decodedToolIndexes[String(outputIndex)]
        return delta === undefined || delta === '' || index === undefined ? [] : [{ type: 'tool-args', index, delta }]
      }
      case 'response.output_item.added': {
        const responseStatus = str(response?.status)
        if (responseStatus === 'failed' || responseStatus === 'cancelled' || responseStatus === 'canceled') {
          const error = obj(response?.error)
          const message = str(error?.message) ?? `upstream response ${responseStatus}`
          state.error = message
          return [{ type: 'error', message }, { type: 'finish', reason: 'error' }]
        }
        return outputItemEvents(payload, state)
      }
      case 'response.completed':
      case 'response.incomplete': {
        const events = completedEvents(payload, state)
        if (state.error === undefined) return events
        return [{ type: 'error', message: state.error }, { type: 'finish', reason: 'error' }]
      }
      case 'response.failed':
      case 'response.cancelled':
      case 'response.canceled':
      case 'error': {
        const responsePayload = obj(payload.response)
        const responseStatus = str(responsePayload?.status)
        const err = obj(responsePayload?.error) ?? obj(payload.error)
        const message = str(err?.message) ?? str(payload.message)
          ?? (event === 'response.cancelled' || event === 'response.canceled' || responseStatus === 'cancelled' || responseStatus === 'canceled'
            ? 'upstream response cancelled'
            : 'upstream error')
        state.error = message
        return [{ type: 'error', message }, { type: 'finish', reason: 'error' }]
      }
      default: return []
    }
  },

  /* ---------------- 响应侧：ChatEvent → Responses SSE ---------------- */

  encodeFrame(event, session) {
    const state = responsesSession(session)
    switch (event.type) {
      case 'text': {
        const { index, item, added } = ensureResponsesMessage(state)
        appendResponsesText(item, event.text)
        const frames: string[] = []
        if (added) {
          frames.push(responsesEvent(state, 'response.output_item.added', {
            type: 'response.output_item.added', output_index: index,
            item: { id: item.id, type: 'message', status: 'in_progress', role: 'assistant', content: [] },
          }))
          frames.push(responsesEvent(state, 'response.content_part.added', {
            type: 'response.content_part.added', item_id: item.id, output_index: index, content_index: 0,
            part: { type: 'output_text', text: '', annotations: [] },
          }))
        }
        frames.push(responsesEvent(state, 'response.output_text.delta', {
          type: 'response.output_text.delta', item_id: item.id, output_index: index, content_index: 0, delta: event.text,
        }))
        return frames
      }
      case 'reasoning': {
        const { index, item, added } = ensureResponsesReasoning(state)
        const summary = (item.summary as JsonObject[])[0]!
        summary.text = String(summary.text ?? '') + event.text
        const frames: string[] = []
        if (added) frames.push(responsesEvent(state, 'response.output_item.added', {
          type: 'response.output_item.added', output_index: index,
          item: { id: item.id, type: 'reasoning', status: 'in_progress', summary: [] },
        }))
        frames.push(responsesEvent(state, 'response.reasoning_summary_text.delta', {
          type: 'response.reasoning_summary_text.delta', item_id: item.id, output_index: index, summary_index: 0, delta: event.text,
        }))
        return frames
      }
      case 'tool-start': {
        const index = state.output.length
        const item: JsonObject = {
          type: 'function_call', id: `fc_${event.index}_${state.responseId}`, status: 'in_progress',
          call_id: event.id ?? `call_${event.index}`, name: event.name ?? '', arguments: '',
        }
        state.toolIndexes[String(event.index)] = index
        state.output.push(item)
        return [responsesEvent(state, 'response.output_item.added', {
          type: 'response.output_item.added', output_index: index,
          item: { ...item },
        })]
      }
      case 'tool-args': {
        const outputIndex = state.toolIndexes[String(event.index)]
        const item = outputIndex === undefined ? undefined : state.output[outputIndex]
        if (item === undefined || item.type !== 'function_call') return []
        item.arguments = String(item.arguments ?? '') + event.delta
        return [responsesEvent(state, 'response.function_call_arguments.delta', {
          type: 'response.function_call_arguments.delta', item_id: item.id, output_index: outputIndex, delta: event.delta,
        })]
      }
      case 'error':
        state.error = event.message
        return [responsesEvent(state, 'error', { type: 'error', code: 'server_error', message: event.message })]
      case 'usage':
      case 'finish': return []
    }
  },

  /** Build a standard Responses response from normalized Chat events. */
  encodeJson(events, ctx) {
    const state = newResponsesState()
    let status = 'completed'
    let usage = { input: 0, output: 0, cached: 0 }
    for (const ev of events) {
      switch (ev.type) {
        case 'text': {
          const { item } = ensureResponsesMessage(state)
          appendResponsesText(item, ev.text)
          break
        }
        case 'reasoning': {
          const { item } = ensureResponsesReasoning(state)
          const summary = (item.summary as JsonObject[])[0]!
          summary.text = String(summary.text ?? '') + ev.text
          break
        }
        case 'tool-start': {
          const index = state.output.length
          const item: JsonObject = {
            type: 'function_call', id: `fc_${ev.index}_${state.responseId}`, status: 'completed',
            call_id: ev.id ?? `call_${ev.index}`, name: ev.name ?? '', arguments: '',
          }
          state.toolIndexes[String(ev.index)] = index
          state.output.push(item)
          break
        }
        case 'tool-args': {
          const index = state.toolIndexes[String(ev.index)]
          const item = index === undefined ? undefined : state.output[index]
          if (item !== undefined && item.type === 'function_call') item.arguments = String(item.arguments ?? '') + ev.delta
          break
        }
        case 'finish':
          if (ev.reason === 'length' || ev.reason === 'content-filter') status = 'incomplete'
          else if (ev.reason === 'error') status = 'failed'
          break
        case 'usage': usage = { input: ev.promptTokens, output: ev.completionTokens, cached: ev.cachedTokens }; break
        case 'error': state.error = ev.message; status = 'failed'; break
      }
    }
    const itemStatus = status === 'completed' ? 'completed' : 'incomplete'
    for (const item of state.output) item.status = itemStatus
    const response: JsonObject = {
      id: state.responseId, object: 'response', status, model: ctx.model, output: state.output,
    }
    if (events.some((ev) => ev.type === 'usage')) {
      response.usage = {
        input_tokens: usage.input, output_tokens: usage.output, total_tokens: usage.input + usage.output,
        ...(usage.cached > 0 ? { input_tokens_details: { cached_tokens: usage.cached } } : {}),
      }
    }
    if (status === 'incomplete') {
      const reason = events.some((ev) => ev.type === 'finish' && ev.reason === 'content-filter') ? 'content_filter' : 'max_output_tokens'
      response.incomplete_details = { reason }
    }
    if (status === 'failed') response.error = { code: 'server_error', message: state.error ?? 'upstream error' }
    return response
  },

  /** Stream finalizers include full item contents and correlated IDs. */
  endFrames(ctx, session) {
    const state = responsesSession(session)
    const frames: string[] = []
    const terminalStatus = ctx.finish === 'length' || ctx.finish === 'content-filter'
      ? 'incomplete'
      : ctx.finish === 'error' ? 'failed' : 'completed'
    const itemStatus = terminalStatus === 'completed' ? 'completed' : 'incomplete'
    for (let index = 0; index < state.output.length; index++) {
      const item = state.output[index]!
      if (item.type === 'message') {
        const content = (item.content as JsonObject[])[0]
        if (content !== undefined) {
          frames.push(responsesEvent(state, 'response.output_text.done', {
            type: 'response.output_text.done', item_id: item.id, output_index: index, content_index: 0, text: content.text,
          }))
          frames.push(responsesEvent(state, 'response.content_part.done', {
            type: 'response.content_part.done', item_id: item.id, output_index: index, content_index: 0,
            part: { ...content },
          }))
        }
        frames.push(responsesEvent(state, 'response.output_item.done', {
          type: 'response.output_item.done', output_index: index, item: { ...item, status: itemStatus },
        }))
        item.status = itemStatus
      } else if (item.type === 'reasoning') {
        const summary = (item.summary as JsonObject[])[0]
        frames.push(responsesEvent(state, 'response.reasoning_summary_text.done', {
          type: 'response.reasoning_summary_text.done', item_id: item.id, output_index: index, summary_index: 0,
          text: summary?.text ?? '',
        }))
        frames.push(responsesEvent(state, 'response.output_item.done', {
          type: 'response.output_item.done', output_index: index, item: { ...item, status: itemStatus },
        }))
        item.status = itemStatus
      } else if (item.type === 'function_call') {
        frames.push(responsesEvent(state, 'response.function_call_arguments.done', {
          type: 'response.function_call_arguments.done', item_id: item.id, output_index: index, arguments: item.arguments,
        }))
        frames.push(responsesEvent(state, 'response.output_item.done', {
          type: 'response.output_item.done', output_index: index, item: { ...item, status: itemStatus },
        }))
        item.status = itemStatus
      }
    }
    const response: JsonObject = {
      id: state.responseId, object: 'response', status: terminalStatus,
      model: ctx.model, output: state.output,
    }
    if (ctx.finish === 'length' || ctx.finish === 'content-filter') {
      response.incomplete_details = { reason: ctx.finish === 'content-filter' ? 'content_filter' : 'max_output_tokens' }
    }
    if (ctx.usage !== undefined) {
      response.usage = {
        input_tokens: ctx.usage.promptTokens, output_tokens: ctx.usage.completionTokens,
        total_tokens: ctx.usage.promptTokens + ctx.usage.completionTokens,
        ...(ctx.usage.cachedTokens > 0 ? { input_tokens_details: { cached_tokens: ctx.usage.cachedTokens } } : {}),
      }
    }
    if (ctx.finish === 'error') {
      response.status = 'failed'
      response.error = { code: 'server_error', message: state.error ?? 'upstream error' }
      frames.push(responsesEvent(state, 'response.failed', { type: 'response.failed', response }))
    } else {
      frames.push(responsesEvent(state, 'response.completed', { type: 'response.completed', response }))
    }
    return frames
  },

  decodeJson(body) {
    const out: ChatEvent[] = []
    let index = 0
    for (const item of arr(body.output) ?? []) {
      const it = obj(item)
      if (it === undefined) continue
      if (it.type === 'message') {
        for (const part of arr(it.content) ?? []) {
          const value = str(obj(part)?.text)
          if (value !== undefined) out.push({ type: 'text', text: value })
        }
      } else if (it.type === 'function_call') {
        out.push({ type: 'tool-start', index, ...(str(it.call_id) === undefined ? {} : { id: str(it.call_id) }), name: str(it.name) ?? '' })
        out.push({ type: 'tool-args', index, delta: str(it.arguments) ?? '' })
        index += 1
      } else if (it.type === 'reasoning') {
        for (const part of arr(it.summary) ?? []) {
          const value = str(obj(part)?.text)
          if (value !== undefined) out.push({ type: 'reasoning', text: value })
        }
      }
    }
    const usage = obj(body.usage)
    if (usage !== undefined) out.push({
      type: 'usage', promptTokens: num(usage.input_tokens) ?? 0, completionTokens: num(usage.output_tokens) ?? 0,
      cachedTokens: num(obj(usage.input_tokens_details)?.cached_tokens) ?? 0,
    })
    const status = str(body.status)
    const incompleteReason = str(obj(body.incomplete_details)?.reason)
    if (status === 'failed' || status === 'cancelled' || status === 'canceled') {
      const error = obj(body.error)
      const message = str(error?.message) ?? `upstream response ${status}`
      out.push({ type: 'error', message }, { type: 'finish', reason: 'error' })
    } else if (status === 'incomplete') {
      if (incompleteReason !== undefined && incompleteReason !== 'max_output_tokens' && incompleteReason !== 'content_filter') {
        out.push({ type: 'error', message: `unknown incomplete reason: ${incompleteReason}` }, { type: 'finish', reason: 'error' })
      } else {
        out.push({ type: 'finish', reason: incompleteReason === 'content_filter' ? 'content-filter' : 'length' })
      }
    } else if (status === 'completed') {
      out.push({ type: 'finish', reason: outputHasToolCall(body.output) ? 'tool-calls' : 'stop' })
    } else {
      out.push({ type: 'error', message: `unknown response status: ${status ?? 'missing'}` }, { type: 'finish', reason: 'error' })
    }
    return out
  },
}

interface ResponsesEncodingState {
  responseId: string
  sequence: number
  output: JsonObject[]
  toolIndexes: Record<string, number>
  decodedToolIndexes: Record<string, number>
  nextDecodedToolIndex: number
  error?: string
}

function newResponsesState(): ResponsesEncodingState {
  return {
    responseId: `resp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
    sequence: 0,
    output: [],
    toolIndexes: Object.create(null) as Record<string, number>,
    decodedToolIndexes: Object.create(null) as Record<string, number>,
    nextDecodedToolIndex: 0,
  }
}

function responsesSession(session?: { state?: unknown }): ResponsesEncodingState {
  const value = session?.state
  if (value !== null && typeof value === 'object' && 'responseId' in value && 'output' in value && 'toolIndexes' in value) {
    const state = value as ResponsesEncodingState
    state.decodedToolIndexes ??= Object.create(null) as Record<string, number>
    state.nextDecodedToolIndex ??= Object.keys(state.decodedToolIndexes).length
    return state
  }
  return newResponsesState()
}

function responsesEvent(state: ResponsesEncodingState, event: string, payload: JsonObject): string {
  payload.sequence_number = state.sequence++
  return eventFrame(event, JSON.stringify(payload))
}

function ensureResponsesMessage(state: ResponsesEncodingState): { index: number; item: JsonObject; added: boolean } {
  const lastIndex = state.output.length - 1
  const last = state.output[lastIndex]
  if (last?.type === 'message') return { index: lastIndex, item: last, added: false }
  const item: JsonObject = {
    id: `msg_${state.responseId}_${state.output.length}`, type: 'message', status: 'in_progress', role: 'assistant',
    content: [{ type: 'output_text', text: '', annotations: [] }],
  }
  state.output.push(item)
  return { index: state.output.length - 1, item, added: true }
}

function ensureResponsesReasoning(state: ResponsesEncodingState): { index: number; item: JsonObject; added: boolean } {
  const lastIndex = state.output.length - 1
  const last = state.output[lastIndex]
  if (last?.type === 'reasoning') return { index: lastIndex, item: last, added: false }
  const item: JsonObject = {
    id: `rs_${state.responseId}_${state.output.length}`, type: 'reasoning', status: 'in_progress',
    summary: [{ type: 'summary_text', text: '' }],
  }
  state.output.push(item)
  return { index: state.output.length - 1, item, added: true }
}

function appendResponsesText(item: JsonObject, text: string): void {
  const content = item.content as JsonObject[]
  if (content.length === 0) content.push({ type: 'output_text', text: '', annotations: [] })
  content[0]!.text = String(content[0]!.text ?? '') + text
}

/* ------------------------------------------------------------------ */
/* 请求侧实现                                                         */
/* ------------------------------------------------------------------ */

/** Responses 的 input 项 → Chat message。 */
function inputItem(item: unknown): JsonObject | undefined {
  const it = obj(item)
  if (it === undefined) return undefined
  const type = str(it.type)
  // 消息形态
  if (type === 'message' || type === undefined) {
    const role = str(it.role) ?? 'user'
    const content = it.content
    if (typeof content === 'string') return { role, content }
    const text: string[] = []
    for (const p of arr(content) ?? []) {
      const part = obj(p)
      const t = part === undefined ? undefined : (str(part.text) ?? str(part.output_text))
      if (t !== undefined) text.push(t)
    }
    return { role, content: text.join('\n\n') }
  }
  // function_call 形态（模型上一轮发起的调用）
  if (type === 'function_call') {
    return {
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: str(it.call_id) ?? str(it.id) ?? '',
        type: 'function',
        function: { name: str(it.name) ?? '', arguments: str(it.arguments) ?? '' },
      }],
    }
  }
  // function_call_output 形态（用户回传的工具结果）
  if (type === 'function_call_output') {
    return { role: 'tool', tool_call_id: str(it.call_id) ?? '', content: str(it.output) ?? '' }
  }
  return undefined
}

/** Chat message content → Responses message content, retaining input images. */
function responsesMessageContent(content: unknown, role: 'assistant' | 'user'): string | JsonObject[] {
  if (typeof content === 'string') return content
  const out: JsonObject[] = []
  for (const raw of arr(content) ?? []) {
    const part = obj(raw)
    if (part === undefined) continue
    const type = str(part.type)
    if (type === 'text' || type === 'input_text' || type === 'output_text') {
      const text = str(part.text)
      if (text !== undefined) out.push({ type: role === 'assistant' ? 'output_text' : 'input_text', text })
      continue
    }
    if (role === 'user' && type === 'image_url') {
      const image = part.image_url
      const imageObject = obj(image)
      const url = typeof image === 'string' ? image : str(imageObject?.url)
      if (url !== undefined && url !== '') {
        const detail = str(imageObject?.detail)
        out.push({
          type: 'input_image',
          image_url: url,
          ...(detail === undefined ? {} : { detail }),
        })
      }
    }
  }
  return out
}

/** Chat 的 content（字符串或 parts）→ 纯文本。 */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  const parts: string[] = []
  for (const p of arr(content) ?? []) {
    const t = str(obj(p)?.text)
    if (t !== undefined) parts.push(t)
  }
  return parts.join('\n\n')
}

/** Chat tools → Responses tools（扁平形态）。 */
function convertTools(tools: unknown): JsonObject[] {
  const out: JsonObject[] = []
  for (const t of arr(tools) ?? []) {
    // Responses 的 tools 是扁平的；兼容被中间层包过一层的输入
    const tool = obj(t)
    const fn = tool === undefined ? undefined : (obj(tool.function) ?? tool)
    if (fn === undefined) continue
    const name = str(fn.name)
    if (name === undefined) continue
    out.push({
      type: 'function',
      // Chat 的具名工具是 `{type:'function', function:{...}}`，规范形态就是
      // Chat 形态 —— 所以这里必须**恢复包装**，否则跨协议往返时工具被丢掉
      // （Responses 上游能接受扁平形态，但 Router 只认 Chat 形态）。
      function: {
        name,
        description: str(fn.description) ?? '',
        parameters: obj(fn.parameters) ?? { type: 'object', properties: {} },
      },
    })
  }
  return out
}

/**
 * Chat tool → Responses tool（`fromChat` 方向）。Responses 的 tools 是**扁平**的
 * `{ type:'function', name, description, parameters }`，而 Chat 的具名工具多包了
 * 一层 `function`。不解包的话 `tool.name` 恒为 undefined，工具被静默全部丢掉。
 */
function chatToolToResponses(t: unknown): JsonObject | undefined {
  const tool = obj(t)
  if (tool === undefined) return undefined
  const fn = obj(tool.function) ?? tool
  const name = str(fn.name)
  if (name === undefined) return undefined
  return {
    type: 'function',
    name,
    description: str(fn.description) ?? '',
    parameters: obj(fn.parameters) ?? { type: 'object', properties: {} },
  }
}

/* ------------------------------------------------------------------ */
/* 响应侧实现                                                         */
/* ------------------------------------------------------------------ */

/** `response.output_item.added`：函数调用项给出名字。 */
function outputItemEvents(payload: JsonObject, state: ResponsesEncodingState): ChatEvent[] {
  const item = obj(payload.item)
  const outputIndex = num(payload.output_index)
  if (item === undefined || item.type !== 'function_call' || outputIndex === undefined) return []
  const key = String(outputIndex)
  let chatIndex = state.decodedToolIndexes[key]
  if (chatIndex === undefined) {
    chatIndex = state.nextDecodedToolIndex++
    state.decodedToolIndexes[key] = chatIndex
  }
  return [{
    type: 'tool-start',
    index: chatIndex,
    ...(str(item.call_id) === undefined ? {} : { id: str(item.call_id) }),
    name: str(item.name) ?? '',
  }]
}

/** `response.completed`：收尾 + 用量都在这帧。 */
function completedEvents(payload: JsonObject, state: ResponsesEncodingState): ChatEvent[] {
  const response = obj(payload.response)
  const out: ChatEvent[] = []
  const usage = obj(response?.usage)
  if (usage !== undefined) {
    out.push({
      type: 'usage',
      promptTokens: num(usage.input_tokens) ?? 0,
      completionTokens: num(usage.output_tokens) ?? 0,
      cachedTokens: num(obj(usage.input_tokens_details)?.cached_tokens) ?? 0,
    })
  }
  const status = str(response?.status)
  if (status === 'failed' || status === 'cancelled' || status === 'canceled') {
    const error = obj(response?.error)
    state.error = str(error?.message) ?? `upstream response ${status}`
    out.push({ type: 'finish', reason: 'error' })
  } else if (status === 'incomplete') {
    // `incomplete_details.reason` 只可能是 `max_output_tokens` / `content_filter`。
    // 别看 `status` 本身：`incomplete` 不等于截断，content_filter 也是 incomplete。
    const reason = str(obj(response?.incomplete_details)?.reason)
    if (reason !== undefined && reason !== 'max_output_tokens' && reason !== 'content_filter') {
      state.error = `unknown incomplete reason: ${reason}`
      out.push({ type: 'finish', reason: 'error' })
    } else {
      out.push({ type: 'finish', reason: finishOf(reason) })
    }
  } else if (status === 'completed') {
    // `status:'completed'` 本身**不带**收尾原因（Responses 没有 finish_reason
    // 字段），真原因是 output 里有没有 function_call：有就是 tool-calls。
    // 读不到 output 时按 stop —— 这是 Responses 语义上的「正常说完」。
    out.push({ type: 'finish', reason: outputHasToolCall(response?.output) ? 'tool-calls' : 'stop' })
  } else {
    state.error = `unknown response status: ${status ?? 'missing'}`
    out.push({ type: 'finish', reason: 'error' })
  }
  return out
}

/** `response.output` 里有没有 `function_call` 项。 */
function outputHasToolCall(output: unknown): boolean {
  for (const item of Array.isArray(output) ? output : []) {
    if (obj(item)?.type === 'function_call') return true
  }
  return false
}

/**
 * 拼 `response.completed` 帧（收尾时由调用方带用量与收尾原因调）。
 *
 * `output` 里要写一条 `function_call` 占位项（当 finish 是 tool-calls 时）——
 * Responses 没有 finish_reason 字段，客户端（以及我们自己的 `completedEvents`）
 * 只能靠 `output` 里有没有 function_call 判断「这轮是调工具还是说完」。
 * 少了这条，工具轮在往返后会被认成普通结束。
 */
export function completedFrame(
  model: string,
  usage?: { promptTokens: number; completionTokens: number; cachedTokens?: number },
  finish?: string,
): string {
  const response: JsonObject = {
    id: `resp_${Date.now().toString(36)}`,
    object: 'response',
    // 收尾原因映射到 Responses 的终态：长度截断 → incomplete，其余 completed。
    // 没有 `error` 分支：流内错误走 `error` 事件，不会走到收尾帧。
    status: finish === 'length' ? 'incomplete' : 'completed',
    model,
    output: finish === 'tool-calls'
      ? [{ type: 'function_call', id: `fc_${Date.now().toString(36)}`, call_id: `call_${Date.now().toString(36)}`, name: '', arguments: '' }]
      : [],
  }
  if (finish === 'length') response.incomplete_details = { reason: 'max_output_tokens' }
  if (usage !== undefined) {
    response.usage = {
      input_tokens: usage.promptTokens,
      output_tokens: usage.completionTokens,
      total_tokens: usage.promptTokens + usage.completionTokens,
      ...(usage.cachedTokens !== undefined && usage.cachedTokens > 0
        ? { input_tokens_details: { cached_tokens: usage.cachedTokens } }
        : {}),
    }
  }
  return eventFrame('response.completed', JSON.stringify({ type: 'response.completed', response }))
}

/** Responses 的 usage 帧（若调用方要单独发）。 */
export function usageFrame(event: Extract<ChatEvent, { type: 'usage' }>): string {
  return dataFrame(JSON.stringify({ type: 'response.completed', response: { usage: event } }))
}
