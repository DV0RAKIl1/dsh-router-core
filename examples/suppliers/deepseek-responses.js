/**
 * A minimal DeepSeek supplier with native Responses support.
 *
 * Copy this file to <profile>/suppliers/deepseek-responses.js.
 * Add the upstream DeepSeek API key in the router panel; never put a key in this file.
 * Models are discovered from the account's /v1/models endpoint and use the deepseek-responses/<model-id> prefix.
 */

const id = 'deepseek-responses'
const name = 'DeepSeek Responses Example'
const priority = 40
const alias = id
const baseUrl = 'https://api.deepseek.com/v1'
const modelsUrl = `${baseUrl}/models`
const chatUrl = `${baseUrl}/chat/completions`
const responsesUrl = 'https://api.deepseek.com/responses'
const responseHeaderTimeoutMs = 120000
const probeTimeoutMs = 15000

function stateFromHttpStatus(status) {
  if (status === 429) return 'rate_limit'
  if (status === 401 || status === 403) return 'session_dead'
  if (status === 404) return 'unavailable'
  if (status === 402) return 'quota'
  if (status >= 400 && status < 500) return 'bad_request'
  return 'unknown'
}

function accountFor(env, uid) {
  const account = env.credentials.get(id, uid)
  return account && typeof account.apiKey === 'string' && account.apiKey !== '' ? account : undefined
}

function configuredAlias(env) {
  return env.store?.get?.(id)?.alias || alias
}

function upstreamModel(model, currentAlias) {
  return currentAlias !== '' && model.startsWith(`${currentAlias}/`)
    ? model.slice(currentAlias.length + 1)
    : model
}

function parseObject(rawBody) {
  const parsed = JSON.parse(rawBody)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('body must be a JSON object')
  }
  return parsed
}

function requestBody(req, model, reasoningLevel) {
  const body = parseObject(req.rawBody)
  body.model = model
  body.stream = req.stream
  if (reasoningLevel !== undefined && reasoningLevel !== '' && reasoningLevel !== 'auto' && reasoningLevel !== 'none' && reasoningLevel !== 'off') {
    body.reasoning_effort = reasoningLevel
  } else if (reasoningLevel === 'none' || reasoningLevel === 'off') {
    delete body.reasoning_effort
    delete body.reasoning_summary
  }
  return JSON.stringify(body)
}

function responsesBody(req, model) {
  const body = parseObject(req.rawBody)
  // Spread first so caller fields such as prompt_cache_key remain untouched.
  return JSON.stringify({ ...body, model, stream: req.stream })
}

function linkedSignal(parentSignal, timeoutMs, message) {
  const controller = new AbortController()
  const onAbort = () => controller.abort(parentSignal?.reason ?? new Error('request aborted'))
  if (parentSignal?.aborted) onAbort()
  else parentSignal?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => {
    const error = new Error(message)
    error.name = 'TimeoutError'
    controller.abort(error)
  }, timeoutMs)
  return {
    signal: controller.signal,
    clearTimer: () => clearTimeout(timer),
    cleanup: () => {
      clearTimeout(timer)
      parentSignal?.removeEventListener('abort', onAbort)
    },
  }
}

function linkedStream(body, linked) {
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
      } catch {
        linked.cleanup()
        controller.error(new Error('DeepSeek upstream stream error'))
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason)
      } catch {
        // Cancellation failures must not expose upstream error details.
      } finally {
        linked.cleanup()
      }
    },
  })
}

function discardResponse(response) {
  try {
    response.body?.cancel()?.catch(() => {})
  } catch {
    // The connection is already closed or the body was consumed.
  }
}

async function postUpstream(url, apiKey, body, req, label) {
  const linked = linkedSignal(req.signal, responseHeaderTimeoutMs, `${label} upstream response headers timed out after ${responseHeaderTimeoutMs}ms`)
  let response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(req.stream ? { Accept: 'text/event-stream' } : {}),
        Authorization: `Bearer ${apiKey}`,
      },
      body,
      signal: linked.signal,
    })
  } catch {
    const timedOut = linked.signal.reason?.name === 'TimeoutError'
    linked.cleanup()
    const message = req.signal?.aborted
      ? `${label} request aborted`
      : timedOut
        ? `${label} upstream response headers timed out after ${responseHeaderTimeoutMs}ms`
        : `${label} upstream transport error`
    return { ok: false, state: 'transport', message }
  }
  linked.clearTimer()

  if (!response.ok) {
    const status = stateFromHttpStatus(response.status)
    discardResponse(response)
    linked.cleanup()
    return { ok: false, state: status, message: `${label} upstream ${response.status}` }
  }
  if (req.stream) {
    if (!response.body) {
      linked.cleanup()
      return { ok: false, state: 'transport', message: `${label} upstream: empty stream body` }
    }
    return { ok: true, stream: linkedStream(response.body, linked) }
  }
  try {
    const text = await response.text()
    return text
      ? { ok: true, status: response.status, body: text }
      : { ok: false, state: 'transport', message: `${label} upstream: empty body` }
  } catch {
    return { ok: false, state: 'transport', message: `${label} upstream response read error` }
  } finally {
    linked.cleanup()
  }
}

