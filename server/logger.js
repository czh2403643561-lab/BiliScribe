import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const logDirectory = path.join(projectRoot, 'logs')
const logFile = path.join(logDirectory, 'biliscribe.log')
const maxBytes = 2 * 1024 * 1024
const archiveCount = 3

fs.mkdirSync(logDirectory, { recursive: true })

function redactUrl(value) {
  try {
    const url = new URL(value)
    if (/bilivideo\.com$/i.test(url.hostname) || /\.bilivideo\.com$/i.test(url.hostname)) return '[视频流地址已隐藏]'
    return `${url.origin}${url.pathname}${url.search ? '?[参数已隐藏]' : ''}`
  } catch {
    return '[地址已隐藏]'
  }
}

function sanitizeString(value) {
  return value
    .replace(/https?:\/\/[^\s"'<>]+/gi, (url) => redactUrl(url.replace(/[),\]}]+$/, '')))
    .replace(/((?:cookie|sessdata|bili_jct|dedeuserid|access[_-]?token|refresh[_-]?token|access[_-]?key|authorization|x-bbdown-token|mimo[_ -]?api[_ -]?key)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[已隐藏]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [已隐藏]')
}

function sanitize(value, key = '') {
  if (/cookie|token|secret|api.?key|authorization/i.test(key)) return '[已隐藏]'
  if (typeof value === 'string') return sanitizeString(value)
  if (Array.isArray(value)) return value.map((item) => sanitize(item))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [entryKey, sanitize(entryValue, entryKey)]))
  }
  return value
}

function rotateIfNeeded(nextLineBytes) {
  let currentSize = 0
  try { currentSize = fs.statSync(logFile).size } catch { return }
  if (currentSize + nextLineBytes <= maxBytes) return

  try { fs.rmSync(`${logFile}.${archiveCount}`, { force: true }) } catch { /* best effort */ }
  for (let index = archiveCount - 1; index >= 1; index--) {
    try { fs.renameSync(`${logFile}.${index}`, `${logFile}.${index + 1}`) } catch { /* missing archive */ }
  }
  try { fs.renameSync(logFile, `${logFile}.1`) } catch { /* best effort */ }
}

export function log(level, event, details = {}) {
  const entry = {
    time: new Date().toISOString(),
    level,
    event,
    ...sanitize(details),
  }
  const line = `${JSON.stringify(entry)}\n`
  rotateIfNeeded(Buffer.byteLength(line))
  fs.appendFileSync(logFile, line, 'utf8')
}

export function getLogPath() { return logFile }
export function getLogDirectory() { return logDirectory }

export function readRecentLogLines(limit = 300) {
  if (!fs.existsSync(logFile)) return { available: false, lines: 0, content: '' }
  const content = fs.readFileSync(logFile, 'utf8')
  const recentLines = content.split(/\r?\n/).filter(Boolean).slice(-limit)
  return { available: recentLines.length > 0, lines: recentLines.length, content: recentLines.join('\n') }
}

export function readCompleteLog() {
  if (!fs.existsSync(logFile)) return null
  return fs.readFileSync(logFile, 'utf8')
}
