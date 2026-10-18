import test from 'node:test'
import assert from 'node:assert/strict'
import { readMiMoHttpError } from './mimo-http-error.js'

test('HTTP 400 diagnostics are parsed and redact sensitive response content', async () => {
  const response = new Response(JSON.stringify({
    error: {
      code: 'invalid_audio',
      type: 'request_error',
      message: 'Audio rejected; prompt: SECRET PROMPT; Authorization: Bearer super-secret-token; data:audio/mp4;base64,SECRET_AUDIO_BASE64',
    },
  }), { status: 400, headers: { 'x-request-id': 'req-400-123' } })
  const capturedLog = JSON.stringify({ status: response.status, ...(await readMiMoHttpError(response)) })

  assert.match(capturedLog, /"status":400/)
  assert.match(capturedLog, /invalid_audio/)
  assert.match(capturedLog, /request_error/)
  assert.match(capturedLog, /Audio rejected/)
  assert.match(capturedLog, /req-400-123/)
  assert.doesNotMatch(capturedLog, /SECRET PROMPT|super-secret-token|SECRET_AUDIO_BASE64/)
})

test('error response reading stops at the byte limit', async () => {
  let bytesSentToReader = 0
  let cancelled = false
  const body = new ReadableStream({
    pull(controller) {
      const chunk = new Uint8Array(4096).fill(0x61)
      bytesSentToReader += chunk.byteLength
      controller.enqueue(chunk)
    },
    cancel() { cancelled = true },
  })
  await readMiMoHttpError({ body, headers: new Headers(), status: 400 })
  assert.ok(bytesSentToReader <= 12 * 1024)
  assert.equal(cancelled, true)
})

test('error response reading has a bounded wait', async () => {
  let cancelled = false
  const body = new ReadableStream({
    pull() { return new Promise(() => {}) },
    cancel() { cancelled = true },
  })
  const startedAt = Date.now()
  const details = await readMiMoHttpError({ body, headers: new Headers(), status: 400 })
  assert.ok(Date.now() - startedAt < 3000)
  assert.equal(details.serverErrorMessage, null)
  assert.equal(cancelled, true)
})