async function discoverModels(uid, env) {
  const account = accountFor(env, uid)
  if (account === undefined) return []
  const response = await fetch(modelsUrl, {
    headers: { Authorization: `Bearer ${account.apiKey}` },
    signal: AbortSignal.timeout(probeTimeoutMs),
  })
  if (!response.ok) {
    discardResponse(response)
    throw new Error(`DeepSeek model discovery failed: ${response.status}`)
  }
  try {
    const payload = await response.json()
    if (!Array.isArray(payload?.data)) throw new Error('invalid model list')
    return payload.data
      .filter((item) => typeof item?.id === 'string' && item.id !== '')
      .map(({ id }) => ({ id }))
  } catch {
    discardResponse(response)
    throw new Error('DeepSeek model discovery returned an invalid response')
  }
}

async function validateApiKey(apiKey) {
  try {
    const response = await fetch(modelsUrl, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(probeTimeoutMs),
    })
    if (response.ok) {
      discardResponse(response)
      return { ok: true }
    }
    const status = response.status
    discardResponse(response)
    return { ok: false, error: `key rejected: ${status}` }
  } catch {
    return { ok: false, error: 'key validation failed: network error or timeout' }
  }
}

export default function createDeepSeekSupplier(env) {

  function listUids() {
    return env.credentials.list(id)
  }

  function nextUid() {
    let n = listUids().length + 1
    let uid = `key-${n}`
    while (accountFor(env, uid) !== undefined) uid = `key-${++n}`
    return uid
  }

  return {
    id,
    name,
    priority,
    apiKeyHint: 'DeepSeek API key: https://platform.deepseek.com/api_keys',

    status() {
      return {
        id,
        name,
        accounts: listUids().map((uid) => {
          const account = accountFor(env, uid)
          return { uid, nickname: account?.name || 'API key', credits: -1, state: account === undefined ? 'session_dead' : 'ok' }
        }),
      }
    },

    async listModels() {
      const results = await Promise.allSettled(env.credentials.list(id).map((uid) => discoverModels(uid, env)))
      const fulfilled = results.filter((result) => result.status === 'fulfilled')
      if (fulfilled.length === 0 && results.length > 0) {
        throw new Error('DeepSeek model discovery failed for all configured accounts')
      }
      const models = new Map()
      for (const result of fulfilled) {
        for (const model of result.value) models.set(model.id, model)
      }
      return [...models.values()]
    },

    getAlias() {
      return configuredAlias(env)
    },

    async addApiKey(input) {
      const apiKey = String(input.apiKey ?? '').trim()
      if (apiKey === '') return { ok: false, error: 'API key is required' }
      const validation = await validateApiKey(apiKey)
      if (!validation.ok) return validation
      const uid = nextUid()
      const nickname = String(input.name ?? '').trim() || `Key ${uid.slice(4)}`
      env.credentials.save(id, uid, { name: nickname, apiKey })
      env.log(`deepseek add api key ${uid}`)
      return { ok: true, account: { uid, nickname } }
    },

    async removeLink(uid) {
      if (accountFor(env, uid) === undefined) return false
      env.credentials.remove(id, uid)
      return true
    },

    async chatOnce(uid, lv, req) {
      const account = accountFor(env, uid)
      const model = upstreamModel(req.model, configuredAlias(env))
      if (account === undefined) return { ok: false, state: 'session_dead', message: `unknown DeepSeek account ${JSON.stringify(uid)}` }
      let body
      try {
        body = requestBody(req, model, lv)
      } catch {
        return { ok: false, state: 'bad_request', message: 'invalid Chat request body' }
      }
      return postUpstream(chatUrl, account.apiKey, body, req, 'DeepSeek Chat')
    },

    async responsesOnce(uid, _lv, req) {
      const account = accountFor(env, uid)
      const model = upstreamModel(req.model, configuredAlias(env))
      if (account === undefined) return { ok: false, state: 'session_dead', message: `unknown DeepSeek account ${JSON.stringify(uid)}` }
      let body
      try {
        body = responsesBody(req, model)
      } catch {
        return { ok: false, state: 'bad_request', message: 'invalid Responses request body' }
      }
      return postUpstream(responsesUrl, account.apiKey, body, req, 'DeepSeek Responses')
    },

    dispose() {},
  }
}
