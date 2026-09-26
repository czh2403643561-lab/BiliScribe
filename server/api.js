import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import net from 'node:net'
import os from 'node:os'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { getLogDirectory, getLogPath, log, readCompleteLog, readRecentLogLines } from './logger.js'
import {
  ensureTranscriptSegmentTimeRanges, formatTranscriptTimeRange, isAdaptiveTranscriptError,
  planAdaptiveTranscriptSplit, replaceAdaptiveTranscriptSegment,
} from './transcript-adaptive.js'
import { analyzeTranscriptOutput, cleanTranscriptText } from './transcript-text.js'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const configuredExe = process.env.BBDOWN_PATH || path.join(projectRoot, 'tools', 'BBDownNext', 'BBDown.exe')
const executablePath = path.resolve(configuredExe)
const credentialPath = path.join(path.dirname(executablePath), 'BBDown.data')
const port = Number(process.env.BILISCRIBE_API_PORT || 4174)
const parseTimeoutMs = 30_000
const childProcesses = new Set()
const authSessions = new Map()
let bbdownServe = null
let bbdownServePort = null
let bbdownServeToken = null
let bbdownServeStarting = null
const productionMode = process.argv.includes('--production')
const distDirectory = path.join(projectRoot, 'dist')
const stateDirectory = path.join(projectRoot, '.biliscribe')
const stateFile = path.join(stateDirectory, 'state.json')
const secretsFile = path.join(stateDirectory, 'secrets.json')
const transcriptsFile = path.join(stateDirectory, 'transcripts.json')
const transcriptWorkDirectory = path.join(stateDirectory, 'transcript-work')
const transcriptPromptFile = path.join(projectRoot, 'prompts', 'bazi-transcript.md')
const transcriptPromptVersion = 'transcript-v1'
const transcriptMaxBase64Bytes = 40_000_000
const transcriptSegmentSafetyBase64Bytes = 38_000_000
const transcriptBitrate = '32k'
const transcriptMaxSplitDepth = 10
const transcriptMaxContentFilterSplitDepth = 4
const transcriptMinimumContentFilterSegmentSeconds = 1
const transcriptMinimumAdaptiveSegmentSeconds = 8 * 60
const transcriptProcessingVersion = 2
const transcriptConnectTimeoutMs = 30_000
const transcriptStreamIdleTimeoutMs = 120_000
const defaultDownloadDirectory = path.join(os.homedir(), 'Videos', 'BiliScribe')
const mediaExtensions = new Set(['.mp4', '.mkv', '.flv', '.m4a', '.mka', '.mp3', '.aac', '.wav', '.flac', '.m4s'])
const localAudioExtensions = new Set(['.mp3', '.m4a', '.wav', '.flac', '.ogg'])
const localAudioSelections = new Map()
const localAudioSelectionTtlMs = 60 * 60 * 1000
const bilibiliImageHosts = ['hdslb.com', 'bilivideo.com']
const wbiMixinIndices = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52]

let downloadDirectory = defaultDownloadDirectory
let transcriptDirectory = defaultDownloadDirectory
let mimoApiKey = ''
const downloadTasks = new Map()
let queuePumpActive = false
let activeDownloadChild = null
let activeDownloadTaskId = null
let activeTaskAbortController = null
let transcriptWakeLockChild = null
let mimoRequestTail = Promise.resolve()

async function withMiMoRequestLock(callback) {
  const previous = mimoRequestTail
  let release
  mimoRequestTail = new Promise((resolve) => { release = resolve })
  await previous
  try { return await callback() } finally { release() }
}

try {
  const secrets = JSON.parse(fs.readFileSync(secretsFile, 'utf8'))
  if (typeof secrets.mimoApiKey === 'string') mimoApiKey = secrets.mimoApiKey
} catch (error) {
  if (error.code !== 'ENOENT') log('warn', 'Local service credentials could not be loaded', { code: error.code || 'credentials_load_failed' })
}

function maskMimoApiKey(key = mimoApiKey) {
  return key ? `••••••••${key.slice(-4)}` : ''
}

function saveMimoApiKey(key) {
  fs.mkdirSync(stateDirectory, { recursive: true })
  const temporary = `${secretsFile}.${process.pid}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify({ mimoApiKey: key }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(temporary, secretsFile)
  mimoApiKey = key
}

function saveLocalState() {
  try {
    fs.mkdirSync(stateDirectory, { recursive: true })
    const payload = JSON.stringify({ downloadDirectory, transcriptDirectory, tasks: [...downloadTasks.values()] }, null, 2)
    const temporary = `${stateFile}.${process.pid}.tmp`
    fs.writeFileSync(temporary, `${payload}\n`, 'utf8')
    fs.renameSync(temporary, stateFile)
  } catch (error) {
    log('error', 'Local task state save failed', { code: error.code || 'state_save_failed', message: error.message })
  }
}

try {
  const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  if (typeof saved.downloadDirectory === 'string' && saved.downloadDirectory.trim()) downloadDirectory = path.resolve(saved.downloadDirectory)
  if (typeof saved.transcriptDirectory === 'string' && saved.transcriptDirectory.trim()) transcriptDirectory = path.resolve(saved.transcriptDirectory)
  else transcriptDirectory = downloadDirectory
  for (const task of Array.isArray(saved.tasks) ? saved.tasks : []) {
    if (!task?.id || !['waiting', 'running', 'completed', 'failed', 'cancelled'].includes(task.status)) continue
    if (task.status === 'running') {
      task.status = 'failed'
      task.phase = '后台关闭时任务中断'
      task.error = 'BiliScribe 关闭时任务未完成，请重试。'
      const endedAt = new Date().toISOString()
      task.endedAt = endedAt
      const startedAtMs = Date.parse(task.startedAt || '')
      task.durationMs = Number.isFinite(startedAtMs) ? Math.max(0, Date.parse(endedAt) - startedAtMs) : null
      task.completedAt = endedAt
    }
    downloadTasks.set(task.id, task)
  }
  saveLocalState()
} catch (error) {
  if (error.code !== 'ENOENT') log('warn', 'Local task state could not be loaded', { code: error.code || 'state_load_failed' })
}

if (productionMode && !fs.existsSync(path.join(distDirectory, 'index.html'))) {
  log('error', 'Production server could not start', { reason: 'built frontend dist/index.html is missing' })
  console.error('正式页面尚未构建。请先运行 npm run build，再重新打开 BiliScribe。')
  process.exit(1)
}

function readBBDownVersion() {
  if (!fs.existsSync(executablePath)) return null
  try {
    const result = spawnSync(executablePath, ['--version'], { cwd: projectRoot, encoding: 'utf8', timeout: 5000, windowsHide: true })
    if (result.status !== 0) return null
    return `${result.stdout || ''}${result.stderr || ''}`.match(/BBDown Next v?([^\s\r\n]+)/i)?.[1] || null
  } catch (error) {
    log('warn', 'BBDownNext version check failed', { message: error.message, stack: error.stack })
    return null
  }
}

const bbdownVersion = readBBDownVersion()

function sendJson(response, statusCode, data) {
  if (response.headersSent || response.writableEnded) return false
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  response.end(JSON.stringify(data))
  return true
}

function sendError(response, statusCode, code, message) {
  sendJson(response, statusCode, { error: { code, message } })
}

function proxiedImageUrl(remoteUrl) {
  if (typeof remoteUrl !== 'string' || !remoteUrl) return ''
  return `/api/images/proxy?url=${encodeURIComponent(remoteUrl.replace(/^http:/i, 'https:'))}`
}

function publicAccount(account) {
  return account ? { ...account, avatar: proxiedImageUrl(account.avatar) } : null
}

function readSavedWebCookie() {
  try {
    const data = JSON.parse(fs.readFileSync(credentialPath, 'utf8'))
    return typeof data.cookie === 'string' ? data.cookie : ''
  } catch {
    return ''
  }
}

function credentialRevision() {
  try {
    const stat = fs.statSync(credentialPath, { bigint: true })
    return [stat.mtimeNs, stat.ctimeNs, stat.size, stat.ino].map(String).join(':')
  } catch {
    return ''
  }
}

async function getBilibiliAccount(cookie) {
  if (!cookie) return { loggedIn: false, account: null, expired: false }
  try {
    const response = await fetch('https://api.bilibili.com/x/web-interface/nav', {
      headers: { Accept: 'application/json', Cookie: cookie, 'User-Agent': 'Mozilla/5.0 BiliScribe/0.1' },
      signal: AbortSignal.timeout(8000),
    })
    if (!response.ok) return { loggedIn: true, account: null, expired: false }
    const result = await response.json()
    if (result.code === 0 && result.data?.isLogin) {
      return {
        loggedIn: true,
        account: { name: result.data.uname || '', avatar: result.data.face || '', uid: String(result.data.mid || '') },
        expired: false,
      }
    }
    if (result.code === -101 || result.data?.isLogin === false) return { loggedIn: false, account: null, expired: true }
    return { loggedIn: true, account: null, expired: false }
  } catch {
    // Keep the locally stored login state when Bilibili cannot be reached.
    return { loggedIn: true, account: null, expired: false }
  }
}

async function getLoginStatus() {
  return getBilibiliAccount(readSavedWebCookie())
}

async function allocateLoopbackPort() {
  return new Promise((resolve, reject) => {
    const socket = net.createServer()
    socket.once('error', reject)
    socket.listen(0, '127.0.0.1', () => {
      const address = socket.address()
      socket.close((error) => error ? reject(error) : resolve(address.port))
    })
  })
}

async function ensureBBDownServe() {
  if (bbdownServeStarting) return bbdownServeStarting
  bbdownServeStarting = (async () => {
    if (!fs.existsSync(executablePath)) throw Object.assign(new Error('未找到 BBDownNext，暂时无法扫码登录。'), { code: 'bbdown_unavailable' })
    if (bbdownServe && bbdownServe.exitCode === null && bbdownServePort) {
      try {
        const health = await fetch(`http://127.0.0.1:${bbdownServePort}/healthz`, { signal: AbortSignal.timeout(800) })
        if (health.ok) return
      } catch { /* restart the owned child below */ }
      const unhealthyChild = bbdownServe
      log('warn', 'BBDownNext login service health check failed; restarting it')
      unhealthyChild.kill()
      await Promise.race([
        new Promise((resolve) => unhealthyChild.once('close', resolve)),
        new Promise((resolve) => setTimeout(resolve, 1500)),
      ])
      if (unhealthyChild.exitCode === null) {
        throw Object.assign(new Error('BBDownNext 登录服务暂时无响应，请刷新二维码重试。'), { code: 'bbdown_login_service_unavailable' })
      }
    }
    if (bbdownServe && bbdownServe.exitCode !== null) {
      bbdownServe = null
      bbdownServePort = null
      bbdownServeToken = null
    }

    const listenPort = await allocateLoopbackPort()
    const serveToken = randomBytes(32).toString('hex')
    const child = spawn(executablePath, ['serve', '--listen', `http://127.0.0.1:${listenPort}`, '--serve-token', serveToken], {
      cwd: path.dirname(executablePath), windowsHide: true, stdio: 'ignore',
    })
    bbdownServe = child
    bbdownServePort = listenPort
    bbdownServeToken = serveToken
    childProcesses.add(child)
    child.once('close', (exitCode, signal) => {
      childProcesses.delete(child)
      if (bbdownServe === child) {
        bbdownServe = null
        bbdownServePort = null
        bbdownServeToken = null
      }
      log('warn', 'BBDownNext login service exited', { exitCode, signal })
    })
    child.once('error', (error) => {
      log('error', 'BBDownNext login service failed to start', { code: error.code || 'spawn_error' })
    })
    log('info', 'BBDownNext login service started', { port: listenPort, version: bbdownVersion })

    const deadline = Date.now() + 12_000
    while (Date.now() < deadline) {
      if (child.exitCode !== null) break
      try {
        const health = await fetch(`http://127.0.0.1:${listenPort}/healthz`, { signal: AbortSignal.timeout(500) })
        if (health.ok) return
      } catch { /* wait until the local sidecar is ready */ }
      await new Promise((resolve) => setTimeout(resolve, 180))
    }
    child.kill()
    throw Object.assign(new Error('BBDownNext 登录服务启动超时，请重试。'), { code: 'bbdown_login_service_timeout' })
  })()
  try { await bbdownServeStarting } finally { bbdownServeStarting = null }
}

async function requestBBDownServe(endpoint, options = {}) {
  await ensureBBDownServe()
  const response = await fetch(`http://127.0.0.1:${bbdownServePort}${endpoint}`, {
    ...options,
    headers: { ...(options.headers || {}), 'X-BBDown-Token': bbdownServeToken },
    signal: options.signal || AbortSignal.timeout(12_000),
  })
  let body = null
  try { body = await response.json() } catch { /* normalize malformed sidecar replies below */ }
  return { response, body }
}

async function startQrLogin(response) {
  for (const [id, session] of authSessions) if (session.expiresAt <= Date.now()) authSessions.delete(id)
  log('info', 'Bilibili QR login requested')
  const previousCredentialRevision = credentialRevision()
  const { response: upstream, body } = await requestBBDownServe('/api/v1/login/qr', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channel: 'web' }),
  })
  if (!upstream.ok || !body?.qrcodeKey || !body?.qrPngBase64) {
    log('warn', 'Bilibili QR login start failed', { statusCode: upstream.status })
    sendError(response, upstream.status === 429 ? 429 : 502, 'qr_login_start_failed', '二维码生成失败，请稍后重试。')
    return
  }
  const id = randomUUID()
  authSessions.set(id, { key: body.qrcodeKey, state: 'waitingScan', expiresAt: Date.now() + 10 * 60_000, account: null, previousCredentialRevision, scanned: false, credentialUpdateLogged: false })
  log('info', 'Bilibili QR started')
  log('info', 'Bilibili QR code generated')
  sendJson(response, 200, { sessionId: id, qrDataUrl: `data:image/png;base64,${body.qrPngBase64}`, state: 'waitingScan' })
}

async function pollQrLogin(response, id) {
  const session = authSessions.get(id)
  if (!session) {
    sendJson(response, 200, { state: 'expired', message: '二维码已过期，请刷新二维码。' })
    return
  }
  const recoverPersistedSuccess = async () => {
    const currentRevision = credentialRevision()
    if (!currentRevision || currentRevision === session.previousCredentialRevision) return false
    if (!session.credentialUpdateLogged) {
      session.credentialUpdateLogged = true
      log('info', 'Bilibili credential file updated during QR session')
    }
    const status = await getLoginStatus()
    if (!status.loggedIn) return false
    session.state = 'success'
    session.account = status.account
    log('info', 'Bilibili login verified after QR credential update', { hasAccountName: !!session.account?.name })
    log('info', 'Bilibili QR success', { hasAccountName: !!session.account?.name })
    sendJson(response, 200, { state: 'success', account: publicAccount(session.account) })
    return true
  }
  if (session.expiresAt <= Date.now()) {
    if (await recoverPersistedSuccess()) return
    authSessions.delete(id)
    sendJson(response, 200, { state: 'expired', message: '二维码已过期，请刷新二维码。' })
    return
  }
  if (session.state === 'success') {
    sendJson(response, 200, { state: 'success', account: publicAccount(session.account) })
    return
  }
  try {
    const { response: upstream, body } = await requestBBDownServe(`/api/v1/login/qr/${encodeURIComponent(session.key)}`)
    if (upstream.status === 404) {
      if (await recoverPersistedSuccess()) return
      session.state = 'expired'
      sendJson(response, 200, { state: 'expired', message: '二维码已过期，请刷新二维码。' })
      return
    }
    if (!upstream.ok || !body?.state) {
      if (await recoverPersistedSuccess()) return
      session.state = 'failed'
      sendJson(response, 200, { state: 'failed', message: '扫码状态读取失败，请刷新二维码重试。' })
      return
    }
    const nextState = String(body.state)
    if (nextState === 'waitingConfirm' && !session.scanned) {
      session.scanned = true
      log('info', 'Bilibili QR scanned; awaiting confirmation')
    }
    if (await recoverPersistedSuccess()) return
    if (nextState !== session.state && ['waitingConfirm', 'expired', 'failed'].includes(nextState)) {
      const event = { waitingConfirm: 'Bilibili QR awaiting phone confirmation', expired: 'Bilibili QR login expired', failed: 'Bilibili QR login failed' }[nextState]
      log(nextState === 'failed' ? 'warn' : 'info', event)
    }
    if (nextState === 'success') {
      // BBDownNext persists the WEB credential itself; never forward its credential payload.
      const confirmedName = body.accountName ? String(body.accountName) : ''
      const status = await getLoginStatus()
      const verifiedAccount = status.account
      session.account = confirmedName
        ? { name: confirmedName, avatar: verifiedAccount?.name === confirmedName ? verifiedAccount.avatar : '', uid: verifiedAccount?.name === confirmedName ? verifiedAccount.uid : '' }
        : verifiedAccount
      session.state = 'success'
      log('info', 'Bilibili login verified', { hasAccountName: !!session.account?.name })
      log('info', 'Bilibili QR success', { hasAccountName: !!session.account?.name })
      sendJson(response, 200, { state: 'success', account: publicAccount(session.account) })
      return
    }
    session.state = ['waitingScan', 'waitingConfirm', 'expired', 'failed'].includes(nextState) ? nextState : 'waitingScan'
    sendJson(response, 200, {
      state: session.state,
      message: session.state === 'waitingConfirm' ? '已扫码，请在手机上确认登录。' : session.state === 'expired' ? '二维码已过期，请刷新二维码。' : session.state === 'failed' ? '登录失败，请刷新二维码重试。' : '等待扫码',
    })
  } catch (error) {
    if (await recoverPersistedSuccess()) return
    session.state = 'failed'
    log('warn', 'Bilibili QR login poll failed', { code: error.code || 'poll_error' })
    sendJson(response, 200, { state: 'failed', message: '扫码状态读取失败，请刷新二维码重试。' })
  }
}

