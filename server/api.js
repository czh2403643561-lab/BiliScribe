import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import net from 'node:net'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { getLogDirectory, getLogPath, log, readCompleteLog, readRecentLogLines } from './logger.js'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const configuredExe = process.env.BBDOWN_PATH || path.join(projectRoot, 'tools', 'BBDownNext', 'BBDown.exe')
const executablePath = path.resolve(configuredExe)
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

function readSavedWebCookie() {
  const credentialPath = path.join(path.dirname(executablePath), 'BBDown.data')
  try {
    const data = JSON.parse(fs.readFileSync(credentialPath, 'utf8'))
    return typeof data.cookie === 'string' ? data.cookie : ''
  } catch {
    return ''
  }
}

function savedCookieFingerprint() {
  const cookie = readSavedWebCookie()
  return cookie ? createHash('sha256').update(cookie).digest('hex') : ''
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
  const previousCookieFingerprint = savedCookieFingerprint()
  const { response: upstream, body } = await requestBBDownServe('/api/v1/login/qr', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channel: 'web' }),
  })
  if (!upstream.ok || !body?.qrcodeKey || !body?.qrPngBase64) {
    log('warn', 'Bilibili QR login start failed', { statusCode: upstream.status })
    sendError(response, upstream.status === 429 ? 429 : 502, 'qr_login_start_failed', '二维码生成失败，请稍后重试。')
    return
  }
  const id = randomUUID()
  authSessions.set(id, { key: body.qrcodeKey, state: 'waitingScan', expiresAt: Date.now() + 10 * 60_000, account: null, previousCookieFingerprint })
  log('info', 'Bilibili QR code generated')
  sendJson(response, 200, { sessionId: id, qrDataUrl: `data:image/png;base64,${body.qrPngBase64}`, state: 'waitingScan' })
}

async function pollQrLogin(response, id) {
  const session = authSessions.get(id)
  if (!session || session.expiresAt <= Date.now()) {
    authSessions.delete(id)
    sendJson(response, 200, { state: 'expired', message: '二维码已过期，请刷新二维码。' })
    return
  }
  if (session.state === 'success') {
    sendJson(response, 200, { state: 'success', account: session.account })
    return
  }
  const recoverPersistedSuccess = async () => {
    const currentFingerprint = savedCookieFingerprint()
    if (!currentFingerprint || currentFingerprint === session.previousCookieFingerprint) return false
    const status = await getLoginStatus()
    if (!status.loggedIn) return false
    session.state = 'success'
    session.account = status.account
    log('info', 'Bilibili QR login succeeded; restored from local credentials', { hasAccountName: !!session.account?.name })
    sendJson(response, 200, { state: 'success', account: session.account })
    return true
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
    if (nextState !== session.state && ['waitingConfirm', 'expired', 'failed'].includes(nextState)) {
      const event = { waitingConfirm: 'Bilibili QR scanned, awaiting confirmation', expired: 'Bilibili QR login expired', failed: 'Bilibili QR login failed' }[nextState]
      log(nextState === 'failed' ? 'warn' : 'info', event)
    }
    if (nextState === 'success') {
      // BBDownNext persists the WEB credential itself; never forward its credential payload.
      session.account = body.accountName ? { name: String(body.accountName), avatar: '', uid: '' } : null
      const status = await getLoginStatus()
      session.account = status.account || session.account
      session.state = 'success'
      log('info', 'Bilibili QR login succeeded', { hasAccountName: !!session.account?.name })
      sendJson(response, 200, { state: 'success', account: session.account })
      return
    }
    session.state = ['waitingScan', 'waitingConfirm', 'expired', 'failed'].includes(nextState) ? nextState : 'waitingScan'
    sendJson(response, 200, {
      state: session.state,
      message: session.state === 'waitingConfirm' ? '已扫码，请在手机上确认登录。' : session.state === 'expired' ? '二维码已过期，请刷新二维码。' : session.state === 'failed' ? '登录失败，请刷新二维码重试。' : '等待扫码',
    })
  } catch (error) {
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

async function readJsonBody(request) {
  if (!request.headers['content-type']?.toLowerCase().includes('application/json')) {
    throw Object.assign(new Error('请求必须使用 JSON 格式。'), { statusCode: 415, code: 'unsupported_media_type' })
  }
  const chunks = []
  let byteLength = 0
  for await (const chunk of request) {
    byteLength += chunk.length
    if (byteLength > 16 * 1024) throw Object.assign(new Error('请求内容过大。'), { statusCode: 413, code: 'payload_too_large' })
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
      cover: details?.pic?.replace(/^http:/i, 'https:') || '',
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
    } else if (method === 'POST' && pathname === '/api/videos/parse') {
      await parseSingleVideo(request, response)
      statusCode = response.statusCode || 200
    } else if (method === 'GET' && pathname === '/api/bilibili/login') {
      const login = await getLoginStatus()
      if (login.loggedIn) log('info', 'Bilibili login status restored', { hasAccountName: !!login.account?.name })
      sendJson(response, 200, { loggedIn: login.loggedIn, account: login.account })
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
