import { spawn } from 'node:child_process'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const apiFile = fileURLToPath(new URL('./api.js', import.meta.url))
const viteCli = path.join(projectRoot, 'node_modules', 'vite', 'bin', 'vite.js')
const children = []
let shuttingDown = false

function start(label, file, args, env = process.env) {
  const child = spawn(process.execPath, [file, ...args], { cwd: projectRoot, stdio: 'inherit', windowsHide: true, env })
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

async function findAvailablePort(firstPort) {
  for (let port = firstPort; port < firstPort + 100; port++) {
    const available = await new Promise((resolve) => {
      const probe = net.createServer()
      probe.once('error', () => resolve(false))
      probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)))
    })
    if (available) return port
  }
  throw new Error('找不到可用的 Vite 开发端口。')
}

try {
  const webPort = await findAvailablePort(Number(process.env.BILISCRIBE_WEB_PORT || 5173))
  const backendEnv = { ...process.env, BILISCRIBE_WEB_URL: `http://127.0.0.1:${webPort}/` }
  start('backend', apiFile, [], backendEnv)
  start('vite', viteCli, ['--host', '127.0.0.1', '--port', String(webPort), '--strictPort'])
} catch (error) {
  console.error(error.message)
  shutdown(1)
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))