async function logoutBilibili(response) {
  const credentialPath = path.join(path.dirname(executablePath), 'BBDown.data')
  try {
    const raw = fs.existsSync(credentialPath) ? JSON.parse(fs.readFileSync(credentialPath, 'utf8')) : {}
    delete raw.cookie
    delete raw.refresh_token
    delete raw.ts
    fs.writeFileSync(credentialPath, `${JSON.stringify(raw, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    if (bbdownServe && bbdownServe.exitCode === null) {
      const child = bbdownServe
      child.kill()
      await new Promise((resolve) => child.once('close', resolve))
    }
    for (const [id, session] of authSessions) if (session.state !== 'success') authSessions.delete(id)
    log('info', 'Bilibili logout completed')
    sendJson(response, 200, { loggedIn: false })
  } catch (error) {
    log('error', 'Bilibili logout failed', { code: error.code || 'logout_error', stack: error.stack })
    sendError(response, 500, 'logout_failed', '退出登录失败，请关闭 BiliScribe 后重试。')
  }
}

async function readJsonBody(request, maxBytes = 16 * 1024) {
  if (!request.headers['content-type']?.toLowerCase().includes('application/json')) {
    throw Object.assign(new Error('请求必须使用 JSON 格式。'), { statusCode: 415, code: 'unsupported_media_type' })
  }
  const chunks = []
  let byteLength = 0
  for await (const chunk of request) {
    byteLength += chunk.length
    if (byteLength > maxBytes) throw Object.assign(new Error('请求内容过大。'), { statusCode: 413, code: 'payload_too_large' })
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch {
    throw Object.assign(new Error('请求内容不是有效的 JSON。'), { statusCode: 400, code: 'invalid_json' })
  }
}

function normalizeVideoUrl(input) {
  if (typeof input !== 'string' || !input.trim()) {
    throw Object.assign(new Error('请粘贴 B 站单视频链接。'), { statusCode: 400, code: 'empty_url' })
  }

  let url
  try { url = new URL(input.trim()) } catch {
    throw Object.assign(new Error('链接格式不正确，请输入有效的 B 站视频链接。'), { statusCode: 400, code: 'invalid_url' })
  }
  const allowedHosts = new Set(['bilibili.com', 'www.bilibili.com', 'm.bilibili.com'])
  const bvid = url.pathname.match(/^\/video\/(BV[0-9A-Za-z]{10})(?:\/|$)/i)?.[1]
  if (!['http:', 'https:'].includes(url.protocol) || !allowedHosts.has(url.hostname.toLowerCase()) || !bvid) {
    throw Object.assign(new Error('目前只支持 B 站单视频链接，暂不支持 UP 主主页或其他链接。'), { statusCode: 400, code: 'unsupported_url' })
  }
  return { bvid, canonicalUrl: `https://www.bilibili.com/video/${bvid}/` }
}

function runBBDown(canonicalUrl, bvid) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now()
    let output = ''
    let timedOut = false
    let outputExceeded = false
    let settled = false
    let child
    try {
      child = spawn(executablePath, [canonicalUrl, '--info-only', '--hide-streams'], {
        cwd: path.dirname(executablePath),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      reject(Object.assign(new Error('BBDownNext 无法启动。'), { code: 'bbdown_spawn_failed', cause: error }))
      return
    }

    childProcesses.add(child)
    log('info', 'BBDownNext process started', { bvid, executable: path.basename(executablePath), mode: 'info-only' })
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, parseTimeoutMs)

    const collect = (chunk) => {
      if (Buffer.byteLength(output) + chunk.length > 4 * 1024 * 1024) {
        outputExceeded = true
        child.kill()
        return
      }
      output += chunk.toString('utf8')
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    child.once('error', (error) => {
      log('error', 'BBDownNext process error', { bvid, message: error.message, stack: error.stack })
      if (!settled) {
        settled = true
        clearTimeout(timer)
        childProcesses.delete(child)
        reject(Object.assign(new Error('BBDownNext 启动失败，请检查可执行文件。'), { code: 'bbdown_spawn_failed' }))
      }
    })
    child.once('close', (exitCode, signal) => {
      clearTimeout(timer)
      childProcesses.delete(child)
      const durationMs = Date.now() - startedAt
      log(exitCode === 0 && !timedOut && !outputExceeded ? 'info' : 'warn', 'BBDownNext process exited', {
        bvid, exitCode, signal, timedOut, outputExceeded, durationMs,
      })
      if (settled) return
      settled = true
      resolve({ exitCode, output, durationMs, timedOut, outputExceeded })
    })
  })
}

function readCliMetadata(output) {
  const title = output.match(/视频标题：([^\r\n]+)/)?.[1]?.trim()
  const ownerUrl = output.match(/UP 主页：https?:\/\/space\.bilibili\.com\/(\d+)/i)?.[1]
  const part = output.match(/P1:\s*\[(\d+)\]\s*\[(.*?)\]\s*\[([^\]]+)\]/)
  if (!part) return null
  return { title, ownerId: ownerUrl || null, cid: part[1], partTitle: part[2], durationText: part[3] }
}

function formatDuration(totalSeconds) {
  const seconds = Math.max(0, Number(totalSeconds) || 0)
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const remainder = seconds % 60
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
    : `${minutes}:${String(remainder).padStart(2, '0')}`
}

async function fetchPublicVideoDetails(bvid) {
  const endpoint = new URL('https://api.bilibili.com/x/web-interface/view')
  endpoint.searchParams.set('bvid', bvid)
  const response = await fetch(endpoint, {
    headers: { Accept: 'application/json', 'User-Agent': 'BiliScribe/0.1 (local video metadata)' },
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`视频信息服务返回 HTTP ${response.status}`)
  const result = await response.json()
  if (result.code !== 0 || !result.data) throw new Error(`视频信息服务返回错误码 ${result.code ?? 'unknown'}`)
  return result.data
}

let cachedWbiKey = ''
let cachedWbiKeyAt = 0

function bilibiliHeaders(mid) {
  const headers = {
    Accept: 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    Referer: `https://space.bilibili.com/${mid}`,
    Origin: 'https://space.bilibili.com',
  }
  const cookie = readSavedWebCookie()
  if (cookie) headers.Cookie = cookie
  return headers
}

async function getWbiKey(mid) {
  if (cachedWbiKey && Date.now() - cachedWbiKeyAt < 6 * 60 * 60 * 1000) return cachedWbiKey
  const response = await fetch('https://api.bilibili.com/x/web-interface/nav', {
    headers: bilibiliHeaders(mid), signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`B 站主页服务暂时不可用（HTTP ${response.status}）。`)
  const result = await response.json()
  const images = result.data?.wbi_img
  const imageKey = images?.img_url?.split('/').at(-1)?.split('.')[0] || ''
  const subKey = images?.sub_url?.split('/').at(-1)?.split('.')[0] || ''
  const raw = imageKey + subKey
  const key = wbiMixinIndices.map((index) => raw[index] || '').join('').slice(0, 32)
  if (key.length !== 32) throw new Error('无法读取 B 站主页解析参数，请稍后重试。')
  cachedWbiKey = key
  cachedWbiKeyAt = Date.now()
  return key
}

function signWbiParams(params, key) {
  const sorted = Object.entries(params).sort(([left], [right]) => left.localeCompare(right))
  const query = sorted.map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(String(value).replace(/[!'()*]/g, ''))}`).join('&')
  return `${query}&w_rid=${createHash('md5').update(`${query}${key}`).digest('hex')}`
}

async function fetchBilibiliJson(endpoint, mid) {
  const response = await fetch(endpoint, {
    headers: bilibiliHeaders(mid), signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`B 站主页服务暂时不可用（HTTP ${response.status}）。`)
  const result = await response.json()
  if (result.code !== 0) {
    if (result.code === -101 || result.code === -111) {
      throw Object.assign(new Error('B 站登录状态已失效，请在设置中重新扫码登录后重试。'), { statusCode: 401, code: 'bilibili_login_expired' })
    }
    throw Object.assign(new Error(`B 站主页解析失败（错误码 ${result.code}），请稍后重试。`), { code: `bilibili_${Math.abs(Number(result.code)) || 'api'}_error` })
  }
  if (!result.data) throw new Error('B 站主页没有返回可用信息。')
  return result.data
}

async function mapWithConcurrency(items, limit, mapper) {
  const output = new Array(items.length)
  let nextIndex = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++
      output[index] = await mapper(items[index], index)
    }
  }))
  return output
}

function mapCreatorVideo(archive, ownerName = '') {
  const bvid = String(archive?.bvid || '')
  if (!/^BV[0-9A-Za-z]{10}$/i.test(bvid)) return null
  const durationValue = archive.duration ?? archive.length ?? 0
  const durationSeconds = typeof durationValue === 'string' && durationValue.includes(':')
    ? durationValue.split(':').reverse().reduce((total, part, index) => total + (Number(part) || 0) * 60 ** index, 0)
    : Number(durationValue) || 0
  const created = Number(archive.pubdate ?? archive.ctime ?? archive.created) || 0
  const cover = String(archive.pic || archive.cover || '').replace(/^http:/i, 'https:')
  return {
    id: bvid, bvid, title: String(archive.title || bvid), duration: formatDuration(durationSeconds),
    date: created ? new Date(created * 1000).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' }) : '',
    views: Number(archive.stat?.view ?? archive.play) || 0,
    cover: proxiedImageUrl(cover), url: `https://www.bilibili.com/video/${bvid}/`, owner: String(archive.author || archive.owner?.name || ownerName),
  }
}

async function parseCreatorHomepage(request, response) {
  const body = await readJsonBody(request)
  let input
  try { input = new URL(String(body.url || '').trim()) } catch {
    throw Object.assign(new Error('请输入有效的 B 站 UP 主主页链接。'), { statusCode: 400, code: 'invalid_url' })
  }
  const mid = input.hostname.toLowerCase() === 'space.bilibili.com' ? input.pathname.match(/^\/(\d+)(?:\/|$)/)?.[1] : null
  if (!['http:', 'https:'].includes(input.protocol) || !mid) {
    throw Object.assign(new Error('目前只支持 B 站 UP 主主页链接。'), { statusCode: 400, code: 'unsupported_url' })
  }
  const startedAt = Date.now()
  log('info', 'Creator parse started', { mid })
  try {
    const profilePromise = fetchBilibiliJson(`https://api.bilibili.com/x/web-interface/card?mid=${mid}`, mid)
    const wbiKeyPromise = getWbiKey(mid)
    const collectionListPromise = (async () => {
      const collections = []
      const pageSize = 20
      let pageNum = 1
      let total = 0
      do {
        const data = await fetchBilibiliJson(`https://api.bilibili.com/x/polymer/web-space/seasons_series_list?mid=${mid}&page_num=${pageNum}&page_size=${pageSize}`, mid)
        const list = data.items_lists || {}
        const items = [...(list.seasons_list || []).map((item) => ({ ...item, kind: 'collection' })), ...(list.series_list || []).map((item) => ({ ...item, kind: 'series' }))]
        collections.push(...items)
        total = Number(list.page?.total) || items.length
        if (!items.length || pageNum * pageSize >= total) break
        pageNum += 1
      } while (pageNum <= 100)
      return { collections, pages: pageNum }
    })()
    const [profileData, wbiKey, collectionResult] = await Promise.all([profilePromise, wbiKeyPromise, collectionListPromise])
    const profile = profileData.card || {}
    if (!profile.mid) throw new Error('B 站没有返回此 UP 主的基本资料。')
    const name = String(profile.name || '未知 UP 主')

    const posts = []
    const postPageSize = 30
    let postPage = 1
    let postTotal = 0
    do {
      const params = {
        mid, pn: postPage, ps: postPageSize, order: 'pubdate', platform: 'web',
        web_location: '1550101', order_avoided: 'true', wts: Math.floor(Date.now() / 1000),
      }
      const query = signWbiParams(params, wbiKey)
      const data = await fetchBilibiliJson(`https://api.bilibili.com/x/space/wbi/arc/search?${query}`, mid)
      const page = data.page || {}
      postTotal = Number(page.count) || 0
      const items = data.list?.vlist || []
      posts.push(...items)
      if (!items.length || postPage * postPageSize >= postTotal) break
      postPage += 1
    } while (postPage <= 1000)

    const loadedCollections = await mapWithConcurrency(collectionResult.collections, 4, async (item) => {
      const meta = item.meta || {}
      const isSeries = item.kind === 'series'
      const itemId = String(isSeries ? meta.series_id : meta.season_id || meta.id || '')
      if (!/^\d+$/.test(itemId)) return null
      const videos = []
      const pageSize = 30
      let pageNum = 1
      let total = Number(meta.total) || item.archives?.length || 0
      do {
        const endpoint = isSeries
          ? `https://api.bilibili.com/x/series/archives?mid=${mid}&series_id=${itemId}&only_normal=true&sort=desc&pn=${pageNum}&ps=${pageSize}`
          : `https://api.bilibili.com/x/polymer/web-space/seasons_archives_list?mid=${mid}&season_id=${itemId}&page_num=${pageNum}&page_size=${pageSize}`
        const data = await fetchBilibiliJson(endpoint, mid)
        const archives = data.archives || []
        total = Number(data.page?.total) || total || archives.length
        videos.push(...archives.map((archive) => mapCreatorVideo(archive, name)).filter(Boolean))
        if (!archives.length || videos.length >= total) break
        pageNum += 1
      } while (pageNum <= 1000)
      return {
        id: `${item.kind}-${itemId}`, kind: item.kind, title: String(meta.name || `${isSeries ? '系列' : '合集'} ${itemId}`),
        owner: name, total, videos, cover: videos[0]?.cover || proxiedImageUrl(meta.cover || ''),
      }
    })

    const groups = loadedCollections.filter(Boolean)
    const groupedIds = new Set(groups.flatMap((group) => group.videos.map((video) => video.bvid)))
    const postsMapped = posts.map((archive) => mapCreatorVideo(archive, name)).filter(Boolean)
    const uniqueVideos = new Map()
    for (const video of postsMapped) uniqueVideos.set(video.bvid, video)
    for (const group of groups) for (const video of group.videos) if (!uniqueVideos.has(video.bvid)) uniqueVideos.set(video.bvid, video)
    const others = postsMapped.filter((video) => !groupedIds.has(video.bvid))
    if (others.length) groups.push({ id: 'other-videos', kind: 'other', title: '其他视频', owner: name, total: others.length, videos: others, cover: others[0].cover })
    const creator = {
      uid: String(profile.mid), name, avatar: proxiedImageUrl(profile.face || ''),
      description: String(profile.sign || ''), videoCount: postTotal || postsMapped.length,
      collectionCount: loadedCollections.filter(Boolean).length, followers: Number(profile.fans) || 0,
      resultCount: uniqueVideos.size, groups, videos: [...uniqueVideos.values()],
    }
    log('info', 'Creator parse succeeded', {
      mid, postPages: postPage, videoCount: creator.videoCount, resultVideoCount: creator.resultCount,
      collectionPages: collectionResult.pages, collectionCount: creator.collectionCount, durationMs: Date.now() - startedAt,
    })
    sendJson(response, 200, { creator })
  } catch (error) {
    log(error.statusCode === 401 ? 'warn' : 'error', 'Creator parse failed', {
      mid, code: error.code || 'creator_parse_failed', message: error.message, durationMs: Date.now() - startedAt,
    })
    sendError(response, error.statusCode || 502, error.code || 'creator_parse_failed', error.message || 'UP 主主页解析失败，请稍后重试。')
  }
}

function isBilibiliImageHost(hostname) {
  return bilibiliImageHosts.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`))
}

async function proxyBilibiliImage(request, response) {
  let target
  try { target = new URL(new URL(request.url, 'http://127.0.0.1').searchParams.get('url') || '') } catch {
    sendError(response, 400, 'invalid_image_url', '图片地址无效。')
    return
  }
  if (target.protocol !== 'https:' || target.port && target.port !== '443' || target.username || target.password || !isBilibiliImageHost(target.hostname.toLowerCase())) {
    sendError(response, 403, 'image_host_not_allowed', '只允许加载 B 站图片资源。')
    return
  }
  try {
    let remote = await fetch(target, {
      headers: { Referer: 'https://www.bilibili.com/', 'User-Agent': 'Mozilla/5.0 BiliScribe/0.1', Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8' },
      redirect: 'manual', signal: AbortSignal.timeout(12_000),
    })
    for (let redirects = 0; remote.status >= 300 && remote.status < 400 && redirects < 3; redirects++) {
      const location = remote.headers.get('location')
      if (!location) break
      const redirected = new URL(location, target)
      if (redirected.protocol !== 'https:' || !isBilibiliImageHost(redirected.hostname.toLowerCase())) break
      target = redirected
      remote = await fetch(target, {
        headers: { Referer: 'https://www.bilibili.com/', 'User-Agent': 'Mozilla/5.0 BiliScribe/0.1', Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8' },
        redirect: 'manual', signal: AbortSignal.timeout(12_000),
      })
    }
    const contentType = (remote.headers.get('content-type') || '').split(';')[0].toLowerCase()
    const length = Number(remote.headers.get('content-length')) || 0
    if (!remote.ok || !contentType.startsWith('image/') || contentType === 'image/svg+xml' || length > 12 * 1024 * 1024) {
      sendError(response, 502, 'image_unavailable', 'B 站图片暂时无法加载。')
      return
    }
    const reader = remote.body?.getReader()
    if (!reader) {
      sendError(response, 502, 'image_unavailable', 'B 站图片暂时无法加载。')
      return
    }
    const chunks = []
    let byteLength = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      byteLength += value.byteLength
      if (byteLength > 12 * 1024 * 1024) {
        await reader.cancel()
        sendError(response, 502, 'image_too_large', '图片文件过大，无法加载。')
        return
      }
      chunks.push(Buffer.from(value))
    }
    const data = Buffer.concat(chunks, byteLength)
    response.writeHead(200, {
      'Content-Type': contentType, 'Content-Length': data.length,
      'Cache-Control': 'public, max-age=21600', 'X-Content-Type-Options': 'nosniff',
    })
    response.end(data)
  } catch {
    sendError(response, 502, 'image_unavailable', 'B 站图片暂时无法加载。')
  }
}

function getDownloadTasks() {
  return [...downloadTasks.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt))
}

function publicTask(task) {
  if (task.source?.type !== 'local') return task
  const safeSource = Object.fromEntries(Object.entries(task.source).filter(([key]) => key !== 'path'))
  return { ...task, source: safeSource }
}

function beginTaskExecution(task) {
  const startedAtMs = Date.now()
  task.startedAt = new Date(startedAtMs).toISOString()
  task.endedAt = null
  task.durationMs = null
  return startedAtMs
}

function endTaskExecution(task, startedAtMs) {
  if (!['completed', 'failed', 'cancelled'].includes(task.status)) return
  const endedAtMs = Date.now()
  task.endedAt = new Date(endedAtMs).toISOString()
  task.durationMs = Number.isFinite(startedAtMs) ? Math.max(0, endedAtMs - startedAtMs) : null
  task.completedAt = task.endedAt
}

function findFFmpeg() {
  const configuredPath = process.env.FFMPEG_PATH
  if (configuredPath && fs.existsSync(configuredPath)) return configuredPath
  if (process.platform === 'win32') {
    const result = spawnSync('where.exe', ['ffmpeg.exe'], { encoding: 'utf8', timeout: 2500, windowsHide: true })
    const candidate = (result.stdout || '').split(/\r?\n/).map((line) => line.trim()).find((line) => line && fs.existsSync(line))
    if (candidate) return candidate
  }
  return null
}

async function ensureWritableDirectory(directory) {
  const probePath = path.join(directory, `.biliscribe-write-test-${randomUUID()}.tmp`)
  try {
    await fs.promises.mkdir(directory, { recursive: true })
    await fs.promises.writeFile(probePath, 'ok', { flag: 'wx' })
  } catch (error) {
    throw Object.assign(new Error(`下载目录无法创建或写入：${directory}。请检查路径和权限。`), { code: error.code || 'download_directory_unwritable' })
  } finally {
    try { await fs.promises.unlink(probePath) } catch { /* only remove the uniquely named probe file */ }
  }
}

function safeDirectoryName(value, maxLength = 60) {
  let cleaned = String(value || 'B站视频').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').trim()
  cleaned = (cleaned || 'B站视频').slice(0, maxLength).replace(/[. ]+$/g, '')
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(cleaned)) cleaned = `_${cleaned}`
  return cleaned || 'B站视频'
}

function taskCollectionDirectory(task) {
  if (!task.creatorName || !task.groupName) return ''
  return path.join(downloadDirectory, safeDirectoryName(task.creatorName), safeDirectoryName(task.groupName))
}

function taskMediaDirectory(task) {
  const mediaFolder = task.mode === 'audio' ? '音频' : '视频'
  const collectionDirectory = taskCollectionDirectory(task)
  if (collectionDirectory) return path.join(collectionDirectory, mediaFolder)
  return path.join(downloadDirectory, safeDirectoryName(task.title), mediaFolder)
}

function finalMediaPath(task, sourcePath, index = 0) {
  const extension = path.extname(sourcePath).toLowerCase()
  const suffix = index ? ` (${index + 1})` : ''
  let base = safeDirectoryName(task.title, 84).slice(0, 84 - extension.length - suffix.length)
  let destination = path.join(task.outputDirectory, `${base}${suffix}${extension}`)
  if (fs.existsSync(destination) && path.resolve(destination) !== path.resolve(sourcePath)) {
    const collisionSuffix = ` (${task.bvid})${suffix}`
    base = safeDirectoryName(task.title, 84).slice(0, 84 - extension.length - collisionSuffix.length)
    destination = path.join(task.outputDirectory, `${base}${collisionSuffix}${extension}`)
  }
  if (fs.existsSync(destination) && path.resolve(destination) !== path.resolve(sourcePath)) {
    const attemptSuffix = ` (${task.bvid}-${task.attempt})${suffix}`
    base = safeDirectoryName(task.title, 84).slice(0, 84 - extension.length - attemptSuffix.length)
    destination = path.join(task.outputDirectory, `${base}${attemptSuffix}${extension}`)
  }
  return destination
}

async function openExplorerLocation(resolvedTarget, isFile, taskId) {
  if (isFile) {
    const encodedTarget = Buffer.from(resolvedTarget, 'utf8').toString('base64')
    const script = [
      "$ErrorActionPreference = 'Stop'",
      `$target = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedTarget}'))`,
      "$parent = [System.IO.Path]::GetDirectoryName($target)",
      "$name = [System.IO.Path]::GetFileName($target)",
      "$shell = New-Object -ComObject Shell.Application",
      "$shell.Explore($parent)",
      "$selected = $false",
      "for ($i = 0; $i -lt 40 -and -not $selected; $i++) {",
      "  Start-Sleep -Milliseconds 150",
      "  foreach ($window in $shell.Windows()) {",
      "    try {",
      "      $folderPath = $window.Document.Folder.Self.Path",
      "      if ([System.IO.Path]::GetFullPath($folderPath).TrimEnd('\\') -ieq $parent.TrimEnd('\\')) {",
      "        $item = $window.Document.Folder.ParseName($name)",
      "        if ($item) { $window.Document.SelectItem($item, 29); $selected = $true; break }",
      "      }",
      "    } catch {}",
      "  }",
      "}",
      "if ($selected) { exit 0 } else { exit 2 }",
    ].join('\n')
    const encodedScript = Buffer.from(script, 'utf16le').toString('base64')
    const helper = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encodedScript], {
      windowsHide: true, stdio: 'ignore',
    })
    await new Promise((resolve, reject) => {
      let settled = false
      const timeout = setTimeout(() => {
        if (settled) return
        settled = true
        helper.kill()
        reject(Object.assign(new Error('文件资源管理器未能定位到下载文件。'), { code: 'explorer_selection_timeout' }))
      }, 12_000)
      helper.once('spawn', () => log('info', 'Explorer file selection helper spawned', { taskId, pid: helper.pid || null }))
      helper.once('error', (error) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        reject(error)
      })
      helper.once('close', (exitCode, signal) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        log(exitCode === 0 ? 'info' : 'error', 'Explorer file selection completed', { taskId, exitCode, signal, selected: exitCode === 0 })
        if (exitCode === 0) resolve()
        else reject(Object.assign(new Error('无法在文件资源管理器中定位下载文件。'), { code: 'explorer_selection_failed' }))
      })
    })
    return
  }

  const explorer = spawn('explorer.exe', [resolvedTarget], {
    cwd: process.env.SystemRoot || 'C:\\Windows', detached: true, stdio: 'ignore', windowsHide: false,
  })
  await new Promise((resolve, reject) => {
    explorer.once('spawn', () => {
      log('info', 'Explorer directory spawned', { taskId, pid: explorer.pid || null })
      resolve()
    })
    explorer.once('error', reject)
  })
  explorer.unref()
}

