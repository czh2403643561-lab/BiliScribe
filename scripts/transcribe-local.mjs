import { setTimeout as delay } from 'node:timers/promises'

const files = process.argv.slice(2)
if (!files.length) {
  console.error('用法：node scripts/transcribe-local.mjs <本机 MP3/MP4 路径> [更多文件路径]')
  process.exit(2)
}

const base = `http://127.0.0.1:${process.env.BILISCRIBE_API_PORT || 4174}`
async function request(path, options) {
  const response = await fetch(`${base}${path}`, options)
  const body = await response.json()
  if (!response.ok) throw new Error(body.message || body.error?.message || (typeof body.error === 'string' ? body.error : '') || `HTTP ${response.status}`)
  return body
}

try {
  const submitted = await request('/api/agent/transcripts', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ files }),
  })
  const ids = new Set(submitted.tasks.map((task) => task.id))
  console.log(`任务：新建 ${submitted.created}，复用 ${submitted.reused}`)
  const observed = new Map()
  while (ids.size) {
    const snapshot = await request('/api/tasks')
    for (const task of snapshot.tasks.filter((item) => ids.has(item.id))) {
      const marker = `${task.status}:${task.phase}`
      if (observed.get(task.id) !== marker) {
        console.log(`${task.title}：${task.phase || task.status}`)
        observed.set(task.id, marker)
      }
      if (['completed', 'failed', 'cancelled'].includes(task.status)) {
        console.log(JSON.stringify({ id: task.id, status: task.status, outputPath: task.outputPath || null, error: task.error || null }))
        ids.delete(task.id)
        if (task.status !== 'completed') process.exitCode = 1
      }
    }
    if (ids.size) await delay(3000)
  }
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
