const maxErrorBodyBytes = 8 * 1024
const errorBodyTimeoutMs = 2_000

function safeIdentifier(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const result = String(value).replace(/[^a-zA-Z0-9_.:-]/g, '').slice(0, 100)
  return result || null
}

function safeErrorMessage(value) {
  if (typeof value !== 'string') return null
  const result = value
    .replace(/data:[^\s,;]+;base64,[^\s]+/gi, '[已隐藏音频数据]')
    .replace(/\b(?:prompt|messages|input_audio|request_body|audio(?:_data)?|authorization|api[-_ ]?key)\b\s*[:=]\s*(?:"(?:\\.|[^"\\])*"|'[^']*'|[^;]+)/gi, '[已隐藏敏感字段]')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [已隐藏]')
    .replace(/\b(?:sk-[a-z\d_-]{8,}|[a-z\d+/=_-]{80,})\b/gi, '[已隐藏长凭据或数据]')
    .replace(/[\r\n\t\u0000-\u001f]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
  return Array.from(result).slice(0, 500).join('') || null
}

function getErrorFields(payload) {
  const error = payload?.error && typeof payload.error === 'object' ? payload.error : payload
  return {
    code: safeIdentifier(error?.code ?? payload?.code),
    type: safeIdentifier(error?.type ?? payload?.type),
    message: safeErrorMessage(error?.message ?? (typeof payload?.error === 'string' ? payload.error : payload?.message)),
    bodyRequestId: safeIdentifier(error?.request_id ?? payload?.request_id ?? payload?.requestId),
  }
}

export async function readMiMoHttpError(response) {
  const details = {
    serverErrorCode: null,
    serverErrorType: null,
    serverErrorMessage: null,
    requestId: safeIdentifier(response.headers?.get?.('x-request-id')
      || response.headers?.get?.('request-id')
      || response.headers?.get?.('x-mimo-request-id')
      || response.headers?.get?.('trace-id')),
  }
  let reader
  try { reader = response.body?.getReader?.() } catch { return details }
  if (!reader) return details

  let timer
  let bytes = new Uint8Array(0)
  let timedOut = false
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      timedOut = true
      reader.cancel().catch(() => {})
      resolve()
    }, errorBodyTimeoutMs)
  })
  try {
    await Promise.race([(async () => {
      while (bytes.byteLength < maxErrorBodyBytes) {
        const { done, value } = await reader.read()
        if (done) break
        const remaining = maxErrorBodyBytes - bytes.byteLength
        const next = value.subarray(0, remaining)
        const joined = new Uint8Array(bytes.byteLength + next.byteLength)
        joined.set(bytes)
        joined.set(next, bytes.byteLength)
        bytes = joined
      }
    })(), timeout])
    if (!timedOut && bytes.byteLength >= maxErrorBodyBytes) reader.cancel().catch(() => {})
    const text = new TextDecoder().decode(bytes)
    let payload
    try { payload = JSON.parse(text) } catch { return details }
    const parsed = getErrorFields(payload)
    details.serverErrorCode = parsed.code
    details.serverErrorType = parsed.type
    details.serverErrorMessage = parsed.message
    details.requestId ||= parsed.bodyRequestId
    return details
  } catch {
    return details
  } finally {
    clearTimeout(timer)
    if (!timedOut) reader.cancel().catch(() => {})
  }
}