async function listMediaFiles(directory, mode) {
  const allowed = mode === 'audio'
    ? new Set(['.m4a', '.mka', '.mp3', '.aac', '.wav', '.flac'])
    : new Set(['.mp4', '.mkv', '.flv'])
  const files = []
  async function walk(current) {
    for (const entry of await fs.promises.readdir(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name)
      if (entry.isDirectory()) await walk(entryPath)
      else if (entry.isFile() && allowed.has(path.extname(entry.name).toLowerCase())) {
        const stat = await fs.promises.stat(entryPath)
        if (stat.size > 0) files.push({ path: entryPath, size: stat.size })
      }
    }
  }
  await walk(directory)
  return files.sort((left, right) => left.path.localeCompare(right.path))
}

function friendlyDownloadError(output, exitCode) {
  if (/ffmpeg|混流|mux/i.test(output) && /not found|找不到|无法启动|missing|不存在/i.test(output)) {
    return '合并媒体文件失败，请检查 FFmpeg 是否可用后重试。'
  }
  if (/-101|\b401\b|unauthori[sz]ed|登录状态已失效|请先登录|尚未登录|authentication failed|not logged in/i.test(output)) {
    return 'B 站登录状态可能已失效，请重新扫码登录后重试。'
  }
  if (/视频不存在|未找到视频|not found|invalid video|无效的视频/i.test(output)) return '视频不存在或暂不可用，请检查链接后重试。'
  if (/disk full|no space|磁盘空间不足/i.test(output)) return '保存位置空间不足，请清理磁盘后重试。'
  if (exitCode === null) return 'BBDownNext 未能正常结束，请查看日志后重试。'
  return `BBDownNext 下载失败（退出码 ${exitCode}），请检查网络或查看日志后重试。`
}

function updateDownloadPhase(task, phase) {
  if (task.phase === phase) return
  task.phase = phase
  saveLocalState()
  log('info', 'Download task phase changed', { taskId: task.id, bvid: task.bvid, mode: task.mode, phase })
}

function killDownloadTree(child) {
  if (!child || child.exitCode !== null) return
  if (process.platform === 'win32' && child.pid) {
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    killer.once('error', () => child.kill())
    killer.once('close', (exitCode) => { if (exitCode !== 0) child.kill() })
  } else {
    child.kill('SIGTERM')
  }
}

async function runDownloadTask(task) {
  let child = null
  task.status = 'running'
  const startedAt = beginTaskExecution(task)
  task.phase = '准备中'
  task.progress = null
  task.error = ''
  task.completedAt = null
  task.attempt = (task.attempt || 0) + 1
  task.outputDirectory = taskMediaDirectory(task)
  task.workDirectory = path.join(downloadDirectory, '.biliscribe-work', `${task.id}-${task.attempt}`)
  task.outputPath = ''
  task.fileSize = 0
  saveLocalState()
  log('info', 'Download task started', { taskId: task.id, bvid: task.bvid, mode: task.mode })

  try {
    if (!fs.existsSync(executablePath)) throw Object.assign(new Error('未找到 BBDownNext，请确认 tools/BBDownNext/BBDown.exe 存在。'), { code: 'bbdown_unavailable' })
    await ensureWritableDirectory(downloadDirectory)
    const collectionDirectory = taskCollectionDirectory(task)
    if (collectionDirectory) await fs.promises.mkdir(path.join(collectionDirectory, '文字稿'), { recursive: true })
    await ensureWritableDirectory(task.outputDirectory)
    await ensureWritableDirectory(task.workDirectory)
    if (task.cancelRequested) {
      task.status = 'cancelled'
      task.phase = '已取消'
      task.error = '任务已取消；未自动删除可能残留的临时文件。'
      return
    }

    const ffmpegPath = task.mode === 'video' ? findFFmpeg() : null
    if (task.mode === 'video' && !ffmpegPath) {
      throw Object.assign(new Error('下载完整视频需要 FFmpeg 合并音视频；请安装 FFmpeg 并加入 PATH 后重试。'), { code: 'ffmpeg_unavailable' })
    }

    const args = [task.url, '--get', task.mode === 'audio' ? 'a' : 'av', '--work-dir', task.workDirectory, '--file-pattern', '<videoTitle>', '--stop-on-error']
    if (task.mode === 'audio') args.push('--mux', 'None')
    else args.push('--mux', 'Mpeg4', '--ffmpeg-path', ffmpegPath)

    try {
      child = spawn(executablePath, args, { cwd: path.dirname(executablePath), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      throw Object.assign(new Error('BBDownNext 无法启动。'), { code: error.code || 'bbdown_spawn_failed' })
    }
    activeDownloadChild = child
    childProcesses.add(child)
    log('info', 'BBDownNext download process started', { taskId: task.id, bvid: task.bvid, mode: task.mode, executable: path.basename(executablePath) })
    updateDownloadPhase(task, '下载中')

    let output = ''
    let pendingLine = ''
    const collect = (chunk) => {
      const text = chunk.toString('utf8')
      if (output.length < 24_000) output += text.slice(0, 24_000 - output.length)
      const segments = `${pendingLine}${text}`.split(/[\r\n]+/)
      pendingLine = segments.pop() || ''
      for (const line of segments) {
        if (/混流|合并|mux|merge|ffmpeg/i.test(line)) updateDownloadPhase(task, '合并中')
        else if (/下载|download|received|速度|speed/i.test(line)) updateDownloadPhase(task, '下载中')
      }
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)

    const result = await new Promise((resolve, reject) => {
      let settled = false
      child.once('error', (error) => {
        if (settled) return
        settled = true
        reject(error)
      })
      child.once('close', (exitCode, signal) => {
        if (settled) return
        settled = true
        resolve({ exitCode, signal })
      })
    })
    childProcesses.delete(child)
    if (activeDownloadChild === child) activeDownloadChild = null

    if (task.cancelRequested) {
      task.status = 'cancelled'
      task.phase = '已取消'
      task.error = '任务已取消；未自动删除可能残留的临时文件。'
      log('info', 'Download task cancelled', { taskId: task.id, bvid: task.bvid, outputDirectory: task.outputDirectory, durationMs: Date.now() - startedAt })
      return
    }
    if (result.exitCode !== 0) {
      task.status = 'failed'
      task.phase = '下载失败'
      task.error = friendlyDownloadError(output, result.exitCode)
      task.completedAt = new Date().toISOString()
      log('error', 'Download task failed', { taskId: task.id, bvid: task.bvid, mode: task.mode, exitCode: result.exitCode, signal: result.signal, reason: task.error, outputDirectory: task.outputDirectory, durationMs: Date.now() - startedAt })
      return
    }

    let files = await listMediaFiles(task.workDirectory, task.mode)
    if (!files.length) {
      task.status = 'failed'
      task.phase = '未找到输出文件'
      task.error = 'BBDownNext 已结束，但没有找到完整媒体文件；可能的临时文件已保留。'
      task.completedAt = new Date().toISOString()
      log('error', 'Download task output missing', { taskId: task.id, bvid: task.bvid, mode: task.mode, outputDirectory: task.outputDirectory, workDirectory: task.workDirectory, durationMs: Date.now() - startedAt })
      return
    }
    files = await Promise.all(files.map(async (file, index) => {
      const destination = finalMediaPath(task, file.path, index)
      if (path.resolve(destination) !== path.resolve(file.path)) await fs.promises.rename(file.path, destination)
      return { ...file, path: destination }
    }))
    task.status = 'completed'
    task.phase = '已完成'
    task.outputFiles = files.map((file) => file.path)
    task.outputPath = files.length === 1 ? files[0].path : task.outputDirectory
    task.fileSize = files.reduce((total, file) => total + file.size, 0)
    task.completedAt = new Date().toISOString()
    log('info', 'Download task completed', { taskId: task.id, bvid: task.bvid, mode: task.mode, outputPath: task.outputPath, outputFiles: files.length, fileSize: task.fileSize, durationMs: Date.now() - startedAt })
  } catch (error) {
    if (child && child.exitCode === null) killDownloadTree(child)
    if (child) childProcesses.delete(child)
    if (activeDownloadChild === child) activeDownloadChild = null
    if (task.cancelRequested) {
      task.status = 'cancelled'
      task.phase = '已取消'
      task.error = '任务已取消；未自动删除可能残留的临时文件。'
      log('info', 'Download task cancelled', { taskId: task.id, bvid: task.bvid, outputDirectory: task.outputDirectory, durationMs: Date.now() - startedAt })
    } else {
      task.status = 'failed'
      task.phase = '下载失败'
      task.error = error.message || '本地下载失败。'
      task.completedAt = new Date().toISOString()
      log('error', 'Download task failed', { taskId: task.id, bvid: task.bvid, mode: task.mode, code: error.code || 'download_error', reason: task.error, outputDirectory: task.outputDirectory, stack: error.stack, durationMs: Date.now() - startedAt })
    }
  } finally {
    endTaskExecution(task, startedAt)
    if (activeDownloadChild && activeDownloadChild.exitCode !== null) {
      childProcesses.delete(activeDownloadChild)
      activeDownloadChild = null
    }
    task.cancelRequested = false
    saveLocalState()
  }
}

function transcriptFailure(code, message) {
  return Object.assign(new Error(message), { code })
}

function setTranscriptPhase(task, phase) {
  if (task.phase === phase) return
  task.phase = phase
  saveLocalState()
  log('info', 'Transcript task phase changed', { taskId: task.id, bvid: task.bvid, phase })
}

async function runTranscriptProcess(task, command, args, phase) {
  if (task.cancelRequested) throw transcriptFailure('transcript_cancelled', '任务已取消。')
  setTranscriptPhase(task, phase)
  let child
  try {
    child = spawn(command, args, { cwd: projectRoot, windowsHide: true, stdio: 'ignore' })
  } catch (error) {
    throw transcriptFailure(error.code || 'transcript_process_start_failed', '音频处理程序无法启动。')
  }
  activeDownloadChild = child
  childProcesses.add(child)
  const result = await new Promise((resolve, reject) => {
    let settled = false
    child.once('error', (error) => {
      if (settled) return
      settled = true
      reject(transcriptFailure(error.code || 'transcript_process_failed', '音频处理程序运行失败。'))
    })
    child.once('close', (exitCode, signal) => {
      if (settled) return
      settled = true
      resolve({ exitCode, signal })
    })
  }).finally(() => {
    childProcesses.delete(child)
    if (activeDownloadChild === child) activeDownloadChild = null
  })
  if (task.cancelRequested) throw transcriptFailure('transcript_cancelled', '任务已取消。')
  if (result.exitCode !== 0) throw transcriptFailure('transcript_process_failed', '音频处理失败，请检查 FFmpeg 或 B 站网络后重试。')
  return result
}

function startTranscriptWakeLock(task) {
  if (process.platform !== 'win32' || transcriptWakeLockChild) return
  const script = "Add-Type -Namespace BiliScribe -Name Power -MemberDefinition '[System.Runtime.InteropServices.DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint esFlags);'; $r = [BiliScribe.Power]::SetThreadExecutionState([uint32]2147483649); if ($r -eq 0) { exit 2 }; [Console]::Out.WriteLine('enabled'); while ($true) { Start-Sleep -Seconds 30 }"
  try {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    transcriptWakeLockChild = child
    childProcesses.add(child)
    child.stdout?.on('data', (chunk) => {
      if (String(chunk).includes('enabled')) log('info', 'Transcript sleep prevention enabled', { taskId: task.id })
    })
    child.once('error', (error) => {
      if (transcriptWakeLockChild === child) transcriptWakeLockChild = null
      childProcesses.delete(child)
      log('warn', 'Transcript sleep prevention unavailable', { taskId: task.id, code: error.code || 'power_request_failed' })
    })
    child.once('close', (code) => {
      childProcesses.delete(child)
      if (transcriptWakeLockChild === child) transcriptWakeLockChild = null
      if (code !== 0 && !child.stopRequested && !shuttingDown) log('warn', 'Transcript sleep prevention ended', { taskId: task.id, code: code ?? 'unknown' })
    })
  } catch (error) {
    log('warn', 'Transcript sleep prevention unavailable', { taskId: task.id, code: error.code || 'power_request_failed' })
  }
}

function stopTranscriptWakeLock() {
  const child = transcriptWakeLockChild
  transcriptWakeLockChild = null
  if (child) { child.stopRequested = true; child.kill() }
}

function transcriptOutputDirectory(task) {
  if (task.source?.type === 'local') {
    return path.join(transcriptDirectory, '本地导入', safeDirectoryName(task.groupName || '未分组'))
  }
  if (task.creatorName && task.groupName) {
    return path.join(transcriptDirectory, safeDirectoryName(task.creatorName), safeDirectoryName(task.groupName), '文字稿')
  }
  return path.join(transcriptDirectory, safeDirectoryName(task.title), '文字稿')
}

function matchingCompletedAudio(task) {
  const candidates = getDownloadTasks()
    .filter((item) => item.bvid === task.bvid && item.mode === 'audio' && item.status === 'completed')
    .flatMap((item) => item.outputFiles?.length ? item.outputFiles : item.outputPath ? [item.outputPath] : [])
    .filter((file) => fs.existsSync(file) && fs.statSync(file).isFile())
  return candidates.find((file) => path.extname(file).toLowerCase() === '.m4a')
    || candidates.find((file) => ['.mp3', '.mka', '.aac'].includes(path.extname(file).toLowerCase()))
    || null
}

function readTranscriptLibrary() {
  try {
    const saved = JSON.parse(fs.readFileSync(transcriptsFile, 'utf8'))
    return Array.isArray(saved) ? saved.filter((item) => item && typeof item.id === 'string') : []
  } catch (error) {
    if (error.code !== 'ENOENT') log('warn', 'Transcript library could not be loaded', { code: error.code || 'transcript_library_load_failed' })
    return []
  }
}

function writeTranscriptLibrary(entries) {
  fs.mkdirSync(stateDirectory, { recursive: true })
  const temporary = `${transcriptsFile}.${process.pid}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(entries, null, 2)}\n`, 'utf8')
  fs.renameSync(temporary, transcriptsFile)
}

async function hashFile(filePath) {
  const hash = createHash('sha256')
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk)
  return hash.digest('hex')
}

