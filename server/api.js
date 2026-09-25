import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { getLogDirectory, getLogPath, log, readCompleteLog, readRecentLogLines } from './logger.js'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const configuredExe = process.env.BBDOWN_PATH || path.join(projectRoot, 'tools', 'BBDownNext', 'BBDown.exe')
const executablePath = path.resolve(configuredExe)
const port = Number(process.env.BILISCRIBE_API_PORT || 4174)
const parseTimeoutMs = 30_000
const childProcesses = new Set()

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
        cwd: projectRoot,
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
        bbdownAvailable: fs.existsSync(executablePath),
        bbdownVersion,
        logPath: getLogPath(),
        logDirectory: getLogDirectory(),
      })
    } else if (method === 'POST' && pathname === '/api/videos/parse') {
      await parseSingleVideo(request, response)
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

server.on('clientError', (error, socket) => {
  log('warn', 'HTTP client error', { message: error.message })
  socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
})

server.listen(port, '127.0.0.1', () => {
  log('info', 'BiliScribe backend started', {
    address: `http://127.0.0.1:${port}`,
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
