import type { AccountState, ResponsesOnceResult } from './contract.ts'
import type { ResponsesRequest } from '../router/types.ts'

const RESPONSE_HEADER_TIMEOUT_MS = 120000

function linkedSignal(parentSignal: AbortSignal | undefined, timeoutMs: number, message: string) {
  const controller = new AbortController()
  const onAbort = (): void => controller.abort(parentSignal?.reason ?? new Error('request aborted'))
  if (parentSignal?.aborted) onAbort()
  else parentSignal?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => {
    const error = new Error(message)
    error.name = 'TimeoutError'
    controller.abort(error)
  }, timeoutMs)
  return {
    signal: controller.signal,
    clearTimer: (): void => clearTimeout(timer),
    cleanup: (): void => {
      clearTimeout(timer)
      parentSignal?.removeEventListener('abort', onAbort)
    },
  }
}

export function nativeResponsesBody(req: ResponsesRequest, model: string): string {
  const parsed: unknown = JSON.parse(req.rawBody)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('body must be a JSON object')
  }
  return JSON.stringify({ ...parsed, model, stream: req.stream })
}

function linkedStream(body: ReadableStream<Uint8Array>, linked: ReturnType<typeof linkedSignal>): ReadableStream<Uint8Array> {
  const reader = body.getReader()
  return new ReadableStream({
    async pull(controller) {
      try {
        const result = await reader.read()
        if (result.done) {
          linked.cleanup()
          controller.close()
        } else {
          controller.enqueue(result.value)
        }
      } catch (error) {
        linked.cleanup()
        controller.error(error)
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason)
      } finally {
        linked.cleanup()
      }
    },
  })
}

export async function requestNativeResponses(
  url: string,
  headers: Record<string, string>,
  body: string,
  req: ResponsesRequest,
  label: string,
  classify: (status: number) => AccountState,
): Promise<ResponsesOnceResult> {
  const linked = linkedSignal(req.signal, RESPONSE_HEADER_TIMEOUT_MS, `${label} upstream response headers timed out after ${RESPONSE_HEADER_TIMEOUT_MS}ms`)
  let upstream: Response
  try {
    upstream = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(req.stream ? { Accept: 'text/event-stream' } : {}),
        ...headers,
      },
      body,
      signal: linked.signal,
    })
  } catch (error) {
    linked.cleanup()
    return { ok: false, state: 'transport', message: error instanceof Error ? error.message : String(error) }
  }
  linked.clearTimer()

  if (upstream.status < 200 || upstream.status >= 300) {
    try {
      const text = await upstream.text().catch(() => '')
      return { ok: false, state: classify(upstream.status), message: `upstream ${upstream.status}: ${text.slice(0, 120)}` }
    } finally {
      linked.cleanup()
    }
  }
  if (req.stream) {
    if (!upstream.body) {
      linked.cleanup()
      return { ok: false, state: 'transport', message: `${label} upstream: empty stream body` }
    }
    return { ok: true, stream: linkedStream(upstream.body, linked) }
  }
  try {
    const text = await upstream.text()
    return text
      ? { ok: true, status: upstream.status, body: text }
      : { ok: false, state: 'transport', message: `${label} upstream: empty body` }
  } catch (error) {
    return { ok: false, state: 'transport', message: error instanceof Error ? error.message : String(error) }
  } finally {
    linked.cleanup()
  }
}