function saveTranscriptCheckpoint(directory, checkpoint) {
  checkpoint.updatedAt = new Date().toISOString()
  const statePath = path.join(directory, 'state.json')
  const temporary = `${statePath}.${process.pid}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(checkpoint, null, 2)}\n`, 'utf8')
  fs.renameSync(temporary, statePath)
}

function writeTranscriptSegmentText(directory, segmentId, text) {
  const outputPath = path.join(directory, `segment-${segmentId}.txt`)
  const temporary = `${outputPath}.${process.pid}.tmp`
  fs.writeFileSync(temporary, `${cleanTranscriptText(text)}\n`, 'utf8')
  fs.renameSync(temporary, outputPath)
}

function readTranscriptCheckpoint(directory, taskId) {
  try {
    const saved = JSON.parse(fs.readFileSync(path.join(directory, 'state.json'), 'utf8'))
    if (saved.taskId !== taskId || !Array.isArray(saved.segments) || !Array.isArray(saved.completedSegments)) return null
    if (saved.segments.some((item) => !item || !/^\d{3}[ab]{0,14}$/.test(item.id || ''))) return null
    return saved
  } catch (error) {
    if (error.code !== 'ENOENT') log('warn', 'Transcript checkpoint could not be loaded', { code: error.code || 'checkpoint_read_failed' })
    return null
  }
}

async function clearTranscriptCheckpoint(directory) {
  const resolvedRoot = path.resolve(transcriptWorkDirectory)
  const resolvedDirectory = path.resolve(directory)
  if (!resolvedDirectory.startsWith(`${resolvedRoot}${path.sep}`)) throw transcriptFailure('unsafe_checkpoint_path', '转写临时目录路径无效。')
  const names = await fs.promises.readdir(directory).catch(() => [])
  for (const name of names) {
    if (/^segment-\d{3}[ab]{0,14}(?:\.partial)?\.(?:m4a|mp3|txt)(?:\.\d+\.tmp)?$/i.test(name) || name === 'state.json') {
      await fs.promises.rm(path.join(directory, name), { force: true })
    }
  }
  const audioSegmentsDirectory = path.join(directory, 'audio-segments')
  const resolvedSegmentsDirectory = path.resolve(audioSegmentsDirectory)
  if (resolvedSegmentsDirectory.startsWith(`${resolvedDirectory}${path.sep}`)) {
    await fs.promises.rm(audioSegmentsDirectory, { recursive: true, force: true })
  }
}

