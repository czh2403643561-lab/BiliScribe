import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import net from 'node:net'
import os from 'node:os'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { getLogDirectory, getLogPath, log, readCompleteLog, readRecentLogLines } from './logger.js'

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
const defaultDownloadDirectory = path.join(os.homedir(), 'Videos', 'BiliScribe')
const mediaExtensions = new Set(['.mp4', '.mkv', '.flv', '.m4a', '.mka', '.mp3', '.aac', '.wav', '.flac', '.m4s'])
const bilibiliImageHosts = ['hdslb.com', 'bilivideo.com']
const wbiMixinIndices = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52]

let downloadDirectory = defaultDownloadDirectory
const downloadTasks = new Map()
let queuePumpActive = false
let activeDownloadChild = null
let activeDownloadTaskId = null

function saveLocalState() {
  try {
    fs.mkdirSync(stateDirectory, { recursive: true })
    const payload = JSON.stringify({ downloadDirectory, tasks: [...downloadTasks.values()] }, null, 2)
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
  for (const task of Array.isArray(saved.tasks) ? saved.tasks : []) {
    if (!task?.id || !['waiting', 'running', 'completed', 'failed', 'cancelled'].includes(task.status)) continue
    if (task.status === 'running') {
      task.status = 'failed'
      task.phase = '后台关闭时任务中断'
      task.error = 'BiliScribe 关闭时任务未完成，请重试。'
      task.completedAt = new Date().toISOString()
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
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  response.end(JSON.stringify(data))
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

function safeDirectoryName(value) {
  const cleaned = String(value || 'B站视频').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').trim()
  return (cleaned || 'B站视频').slice(0, 72)
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
  const startedAt = Date.now()
  let child = null
  task.status = 'running'
  task.phase = '准备中'
  task.progress = null
  task.error = ''
  task.completedAt = null
  task.attempt = (task.attempt || 0) + 1
  const safeTitle = safeDirectoryName(task.title)
  task.outputDirectory = path.join(downloadDirectory, `${task.bvid} - ${safeTitle} (${task.attempt})`)
  task.outputPath = ''
  task.fileSize = 0
  saveLocalState()
  log('info', 'Download task started', { taskId: task.id, bvid: task.bvid, mode: task.mode })

  try {
    if (!fs.existsSync(executablePath)) throw Object.assign(new Error('未找到 BBDownNext，请确认 tools/BBDownNext/BBDown.exe 存在。'), { code: 'bbdown_unavailable' })
    await ensureWritableDirectory(downloadDirectory)
    await ensureWritableDirectory(task.outputDirectory)
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

    const args = [task.url, '--get', task.mode === 'audio' ? 'a' : 'av', '--work-dir', task.outputDirectory, '--file-pattern', `[<bvid>] <videoTitle>`, '--stop-on-error']
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

    const files = await listMediaFiles(task.outputDirectory, task.mode)
    if (!files.length) {
      task.status = 'failed'
      task.phase = '未找到输出文件'
      task.error = 'BBDownNext 已结束，但没有找到完整媒体文件；可能的临时文件已保留。'
      task.completedAt = new Date().toISOString()
      log('error', 'Download task output missing', { taskId: task.id, bvid: task.bvid, mode: task.mode, outputDirectory: task.outputDirectory, durationMs: Date.now() - startedAt })
      return
    }
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
    if (activeDownloadChild && activeDownloadChild.exitCode !== null) {
      childProcesses.delete(activeDownloadChild)
      activeDownloadChild = null
    }
    task.cancelRequested = false
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
      await runDownloadTask(next)
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
  if (!['video', 'audio'].includes(body.mode)) {
    sendError(response, 400, 'invalid_download_mode', '目前只支持下载视频或音频。')
    return
  }
  const { bvid, canonicalUrl } = normalizeVideoUrl(body.url)
  const task = {
    id: randomUUID(), bvid, url: canonicalUrl,
    title: String(body.title || bvid).slice(0, 300),
    owner: String(body.owner || '未知 UP 主').slice(0, 120),
    mode: body.mode, status: 'waiting', phase: '等待中', progress: null,
    outputPath: '', outputDirectory: '', outputFiles: [], fileSize: 0,
    error: '', createdAt: new Date().toISOString(), completedAt: null, attempt: 0,
  }
  downloadTasks.set(task.id, task)
  saveLocalState()
  log('info', 'Download task created', { taskId: task.id, bvid, mode: task.mode })
  sendJson(response, 201, { task })
  void pumpDownloadQueue()
}

async function createBatchDownloadTasks(request, response) {
  const body = await readJsonBody(request, 2 * 1024 * 1024)
  if (!['video', 'audio'].includes(body.mode)) {
    sendError(response, 400, 'invalid_download_mode', '目前只支持批量下载视频或音频。')
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
    }
  })
  const unique = [...new Map(normalized.map((video) => [video.bvid, video])).values()]
  const tasks = unique.map((video) => ({
    id: randomUUID(), ...video, mode: body.mode, status: 'waiting', phase: '等待中', progress: null,
    outputPath: '', outputDirectory: '', outputFiles: [], fileSize: 0, error: '',
    createdAt: new Date().toISOString(), completedAt: null, attempt: 0,
  }))
  for (const task of tasks) downloadTasks.set(task.id, task)
  saveLocalState()
  log('info', 'Creator batch download tasks created', { count: tasks.length, mode: body.mode })
  sendJson(response, 201, { tasks: tasks.map(({ id, bvid, title, owner, mode, status, createdAt }) => ({ id, bvid, title, owner, mode, status, createdAt })) })
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

async function handleTaskAction(request, response, method, pathname) {
  if (pathname === '/api/tasks' && method === 'GET') {
    sendJson(response, 200, { tasks: getDownloadTasks(), downloadDirectory })
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
    sendJson(response, 200, { tasks: getDownloadTasks() })
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
    sendJson(response, 200, { task })
    return true
  }
  if (method === 'POST' && action === 'open' && task.status === 'completed' && task.outputPath) {
    if (process.platform !== 'win32') {
      sendError(response, 501, 'unsupported_platform', '打开文件位置仅支持 Windows。')
      return true
    }
    if (!fs.existsSync(task.outputPath)) {
      sendError(response, 404, 'output_not_found', '下载文件已不存在，请检查保存目录。')
      return true
    }
    const outputStats = fs.statSync(task.outputPath)
    const isFile = outputStats.isFile()
    const target = isFile ? `/select,${path.resolve(task.outputPath)}` : path.resolve(task.outputPath)
    const explorer = spawn('explorer.exe', [target], {
      cwd: isFile ? path.dirname(path.resolve(task.outputPath)) : path.resolve(task.outputPath),
      detached: true, stdio: 'ignore', windowsHide: false,
    })
    await new Promise((resolve, reject) => {
      explorer.once('spawn', resolve)
      explorer.once('error', reject)
    })
    explorer.unref()
    sendJson(response, 200, { opened: true, located: isFile })
    return true
  }
  if (method === 'POST' && action === 'retry' && task.status === 'failed') {
    task.status = 'waiting'
    task.phase = '等待中'
    task.error = ''
    task.completedAt = null
    task.progress = null
    task.cancelRequested = false
    saveLocalState()
    log('info', 'Failed download task retried', { taskId: id, bvid: task.bvid, mode: task.mode })
    sendJson(response, 200, { task })
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
    } else if (method === 'GET' && pathname === '/api/settings/download') {
      sendJson(response, 200, { downloadDirectory })
    } else if (method === 'PUT' && pathname === '/api/settings/download') {
      await saveDownloadDirectory(request, response)
      statusCode = response.statusCode || 200
    } else if (pathname.startsWith('/api/tasks')) {
      const handled = await handleTaskAction(request, response, method, pathname)
      if (!handled) {
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
    statusCode = error.statusCode || 500
    log(statusCode >= 500 ? 'error' : 'warn', 'API request error', {
      method, path: pathname, statusCode, code: error.code || 'request_error', message: error.message, stack: error.stack,
    })
    if (!response.headersSent) sendError(response, statusCode, error.code || 'request_error', error.message || '本地后台请求失败。')
    else response.destroy()
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
