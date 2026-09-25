import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const apiFile = fileURLToPath(new URL('./api.js', import.meta.url))
const viteCli = path.join(projectRoot, 'node_modules', 'vite', 'bin', 'vite.js')
const children = []
let shuttingDown = false

function start(label, file, args) {
  const child = spawn(process.execPath, [file, ...args], { cwd: projectRoot, stdio: 'inherit', windowsHide: true })
  children.push(child)
  child.once('error', (error) => {
    console.error(`[${label}] 无法启动：${error.message}`)
    shutdown(1)
  })
  child.once('exit', (code, signal) => {
    if (!shuttingDown) {
      console.error(`[${label}] 已停止（${signal || `退出码 ${code}`}）`)
      shutdown(code || 1)
    }
  })
  return child
}

function shutdown(exitCode = 0) {
  if (shuttingDown) return
  shuttingDown = true
  for (const child of children) {
    if (child.exitCode === null) child.kill()
  }
  setTimeout(() => process.exit(exitCode), 250).unref()
}

console.log('启动本地后台与 Vue 开发服务器（按 Ctrl+C 一并关闭）')
start('backend', apiFile, [])
start('vite', viteCli, ['--host', '127.0.0.1'])

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))