function mergeTranscriptSegments(segments) {
  let result = ''
  for (const segment of segments) {
    let next = cleanTranscriptText(segment)
    if (result && next) {
      const previousSentence = result.match(/[^。！？!?\n]{8,}[。！？!?]?\s*$/u)?.[0]?.trim() || ''
      const nextSentence = next.match(/^[^。！？!?\n]{8,}[。！？!?]?/u)?.[0]?.trim() || ''
      const normalize = (text) => text.replace(/[\s，。！？、；：,.!?;:「」『』“”"'（）()]/gu, '')
      if (previousSentence && nextSentence && normalize(previousSentence) === normalize(nextSentence)) {
        next = next.slice(next.indexOf(nextSentence) + nextSentence.length).trimStart()
      }
    }
    if (next) result += `${result ? '\n\n' : ''}${next}`
  }
  return result.trim()
}

function transcriptErrorForStatus(status) {
  if (status === 401 || status === 403) return transcriptFailure(`mimo_http_${status}`, 'MiMo API Key 无效或没有权限，请在设置中检查。')
  if (status === 429) return transcriptFailure('mimo_rate_limited', 'MiMo 请求过于频繁，稍后可重试。')
  if (status >= 500) return transcriptFailure(`mimo_http_${status}`, 'MiMo 服务暂时不可用，请稍后重试。')
  return transcriptFailure(`mimo_http_${status}`, `MiMo 请求失败（HTTP ${status}）。`)
}

async function callMiMoForSegment(task, prompt, filePath, index, count, segment, ffmpegPath) {
  return withMiMoRequestLock(() => callMiMoForSegmentUnlocked(task, prompt, filePath, index, count, segment, ffmpegPath))
}

async function callMiMoForSegmentUnlocked(task, prompt, filePath, index, count, segment, ffmpegPath) {
  if (!mimoApiKey) throw transcriptFailure('mimo_key_missing', '请先在设置中配置 MiMo API Key。')
  const fileStats = await fs.promises.stat(filePath)
  const base64Size = Math.ceil(fileStats.size / 3) * 4
  if (base64Size > transcriptMaxBase64Bytes) throw transcriptFailure('audio_segment_too_large', '音频片段超过 MiMo Base64 安全大小。')
  const audioDiagnostics = probeAudioDiagnostics(ffmpegPath, filePath, segment?.durationSeconds)
  const taskWorkDirectory = path.resolve(transcriptWorkDirectory, task.id)
  const resolvedAudioPath = path.resolve(filePath)
  const relativeAudioPath = path.relative(taskWorkDirectory, resolvedAudioPath)
  const audioInternalPath = relativeAudioPath && relativeAudioPath !== '..' && !relativeAudioPath.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeAudioPath)
    ? relativeAudioPath.split(path.sep).join('/')
    : 'audio-segment'
  log('info', 'MiMo transcript input diagnostics', {
    taskId: task.id, audioInternalPath, durationSeconds: audioDiagnostics.durationSeconds,
    fileSize: fileStats.size, codec: audioDiagnostics.codec, bitrate: audioDiagnostics.bitrate,
    sampleRate: audioDiagnostics.sampleRate, channels: audioDiagnostics.channels,
    model: 'mimo-v2.6-flash', promptVersion: transcriptPromptVersion, segmentCount: count,
    segment: index, segmentStart: segment?.startSeconds ?? null, segmentEnd: segment?.endSeconds ?? null,
  })
  const bytes = await fs.promises.readFile(filePath)
  const extension = path.extname(filePath).toLowerCase()
  const mimeType = extension === '.m4a' ? 'audio/mp4' : 'audio/mpeg'
  const format = extension === '.m4a' ? 'm4a' : 'mp3'
  const body = {
    model: 'mimo-v2.6-flash',
    stream: true,
    stream_options: { include_usage: true },
    max_completion_tokens: 32000,
    thinking: { type: 'disabled' },
    messages: [
      { role: 'system', content: `${prompt}\n\n本次任务补充要求：请修正所附音频中的本段课程内容。只输出本段修正后的完整正文，不输出字数统计、标题、摘要、说明或其他内容。` },
      { role: 'user', content: [
        { type: 'input_audio', input_audio: { data: `data:${mimeType};base64,${bytes.toString('base64')}`, format } },
        { type: 'text', text: `这是第 ${index} 段，共 ${count} 段。请只返回本段修正后的完整正文，保持原话顺序，不要总结全文。` },
      ] },
    ],
  }
  let lastError
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (task.cancelRequested) throw transcriptFailure('transcript_cancelled', '任务已取消。')
    const controller = new AbortController()
    activeTaskAbortController = controller
    let connectTimer
    let idleTimer
    let outputHandle
    let streamReader
    let outputPath
    let characterCount = 0
    let firstContentAt = null
    const requestStartedAt = Date.now()
    const expectedModel = 'mimo-v2.6-flash'
    try {
      const outputDirectory = path.join(transcriptWorkDirectory, task.id)
      await fs.promises.mkdir(outputDirectory, { recursive: true })
      outputPath = path.join(outputDirectory, `segment-${String(index).padStart(3, '0')}.partial.txt`)
      await fs.promises.rm(outputPath, { force: true })
      outputHandle = await fs.promises.open(outputPath, 'w')
      task.transcriptProgress = { ...(task.transcriptProgress || {}), generatedCharacters: 0 }
      connectTimer = setTimeout(() => controller.abort('connect_timeout'), transcriptConnectTimeoutMs)
      const response = await fetch('https://api.xiaomimimo.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'api-key': mimoApiKey },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      clearTimeout(connectTimer)
      log('info', 'MiMo transcript response received', { taskId: task.id, bvid: task.bvid, segment: index, status: response.status })
      if (!response.ok) {
        await response.body?.cancel().catch(() => {})
        const error = transcriptErrorForStatus(response.status)
        const retryable = response.status === 429 || response.status >= 500
        if (retryable && attempt < 2) {
          log('warn', 'MiMo transcript request retry', { taskId: task.id, segment: index, status: response.status, attempt: attempt + 1 })
          await outputHandle.close()
          outputHandle = null
          await fs.promises.rm(outputPath, { force: true })
          await new Promise((resolve) => setTimeout(resolve, 1000 * (2 ** attempt)))
          continue
        }
        throw error
      }
      if (!response.body) throw transcriptFailure('mimo_invalid_response', 'MiMo 没有返回流式内容。')
      log('info', 'MiMo transcript stream started', { taskId: task.id, bvid: task.bvid, segment: index, segmentCount: count })
      const reader = response.body.getReader()
      streamReader = reader
      const decoder = new TextDecoder()
      let buffer = ''
      let finishReason = null
      let responseModel = ''
      let usage = null
      let streamDone = false
      while (!streamDone) {
        if (task.cancelRequested) throw transcriptFailure('transcript_cancelled', '任务已取消。')
        const readPromise = reader.read()
        const next = await Promise.race([
          readPromise,
          new Promise((_, reject) => {
            idleTimer = setTimeout(() => {
              controller.abort('stream_idle_timeout')
              reject(transcriptFailure('mimo_stream_idle_timeout', 'MiMo 流式输出长时间没有数据，请稍后重试。'))
            }, transcriptStreamIdleTimeoutMs)
          }),
        ])
        clearTimeout(idleTimer)
        idleTimer = null
        if (next.done) {
          buffer += decoder.decode()
          streamDone = true
        } else buffer += decoder.decode(next.value, { stream: true })
        const events = buffer.split(/\r?\n\r?\n/)
        buffer = events.pop() || ''
        for (const event of events) {
          const data = event.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n')
          if (!data || data === '[DONE]') continue
          let chunk
          try { chunk = JSON.parse(data) } catch { throw transcriptFailure('mimo_invalid_stream_chunk', 'MiMo 流式数据格式异常。') }
          if (chunk.model) responseModel = String(chunk.model)
          if (chunk.usage) usage = chunk.usage
          const choice = chunk.choices?.[0]
          if (choice?.finish_reason) finishReason = String(choice.finish_reason)
          const content = choice?.delta?.content
          if (typeof content === 'string' && content) {
            if (firstContentAt === null) {
              firstContentAt = Date.now()
              log('info', 'MiMo first transcript content received', {
                taskId: task.id, bvid: task.bvid, segment: index, timeToFirstContentMs: firstContentAt - requestStartedAt,
              })
            }
            await outputHandle.write(content)
            characterCount += Array.from(content).length
            task.transcriptProgress = { ...(task.transcriptProgress || {}), generatedCharacters: characterCount }
            if (characterCount % 1000 < Array.from(content).length) saveLocalState()
          }
        }
      }
      if (buffer.trim()) {
        const data = buffer.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n')
        if (data && data !== '[DONE]') {
          try {
            const chunk = JSON.parse(data)
            if (chunk.model) responseModel = String(chunk.model)
            if (chunk.usage) usage = chunk.usage
            if (chunk.choices?.[0]?.finish_reason) finishReason = String(chunk.choices[0].finish_reason)
            const content = chunk.choices?.[0]?.delta?.content
            if (typeof content === 'string' && content) { await outputHandle.write(content); characterCount += Array.from(content).length }
          } catch { throw transcriptFailure('mimo_invalid_stream_chunk', 'MiMo 流式数据格式异常。') }
        }
      }
      if (responseModel.toLowerCase() !== expectedModel) throw transcriptFailure('mimo_unexpected_model', 'MiMo 返回了非预期模型，文字稿未保存。')
      await outputHandle.close()
      outputHandle = null
      const rawOutput = await fs.promises.readFile(outputPath, 'utf8')
      const outputDiagnostics = analyzeTranscriptOutput(rawOutput)
      const abnormalFinish = finishReason !== 'stop'
      log('info', 'MiMo transcript output diagnostics', {
        taskId: task.id, segment: index, model: responseModel, finishReason: finishReason || 'missing',
        outputCharacterCount: outputDiagnostics.outputCharacterCount,
        outputWordCount: outputDiagnostics.outputWordCount,
        first100Characters: outputDiagnostics.first100Characters,
        last300Characters: outputDiagnostics.last300Characters,
        ...(abnormalFinish ? {
          repetitionScore: outputDiagnostics.repetitionScore,
          repeatedFragmentSample: outputDiagnostics.repeatedFragmentSample,
        } : {}),
      })
      if (finishReason !== 'stop') {
        log('warn', 'MiMo transcript segment was incomplete', {
          taskId: task.id, bvid: task.bvid, segment: index, model: responseModel, finishReason: finishReason || 'missing',
          generatedCharacterCount: characterCount,
          completionTokenCount: Number.isFinite(usage?.completion_tokens) ? usage.completion_tokens : null,
          reasoningCount: Number.isFinite(usage?.completion_tokens_details?.reasoning_tokens) ? usage.completion_tokens_details.reasoning_tokens : null,
        })
        if (finishReason === 'length') {
          const error = transcriptFailure('mimo_output_truncated', 'MiMo 输出长度不足，正在缩小此片段后重试。')
          error.generatedCharacterCount = characterCount
          error.finishReason = finishReason
          throw error
        }
        if (finishReason === 'repetition_truncation') {
          const error = transcriptFailure('mimo_repetition_truncation', 'MiMo 检测到当前音频段出现重复生成，需要缩短本段后继续。')
          error.generatedCharacterCount = characterCount
          error.finishReason = finishReason
          throw error
        }
        if (finishReason === 'content_filter') {
          const error = transcriptFailure('mimo_content_filtered', 'MiMo 安全过滤阻止了本段返回，正在拆分音频片段后重试。')
          error.generatedCharacterCount = characterCount
          error.finishReason = finishReason
          throw error
        }
        throw transcriptFailure('mimo_incomplete_response', 'MiMo 未能完整返回本段文字稿，请重试。')
      }
      const text = cleanTranscriptText(rawOutput)
      if (!text) throw transcriptFailure('mimo_empty_response', 'MiMo 返回了空文字稿，请重试。')
      log('info', 'MiMo transcript segment completed', {
        taskId: task.id, bvid: task.bvid, segment: index, model: responseModel,
        durationMs: Date.now() - requestStartedAt, timeToFirstContentMs: firstContentAt === null ? null : firstContentAt - requestStartedAt,
        textLength: Array.from(text).length, finishReason,
        completionTokenCount: Number.isFinite(usage?.completion_tokens) ? usage.completion_tokens : null,
        reasoningCount: Number.isFinite(usage?.completion_tokens_details?.reasoning_tokens) ? usage.completion_tokens_details.reasoning_tokens : null,
      })
      await fs.promises.rm(outputPath, { force: true })
      return text
    } catch (error) {
      await streamReader?.cancel().catch(() => {})
      const cancelled = task.cancelRequested
      if (cancelled) {
        await outputHandle?.close().catch(() => {})
        outputHandle = null
        await fs.promises.rm(outputPath, { force: true })
        throw transcriptFailure('transcript_cancelled', '任务已取消。')
      }
      const transient = error.name === 'TypeError' || error.name === 'TimeoutError' || error.code === 'ETIMEDOUT' || ['connect_timeout', 'stream_idle_timeout'].includes(controller.signal.reason)
      if ((transient || error.code === 'mimo_invalid_response' || error.code === 'mimo_invalid_stream_chunk') && attempt < 2) {
        log('warn', 'MiMo transcript request retry', { taskId: task.id, segment: index, code: error.code || controller.signal.reason || 'network_error', attempt: attempt + 1 })
        lastError = error
        await outputHandle?.close().catch(() => {})
        outputHandle = null
        await fs.promises.rm(outputPath, { force: true })
        await new Promise((resolve) => setTimeout(resolve, 1000 * (2 ** attempt)))
        continue
      }
      await outputHandle?.close().catch(() => {})
      outputHandle = null
      await fs.promises.rm(outputPath, { force: true })
      if (transient) {
        const code = controller.signal.reason === 'connect_timeout' ? 'mimo_connect_timeout' : error.code || 'mimo_stream_idle_timeout'
        throw transcriptFailure(code, controller.signal.reason === 'connect_timeout' ? '连接 MiMo 超时，请检查网络后重试。' : 'MiMo 流式输出中断，请稍后重试。')
      }
      throw error
    } finally {
      clearTimeout(connectTimer)
      clearTimeout(idleTimer)
      await outputHandle?.close().catch(() => {})
      if (activeTaskAbortController === controller) activeTaskAbortController = null
    }
  }
  throw transcriptFailure('mimo_network_error', lastError?.code || 'MiMo 网络请求失败，请稍后重试。')
}

function findFFprobe(ffmpegPath) {
  const sibling = path.join(path.dirname(ffmpegPath), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')
  if (fs.existsSync(sibling)) return sibling
  if (process.platform === 'win32') {
    const result = spawnSync('where.exe', ['ffprobe.exe'], { encoding: 'utf8', timeout: 2500, windowsHide: true })
    return (result.stdout || '').split(/\r?\n/).map((line) => line.trim()).find((line) => line && fs.existsSync(line)) || null
  }
  return null
}

function probeAudioDuration(ffmpegPath, filePath) {
  const executable = findFFprobe(ffmpegPath)
  if (!executable) return null
  const result = spawnSync(executable, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath], {
    encoding: 'utf8', timeout: 15_000, windowsHide: true,
  })
  if (result.status !== 0) return null
  const duration = Number.parseFloat((result.stdout || '').trim())
  return Number.isFinite(duration) && duration > 0 ? duration : null
}

function probeAudioDiagnostics(ffmpegPath, filePath, fallbackDuration = null) {
  const diagnostics = { durationSeconds: Number.isFinite(fallbackDuration) ? fallbackDuration : null, codec: null, bitrate: null, sampleRate: null, channels: null }
  const executable = findFFprobe(ffmpegPath)
  if (!executable) return diagnostics
  const result = spawnSync(executable, [
    '-v', 'error', '-select_streams', 'a:0', '-show_entries',
    'stream=codec_name,sample_rate,channels,bit_rate:format=duration,bit_rate', '-of', 'json', filePath,
  ], { encoding: 'utf8', timeout: 15_000, windowsHide: true })
  if (result.status !== 0) return diagnostics
  try {
    const details = JSON.parse(result.stdout || '{}')
    const stream = details.streams?.[0] || {}
    const format = details.format || {}
    const duration = Number.parseFloat(format.duration)
    const bitrate = Number.parseInt(stream.bit_rate || format.bit_rate, 10)
    const sampleRate = Number.parseInt(stream.sample_rate, 10)
    diagnostics.durationSeconds = Number.isFinite(duration) && duration > 0 ? duration : diagnostics.durationSeconds
    diagnostics.codec = typeof stream.codec_name === 'string' ? stream.codec_name : null
    diagnostics.bitrate = Number.isFinite(bitrate) ? bitrate : null
    diagnostics.sampleRate = Number.isFinite(sampleRate) ? sampleRate : null
    diagnostics.channels = Number.isFinite(stream.channels) ? stream.channels : null
  } catch { /* diagnostics must never interrupt transcription */ }
  return diagnostics
}

function runNativeAudioDialog(kind) {
  if (process.platform !== 'win32') throw Object.assign(new Error('本地音频选择仅支持 Windows。'), { statusCode: 501, code: 'unsupported_platform' })
  const script = kind === 'folder'
    ? `$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); Add-Type -AssemblyName System.Windows.Forms; $dialog = New-Object System.Windows.Forms.FolderBrowserDialog; $dialog.Description = '选择包含音频文件的文件夹'; $dialog.ShowNewFolderButton = $false; if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { ConvertTo-Json -Compress -InputObject @{ paths = @($dialog.SelectedPath) } } else { ConvertTo-Json -Compress -InputObject @{ paths = @() } }`
    : `$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); Add-Type -AssemblyName System.Windows.Forms; $dialog = New-Object System.Windows.Forms.OpenFileDialog; $dialog.Title = '选择本地音频'; $dialog.Multiselect = $true; $dialog.CheckFileExists = $true; $dialog.Filter = '支持的音频文件|*.mp3;*.m4a;*.wav;*.flac;*.ogg'; if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { ConvertTo-Json -Compress -InputObject @{ paths = @($dialog.FileNames) } } else { ConvertTo-Json -Compress -InputObject @{ paths = @() } }`
  const encodedScript = Buffer.from(script, 'utf16le').toString('base64')
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-STA', '-NonInteractive', '-EncodedCommand', encodedScript], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
    })
    let output = ''
    let outputExceeded = false
    child.stdout.on('data', (chunk) => {
      output += String(chunk)
      if (output.length > 1024 * 1024) outputExceeded = true
    })
    child.once('error', () => reject(Object.assign(new Error('无法打开 Windows 文件选择器。'), { code: 'audio_picker_unavailable' })))
    child.once('close', (code) => {
      if (code !== 0 || outputExceeded) return reject(Object.assign(new Error('文件选择器未能完成。'), { code: 'audio_picker_failed' }))
      try {
        const selected = JSON.parse(output.replace(/^\uFEFF/, '').trim() || '{}')
        resolve(Array.isArray(selected?.paths) ? selected.paths.filter((item) => typeof item === 'string') : [])
      } catch {
        reject(Object.assign(new Error('文件选择器返回的信息无效。'), { code: 'audio_picker_invalid_response' }))
      }
    })
  })
}

function pruneLocalAudioSelections() {
  const cutoff = Date.now() - localAudioSelectionTtlMs
  for (const [id, item] of localAudioSelections) if (item.createdAt < cutoff) localAudioSelections.delete(id)
  while (localAudioSelections.size > 10000) localAudioSelections.delete(localAudioSelections.keys().next().value)
}

function makeLocalAudioSelection(filePath, groupName = '', ffmpegPath = null) {
  const extension = path.extname(filePath).toLowerCase()
  if (!localAudioExtensions.has(extension)) return null
  const stats = fs.statSync(filePath)
  if (!stats.isFile()) return null
  const id = randomUUID()
  const item = {
    id, path: path.resolve(filePath), originalName: path.basename(filePath), extension,
    size: stats.size, mtimeMs: stats.mtimeMs, duration: ffmpegPath ? probeAudioDuration(ffmpegPath, filePath) : null,
    groupName, createdAt: Date.now(),
  }
  localAudioSelections.set(id, item)
  return { id, originalName: item.originalName, extension, size: item.size, duration: item.duration, groupName }
}

async function selectLocalAudio(response, kind) {
  pruneLocalAudioSelections()
  const selectedPaths = await runNativeAudioDialog(kind)
  if (!selectedPaths.length) {
    sendJson(response, 200, { files: [], ignoredCount: 0, cancelled: true })
    return
  }
  let ignoredCount = 0
  let files = []
  const ffmpegPath = findFFmpeg()
  if (kind === 'folder') {
    const folderPath = path.resolve(selectedPaths[0])
    let entries
    try { entries = fs.readdirSync(folderPath, { withFileTypes: true }) } catch {
      throw Object.assign(new Error('无法读取所选文件夹。'), { statusCode: 400, code: 'selected_folder_unreadable' })
    }
    const groupName = path.basename(folderPath)
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const filePath = path.join(folderPath, entry.name)
      if (!localAudioExtensions.has(path.extname(entry.name).toLowerCase())) { ignoredCount += 1; continue }
      try {
        const item = makeLocalAudioSelection(filePath, groupName, ffmpegPath)
        if (item) files.push(item)
      } catch { ignoredCount += 1 }
    }
  } else {
    for (const filePath of selectedPaths) {
      try {
        const item = makeLocalAudioSelection(filePath, '', ffmpegPath)
        if (item) files.push(item)
        else ignoredCount += 1
      } catch { ignoredCount += 1 }
    }
  }
  if (files.length > 3000) {
    for (const file of files) localAudioSelections.delete(file.id)
    throw Object.assign(new Error('一次最多导入 3000 个音频文件。'), { statusCode: 400, code: 'too_many_local_audio_files' })
  }
  log('info', 'Local audio files selected', { count: files.length, ignoredCount, source: kind })
  sendJson(response, 200, { files, ignoredCount, cancelled: false })
}

function transcriptSegmentFilename(segment) {
  if (!/^\d{3}[ab]{0,14}$/.test(segment.id)) throw transcriptFailure('invalid_segment_id', '转写分段编号无效。')
  return `segment-${segment.id}.m4a`
}

async function splitTranscriptSegment(task, ffmpegPath, workDirectory, segment, reasonCode = 'mimo_output_truncated') {
  const segmentDirectory = path.join(workDirectory, 'audio-segments')
  const inputPath = path.join(segmentDirectory, transcriptSegmentFilename(segment))
  const isContentFilterSplit = reasonCode === 'mimo_content_filtered'
  const contentFilterSplitDepth = segment.contentFilterSplitDepth || 0
  const depthForPlan = isContentFilterSplit ? contentFilterSplitDepth : segment.splitDepth || 0
  const splitPlan = planAdaptiveTranscriptSplit(
    { ...segment, splitDepth: depthForPlan },
    isContentFilterSplit ? transcriptMinimumContentFilterSegmentSeconds : transcriptMinimumAdaptiveSegmentSeconds,
    isContentFilterSplit ? transcriptMaxContentFilterSplitDepth : transcriptMaxSplitDepth,
  )
  if (!splitPlan.canSplit) {
    if (isContentFilterSplit) {
      const error = transcriptFailure(
        'mimo_content_filter_split_limit',
        `MiMo 安全过滤多次阻止转写，失败时间范围：${formatTranscriptTimeRange(segment)}。已达到自动细分限制，请检查该段音频。`,
      )
      error.adaptiveSplitReason = splitPlan.reason
      throw error
    }
    if (reasonCode === 'mimo_repetition_truncation') {
      throw transcriptFailure('mimo_repetition_truncation_terminal', '该段音频质量较差，MiMo 多次检测到重复生成。已缩小片段仍无法稳定转写，请检查源音频。')
    }
    throw transcriptFailure('mimo_output_truncated_terminal', 'MiMo 输出长度不足，音频已缩小到可安全转写的最小片段，请检查源音频。')
  }
  const splitPattern = path.join(segmentDirectory, `segment-${segment.id}-split-%01d.m4a`)
  await runTranscriptProcess(task, ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-y', '-i', inputPath, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'aac', '-b:a', transcriptBitrate,
    '-f', 'segment', '-segment_format', 'mp4', '-segment_time', splitPlan.childDurationSeconds.toFixed(3), '-segment_start_number', '1', '-reset_timestamps', '1', splitPattern,
  ], reasonCode === 'mimo_repetition_truncation'
    ? '检测到重复生成，正在缩小音频片段…'
    : reasonCode === 'mimo_content_filtered' ? 'MiMo 安全过滤，正在拆分音频片段…' : '音频处理中')
  const staged = (await fs.promises.readdir(segmentDirectory))
    .filter((name) => name.startsWith(`segment-${segment.id}-split-`) && name.endsWith('.m4a'))
    .sort((left, right) => left.localeCompare(right, 'en'))
  if (staged.length !== 2) {
    for (const name of staged) await fs.promises.rm(path.join(segmentDirectory, name), { force: true })
    throw transcriptFailure('transcript_segment_split_failed', '无法将被截断的音频片段安全拆分。')
  }
  const children = []
  let childStartSeconds = Number.isFinite(segment.startSeconds) ? segment.startSeconds : 0
  const parentEndSeconds = Number.isFinite(segment.endSeconds) ? segment.endSeconds : null
  const nextSegmentDepth = (segment.splitDepth || 0) + 1
  const nextContentFilterDepth = isContentFilterSplit ? splitPlan.nextDepth : contentFilterSplitDepth
  for (let index = 0; index < staged.length; index += 1) {
    const id = `${segment.id}${index === 0 ? 'a' : 'b'}`
    const audioFile = `segment-${id}.m4a`
    const stagedPath = path.join(segmentDirectory, staged[index])
    const finalPath = path.join(segmentDirectory, audioFile)
    await fs.promises.rename(stagedPath, finalPath)
    const stats = await fs.promises.stat(finalPath)
    if (Math.ceil(stats.size / 3) * 4 > transcriptMaxBase64Bytes) throw transcriptFailure('audio_segment_too_large', '细分后的音频仍超过 MiMo Base64 安全大小。')
    const measuredDurationSeconds = probeAudioDuration(ffmpegPath, finalPath) || splitPlan.childDurationSeconds
    const childEndSeconds = index === staged.length - 1 && parentEndSeconds !== null
      ? parentEndSeconds
      : childStartSeconds + measuredDurationSeconds
    const childDurationSeconds = Math.max(0, childEndSeconds - childStartSeconds)
    children.push({
      id, audioFile, startSeconds: childStartSeconds, endSeconds: childEndSeconds,
      durationSeconds: childDurationSeconds, splitDepth: nextSegmentDepth,
      contentFilterSplitDepth: nextContentFilterDepth, sizeBytes: stats.size,
    })
    childStartSeconds = childEndSeconds
  }
  return children
}

function buildTranscriptPrompt(task, basePrompt) {
  const clean = (value) => String(value || '').replace(/[\r\n\t]+/g, ' ').trim()
  const title = clean(task.title)
  const collectionName = clean(task.groupName)
  if (task.source?.type === 'local') {
    const lines = ['课程上下文：']
    if (title && title !== task.source.originalName) lines.push(`标题：${title}`)
    if (collectionName) lines.push(`课程/批次：${collectionName}`)
    if (lines.length === 1) return basePrompt
    lines.push('', '说明：', '这些信息仅用于辅助判断书名、人名、术语和课程主题。', '必须以实际音频内容为准。', '不得根据标题或课程名称补充音频中没有出现的内容。')
    return `${lines.join('\n')}\n\n${basePrompt}`
  }
  const owner = clean(task.creatorName || task.owner)
  const lines = ['课程上下文：']
  if (title && title !== task.bvid) lines.push(`标题：${title}`)
  if (collectionName && collectionName !== '其他视频') lines.push(`合集：${collectionName}`)
  if (owner && owner !== '未知 UP 主' && !/^UP 主（UID：\d+）$/.test(owner)) lines.push(`UP主：${owner}`)
  if (lines.length === 1) return basePrompt
  lines.push('', '说明：', '这些信息仅用于辅助判断书名、人名、术语和课程主题。', '必须以实际音频内容为准。', '不得根据标题、合集名或 UP 主信息补充音频中没有出现的内容。')
  return `${lines.join('\n')}\n\n${basePrompt}`
}

async function runTranscriptTask(task) {
  let startedAt
  const ownedWorkDirectory = path.join(transcriptWorkDirectory, task.id)
  const sourceDownloadDirectory = path.join(ownedWorkDirectory, 'source-audio')
  const segmentDirectory = path.join(ownedWorkDirectory, 'audio-segments')
  let sourceAudio = null
  let sourceFingerprint = null
  let checkpoint = null
  let segments = []
  task.status = 'running'
  startedAt = beginTaskExecution(task)
  task.phase = '准备音频'
  task.error = ''
  task.completedAt = null
  task.attempt = (task.attempt || 0) + 1
  task.outputPath = ''
  task.fileSize = 0
  saveLocalState()
  log('info', 'Transcript task started', { taskId: task.id, bvid: task.bvid, mode: task.mode })
  startTranscriptWakeLock(task)
  try {
    if (task.source?.type === 'local') {
      const sourcePath = path.resolve(String(task.source.path || ''))
      let sourceStats
      try { sourceStats = await fs.promises.stat(sourcePath) } catch {
        throw transcriptFailure('local_audio_missing', '源音频文件不存在或已被移动。')
      }
      if (!sourceStats.isFile() || !localAudioExtensions.has(path.extname(sourcePath).toLowerCase())) {
        throw transcriptFailure('local_audio_missing', '源音频文件不存在或已被移动。')
      }
      sourceAudio = sourcePath
      task.source.path = sourcePath
      task.source.size = sourceStats.size
      task.source.mtimeMs = sourceStats.mtimeMs
      sourceFingerprint = { path: sourcePath, size: sourceStats.size, mtimeMs: sourceStats.mtimeMs }
      saveLocalState()
      log('info', 'Local transcript source verified', { taskId: task.id, size: sourceStats.size })
    }
    if (!mimoApiKey) throw transcriptFailure('mimo_key_missing', '请先在设置中配置 MiMo API Key。')
    const ffmpegPath = findFFmpeg()
    if (!ffmpegPath) throw transcriptFailure('ffmpeg_unavailable', '未找到 FFmpeg，请安装后重试转写。')
    await ensureWritableDirectory(transcriptDirectory)
    await fs.promises.mkdir(ownedWorkDirectory, { recursive: true })
    await fs.promises.mkdir(sourceDownloadDirectory, { recursive: true })
    if (task.source?.type !== 'local') {
      sourceAudio = matchingCompletedAudio(task)
      if (sourceAudio) {
        log('info', 'Transcript audio reused', { taskId: task.id, bvid: task.bvid, source: 'completed-audio-download' })
      } else {
        if (!fs.existsSync(executablePath)) throw transcriptFailure('bbdown_unavailable', '未找到 BBDownNext，无法获取转写音频。')
        const previousAudioFiles = await listMediaFiles(sourceDownloadDirectory, 'audio')
        if (previousAudioFiles.length) {
          sourceAudio = previousAudioFiles[0].path
          log('info', 'Transcript temporary audio reused', { taskId: task.id, bvid: task.bvid, fileSize: previousAudioFiles[0].size })
        } else {
          const args = [task.url, '--get', 'a', '--work-dir', sourceDownloadDirectory, '--file-pattern', '<videoTitle>', '--stop-on-error', '--mux', 'None']
          log('info', 'Transcript audio download started', { taskId: task.id, bvid: task.bvid })
          await runTranscriptProcess(task, executablePath, args, '准备音频')
          const audioFiles = await listMediaFiles(sourceDownloadDirectory, 'audio')
          if (!audioFiles.length) throw transcriptFailure('transcript_audio_missing', 'BBDownNext 已结束，但没有找到音频文件。')
          sourceAudio = audioFiles[0].path
          log('info', 'Transcript audio downloaded temporarily', { taskId: task.id, bvid: task.bvid, fileSize: audioFiles[0].size })
        }
      }
    }
    if (task.cancelRequested) throw transcriptFailure('transcript_cancelled', '任务已取消。')

    const basePrompt = await fs.promises.readFile(transcriptPromptFile, 'utf8')
    const prompt = buildTranscriptPrompt(task, basePrompt)
    const sourceAudioHash = await hashFile(sourceAudio)
    const promptHash = createHash('sha256').update(prompt).digest('hex')
    const existingCheckpoint = readTranscriptCheckpoint(ownedWorkDirectory, task.id)
    const checkpointMatches = existingCheckpoint
      && existingCheckpoint.processingVersion === transcriptProcessingVersion
      && existingCheckpoint.bvid === task.bvid
      && existingCheckpoint.sourceAudioHash === sourceAudioHash
      && JSON.stringify(existingCheckpoint.sourceFingerprint || null) === JSON.stringify(sourceFingerprint)
      && existingCheckpoint.promptHash === promptHash
    if (checkpointMatches) {
      checkpoint = existingCheckpoint
      const missingSegment = checkpoint.segments.find((segment) => !fs.existsSync(path.join(segmentDirectory, transcriptSegmentFilename(segment))))
      if (missingSegment) throw transcriptFailure('checkpoint_audio_missing', '检查点中的临时音频片段缺失；为避免误用旧结果，任务已暂停。')
      log('info', 'Transcript checkpoint restored', { taskId: task.id, bvid: task.bvid, completedSegments: checkpoint.completedSegments.length, segmentCount: checkpoint.segments.length })
    } else {
      if (existingCheckpoint) {
        log('info', 'Transcript checkpoint invalidated', {
          taskId: task.id, bvid: task.bvid,
          reason: existingCheckpoint.processingVersion !== transcriptProcessingVersion ? 'audio_processing_changed'
            : JSON.stringify(existingCheckpoint.sourceFingerprint || null) !== JSON.stringify(sourceFingerprint) ? 'source_file_changed'
            : existingCheckpoint.sourceAudioHash !== sourceAudioHash ? 'source_audio_changed' : 'prompt_changed',
        })
      }
      await clearTranscriptCheckpoint(ownedWorkDirectory)
      await fs.promises.mkdir(segmentDirectory, { recursive: true })
      const sourceDurationSeconds = probeAudioDuration(ffmpegPath, sourceAudio)
      await runTranscriptProcess(task, ffmpegPath, [
        '-hide_banner', '-loglevel', 'error', '-y', '-i', sourceAudio, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'aac', '-b:a', transcriptBitrate,
        '-movflags', '+faststart', path.join(segmentDirectory, 'prepared-audio.m4a'),
      ], '音频处理中')
      const preparedAudioPath = path.join(segmentDirectory, 'prepared-audio.m4a')
      const preparedStats = await fs.promises.stat(preparedAudioPath).catch(() => null)
      if (!preparedStats?.isFile()) throw transcriptFailure('transcript_audio_conversion_failed', 'FFmpeg 没有生成可转写的音频。')
      const preparedBase64Size = Math.ceil(preparedStats.size / 3) * 4
      const durationSeconds = sourceDurationSeconds || probeAudioDuration(ffmpegPath, preparedAudioPath) || 0
      log('info', 'Transcript audio encoded', {
        taskId: task.id, bvid: task.bvid, sourceDurationSeconds: durationSeconds || null,
        fileSize: preparedStats.size, base64Size: preparedBase64Size, sampleRate: 16000, channels: 1, bitrate: transcriptBitrate,
      })
      segments = []
      if (preparedBase64Size <= transcriptMaxBase64Bytes) {
        const audioFile = 'segment-001.m4a'
        await fs.promises.rename(preparedAudioPath, path.join(segmentDirectory, audioFile))
        segments.push({ id: '001', audioFile, durationSeconds, splitDepth: 0, sizeBytes: preparedStats.size })
      } else {
        let partCount = Math.max(2, Math.ceil(preparedBase64Size / transcriptSegmentSafetyBase64Bytes))
        let finalNames = []
        while (partCount <= 256) {
          for (const name of await fs.promises.readdir(segmentDirectory)) {
            if (/^segment-\d{3}\.m4a$/i.test(name)) await fs.promises.rm(path.join(segmentDirectory, name), { force: true })
          }
          const segmentDuration = Math.ceil((durationSeconds || partCount * 600) / partCount)
          const outputPattern = path.join(segmentDirectory, 'segment-%03d.m4a')
          await runTranscriptProcess(task, ffmpegPath, [
            '-hide_banner', '-loglevel', 'error', '-y', '-i', preparedAudioPath, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'aac', '-b:a', transcriptBitrate,
            '-f', 'segment', '-segment_format', 'mp4', '-segment_time', String(segmentDuration), '-segment_start_number', '1', '-reset_timestamps', '1', outputPattern,
          ], '音频处理中')
          finalNames = (await fs.promises.readdir(segmentDirectory))
            .filter((name) => /^segment-\d{3}\.m4a$/i.test(name))
            .sort((left, right) => left.localeCompare(right, 'en'))
          const sizes = await Promise.all(finalNames.map((name) => fs.promises.stat(path.join(segmentDirectory, name))))
          if (finalNames.length >= partCount && sizes.every((stats) => Math.ceil(stats.size / 3) * 4 <= transcriptMaxBase64Bytes)) break
          partCount = Math.max(partCount + 1, Math.ceil(partCount * 1.25))
        }
        if (!finalNames.length || finalNames.some((name) => Math.ceil(fs.statSync(path.join(segmentDirectory, name)).size / 3) * 4 > transcriptMaxBase64Bytes)) {
          throw transcriptFailure('audio_segment_too_large', '音频无法安全切分到 MiMo Base64 限制以内。')
        }
        let timelineStartSeconds = 0
        for (let index = 0; index < finalNames.length; index += 1) {
          const audioFile = finalNames[index]
          const stats = await fs.promises.stat(path.join(segmentDirectory, audioFile))
          const base64Size = Math.ceil(stats.size / 3) * 4
          const segmentDuration = probeAudioDuration(ffmpegPath, path.join(segmentDirectory, audioFile)) || durationSeconds / finalNames.length
          segments.push({
            id: String(index + 1).padStart(3, '0'), audioFile,
            startSeconds: timelineStartSeconds, endSeconds: timelineStartSeconds + segmentDuration,
            durationSeconds: segmentDuration, splitDepth: 0, sizeBytes: stats.size,
          })
          timelineStartSeconds += segmentDuration
          log('info', 'Transcript audio segment prepared', {
            taskId: task.id, bvid: task.bvid, segment: index + 1, segmentCount: finalNames.length,
            durationSeconds: Math.round(segmentDuration * 100) / 100, fileSize: stats.size, base64Size,
          })
        }
      }
      checkpoint = {
        processingVersion: transcriptProcessingVersion, taskId: task.id, bvid: task.bvid, sourceAudioHash, sourceFingerprint, promptHash,
        segmentCount: segments.length, segments, completedSegments: [], currentSegment: null,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      }
      saveTranscriptCheckpoint(ownedWorkDirectory, checkpoint)
      log('info', 'Transcript audio prepared', {
        taskId: task.id, bvid: task.bvid, sourceDurationSeconds: durationSeconds ? Math.round(durationSeconds) : null,
        segmentCount: segments.length, sampleRate: 16000, channels: 1, bitrate: transcriptBitrate, base64Size: preparedBase64Size,
      })
    }

    segments = [...checkpoint.segments]
    ensureTranscriptSegmentTimeRanges(segments)
    const completed = new Set(checkpoint.completedSegments.filter((id) => segments.some((segment) => segment.id === id)))
    for (const segment of segments) {
      if (fs.existsSync(path.join(ownedWorkDirectory, `segment-${segment.id}.txt`))) completed.add(segment.id)
    }
    checkpoint.completedSegments = segments.filter((segment) => completed.has(segment.id)).map((segment) => segment.id)
    checkpoint.segmentCount = segments.length
    const firstPending = segments.findIndex((segment) => !completed.has(segment.id))
    checkpoint.currentSegment = firstPending < 0 ? null : segments[firstPending].id
    saveTranscriptCheckpoint(ownedWorkDirectory, checkpoint)
    task.transcriptProgress = { completedSegments: completed.size, segmentCount: segments.length, currentSegment: checkpoint.currentSegment }
    if (firstPending >= 0 && completed.size > 0) {
      setTranscriptPhase(task, `已恢复进度，继续转写 ${firstPending + 1} / ${segments.length}`)
    } else if (firstPending >= 0) {
      setTranscriptPhase(task, `转写 ${firstPending + 1} / ${segments.length}`)
    }

    let cursor = 0
    while (cursor < segments.length) {
      if (task.cancelRequested) throw transcriptFailure('transcript_cancelled', '任务已取消。')
      const segment = segments[cursor]
      if (completed.has(segment.id)) { cursor += 1; continue }
      checkpoint.currentSegment = segment.id
      checkpoint.segmentCount = segments.length
      task.transcriptProgress = { completedSegments: completed.size, segmentCount: segments.length, currentSegment: segment.id }
      const resumedSegment = completed.size > 0 && cursor === firstPending
      setTranscriptPhase(task, resumedSegment ? `已恢复进度，继续转写 ${cursor + 1} / ${segments.length}` : `转写 ${cursor + 1} / ${segments.length}`)
      saveTranscriptCheckpoint(ownedWorkDirectory, checkpoint)
      log('info', 'MiMo transcript segment started', { taskId: task.id, bvid: task.bvid, segment: cursor + 1, segmentId: segment.id, segmentCount: segments.length })
      const segmentStartedAt = Date.now()
      try {
        const audioPath = path.join(segmentDirectory, transcriptSegmentFilename(segment))
        const text = await callMiMoForSegment(task, prompt, audioPath, cursor + 1, segments.length, segment, ffmpegPath)
        writeTranscriptSegmentText(ownedWorkDirectory, segment.id, text)
        completed.add(segment.id)
        checkpoint.completedSegments = segments.filter((item) => completed.has(item.id)).map((item) => item.id)
        checkpoint.currentSegment = segments[cursor + 1]?.id || null
        task.transcriptProgress = { completedSegments: completed.size, segmentCount: segments.length, currentSegment: checkpoint.currentSegment }
        saveTranscriptCheckpoint(ownedWorkDirectory, checkpoint)
        saveLocalState()
        log('info', 'MiMo transcript segment completed', {
          taskId: task.id, bvid: task.bvid, segment: cursor + 1, segmentId: segment.id,
          model: 'mimo-v2.6-flash', durationMs: Date.now() - segmentStartedAt, textLength: text.length,
        })
        cursor += 1
      } catch (error) {
        if (!isAdaptiveTranscriptError(error.code)) throw error
        const reasonCode = error.code
        const failureReason = {
          mimo_content_filtered: 'content_filter',
          mimo_repetition_truncation: 'repetition_truncation',
          mimo_output_truncated: 'length',
        }[reasonCode]
        if (failureReason) {
          log('warn', 'transcript_failure_reason', {
            taskId: task.id, reason: failureReason,
            segmentStart: segment.startSeconds ?? null,
            segmentEnd: segment.endSeconds ?? null,
            duration: segment.durationSeconds ?? null,
          })
        }
        if (reasonCode === 'mimo_repetition_truncation') setTranscriptPhase(task, '检测到重复生成，正在缩小音频片段…')
        if (reasonCode === 'mimo_content_filtered') {
          setTranscriptPhase(task, 'MiMo 安全过滤，正在拆分音频片段…')
          log('info', 'content_filter_split_start', {
            taskId: task.id, segmentId: segment.id,
            timeRange: formatTranscriptTimeRange(segment),
            splitDepth: segment.contentFilterSplitDepth || 0,
            finishReason: error.finishReason || 'content_filter',
          })
        }
        let children
        try {
          children = await splitTranscriptSegment(task, ffmpegPath, ownedWorkDirectory, segment, reasonCode)
        } catch (splitError) {
          if (reasonCode === 'mimo_repetition_truncation') {
            log('warn', 'MiMo repetition truncation reached adaptive split limit', {
              taskId: task.id, segmentDurationSeconds: segment.durationSeconds,
              splitDepth: segment.splitDepth || 0,
              generatedCharacterCount: error.generatedCharacterCount || 0,
              finishReason: error.finishReason || 'repetition_truncation',
              childSegmentDurationsSeconds: [],
            })
          }
          if (reasonCode === 'mimo_content_filtered') {
            log('warn', 'content_filter_split_failed', {
              taskId: task.id, segmentId: segment.id,
              timeRange: formatTranscriptTimeRange(segment),
              splitDepth: segment.contentFilterSplitDepth || 0,
              finishReason: error.finishReason || 'content_filter',
              failureReason: splitError.adaptiveSplitReason || splitError.code || 'split_failed',
            })
          }
          throw splitError
        }
        replaceAdaptiveTranscriptSegment(segments, cursor, children, checkpoint, completed)
        task.transcriptProgress = { completedSegments: completed.size, segmentCount: segments.length, currentSegment: children[0].id }
        saveTranscriptCheckpoint(ownedWorkDirectory, checkpoint)
        await fs.promises.rm(path.join(segmentDirectory, transcriptSegmentFilename(segment)), { force: true })
        if (reasonCode === 'mimo_content_filtered') {
          log('info', 'content_filter_split_success', {
            taskId: task.id, segmentId: segment.id,
            timeRange: formatTranscriptTimeRange(segment),
            splitDepth: segment.contentFilterSplitDepth || 0,
            childSegments: children.map((child) => ({
              segmentId: child.id,
              timeRange: formatTranscriptTimeRange(child),
            })),
          })
        }
        const splitEvent = reasonCode === 'mimo_repetition_truncation' ? 'MiMo repetition truncation split for retry'
          : reasonCode === 'mimo_content_filtered' ? 'MiMo content-filter segment split for retry'
            : 'Truncated transcript segment split for retry'
        log('warn', splitEvent, {
          taskId: task.id, bvid: task.bvid, segmentId: segment.id, segmentCount: segments.length,
          ...(reasonCode === 'mimo_repetition_truncation' ? {
            segmentDurationSeconds: segment.durationSeconds,
            splitDepth: segment.splitDepth || 0,
            generatedCharacterCount: error.generatedCharacterCount || 0,
            finishReason: error.finishReason || 'repetition_truncation',
            childSegmentDurationsSeconds: children.map((item) => item.durationSeconds),
          } : {}),
          childSegments: children.map((item) => item.id),
        })
      }
    }
    if (task.cancelRequested) throw transcriptFailure('transcript_cancelled', '任务已取消。')
    let text
    if (segments.length === 1) {
      text = cleanTranscriptText(await fs.promises.readFile(path.join(ownedWorkDirectory, `segment-${segments[0].id}.txt`), 'utf8'))
    } else {
      setTranscriptPhase(task, '整理结果')
      const results = []
      for (const segment of segments) {
        results.push(await fs.promises.readFile(path.join(ownedWorkDirectory, `segment-${segment.id}.txt`), 'utf8'))
      }
      text = mergeTranscriptSegments(results)
    }
    if (!text) throw transcriptFailure('transcript_empty', '转写结果为空，未保存文字稿。')
    setTranscriptPhase(task, '保存文字稿')
    const outputDirectory = transcriptOutputDirectory(task)
    await ensureWritableDirectory(outputDirectory)
    const fileName = `${safeDirectoryName(task.title, 120)}.txt`
    const outputPath = path.join(outputDirectory, fileName)
    await fs.promises.writeFile(outputPath, `${text}\n`, 'utf8')
    const completedAt = new Date().toISOString()
    const entry = {
      id: task.id, title: task.title, creator: task.source?.type === 'local' ? '本地音频' : task.creatorName || task.owner || '未知 UP 主',
      sourceType: task.source?.type === 'local' ? 'local' : 'bilibili', originalName: task.source?.originalName || '', bvid: task.bvid,
      completedAt, textPath: outputPath, text, wordCount: Array.from(text.replace(/\s/gu, '')).length,
    }
    const library = readTranscriptLibrary().filter((item) => item.id !== task.id)
    library.push(entry)
    writeTranscriptLibrary(library)
    task.transcriptId = entry.id
    task.status = 'completed'
    task.phase = '已完成'
    task.outputPath = outputPath
    task.fileSize = Buffer.byteLength(text, 'utf8')
    task.completedAt = completedAt
    log('info', 'Transcript task completed', { taskId: task.id, bvid: task.bvid, outputPath, segmentCount: segments.length, wordCount: entry.wordCount, durationMs: Date.now() - startedAt })
    const resolvedWorkRoot = path.resolve(transcriptWorkDirectory)
    const resolvedWorkDirectory = path.resolve(ownedWorkDirectory)
    if (resolvedWorkDirectory.startsWith(`${resolvedWorkRoot}${path.sep}`)) {
      await fs.promises.rm(ownedWorkDirectory, { recursive: true, force: true })
    }
  } catch (error) {
    if (task.cancelRequested || error.code === 'transcript_cancelled') {
      task.status = 'cancelled'
      task.phase = '已取消'
      task.error = '转写任务已取消。'
      task.completedAt = new Date().toISOString()
      log('info', 'Transcript task cancelled', { taskId: task.id, bvid: task.bvid, durationMs: Date.now() - startedAt })
    } else {
      task.status = 'failed'
      task.phase = '转写失败'
      task.error = error.message || '转写失败，请稍后重试。'
      task.completedAt = new Date().toISOString()
      log('error', 'Transcript task failed', { taskId: task.id, bvid: task.bvid, code: error.code || 'transcript_error', reason: task.error, durationMs: Date.now() - startedAt })
    }
  } finally {
    endTaskExecution(task, startedAt)
    stopTranscriptWakeLock()
    activeTaskAbortController = null
    task.cancelRequested = false
    if (activeDownloadChild && activeDownloadChild.exitCode !== null) {
      childProcesses.delete(activeDownloadChild)
      activeDownloadChild = null
    }
    saveLocalState()
  }
}

async function pumpDownloadQueue() {
  if (queuePumpActive || shuttingDown) return
  queuePumpActive = true
  try {
    while (!shuttingDown) {
      const next = getDownloadTasks().find((task) => task.status === 'waiting')
      if (!next) break
      activeDownloadTaskId = next.id
      await (next.mode === 'transcript' ? runTranscriptTask(next) : runDownloadTask(next))
      activeDownloadTaskId = null
    }
  } finally {
    queuePumpActive = false
    activeDownloadTaskId = null
    const waiting = getDownloadTasks().some((task) => task.status === 'waiting')
    if (waiting && !shuttingDown) setImmediate(pumpDownloadQueue)
  }
}

async function createDownloadTask(request, response) {
  const body = await readJsonBody(request)
  if (!['video', 'audio', 'transcript'].includes(body.mode)) {
    sendError(response, 400, 'invalid_download_mode', '请选择有效的任务类型。')
    return
  }
  const { bvid, canonicalUrl } = normalizeVideoUrl(body.url)
  const task = {
    id: randomUUID(), bvid, url: canonicalUrl,
    source: { type: 'bilibili' },
    title: String(body.title || bvid).slice(0, 300),
    owner: String(body.owner || '未知 UP 主').slice(0, 120),
    creatorName: '', groupName: String(body.groupName || '').slice(0, 120),
    mode: body.mode, status: 'waiting', phase: '等待中', progress: null,
    outputPath: '', outputDirectory: '', outputFiles: [], fileSize: 0,
    error: '', createdAt: new Date().toISOString(), completedAt: null,
    startedAt: null, endedAt: null, durationMs: null, attempt: 0,
  }
  downloadTasks.set(task.id, task)
  saveLocalState()
  log('info', task.mode === 'transcript' ? 'Transcript task created' : 'Download task created', { taskId: task.id, bvid, mode: task.mode })
  sendJson(response, 201, { task: publicTask(task) })
  void pumpDownloadQueue()
}

async function createBatchDownloadTasks(request, response) {
  const body = await readJsonBody(request, 2 * 1024 * 1024)
  if (!['video', 'audio', 'transcript'].includes(body.mode)) {
    sendError(response, 400, 'invalid_download_mode', '请选择有效的批量任务类型。')
    return
  }
  if (!Array.isArray(body.videos) || !body.videos.length || body.videos.length > 3000) {
    sendError(response, 400, 'invalid_batch', '请选择 1 到 3000 个视频后再创建任务。')
    return
  }
  const normalized = body.videos.map((video) => {
    if (!video || typeof video !== 'object') throw Object.assign(new Error('批量视频信息无效。'), { statusCode: 400, code: 'invalid_batch_video' })
    const input = typeof video.url === 'string' && video.url ? video.url : `https://www.bilibili.com/video/${String(video.bvid || '')}/`
    const result = normalizeVideoUrl(input)
    return {
      bvid: result.bvid, url: result.canonicalUrl,
      title: String(video.title || result.bvid).slice(0, 300),
      owner: String(video.owner || '未知 UP 主').slice(0, 120),
      creatorName: String(video.creatorName || '').slice(0, 120),
      groupName: String(video.groupName || '').slice(0, 120),
    }
  })
  const unique = [...new Map(normalized.map((video) => [video.bvid, video])).values()]
  const tasks = unique.map((video) => ({
    id: randomUUID(), ...video, source: { type: 'bilibili' }, mode: body.mode, status: 'waiting', phase: '等待中', progress: null,
    outputPath: '', outputDirectory: '', outputFiles: [], fileSize: 0, error: '',
    createdAt: new Date().toISOString(), completedAt: null,
    startedAt: null, endedAt: null, durationMs: null, attempt: 0,
  }))
  for (const task of tasks) downloadTasks.set(task.id, task)
  saveLocalState()
  log('info', body.mode === 'transcript' ? 'Creator batch transcript tasks created' : 'Creator batch download tasks created', { count: tasks.length, mode: body.mode })
  sendJson(response, 201, { tasks: tasks.map(({ id, bvid, title, owner, mode, status, createdAt }) => ({ id, bvid, title, owner, mode, status, createdAt })) })
  void pumpDownloadQueue()
}

async function createLocalAudioTasks(request, response) {
  pruneLocalAudioSelections()
  const body = await readJsonBody(request, 2 * 1024 * 1024)
  if (!Array.isArray(body.items) || !body.items.length || body.items.length > 3000) {
    sendError(response, 400, 'invalid_local_audio_batch', '请选择 1 到 3000 个音频文件后再创建任务。')
    return
  }
  const normalized = body.items.map((input) => {
    if (!input || typeof input.selectionId !== 'string' || typeof input.title !== 'string') {
      throw Object.assign(new Error('本地音频选择信息无效，请重新导入。'), { statusCode: 400, code: 'invalid_local_audio_selection' })
    }
    const selected = localAudioSelections.get(input.selectionId)
    if (!selected || Date.now() - selected.createdAt > localAudioSelectionTtlMs) {
      throw Object.assign(new Error('音频选择已过期，请重新导入文件。'), { statusCode: 400, code: 'local_audio_selection_expired' })
    }
    return { selected, title: String(input.title.trim() || path.parse(selected.originalName).name).slice(0, 300) }
  })
  const tasks = normalized.map(({ selected, title }) => ({
    id: randomUUID(), bvid: null, url: '', title, owner: '', creatorName: '', groupName: selected.groupName,
    source: {
      type: 'local', path: selected.path, originalName: selected.originalName, size: selected.size,
      duration: selected.duration, mtimeMs: selected.mtimeMs, extension: selected.extension,
    },
    mode: 'transcript', status: 'waiting', phase: '等待中', progress: null,
    outputPath: '', outputDirectory: '', outputFiles: [], fileSize: 0, error: '',
    createdAt: new Date().toISOString(), completedAt: null,
    startedAt: null, endedAt: null, durationMs: null, attempt: 0,
  }))
  for (const input of body.items) localAudioSelections.delete(input.selectionId)
  for (const task of tasks) downloadTasks.set(task.id, task)
  saveLocalState()
  log('info', 'Local audio transcript tasks created', { count: tasks.length })
  sendJson(response, 201, { tasks: tasks.map(publicTask) })
  void pumpDownloadQueue()
}

async function saveDownloadDirectory(request, response) {
  const body = await readJsonBody(request)
  if (typeof body.downloadDirectory !== 'string' || !body.downloadDirectory.trim()) {
    sendError(response, 400, 'invalid_download_directory', '请输入有效的下载目录。')
    return
  }
  const requested = body.downloadDirectory.trim()
  if (!path.isAbsolute(requested)) {
    sendError(response, 400, 'invalid_download_directory', '下载目录必须是本机绝对路径。')
    return
  }
  const resolved = path.resolve(requested)
  try {
    await ensureWritableDirectory(resolved)
  } catch (error) {
    sendError(response, 400, 'download_directory_unwritable', error.message || '下载目录不可写。')
    return
  }
  downloadDirectory = resolved
  saveLocalState()
  log('info', 'Download directory saved', { downloadDirectory })
  sendJson(response, 200, { downloadDirectory })
}

async function saveAppSettings(request, response) {
  const body = await readJsonBody(request)
  if ((typeof body.downloadDirectory === 'string' && body.downloadDirectory.trim() && !path.isAbsolute(body.downloadDirectory.trim()))
    || (typeof body.transcriptDirectory === 'string' && body.transcriptDirectory.trim() && !path.isAbsolute(body.transcriptDirectory.trim()))) {
    sendError(response, 400, 'invalid_settings_path', '保存目录必须是本机绝对路径。')
    return
  }
  const nextDownload = typeof body.downloadDirectory === 'string' && body.downloadDirectory.trim() ? path.resolve(body.downloadDirectory.trim()) : downloadDirectory
  const nextTranscript = typeof body.transcriptDirectory === 'string' && body.transcriptDirectory.trim() ? path.resolve(body.transcriptDirectory.trim()) : transcriptDirectory
  if (!path.isAbsolute(nextDownload) || !path.isAbsolute(nextTranscript)) {
    sendError(response, 400, 'invalid_settings_path', '保存目录必须是本机绝对路径。')
    return
  }
  try {
    await ensureWritableDirectory(nextDownload)
    await ensureWritableDirectory(nextTranscript)
  } catch (error) {
    sendError(response, 400, error.code || 'settings_directory_unwritable', error.message || '保存目录不可写。')
    return
  }
  if (typeof body.apiKey === 'string' && body.apiKey.trim()) {
    try { saveMimoApiKey(body.apiKey.trim()) } catch (error) {
      log('error', 'MiMo API Key could not be saved', { code: error.code || 'mimo_key_save_failed' })
      sendError(response, 500, 'mimo_key_save_failed', 'MiMo API Key 保存失败。')
      return
    }
  }
  if (body.apiKey === null) {
    sendError(response, 400, 'invalid_mimo_api_key', 'MiMo API Key 不能为空。')
    return
  }
  downloadDirectory = nextDownload
  transcriptDirectory = nextTranscript
  saveLocalState()
  log('info', 'Local settings saved', { hasMimoApiKey: !!mimoApiKey, downloadDirectory, transcriptDirectory })
  sendJson(response, 200, { downloadDirectory, transcriptDirectory, mimoApiKeyConfigured: !!mimoApiKey, mimoApiKeyMask: maskMimoApiKey() })
}

async function testMiMoConnection(request, response) {
  const body = await readJsonBody(request)
  const key = typeof body.apiKey === 'string' && body.apiKey.trim() ? body.apiKey.trim() : mimoApiKey
  if (!key) {
    sendError(response, 400, 'mimo_key_missing', '请先填写 MiMo API Key。')
    return
  }
  await withMiMoRequestLock(async () => {
  try {
    const result = await fetch('https://api.xiaomimimo.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': key },
      body: JSON.stringify({
        model: 'mimo-v2.6-flash',
        stream: false,
        thinking: { type: 'disabled' },
        max_completion_tokens: 16,
        messages: [{ role: 'user', content: 'Reply with the single word OK.' }],
      }),
      signal: AbortSignal.timeout(30_000),
    })
    log('info', 'MiMo connection test response', { status: result.status })
    if (!result.ok) {
      const error = transcriptErrorForStatus(result.status)
      sendError(response, result.status === 401 || result.status === 403 ? 401 : result.status === 429 ? 429 : 502, error.code, error.message)
      return
    }
    let payload
    try { payload = await result.json() } catch {
      sendError(response, 502, 'mimo_invalid_response', 'MiMo 返回格式异常。')
      return
    }
    if (String(payload?.model || '').toLowerCase() !== 'mimo-v2.6-flash' || payload?.choices?.[0]?.finish_reason !== 'stop' || !payload?.choices?.[0]?.message?.content?.trim()) {
      sendError(response, 502, 'mimo_invalid_response', 'MiMo 返回结果不完整，请稍后重试。')
      return
    }
    sendJson(response, 200, { success: true, message: '连接成功', mimoApiKeyConfigured: !!mimoApiKey, mimoApiKeyMask: maskMimoApiKey(key) })
  } catch (error) {
    const timeout = error.name === 'TimeoutError' || error.name === 'AbortError'
    log('warn', 'MiMo connection test failed', { code: timeout ? 'mimo_timeout' : 'mimo_network_error' })
    sendError(response, 502, timeout ? 'mimo_timeout' : 'mimo_network_error', timeout ? 'MiMo 连接超时，请稍后重试。' : '无法连接 MiMo 服务，请检查网络后重试。')
  }
  })
}

async function listTranscripts(response) {
  const entries = readTranscriptLibrary().sort((left, right) => String(right.completedAt).localeCompare(String(left.completedAt)))
  const transcripts = []
  for (const item of entries) {
    try {
      const text = await fs.promises.readFile(item.textPath, 'utf8')
      transcripts.push({ ...item, text })
    } catch (error) {
      if (error.code !== 'ENOENT') log('warn', 'Transcript file could not be read', { transcriptId: item.id, code: error.code || 'transcript_read_failed' })
    }
  }
  sendJson(response, 200, { transcripts })
}

async function handleTaskAction(request, response, method, pathname) {
  if (pathname === '/api/tasks' && method === 'GET') {
    sendJson(response, 200, { tasks: getDownloadTasks().map(publicTask), downloadDirectory })
    return
  }
  if (pathname === '/api/tasks' && method === 'POST') {
    await createDownloadTask(request, response)
    return
  }
  if (pathname === '/api/tasks/batch' && method === 'POST') {
    await createBatchDownloadTasks(request, response)
    return
  }
  if (pathname === '/api/tasks/history' && method === 'DELETE') {
    for (const [id, task] of downloadTasks) {
      if (['completed', 'failed', 'cancelled'].includes(task.status)) downloadTasks.delete(id)
    }
    saveLocalState()
    log('info', 'Download task history cleared')
    sendJson(response, 200, { tasks: getDownloadTasks().map(publicTask) })
    return
  }
  const match = pathname.match(/^\/api\/tasks\/([0-9a-f-]{36})(?:\/(cancel|retry|open))?$/i)
  if (!match) return false
  const [, id, action] = match
  const task = downloadTasks.get(id)
  if (!task) {
    sendError(response, 404, 'task_not_found', '找不到此任务。')
    return true
  }
  if (method === 'DELETE' && !action && task.status === 'waiting') {
    downloadTasks.delete(id)
    saveLocalState()
    log('info', 'Waiting download task removed', { taskId: id, bvid: task.bvid })
    sendJson(response, 200, { removed: true })
    return true
  }
  if (method === 'POST' && action === 'cancel' && task.status === 'running' && id === activeDownloadTaskId) {
    task.cancelRequested = true
    task.phase = '正在取消'
    saveLocalState()
    log('info', 'Download task cancellation requested', { taskId: id, bvid: task.bvid })
    killDownloadTree(activeDownloadChild)
    activeTaskAbortController?.abort('cancelled')
    sendJson(response, 200, { task: publicTask(task) })
    return true
  }
  if (method === 'POST' && action === 'open' && task.status === 'completed' && task.outputPath) {
    if (process.platform !== 'win32') {
      sendError(response, 501, 'unsupported_platform', '打开文件位置仅支持 Windows。')
      return true
    }
    const resolvedTarget = path.resolve(task.outputPath)
    log('info', 'Open download location requested', { taskId: id, target: task.outputPath, resolvedTarget })
    if (!fs.existsSync(resolvedTarget)) {
      log('warn', 'Open download target missing', { taskId: id, resolvedTarget })
      sendError(response, 404, 'output_not_found', '下载文件已不存在，请检查保存目录。')
      return true
    }
    const outputStats = fs.statSync(resolvedTarget)
    const isFile = outputStats.isFile()
    const targetType = isFile ? 'file' : outputStats.isDirectory() ? 'directory' : 'other'
    if (targetType === 'other') {
      sendError(response, 400, 'invalid_output_target', '保存位置不是文件或文件夹。')
      return true
    }
    log('info', 'Launching Explorer for download location', { taskId: id, resolvedTarget, targetType })
    try {
      await openExplorerLocation(resolvedTarget, isFile, id)
    } catch (error) {
      log('error', 'Explorer failed to open download location', { taskId: id, resolvedTarget, targetType, code: error.code || 'explorer_spawn_failed', message: error.message, stack: error.stack })
      sendError(response, 500, error.code || 'explorer_spawn_failed', error.message || '无法打开下载文件位置。')
      return true
    }
    sendJson(response, 200, { opened: true, located: isFile, targetType })
    return true
  }
  const retryableTask = task.status === 'failed' || (task.status === 'cancelled' && task.mode === 'transcript')
  if (method === 'POST' && action === 'retry' && retryableTask) {
    task.status = 'waiting'
    task.phase = '等待中'
    task.error = ''
    task.completedAt = null
    task.startedAt = null
    task.endedAt = null
    task.durationMs = null
    task.progress = null
    task.cancelRequested = false
    saveLocalState()
    log('info', 'Failed download task retried', { taskId: id, bvid: task.bvid, mode: task.mode })
    sendJson(response, 200, { task: publicTask(task) })
    void pumpDownloadQueue()
    return true
  }
  sendError(response, 409, 'invalid_task_action', '任务当前状态不支持此操作。')
  return true
}

async function parseSingleVideo(request, response) {
  const body = await readJsonBody(request)
  const { bvid, canonicalUrl } = normalizeVideoUrl(body.url)
  log('info', 'Video parse started', { bvid })
  const startedAt = Date.now()

  if (!fs.existsSync(executablePath)) {
    log('error', 'BBDownNext unavailable', { bvid, executable: path.basename(executablePath) })
    sendError(response, 503, 'bbdown_unavailable', '未找到 BBDownNext。请确认 tools/BBDownNext/BBDown.exe 存在，或设置 BBDOWN_PATH。')
    return
  }

  try {
    const result = await runBBDown(canonicalUrl, bvid)
    if (result.timedOut) {
      log('error', 'Video parse timed out', { bvid, durationMs: result.durationMs })
      sendError(response, 504, 'parse_timeout', '解析超过 30 秒仍未完成，请稍后重试。')
      return
    }
    if (result.outputExceeded) {
      sendError(response, 502, 'bbdown_output_too_large', 'BBDownNext 输出异常，解析已停止。')
      return
    }
    if (result.exitCode !== 0) {
      const cookie = readSavedWebCookie()
      if (cookie) {
        const login = await getBilibiliAccount(cookie)
        if (login.expired) {
          log('warn', 'Video parse failed because Bilibili login expired', { bvid, durationMs: result.durationMs })
          sendError(response, 401, 'bilibili_login_expired', 'B 站登录状态已失效，请在设置中重新扫码登录后重试。')
          return
        }
      }
      log('warn', 'Video parse failed', { bvid, exitCode: result.exitCode, durationMs: result.durationMs })
      sendError(response, 422, 'parse_failed', 'BBDownNext 未能解析此视频。请确认链接有效，或稍后重试。')
      return
    }

    const cliMetadata = readCliMetadata(result.output)
    if (!cliMetadata) {
      log('error', 'BBDownNext response could not be normalized', {
        bvid, durationMs: result.durationMs, outputLength: result.output.length,
        hasTitleLine: result.output.includes('视频标题：'), hasPartLine: /P1:/i.test(result.output),
      })
      sendError(response, 502, 'invalid_bbdown_response', 'BBDownNext 返回的信息不完整，暂时无法展示视频详情。')
      return
    }

    let details
    try {
      details = await fetchPublicVideoDetails(bvid)
    } catch (error) {
      log('warn', 'Public metadata enrichment failed', { bvid, message: error.message, stack: error.stack })
      details = null
    }

    if (!cliMetadata.title && !details?.title) {
      log('error', 'BBDownNext title unavailable', { bvid, durationMs: Date.now() - startedAt })
      sendError(response, 502, 'invalid_bbdown_response', '未能读取视频标题，请重试解析。')
      return
    }
    const durationSeconds = details?.duration ?? 0
    const video = {
      bvid,
      title: details?.title || cliMetadata.title || cliMetadata.partTitle,
      owner: details?.owner?.name || (cliMetadata.ownerId ? `UP 主（UID：${cliMetadata.ownerId}）` : '未知 UP 主'),
      collectionName: String(details?.ugc_season?.title || ''),
      duration: durationSeconds ? formatDuration(durationSeconds) : cliMetadata.durationText,
      date: details?.pubdate ? new Date(details.pubdate * 1000).toLocaleDateString('zh-CN') : '',
      views: Number.isFinite(details?.stat?.view) ? details.stat.view : null,
      cover: proxiedImageUrl(details?.pic || ''),
      url: canonicalUrl,
    }
    log('info', 'Video parse succeeded', { bvid, durationMs: Date.now() - startedAt, hasCover: !!video.cover })
    sendJson(response, 200, { video })
  } catch (error) {
    log('error', 'Video parse error', { bvid, code: error.code || 'parse_error', message: error.message, stack: error.stack })
    sendError(response, 502, error.code || 'parse_error', error.message || '视频解析失败，请稍后重试。')
  }
}

const server = http.createServer(async (request, response) => {
  const startedAt = Date.now()
  const method = request.method || 'GET'
  let pathname = '/'
  try { pathname = new URL(request.url || '/', 'http://127.0.0.1').pathname } catch { /* retain root path */ }
  let statusCode = 200
  try {
    if (method === 'GET' && pathname === '/api/health') {
      sendJson(response, 200, {
        status: 'ok',
        mode: productionMode ? 'production' : 'development',
        webUrl: productionMode ? `http://127.0.0.1:${port}/` : process.env.BILISCRIBE_WEB_URL || null,
        bbdownAvailable: fs.existsSync(executablePath),
        bbdownVersion,
        logPath: getLogPath(),
        logDirectory: getLogDirectory(),
      })
    } else if (method === 'GET' && pathname === '/api/images/proxy') {
      await proxyBilibiliImage(request, response)
      statusCode = response.statusCode || 200
    } else if (method === 'POST' && pathname === '/api/videos/parse') {
      await parseSingleVideo(request, response)
      statusCode = response.statusCode || 200
    } else if (method === 'POST' && pathname === '/api/creators/parse') {
      await parseCreatorHomepage(request, response)
      statusCode = response.statusCode || 200
    } else if (method === 'GET' && pathname === '/api/settings') {
      sendJson(response, 200, { downloadDirectory, transcriptDirectory, mimoApiKeyConfigured: !!mimoApiKey, mimoApiKeyMask: maskMimoApiKey() })
    } else if (method === 'PUT' && pathname === '/api/settings') {
      await saveAppSettings(request, response)
      statusCode = response.statusCode || 200
    } else if (method === 'POST' && pathname === '/api/settings/mimo/test') {
      await testMiMoConnection(request, response)
      statusCode = response.statusCode || 200
    } else if (method === 'POST' && pathname === '/api/local-audio/select-files') {
      await selectLocalAudio(response, 'files')
      statusCode = response.statusCode || 200
    } else if (method === 'POST' && pathname === '/api/local-audio/select-folder') {
      await selectLocalAudio(response, 'folder')
      statusCode = response.statusCode || 200
    } else if (method === 'POST' && pathname === '/api/local-audio/tasks') {
      await createLocalAudioTasks(request, response)
      statusCode = response.statusCode || 200
    } else if (method === 'GET' && pathname === '/api/transcripts') {
      await listTranscripts(response)
      statusCode = response.statusCode || 200
    } else if (method === 'GET' && pathname === '/api/settings/download') {
      sendJson(response, 200, { downloadDirectory })
    } else if (method === 'PUT' && pathname === '/api/settings/download') {
      await saveDownloadDirectory(request, response)
      statusCode = response.statusCode || 200
    } else if (pathname.startsWith('/api/tasks')) {
      const handled = await handleTaskAction(request, response, method, pathname)
      if (!handled && !response.headersSent) {
        statusCode = 404
        sendError(response, 404, 'not_found', '找不到此本地 API。')
      } else statusCode = response.statusCode || 200
    } else if (method === 'GET' && pathname === '/api/bilibili/login') {
      const login = await getLoginStatus()
      if (login.loggedIn) log('info', 'Bilibili login status restored', { hasAccountName: !!login.account?.name })
      sendJson(response, 200, { loggedIn: login.loggedIn, account: publicAccount(login.account) })
    } else if (method === 'POST' && pathname === '/api/bilibili/login/qr') {
      await startQrLogin(response)
      statusCode = response.statusCode || 200
    } else if (method === 'POST' && pathname === '/api/bilibili/logout') {
      await logoutBilibili(response)
      statusCode = response.statusCode || 200
    } else if (method === 'GET' && /^\/api\/bilibili\/login\/qr\/[0-9a-f-]{36}$/i.test(pathname)) {
      await pollQrLogin(response, pathname.split('/').at(-1))
      statusCode = response.statusCode || 200
    } else if (method === 'GET' && pathname === '/api/logs/recent') {
      sendJson(response, 200, { logPath: getLogPath(), ...readRecentLogLines(300) })
    } else if (method === 'GET' && pathname === '/api/logs/export') {
      const content = readCompleteLog()
      if (content === null) {
        statusCode = 404
        sendError(response, 404, 'log_empty', '日志文件尚未生成。')
      } else {
        response.writeHead(200, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Disposition': 'attachment; filename="biliscribe.log"',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        })
        response.end(content)
      }
    } else if (method === 'POST' && pathname === '/api/logs/open') {
      if (process.platform !== 'win32') {
        statusCode = 501
        sendError(response, 501, 'unsupported_platform', '打开日志目录仅支持 Windows。')
      } else {
        const explorer = spawn('explorer.exe', [getLogDirectory()], { detached: true, stdio: 'ignore', windowsHide: false })
        await new Promise((resolve, reject) => {
          explorer.once('spawn', resolve)
          explorer.once('error', reject)
        })
        explorer.unref()
        log('info', 'Log directory opened')
        sendJson(response, 200, { opened: true })
      }
    } else if (productionMode && method === 'GET') {
      serveFrontend(pathname, response)
    } else {
      statusCode = 404
      sendError(response, 404, 'not_found', '找不到此本地 API。')
    }
  } catch (error) {
    if (response.headersSent || response.writableEnded) {
      statusCode = response.statusCode || 200
      log('warn', 'API handler failed after response was sent', { method, path: pathname, code: error.code || 'request_error' })
      if (!response.writableEnded) response.destroy()
    } else {
      statusCode = error.statusCode || 500
      log(statusCode >= 500 ? 'error' : 'warn', 'API request error', {
        method, path: pathname, statusCode, code: error.code || 'request_error', message: error.message, stack: error.stack,
      })
      sendError(response, statusCode, error.code || 'request_error', error.message || '本地后台请求失败。')
    }
  } finally {
    log(statusCode >= 500 ? 'warn' : 'info', 'API request completed', { method, path: pathname, statusCode, durationMs: Date.now() - startedAt })
  }
})

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

function serveFrontend(pathname, response) {
  let decodedPath
  try { decodedPath = decodeURIComponent(pathname) } catch {
    sendError(response, 400, 'invalid_path', '页面地址无效。')
    return
  }
  const relativePath = decodedPath === '/' ? 'index.html' : decodedPath.replace(/^\/+/, '')
  const candidatePath = path.resolve(distDirectory, relativePath)
  if (!candidatePath.startsWith(`${distDirectory}${path.sep}`) && candidatePath !== path.join(distDirectory, 'index.html')) {
    sendError(response, 403, 'invalid_path', '页面地址无效。')
    return
  }
  let filePath = candidatePath
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    if (path.extname(relativePath)) {
      sendError(response, 404, 'file_not_found', '找不到此页面文件。')
      return
    }
    filePath = path.join(distDirectory, 'index.html')
  }
  response.writeHead(200, {
    'Content-Type': contentTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': path.basename(filePath) === 'index.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
  })
  fs.createReadStream(filePath).pipe(response)
}

server.on('clientError', (error, socket) => {
  log('warn', 'HTTP client error', { message: error.message })
  socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
})

server.on('error', (error) => {
  log('error', 'BiliScribe backend failed to start', { code: error.code || 'server_error', message: error.message, stack: error.stack })
  console.error(`BiliScribe 本地服务启动失败：${error.code === 'EADDRINUSE' ? `端口 ${port} 已被占用` : error.message}`)
  process.exit(1)
})

server.listen(port, '127.0.0.1', () => {
  log('info', 'BiliScribe backend started', {
    address: `http://127.0.0.1:${port}`,
    mode: productionMode ? 'production' : 'development',
    bbdownAvailable: fs.existsSync(executablePath),
    bbdownVersion,
  })
  console.log(`BiliScribe API: http://127.0.0.1:${port}`)
  void pumpDownloadQueue()
})

let shuttingDown = false
function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  log('info', 'BiliScribe backend stopping', { signal })
  activeTaskAbortController?.abort('shutdown')
  stopTranscriptWakeLock()
  for (const child of childProcesses) child.kill()
  server.close(() => {
    log('info', 'BiliScribe backend stopped', { signal })
    process.exit(0)
  })
  setTimeout(() => process.exit(1), 5000).unref()
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('uncaughtException', (error) => {
  log('error', 'Uncaught exception', { message: error.message, stack: error.stack })
  shutdown('uncaughtException')
})
process.on('unhandledRejection', (reason) => {
  const error = reason instanceof Error ? reason : new Error(String(reason))
  log('error', 'Unhandled rejection', { message: error.message, stack: error.stack })
})
