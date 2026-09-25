<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import {
  Activity, Archive, ArrowDownToLine, AudioLines, Bell, BookOpenText, CalendarDays, Check,
  CheckCheck, ChevronDown, ChevronLeft, ChevronRight, CircleHelp, CirclePlay,
  Clock3, CloudDownload, Copy, Download, ExternalLink, FileAudio, FileText,
  Eye, EyeOff, Film, FolderOpen, Gauge, HardDriveDownload, History, Home, KeyRound, Link2,
  ListChecks, LoaderCircle, LockKeyhole, LogOut, Menu, MoreHorizontal,
  PanelLeftClose, Pause, Play, Plus, Radio, RefreshCw, ScanLine, Search,
  Settings2, ShieldCheck, SlidersHorizontal, Sparkles, Trash2, Upload, UserRound, Video,
  X, XCircle, Zap,
} from '@lucide/vue'

const navItems = [
  { id: 'new', label: '新建任务', icon: Plus },
  { id: 'tasks', label: '任务', icon: ListChecks, badge: '4' },
  { id: 'transcripts', label: '文字稿', icon: BookOpenText },
  { id: 'settings', label: '设置', icon: Settings2 },
]
const page = ref('new')
const toast = ref('')
let toastTimer
let taskPollTimer

function notify(message) {
  toast.value = message
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (toast.value = ''), 2600)
}

const url = ref('https://www.bilibili.com/video/BV1eQNL6JEV2/')
const resultType = ref('video')
const isParsing = ref(false)
const parseState = ref('idle')
const parseErrorKind = ref('')
const parseErrorMessage = ref('')
const isCreatorInput = computed(() => /^https?:\/\/(?:www\.)?space\.bilibili\.com\/\d+(?:\/|\?|$)/i.test(url.value.trim()))
const currentPage = ref(1)
const creatorSearch = ref('')
const expandedAlbums = ref(new Set())
const selectedVideoIds = ref(new Set())
const batchAction = ref('video')
const creatorData = ref(null)
const creator = computed(() => creatorData.value || {})
const creatorAvatarFailed = ref(false)
const creatorGroups = computed(() => creatorData.value?.groups || [])
const pageSize = 20
const creatorResultVideos = computed(() => {
  const query = creatorSearch.value.trim().toLowerCase()
  const videos = creatorData.value?.videos || []
  return query ? videos.filter((video) => video.title.toLowerCase().includes(query)) : videos
})
const pageCount = computed(() => Math.max(1, Math.ceil(creatorResultVideos.value.length / pageSize)))
const pageVideos = computed(() => creatorResultVideos.value.slice((currentPage.value - 1) * pageSize, currentPage.value * pageSize))
const currentAlbums = computed(() => {
  const pageIds = new Set(pageVideos.value.map((video) => video.id))
  const query = creatorSearch.value.trim().toLowerCase()
  return creatorGroups.value.map((group) => {
    const selectionVideos = query ? group.videos.filter((video) => video.title.toLowerCase().includes(query)) : group.videos
    return { ...group, selectionVideos, pageVideos: group.videos.filter((video) => pageIds.has(video.id)) }
  }).filter((group) => group.pageVideos.length)
})
const pageNumbers = computed(() => {
  const start = Math.max(1, Math.min(currentPage.value - 2, pageCount.value - 4))
  return Array.from({ length: Math.min(5, pageCount.value) }, (_, index) => start + index)
})
const selectedCount = computed(() => selectedVideoIds.value.size)
const pageAllSelected = computed(() => pageVideos.value.length > 0 && pageVideos.value.every((video) => selectedVideoIds.value.has(video.id)))
const allSelected = computed(() => creatorResultVideos.value.length > 0 && creatorResultVideos.value.every((video) => selectedVideoIds.value.has(video.id)))
watch(creatorSearch, () => { currentPage.value = 1 })
watch(url, () => { if (!isParsing.value) parseState.value = 'idle'; parseErrorKind.value = ''; parseErrorMessage.value = '' })

const singleVideo = ref({ title: '', bvid: '', owner: '', duration: '', date: '', views: null, cover: '', url: '' })
const singleCoverFailed = ref(false)

function setDemoLink(kind) {
  const samples = {
    video: 'https://www.bilibili.com/video/BV1eQNL6JEV2/',
    creator: 'https://space.bilibili.com/24715837',
    failed: 'https://www.bilibili.com/video/BV1demoFAIL0/',
    invalid: 'https://example.com/video/BV1xx411c7mD',
  }
  url.value = samples[kind]
  parseLink()
}
async function parseLink() {
  const value = url.value.trim()
  selectedVideoIds.value = new Set()
  parseErrorKind.value = ''
  parseErrorMessage.value = ''
  if (!value) {
    isParsing.value = false
    parseState.value = 'empty'
    return
  }
  parseState.value = 'loading'
  isParsing.value = true
  try {
    const creatorMatch = value.match(/^https?:\/\/(?:www\.)?space\.bilibili\.com\/(\d+)(?:\/|\?|$)/i)
    const response = await fetch(creatorMatch ? '/api/creators/parse' : '/api/videos/parse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: value }),
    })
    const result = await response.json()
    if (!response.ok) {
      parseErrorKind.value = result.error?.code || 'parse_failed'
      parseErrorMessage.value = result.error?.message || '视频解析失败，请稍后重试。'
      parseState.value = ['invalid_url', 'unsupported_url', 'empty_url'].includes(parseErrorKind.value) ? 'invalid' : 'failed'
      return
    }
    if (creatorMatch) {
      creatorData.value = result.creator
      creatorAvatarFailed.value = false
      expandedAlbums.value = new Set()
      creatorSearch.value = ''
      currentPage.value = 1
      resultType.value = 'creator'
      notify(`已解析 ${result.creator.name} 的主页`)
    } else {
      singleVideo.value = result.video
      singleCoverFailed.value = false
      resultType.value = 'video'
      notify('视频解析完成')
    }
    parseState.value = 'success'
  } catch {
    parseErrorKind.value = 'backend_unavailable'
    parseErrorMessage.value = 'BiliScribe 本地服务未启动，请重新打开 BiliScribe。'
    parseState.value = 'failed'
  } finally {
    isParsing.value = false
  }
}

function toggleVideo(id) {
  const next = new Set(selectedVideoIds.value)
  next.has(id) ? next.delete(id) : next.add(id)
  selectedVideoIds.value = next
}
function setVideos(ids, checked) {
  const next = new Set(selectedVideoIds.value)
  ids.forEach((id) => checked ? next.add(id) : next.delete(id))
  selectedVideoIds.value = next
}
function selectAll() { setVideos(creatorResultVideos.value.map((video) => video.id), true) }
function selectCurrentPage() { setVideos(pageVideos.value.map((video) => video.id), true) }
function clearCurrentPage() { setVideos(pageVideos.value.map((video) => video.id), false) }
function clearAll() { selectedVideoIds.value = new Set() }
function toggleAlbum(album) {
  const next = new Set(expandedAlbums.value)
  next.has(album.id) ? next.delete(album.id) : next.add(album.id)
  expandedAlbums.value = next
}
function albumChecked(album) { return album.selectionVideos.length > 0 && album.selectionVideos.every((video) => selectedVideoIds.value.has(video.id)) }
function toggleAlbumSelection(album) { setVideos(album.selectionVideos.map((video) => video.id), !albumChecked(album)) }

const modeOptions = [
  { id: 'video', label: '下载视频', icon: Film },
  { id: 'audio', label: '下载音频', icon: AudioLines },
  { id: 'transcript', label: '转写文字稿', icon: FileText },
]
const taskNames = { video: '视频下载', audio: '音频下载', transcript: '文字稿转写' }
const taskIcon = { video: Film, audio: AudioLines, transcript: FileText }
const CalendarIcon = CalendarDays
const SlidersIcon = SlidersHorizontal
const tasks = ref([])
const taskTab = ref('active')
const runningTask = computed(() => tasks.value.find((task) => task.status === 'running'))
const waitingTasks = computed(() => tasks.value.filter((task) => task.status === 'waiting'))
const activeTasks = computed(() => tasks.value.filter((task) => ['running', 'waiting'].includes(task.status)))
const historyTasks = computed(() => tasks.value.filter((task) => ['completed', 'failed', 'cancelled'].includes(task.status)).slice().reverse())
const completedCount = computed(() => tasks.value.filter((task) => task.status === 'completed').length)
const failedCount = computed(() => tasks.value.filter((task) => task.status === 'failed').length)
const queueCount = computed(() => waitingTasks.value.length)

function formatTaskDate(value) {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function formatFileSize(bytes) {
  const size = Number(bytes) || 0
  if (size < 1) return '—'
  if (size < 1024 ** 2) return `${(size / 1024).toFixed(1)} KB`
  if (size < 1024 ** 3) return `${(size / 1024 ** 2).toFixed(1)} MB`
  return `${(size / 1024 ** 3).toFixed(2)} GB`
}

function formatTaskDuration(durationMs) {
  if (!Number.isFinite(durationMs) || durationMs < 0) return ''
  const seconds = Math.floor(durationMs / 1000)
  if (seconds < 60) return `${Math.max(1, seconds)}秒`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}分${seconds % 60}秒`
  return `${Math.floor(seconds / 3600)}小时${String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')}分`
}

async function refreshTasks() {
  try {
    const response = await fetch('/api/tasks')
    if (!response.ok) throw new Error('任务列表读取失败')
    const result = await response.json()
    tasks.value = result.tasks || []
    const completedTranscripts = tasks.value.filter((task) => task.mode === 'transcript' && task.status === 'completed').map((task) => task.id).join(',')
    if (completedTranscripts !== transcriptTaskSignature) {
      transcriptTaskSignature = completedTranscripts
      await refreshTranscriptLibrary()
    }
    return true
  } catch {
    return false
  }
}

async function addSingleTask(mode = batchAction.value) {
  if (!['video', 'audio', 'transcript'].includes(mode) || !singleVideo.value.bvid) return
  try {
    const response = await fetch('/api/tasks', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: singleVideo.value.url || url.value, title: singleVideo.value.title, owner: singleVideo.value.owner, mode }),
    })
    const result = await response.json()
    if (!response.ok) throw new Error(result.error?.message || '创建下载任务失败。')
    await refreshTasks()
    notify(`已加入${taskNames[mode]}队列`)
  } catch (error) {
    notify(error.message || '本地服务未连接，无法创建下载任务。')
  }
  page.value = 'tasks'
}

async function createBatchTasks() {
  if (!['video', 'audio', 'transcript'].includes(batchAction.value)) return
  const selected = (creatorData.value?.videos || []).filter((video) => selectedVideoIds.value.has(video.id))
  if (!selected.length) return
  try {
    const response = await fetch('/api/tasks/batch', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: batchAction.value, videos: selected.map((video) => {
        const group = creatorGroups.value.find((item) => item.videos.some((entry) => entry.id === video.id))
        return { bvid: video.bvid, title: video.title, owner: video.owner, creatorName: creator.value.name, groupName: group?.title || '其他视频' }
      }) }),
    })
    const result = await response.json()
    if (!response.ok) throw new Error(result.error?.message || '批量创建任务失败。')
    await refreshTasks()
    page.value = 'tasks'
    notify(`已创建 ${result.tasks?.length || selected.length} 个${taskNames[batchAction.value]}任务`)
  } catch (error) {
    notify(error.message || '本地服务未连接，无法创建下载任务。')
  }
}

async function cancelTask(task) {
  try {
    const response = await fetch(`/api/tasks/${task.id}/cancel`, { method: 'POST' })
    const result = await response.json()
    if (!response.ok) throw new Error(result.error?.message || '取消任务失败。')
    await refreshTasks()
    notify(task.mode === 'transcript' ? '已请求取消转写，队列会继续执行' : '已请求取消，队列会继续执行')
  } catch (error) { notify(error.message || '取消任务失败。') }
}
const confirmation = ref(null)
const confirmationTitle = computed(() => confirmation.value?.type === 'clear-history' ? '清除任务历史？' : '取消当前任务？')
const confirmationMessage = computed(() => confirmation.value?.type === 'clear-history' ? '已完成、失败和已取消的任务记录将从列表中移除。' : '当前任务会立即停止，队列中的下一项将自动开始。')
function requestClearHistory() { confirmation.value = { type: 'clear-history' } }
function requestCancelRunning(task) { confirmation.value = { type: 'cancel-running', task } }
function confirmAction() {
  const action = confirmation.value
  confirmation.value = null
  if (!action) return
  if (action.type === 'clear-history') clearHistory()
  else cancelTask(action.task)
}
async function removeWaitingTask(task) {
  if (task.status !== 'waiting') return
  try {
    const response = await fetch(`/api/tasks/${task.id}`, { method: 'DELETE' })
    if (!response.ok) throw new Error('移除等待任务失败。')
    await refreshTasks()
    notify('已从等待队列移除')
  } catch (error) { notify(error.message || '移除任务失败。') }
}
async function retryTask(task) {
  if (task.status !== 'failed') return
  try {
    const response = await fetch(`/api/tasks/${task.id}/retry`, { method: 'POST' })
    const result = await response.json()
    if (!response.ok) throw new Error(result.error?.message || '重试任务失败。')
    await refreshTasks()
    notify('任务已重新加入队列')
  } catch (error) { notify(error.message || '重试任务失败。') }
}
async function clearHistory() {
  try {
    const response = await fetch('/api/tasks/history', { method: 'DELETE' })
    if (!response.ok) throw new Error('清除任务历史失败。')
    await refreshTasks()
    notify('已清除任务历史')
  } catch (error) { notify(error.message || '清除任务历史失败。') }
}

async function openTaskLocation(task) {
  try {
    const response = await fetch(`/api/tasks/${task.id}/open`, { method: 'POST' })
    const result = await response.json()
    if (!response.ok) throw new Error(result.error?.message || '无法打开文件位置。')
    notify(result.located ? '已打开并定位到文件' : '已打开保存目录')
  } catch (error) { notify(error.message || '无法打开文件位置。') }
}

function formatViews(value) {
  const views = Number(value) || 0
  return views >= 10000 ? `${(views / 10000).toFixed(1).replace(/\.0$/, '')} 万` : views.toLocaleString('zh-CN')
}
function hideLoginAvatar() {
  if (loginAccount.value) loginAccount.value = { ...loginAccount.value, avatar: '' }
}

const transcripts = ref([])
const activeTranscriptId = ref('')
const transcriptQuery = ref('')
const visibleTranscripts = computed(() => transcripts.value.filter((item) => `${item.title} ${item.creator}`.toLowerCase().includes(transcriptQuery.value.trim().toLowerCase())))
const activeTranscript = computed(() => transcripts.value.find((item) => item.id === activeTranscriptId.value) || transcripts.value[0] || null)
let transcriptTaskSignature = ''
async function refreshTranscriptLibrary() {
  try {
    const response = await fetch('/api/transcripts')
    if (!response.ok) return
    const result = await response.json()
    transcripts.value = result.transcripts || []
    if (!transcripts.value.some((item) => item.id === activeTranscriptId.value)) activeTranscriptId.value = transcripts.value[0]?.id || ''
  } catch { /* library appears when local service is available */ }
}
function formatTranscriptDate(value) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString('zh-CN')
}
async function copyTranscript() {
  if (!activeTranscript.value) return
  try {
    await navigator.clipboard.writeText(activeTranscript.value.text)
    notify('全文已复制')
  } catch { notify('浏览器未授权剪贴板，请手动选择正文复制') }
}
function exportTranscript() {
  if (!activeTranscript.value) return
  const file = new Blob([activeTranscript.value.text], { type: 'text/plain;charset=utf-8' })
  const downloadUrl = URL.createObjectURL(file)
  const link = document.createElement('a')
  link.href = downloadUrl
  link.download = `${activeTranscript.value.title}.txt`
  link.click()
  URL.revokeObjectURL(downloadUrl)
  notify('TXT 已导出')
}

const loginState = ref(false)
const qrDialog = ref(false)
const loginAccount = ref(null)
const loginLoading = ref(false)
const qrStarting = ref(false)
const qrImage = ref('')
const qrSessionId = ref('')
const qrStatus = ref('idle')
const qrMessage = ref('')
const logoutConfirm = ref(false)
let qrPollTimer
let qrPollInFlight = false
let qrSuccessCloseTimer
const qrStatusLabel = computed(() => ({
  idle: '准备生成二维码', loading: '正在生成二维码…', waitingScan: '等待扫码',
  waitingConfirm: '已扫码，请在手机上确认', success: '登录成功', expired: '二维码已过期', failed: '登录失败',
}[qrStatus.value] || '等待扫码'))
const confirmationDialog = computed(() => !!confirmation.value)
const apiKey = ref('')
const showApiKey = ref(false)
const apiKeyConfigured = ref(false)
const apiKeyMask = ref('')
const apiTesting = ref(false)
const apiTested = ref(false)
const settingsSaved = ref(false)
const downloadPath = ref('')
const transcriptPath = ref('')
let settingsSaveTimer
let settingsSavedTimer
let settingsSaveQueue = Promise.resolve()
let settingsReady = false
const backendStatus = ref('connecting')
const bbdownAvailable = ref(null)
const bbdownVersion = ref('')
const logPath = ref('项目目录/logs/biliscribe.log')
const logAvailable = ref(false)
const logLineCount = ref(0)
const logLoading = ref(false)
async function refreshSettings() {
  try {
    const response = await fetch('/api/settings')
    if (!response.ok) return
    const result = await response.json()
    downloadPath.value = result.downloadDirectory || ''
    transcriptPath.value = result.transcriptDirectory || ''
    settingsReady = true
    apiKeyConfigured.value = !!result.mimoApiKeyConfigured
    apiKeyMask.value = result.mimoApiKeyMask || ''
  } catch { /* settings appear when local service is available */ }
}
function markSettingsSaved() {
  settingsSaved.value = true
  clearTimeout(settingsSavedTimer)
  settingsSavedTimer = setTimeout(() => { settingsSaved.value = false }, 1800)
}

async function openTranscriptTask(task) {
  if (task.status !== 'completed' || task.mode !== 'transcript') return
  const transcriptId = task.transcriptId || task.id
  await refreshTranscriptLibrary()
  if (!transcripts.value.some((item) => item.id === transcriptId)) {
    notify('找不到此任务对应的文字稿。')
    return
  }
  transcriptQuery.value = ''
  activeTranscriptId.value = transcriptId
  page.value = 'transcripts'
}

function saveSettings(options = {}) {
  const save = () => persistSettings(options)
  const pending = settingsSaveQueue.then(save, save)
  settingsSaveQueue = pending.catch(() => false)
  return pending
}

async function persistSettings({ quiet = true } = {}) {
  try {
    const response = await fetch('/api/settings', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ downloadDirectory: downloadPath.value, transcriptDirectory: transcriptPath.value, apiKey: apiKey.value.trim() || undefined }),
    })
    const result = await response.json()
    if (!response.ok) throw new Error(result.error?.message || '设置保存失败。')
    downloadPath.value = result.downloadDirectory
    transcriptPath.value = result.transcriptDirectory
    apiKey.value = ''
    apiKeyConfigured.value = !!result.mimoApiKeyConfigured
    apiKeyMask.value = result.mimoApiKeyMask || ''
    markSettingsSaved()
    if (!quiet) notify('设置已保存到本机')
    return true
  } catch (error) {
    settingsSaved.value = false
    notify(error.message || '保存设置失败。')
    return false
  }
}

function saveApiKeyOnBlur() {
  if (!apiKey.value.trim()) return
  setTimeout(() => {
    if (!apiTesting.value && apiKey.value.trim()) void saveSettings({ quiet: true })
  }, 0)
}

watch([downloadPath, transcriptPath], () => {
  if (!settingsReady) return
  settingsSaved.value = false
  clearTimeout(settingsSaveTimer)
  settingsSaveTimer = setTimeout(() => { void saveSettings({ quiet: true }) }, 500)
})

async function refreshLoginStatus() {
  loginLoading.value = true
  try {
    const response = await fetch('/api/bilibili/login')
    if (!response.ok) throw new Error('登录状态读取失败')
    const result = await response.json()
    loginState.value = !!result.loggedIn
    loginAccount.value = result.account || null
  } catch {
    loginState.value = false
    loginAccount.value = null
  } finally {
    loginLoading.value = false
  }
}

function stopQrPolling() {
  clearInterval(qrPollTimer)
  qrPollTimer = undefined
}

function closeQrDialog() {
  stopQrPolling()
  clearTimeout(qrSuccessCloseTimer)
  qrDialog.value = false
}

async function startQrLogin() {
  stopQrPolling()
  qrStarting.value = true
  qrImage.value = ''
  qrSessionId.value = ''
  qrStatus.value = 'loading'
  qrMessage.value = ''
  try {
    const response = await fetch('/api/bilibili/login/qr', { method: 'POST' })
    const result = await response.json()
    if (!response.ok) throw new Error(result.error?.message || '二维码生成失败，请重试。')
    qrImage.value = result.qrDataUrl
    qrSessionId.value = result.sessionId
    qrStatus.value = 'waitingScan'
    qrPollTimer = setInterval(pollQrLogin, 1800)
  } catch (error) {
    qrStatus.value = 'failed'
    qrMessage.value = error.message || '二维码生成失败，请检查本地服务后重试。'
  } finally {
    qrStarting.value = false
  }
}

async function openQrDialog() {
  qrDialog.value = true
  await startQrLogin()
}

async function pollQrLogin() {
  if (!qrSessionId.value || qrStarting.value || qrPollInFlight) return
  qrPollInFlight = true
  try {
    const response = await fetch(`/api/bilibili/login/qr/${qrSessionId.value}`)
    const result = await response.json()
    if (!response.ok) throw new Error(result.error?.message || '扫码状态读取失败。')
    qrStatus.value = result.state || 'failed'
    qrMessage.value = result.message || ''
    if (result.state === 'success') {
      stopQrPolling()
      qrStatus.value = 'success'
      qrMessage.value = '登录成功'
      loginState.value = true
      await refreshLoginStatus()
      loginState.value = true
      if (result.account) loginAccount.value = { ...(loginAccount.value || {}), ...result.account }
      notify(loginAccount.value?.name ? `已登录：${loginAccount.value.name}` : 'B 站登录成功')
      clearTimeout(qrSuccessCloseTimer)
      qrSuccessCloseTimer = setTimeout(() => { if (qrDialog.value) closeQrDialog() }, 800)
    } else if (['expired', 'failed'].includes(result.state)) {
      stopQrPolling()
    }
  } catch (error) {
    stopQrPolling()
    qrStatus.value = 'failed'
    qrMessage.value = error.message || '扫码状态读取失败，请刷新二维码重试。'
  } finally {
    qrPollInFlight = false
  }
}

async function logoutBilibili() {
  try {
    const response = await fetch('/api/bilibili/logout', { method: 'POST' })
    const result = await response.json()
    if (!response.ok) throw new Error(result.error?.message || '退出登录失败。')
    loginState.value = false
    loginAccount.value = null
    logoutConfirm.value = false
    notify('已退出 B 站登录')
  } catch (error) {
    logoutConfirm.value = false
    notify(error.message || '退出登录失败，请稍后重试')
  }
}

async function testApi() {
  if (!apiKey.value.trim() && !apiKeyConfigured.value) { apiTested.value = false; notify('请先填写 MiMo API Key'); return }
  const testingKey = apiKey.value.trim()
  apiTesting.value = true
  apiTested.value = false
  try {
    const response = await fetch('/api/settings/mimo/test', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: testingKey }),
    })
    const result = await response.json()
    if (!response.ok) throw new Error(result.error?.message || '连接测试失败，请检查设置。')
    if (testingKey && !(await saveSettings({ quiet: true }))) throw new Error('连接成功，但 API Key 未能保存到本机。')
    else await refreshSettings()
    apiTested.value = true
    notify('MiMo 连接成功，Key 已保存在本机')
  } catch (error) {
    notify(error.message || 'MiMo 连接失败，请稍后重试。')
  } finally { apiTesting.value = false }
}
async function refreshLogPreview() {
  logLoading.value = true
  try {
    const response = await fetch('/api/logs/recent')
    if (!response.ok) throw new Error('日志读取失败')
    const result = await response.json()
    backendStatus.value = 'online'
    logPath.value = result.logPath || logPath.value
    logAvailable.value = result.available
    logLineCount.value = result.lines || 0
    return result
  } catch {
    backendStatus.value = 'offline'
    logAvailable.value = false
    logLineCount.value = 0
    return null
  } finally {
    logLoading.value = false
  }
}

async function refreshBackendStatus() {
  try {
    const response = await fetch('/api/health')
    if (!response.ok) throw new Error('本地后台不可用')
    const result = await response.json()
    backendStatus.value = 'online'
    bbdownAvailable.value = result.bbdownAvailable
    bbdownVersion.value = result.bbdownVersion || ''
    logPath.value = result.logPath || logPath.value
    await refreshLogPreview()
  } catch {
    backendStatus.value = 'offline'
    bbdownAvailable.value = false
    bbdownVersion.value = ''
    logAvailable.value = false
  }
}

async function copyRecentLogs() {
  const result = await refreshLogPreview()
  if (!result?.available) { notify(backendStatus.value === 'online' ? '当前没有可复制的日志' : '本地后台未运行，无法读取日志'); return }
  try {
    await navigator.clipboard.writeText(result.content)
    notify(`已复制最近 ${result.lines} 行日志`)
  } catch {
    notify('浏览器未授权剪贴板，请检查剪贴板权限后重试')
  }
}

async function exportLogs() {
  try {
    const response = await fetch('/api/logs/export')
    if (response.status === 404) { notify('当前没有可导出的日志'); return }
    if (!response.ok) throw new Error('日志导出失败')
    const fileUrl = URL.createObjectURL(await response.blob())
    const link = document.createElement('a')
    link.href = fileUrl
    link.download = 'biliscribe.log'
    link.click()
    URL.revokeObjectURL(fileUrl)
    notify('完整日志已导出')
  } catch {
    notify('本地后台未运行，无法导出日志')
  }
}

async function openLogDirectory() {
  try {
    const response = await fetch('/api/logs/open', { method: 'POST' })
    const result = await response.json()
    if (!response.ok) throw new Error(result.error?.message || '无法打开日志目录')
    notify('已打开日志目录')
  } catch {
    notify(backendStatus.value === 'online' ? '打开日志目录失败' : '本地后台未运行，无法打开日志目录')
  }
}

watch(page, (value) => { if (value === 'transcripts') refreshTranscriptLibrary(); if (value === 'settings') refreshSettings() })
onMounted(() => { refreshBackendStatus(); refreshLoginStatus(); refreshSettings(); refreshTasks(); taskPollTimer = setInterval(refreshTasks, 1200) })
onUnmounted(() => { clearInterval(taskPollTimer); clearInterval(qrPollTimer); clearTimeout(qrSuccessCloseTimer); clearTimeout(toastTimer); clearTimeout(settingsSaveTimer); clearTimeout(settingsSavedTimer) })
</script>

<template>
  <div class="app-shell">
    <aside class="sidebar">
      <div class="brand-lockup">
        <div class="brand-mark"><span></span><span></span><span></span></div>
        <div class="brand-copy"><strong>BiliScribe</strong><span>视频 · 文字稿工作台</span></div>
        <button class="icon-button sidebar-collapse" aria-label="收起侧边栏"><PanelLeftClose :size="17" /></button>
      </div>

      <div class="workspace-label">工作区</div>
      <nav class="main-nav" aria-label="主导航">
        <button v-for="item in navItems" :key="item.id" class="nav-item" :class="{ active: page === item.id }" @click="page = item.id">
          <component :is="item.icon" :size="18" :stroke-width="1.8" />
          <span>{{ item.label }}</span>
          <span v-if="item.id === 'tasks' && queueCount" class="nav-badge">{{ queueCount + (runningTask ? 1 : 0) }}</span>
        </button>
      </nav>

      <div class="sidebar-spacer"></div>
      <div class="sidebar-queue-card">
        <div class="queue-card-top"><span class="live-dot"></span><span>任务队列</span><span class="queue-count">{{ queueCount + (runningTask ? 1 : 0) }}</span></div>
        <div class="queue-card-title">{{ runningTask ? '正在处理任务' : '队列空闲' }}</div>
        <div class="queue-card-meta"><span>{{ runningTask ? (runningTask.phase || taskNames[runningTask.mode]) : '等待添加任务' }}</span><span v-if="runningTask">{{ taskNames[runningTask.mode] }}</span></div>
      </div>
      <div class="sidebar-footer"><span class="avatar">B</span><div><strong>本机工作区</strong><span>本地 UI 原型</span></div><button class="icon-button"><MoreHorizontal :size="18" /></button></div>
    </aside>

    <main class="main-area">
      <header class="topbar">
        <div class="breadcrumbs"><span>工作区</span><ChevronRight :size="14" /><strong>{{ navItems.find((item) => item.id === page)?.label }}</strong></div>
        <div class="topbar-actions"><span class="prototype-pill"><span></span>本地原型</span></div>
      </header>

      <div class="page-scroll">
        <section v-if="page === 'new'" class="page-content new-page">
          <div class="page-heading">
            <div><div class="eyebrow">BILISCRIBE WORKSPACE</div><h1>新建任务</h1><p>粘贴视频或 UP 主链接，选择你要处理的内容。</p></div>
            <div class="heading-note"><ShieldCheck :size="16" /><span>所有操作均在本机进行</span></div>
          </div>

          <div class="link-panel panel">
            <div class="link-panel-title"><div class="step-icon"><Link2 :size="18" /></div><div><strong>添加 B 站链接</strong><span>支持单个视频或 UP 主主页</span></div><span class="supported-tag">Bilibili</span></div>
            <div class="link-entry"><div class="url-input-wrap"><Link2 :size="17" /><input v-model="url" aria-label="B站视频或UP主主页链接" placeholder="粘贴 B 站视频或 UP 主主页链接" @keydown.enter="parseLink" /><button v-if="url" class="input-clear" aria-label="清空链接" @click="url = ''"><X :size="15" /></button></div><button class="primary-button parse-button" :disabled="isParsing" @click="parseLink"><LoaderCircle v-if="isParsing" class="spin" :size="16" /><Search v-else :size="16" />{{ isParsing ? '解析中' : '解析链接' }}</button></div>
            <div class="demo-hints"><span class="hint-label">快速测试</span><button @click="setDemoLink('video')">测试视频</button><i></i><button @click="setDemoLink('creator')">测试 UP 主</button><i></i><button @click="setDemoLink('failed')">无效视频</button><i></i><button @click="setDemoLink('invalid')">非法链接</button><span class="hint-footnote">通过本地后台读取 B 站公开信息</span></div>
          </div>

          <div v-if="parseState !== 'success'" class="empty-state panel parse-state" :class="{ 'parse-loading': parseState === 'loading' }"><div class="empty-state-icon"><LoaderCircle v-if="parseState === 'loading'" class="spin" :size="19" /><XCircle v-else-if="parseState === 'invalid' || parseState === 'failed'" :size="19" /><Link2 v-else :size="19" /></div><strong>{{ parseState === 'loading' ? (isCreatorInput ? '正在解析 UP 主主页' : '正在解析视频') : parseState === 'empty' ? '请先粘贴 B 站链接' : parseState === 'idle' ? '等待解析' : parseErrorKind === 'backend_unavailable' ? '本地后台未连接' : parseErrorKind === 'bbdown_unavailable' ? 'BBDownNext 未就绪' : parseState === 'invalid' ? '链接无效或暂不支持' : '解析失败' }}</strong><span>{{ parseState === 'loading' ? (isCreatorInput ? '正在读取 UP 主资料、视频列表和合集，请稍候。' : '正在调用本地后台解析视频信息。') : parseState === 'empty' ? '粘贴 B 站视频或 UP 主主页链接，再点击“解析链接”。' : parseState === 'idle' ? '输入 B 站视频或 UP 主主页链接后开始解析。' : parseErrorMessage || '请检查链接后重试。' }}</span><button v-if="parseState === 'failed' && parseErrorKind !== 'backend_unavailable' && parseErrorKind !== 'bbdown_unavailable' && parseErrorKind !== 'bilibili_login_expired'" class="outline-button empty-retry" @click="parseLink"><RefreshCw :size="14" />重试解析</button><button v-if="parseErrorKind === 'bilibili_login_expired'" class="outline-button empty-retry" @click="page = 'settings'"><ScanLine :size="14" />前往设置重新扫码</button></div>

          <template v-else-if="resultType === 'creator'">
            <div class="creator-panel panel">
              <div class="creator-cover"><div class="creator-cover-decoration"></div><div class="creator-profile"><div class="creator-avatar"><img v-if="creator.avatar && !creatorAvatarFailed" :src="creator.avatar" alt="" @error="creatorAvatarFailed = true" /><span v-else>{{ creator.name?.slice(0, 1) || 'UP' }}</span><span class="verified"><Check :size="10" /></span></div><div class="creator-main"><div class="creator-name-row"><h2>{{ creator.name }}</h2><span class="up-tag">UP 主</span></div><div class="creator-description">{{ creator.description || 'B 站 UP 主主页' }}</div><div class="creator-id">UID：{{ creator.uid }} <span>·</span> 粉丝 {{ formatViews(creator.followers) }}</div></div></div><div class="creator-stats"><div><strong>{{ creator.videoCount }}</strong><span>投稿视频</span></div><div><strong>{{ creator.collectionCount }}</strong><span>合集 / 系列</span></div></div></div>
              <div class="creator-toolbar">
                <div class="toolbar-left"><h3>视频与合集</h3><span class="toolbar-count">{{ creator.videoCount }} 个投稿视频</span><span class="toolbar-divider"></span><button class="text-action" @click="selectAll"><CheckCheck :size="15" />{{ creatorSearch.trim() ? '全选筛选结果' : '全选全部结果' }} <small>({{ creatorResultVideos.length }})</small></button><button class="text-action" @click="selectCurrentPage"><Check :size="15" />全选当前页</button><button class="text-action muted" @click="clearAll"><XCircle :size="15" />取消全部</button><button class="text-action muted" @click="clearCurrentPage"><X :size="15" />取消当前页</button></div><label class="creator-search"><Search :size="15" /><input v-model="creatorSearch" placeholder="搜索视频标题" aria-label="搜索视频标题" /><button v-if="creatorSearch" type="button" aria-label="清空搜索" @click="creatorSearch = ''"><X :size="13" /></button></label>
              </div>
              <div class="selection-line"><label class="check-label"><input type="checkbox" :checked="pageAllSelected" @change="$event.target.checked ? selectCurrentPage() : clearCurrentPage()" /><span class="custom-check"><Check :size="12" /></span><span>本页全选</span></label><span v-if="creatorResultVideos.length">第 {{ currentPage }} 页 · {{ pageVideos.length }} 个视频</span><span v-else>当前没有匹配的视频</span><span v-if="allSelected" class="selection-success">已选择全部 {{ creatorResultVideos.length }} 个匹配视频</span><span v-else-if="selectedCount" class="selection-count">已选 {{ selectedCount }} 个<span>{{ creatorSearch.trim() ? '（包含筛选外选择）' : '（所有页面）' }}</span></span></div>

              <div v-if="creatorResultVideos.length" class="album-list">
                <article v-for="album in currentAlbums" :key="album.id" class="album-card">
                  <div class="album-heading">
                    <label class="album-check check-label" :title="`选择${album.title}中的${creatorSearch.trim() ? '匹配' : '全部'}视频`"><input type="checkbox" :checked="albumChecked(album)" @change="toggleAlbumSelection(album)" /><span class="custom-check"><Check :size="12" /></span></label>
                    <button class="album-cover thumb-art" @click="toggleAlbum(album)"><span class="art-orbit"></span><span class="art-copy"><small>{{ album.kind === 'other' ? '投稿' : album.kind === 'series' ? '系列' : '合集' }}</small><b>{{ album.title }}</b></span><img v-if="album.cover" class="thumb-real-image" :src="album.cover" alt="" @load="$event.target.parentElement.classList.add('image-loaded')" @error="$event.target.style.display = 'none'" /><span class="album-cover-count">{{ album.total }} 个视频</span></button>
                    <button class="album-info" @click="toggleAlbum(album)"><span class="album-title-row"><strong>{{ album.title }}</strong><span class="album-tag"><Archive :size="12" />{{ album.kind === 'other' ? '其他视频' : album.kind === 'series' ? '系列' : '合集' }}</span></span><span class="album-subtitle">共 {{ album.total }} 个视频 <i>·</i> {{ album.owner }}</span></button>
                    <button class="album-expand" @click="toggleAlbum(album)"><span>{{ expandedAlbums.has(album.id) ? '收起' : '展开' }}</span><ChevronDown :size="16" :class="{ rotated: expandedAlbums.has(album.id) }" /></button>
                  </div>
                  <div v-if="expandedAlbums.has(album.id)" class="video-list">
                    <div v-for="video in album.pageVideos" :key="`${album.id}-${video.id}`" class="video-row" :class="{ selected: selectedVideoIds.has(video.id) }">
                      <label class="check-label video-checkbox"><input type="checkbox" :checked="selectedVideoIds.has(video.id)" @change="toggleVideo(video.id)" /><span class="custom-check"><Check :size="12" /></span></label>
                      <div class="video-thumb thumb-art"><span class="art-orbit"></span><span class="art-copy"><small>{{ video.bvid }}</small><b>{{ video.title }}</b></span><img v-if="video.cover" class="thumb-real-image" :src="video.cover" alt="" @load="$event.target.parentElement.classList.add('image-loaded')" @error="$event.target.style.display = 'none'" /><span class="thumb-duration">{{ video.duration }}</span></div>
                      <div class="video-details"><strong>{{ video.title }}</strong><div class="video-meta"><span><UserRound :size="12" />{{ video.owner }}</span><span><CirclePlay :size="12" />{{ formatViews(video.views) }} 播放</span><span>{{ video.date }}</span></div></div>
                      <div class="video-trailing"><span class="format-label"><Video :size="13" />视频</span><button class="icon-button row-more" title="更多操作"><MoreHorizontal :size="17" /></button></div>
                    </div>
                  </div>
                </article>
              </div>
              <div v-else class="empty-state search-empty"><div class="empty-state-icon"><Search :size="18" /></div><strong>没有找到匹配的视频</strong><span>试试其他标题关键词。</span></div>
              <div v-if="creatorResultVideos.length" class="list-footer"><div class="result-count">共 <strong>{{ creatorResultVideos.length }}</strong> 个匹配视频，分为 <strong>{{ pageCount }}</strong> 页</div><div class="pagination"><button class="page-arrow" :disabled="currentPage === 1" aria-label="上一页" @click="currentPage--"><ChevronLeft :size="16" /></button><button v-for="number in pageNumbers" :key="number" class="page-number" :class="{ active: currentPage === number }" @click="currentPage = number">{{ number }}</button><button class="page-arrow" :disabled="currentPage === pageCount" aria-label="下一页" @click="currentPage++"><ChevronRight :size="16" /></button><span class="page-total">第 {{ currentPage }} / {{ pageCount }} 页</span></div></div>
            </div>
          </template>

          <div v-else class="single-result panel">
            <div class="section-heading"><div><div class="eyebrow">解析结果</div><h2>单个视频</h2></div><span class="result-chip"><Check :size="14" />已识别</span></div>
            <div class="single-video-card"><div class="single-cover thumb-art" :class="singleVideo.cover && !singleCoverFailed ? 'has-real-cover' : 'cover-unavailable'"><img v-if="singleVideo.cover && !singleCoverFailed" class="real-cover" :src="singleVideo.cover" alt="视频封面" @error="singleCoverFailed = true" /><span v-else class="cover-placeholder">封面暂不可用</span><span class="thumb-duration">{{ singleVideo.duration }}</span></div><div class="single-video-info"><span class="video-eyebrow"><Radio :size="13" />真实解析结果</span><h3>{{ singleVideo.title }}</h3><div class="single-meta"><span><UserRound :size="14" />{{ singleVideo.owner }}</span><span v-if="singleVideo.bvid">{{ singleVideo.bvid }}</span><span v-if="singleVideo.date">{{ singleVideo.date }}</span><span v-if="singleVideo.views !== null">{{ Number(singleVideo.views).toLocaleString('zh-CN') }} 播放</span></div><div class="single-divider"></div><div class="mode-label">选择处理方式</div><div class="mode-options"><button v-for="mode in modeOptions" :key="mode.id" class="mode-option" :class="{ active: batchAction === mode.id, disabled: mode.disabled }" :disabled="mode.disabled" :title="mode.disabled ? '文字稿功能将在后续版本接入' : ''" @click="batchAction = mode.id"><component :is="mode.icon" :size="17" /><span>{{ mode.label }}</span><span v-if="mode.disabled" class="mode-disabled-label">下一阶段</span><span v-else class="mode-radio"><i></i></span></button></div><button class="primary-button single-action" @click="addSingleTask(batchAction)"><Plus :size="16" />创建任务</button></div></div>
          </div>
        </section>

        <section v-else-if="page === 'tasks'" class="page-content tasks-page">
          <div class="task-page-heading"><div class="page-heading"><div><div class="eyebrow">DOWNLOADS</div><h1>任务</h1></div><div class="task-heading-tools"><div class="task-statistics"><span>正在处理 <strong>{{ runningTask ? 1 : 0 }}</strong></span><i></i><span>已完成 <strong>{{ completedCount }}</strong></span><i></i><span>失败 <strong>{{ failedCount }}</strong></span></div><button class="outline-button" :disabled="!historyTasks.length" @click="requestClearHistory"><Trash2 :size="15" />清空记录</button></div></div><p class="task-serial-hint">一次处理一个任务，完成后自动继续下一项。</p></div>
          <div class="task-section panel">
            <div class="task-toolbar"><div class="filter-tabs"><button :class="{ active: taskTab === 'active' }" @click="taskTab = 'active'">正在处理<span v-if="activeTasks.length">{{ activeTasks.length }}</span></button><button :class="{ active: taskTab === 'history' }" @click="taskTab = 'history'">已完成<span v-if="historyTasks.length">{{ historyTasks.length }}</span></button></div></div>
            <div v-if="taskTab === 'active'" class="download-list">
              <div v-if="runningTask" class="download-row running-row"><div class="task-type-icon" :class="runningTask.mode"><component :is="taskIcon[runningTask.mode]" :size="19" /></div><div class="download-task-main"><div class="download-task-title"><strong>{{ runningTask.title }}</strong><span class="download-mode">{{ taskNames[runningTask.mode] }}</span></div><div class="download-phase"><span class="task-status running">{{ runningTask.phase || '准备中' }}</span><span v-if="runningTask.mode === 'transcript' && runningTask.transcriptProgress?.generatedCharacters">已生成 {{ runningTask.transcriptProgress.generatedCharacters }} 字</span><span v-else>{{ runningTask.owner }}</span></div><div class="download-progress-track" role="progressbar" aria-label="下载处理中"><span v-if="typeof runningTask.progress === 'number'" :style="{ width: `${runningTask.progress}%` }"></span><i v-else></i></div><span v-if="typeof runningTask.progress === 'number'" class="real-progress-label">{{ runningTask.progress }}%</span></div><button class="cancel-button" :disabled="runningTask.phase === '正在取消'" @click="requestCancelRunning(runningTask)"><X :size="14" />{{ runningTask.phase === '正在取消' ? '正在取消' : '取消' }}</button></div>
              <div v-for="(task, index) in waitingTasks" :key="task.id" class="download-row waiting-row"><div class="queue-index">{{ String(index + 1).padStart(2, '0') }}</div><div class="task-type-icon" :class="task.mode"><component :is="taskIcon[task.mode]" :size="18" /></div><div class="download-task-main"><div class="download-task-title"><strong>{{ task.title }}</strong><span class="download-mode">{{ taskNames[task.mode] }}</span></div><div class="download-phase"><span class="task-status waiting">等待中</span><span>{{ task.owner }}</span></div></div><button class="remove-button" @click="removeWaitingTask(task)"><Trash2 :size="14" />移除</button></div>
              <div v-if="!activeTasks.length" class="empty-state task-empty"><div class="empty-state-icon"><ListChecks :size="19" /></div><strong>当前没有待处理任务</strong><span>新建下载或转写任务后会在这里显示。</span></div>
            </div>
            <div v-else class="download-list history-download-list">
              <div v-for="task in historyTasks" :key="task.id" class="download-row history-row" :class="{ 'transcript-history-row': task.status === 'completed' && task.mode === 'transcript' }" @click="openTranscriptTask(task)"><div class="task-type-icon" :class="task.mode"><component :is="taskIcon[task.mode]" :size="18" /></div><div class="download-task-main"><div class="download-task-title"><strong>{{ task.title }}</strong><span class="download-mode">{{ taskNames[task.mode] }}</span><span class="task-status" :class="task.status">{{ task.status === 'completed' ? '已完成' : task.status === 'failed' ? '失败' : '已取消' }}</span></div><div v-if="task.status === 'completed'" class="history-task-meta"><span>{{ formatFileSize(task.fileSize) }}</span><i></i><span>{{ formatTaskDate(task.completedAt) }}</span><template v-if="Number.isFinite(task.durationMs) && task.durationMs >= 0"><i></i><span>耗时 {{ formatTaskDuration(task.durationMs) }}</span></template></div><div v-else-if="task.status === 'failed'" class="history-task-error">{{ task.error || '下载失败，可重试。' }}</div><div v-else class="history-task-meta"><span>已取消</span><i></i><span>{{ formatTaskDate(task.completedAt) }}</span></div></div><button v-if="task.status === 'completed'" class="outline-button task-open-button" @click.stop="openTaskLocation(task)"><FolderOpen :size="14" />打开位置</button><button v-if="task.status === 'failed' || (task.status === 'cancelled' && task.mode === 'transcript')" class="retry-button" @click.stop="retryTask(task)"><RefreshCw :size="14" />{{ task.status === 'cancelled' ? '继续转写' : '重试' }}</button></div>
              <div v-if="!historyTasks.length" class="empty-state task-empty"><div class="empty-state-icon"><History :size="19" /></div><strong>暂无已完成的记录</strong><span>完成或失败的下载会保留在这里。</span></div>
            </div>
          </div>
        </section>

        <section v-else-if="page === 'transcripts'" class="page-content transcripts-page">
          <div class="page-heading"><div><div class="eyebrow">TRANSCRIPT LIBRARY</div><h1>文字稿</h1><p>查看、复制或导出已完成的文字稿。</p></div><div class="transcript-total"><BookOpenText :size="16" /><strong>{{ transcripts.length }}</strong> 篇文字稿</div></div>
          <div v-if="transcripts.length" class="transcript-workspace panel"><aside class="transcript-sidebar"><div class="transcript-sidebar-head"><div><strong>全部文字稿</strong><span>{{ transcripts.length }} 篇</span></div><button class="icon-button" title="搜索文字稿"><Search :size="16" /></button></div><div class="transcript-search"><Search :size="15" /><input v-model="transcriptQuery" placeholder="搜索标题或 UP 主" /></div><div class="transcript-items"><button v-for="item in visibleTranscripts" :key="item.id" class="transcript-item" :class="{ active: activeTranscriptId === item.id }" @click="activeTranscriptId = item.id"><span class="transcript-item-icon"><FileText :size="16" /></span><span class="transcript-item-copy"><strong>{{ item.title }}</strong><small>{{ item.creator }} <i>·</i> {{ formatTranscriptDate(item.completedAt) }}</small></span><ChevronRight :size="15" class="transcript-item-arrow" /></button><div v-if="!visibleTranscripts.length" class="empty-state transcript-no-results"><div class="empty-state-icon"><Search :size="15" /></div><strong>没有找到匹配的文字稿</strong><span>试试其他标题或 UP 主名称。</span></div></div><div class="transcript-sidebar-foot"><span class="storage-icon"><HardDriveDownload :size="15" /></span><span>文字稿保存位置</span><button @click="page = 'settings'">查看设置<ChevronRight :size="13" /></button></div></aside>
            <article class="transcript-reader"><div class="reader-top"><div class="reader-breadcrumb"><FileText :size="15" /><span>文字稿</span><ChevronRight :size="13" /><strong>{{ activeTranscript.title }}</strong></div><div class="reader-actions"><button class="outline-button" @click="copyTranscript"><Copy :size="15" />复制全文</button><button class="outline-button" @click="openTaskLocation({ id: activeTranscript.id })"><FolderOpen :size="15" />打开位置</button><button class="primary-button export-button" @click="exportTranscript"><Download :size="15" />导出 TXT</button></div></div><div class="reader-document"><div class="document-type"><span>课程转写</span><span class="document-dot"></span><span>完整文字稿</span></div><h2>{{ activeTranscript.title }}</h2><div class="document-meta"><span><UserRound :size="14" />{{ activeTranscript.creator }}</span><span><CalendarIcon />{{ formatTranscriptDate(activeTranscript.completedAt) }}</span><span><Clock3 :size="14" />{{ activeTranscript.wordCount }} 字</span></div><div class="document-rule"></div><div class="transcript-body"><p v-for="(paragraph, index) in activeTranscript.text.split('\n\n')" :key="index">{{ paragraph }}</p></div><div class="document-end"><span></span><small>正文结束</small><span></span></div></div><div class="reader-footer"><span><ShieldCheck :size="14" />保留讲师原话 · 未做总结和改写</span><span>共 {{ activeTranscript.wordCount }} 字</span></div></article></div>
          <div v-else class="empty-state panel transcript-page-empty"><div class="empty-state-icon"><BookOpenText :size="19" /></div><strong>还没有文字稿</strong><span>完成一次转写后，文字稿会显示在这里。</span></div>
        </section>

        <section v-else class="page-content settings-page">
          <div class="page-heading"><div><div class="eyebrow">PREFERENCES</div><h1>设置</h1><p>管理登录状态、转写服务和文件保存位置。</p></div><span v-if="settingsSaved" class="settings-saved"><Check :size="13" />已保存</span></div>
          <div class="settings-layout"><aside class="settings-nav panel"><span class="settings-nav-label">偏好设置</span><a class="settings-nav-item active"><UserRound :size="16" />账号与服务</a><a class="settings-nav-item"><FolderOpen :size="16" />文件与目录</a><a class="settings-nav-item"><SlidersIcon />任务处理</a><div class="settings-nav-divider"></div><div class="settings-nav-help"><CircleHelp :size="16" /><span>遇到问题？<small>查看使用说明</small></span><ExternalLink :size="13" /></div></aside><div class="settings-content">
            <section class="settings-card panel"><div class="settings-card-heading"><div class="settings-heading-icon bilibili-icon">哔</div><div><h2>B 站账号</h2><p>登录后可访问需要登录的视频内容</p></div><span class="settings-status" :class="loginState ? 'ok' : 'off'"><i></i>{{ loginLoading ? '检查中' : loginState ? '已登录' : '未登录' }}</span></div><div class="setting-divider"></div><div class="account-row"><div class="account-avatar"><img v-if="loginAccount?.avatar" :src="loginAccount.avatar" alt="" @error="hideLoginAvatar" />{{ !loginAccount?.avatar ? (loginState ? (loginAccount?.name?.slice(0, 1) || 'B') : 'B') : '' }}<span :class="{ online: loginState }"></span></div><div class="account-info"><strong>{{ loginAccount?.name || (loginState ? 'B 站账号' : '尚未登录 B 站') }}</strong><span>{{ loginAccount?.uid ? `UID：${loginAccount.uid}` : loginState ? '已使用本机保存的登录状态' : '扫码登录以使用完整解析能力' }}</span></div><button class="outline-button account-button" @click="openQrDialog"><ScanLine :size="15" />{{ loginState ? '重新登录' : '扫码登录' }}</button><button v-if="loginState" class="outline-button account-button logout-account-button" @click="logoutConfirm = true"><LogOut :size="15" />退出登录</button></div><div class="settings-tip"><ShieldCheck :size="15" /><span>登录凭据仅保存在本机，并由 BBDownNext 管理；公开视频仍可在未登录时解析。</span></div></section>
            <section class="settings-card panel"><div class="settings-card-heading"><div class="settings-heading-icon model-icon"><Sparkles :size="18" /></div><div><h2>文字稿模型</h2><p>用于将视频音频转换为课程文字稿</p></div><span class="fixed-tag"><LockKeyhole :size="12" />固定模型</span></div><div class="model-field"><label>模型</label><div class="model-select"><span class="model-dot"></span><strong>MiMo V2.6 Flash</strong><span class="model-subtle">快速 · 低成本</span><ChevronDown :size="16" /></div><small>转写结果忠实保留原话，不总结、不重写。</small></div><div class="api-key-field"><div class="api-label"><label for="api-key">MiMo API Key</label><a href="https://platform.xiaomimimo.com/console" target="_blank" rel="noreferrer">如何获取？<ExternalLink :size="12" /></a></div><div class="api-input-row"><div class="key-input"><KeyRound :size="16" /><input id="api-key" v-model="apiKey" :type="showApiKey ? 'text' : 'password'" autocomplete="off" :placeholder="apiKeyConfigured ? `已保存 ${apiKeyMask}，输入新 Key 可替换` : '输入你的 API Key'" @input="apiTested = false" @blur="saveApiKeyOnBlur" /><button type="button" class="key-visibility" :aria-label="showApiKey ? '隐藏 API Key' : '显示 API Key'" @click="showApiKey = !showApiKey"><component :is="showApiKey ? EyeOff : Eye" :size="15" /></button></div><button class="outline-button test-api-button" :disabled="apiTesting || (!apiKey.trim() && !apiKeyConfigured)" @click="testApi"><LoaderCircle v-if="apiTesting" class="spin" :size="15" /><Activity v-else :size="15" />{{ apiTesting ? '测试中' : '测试连接' }}</button></div><div class="api-feedback"><span v-if="apiTested" class="success-text"><Check :size="13" />连接成功</span><span v-else-if="apiKey.trim()"><CircleHelp :size="13" />Key 尚未验证</span><span v-else-if="apiKeyConfigured"><Check :size="13" />本机已保存 {{ apiKeyMask }}</span><span v-else><LockKeyhole :size="12" />尚未配置 API Key</span></div><div v-if="!apiKey.trim() && !apiKeyConfigured" class="empty-state api-empty-state"><div class="empty-state-icon"><KeyRound :size="16" /></div><strong>API 尚未配置</strong><span>填写 API Key 并测试连接后，会安全保存在本机。</span></div></div></section>
            <section class="settings-card panel"><div class="settings-card-heading"><div class="settings-heading-icon folder-icon"><FolderOpen :size="18" /></div><div><h2>文件与目录</h2><p>设置下载文件和文字稿的保存位置</p></div></div><div class="setting-divider"></div><div class="path-setting"><div><label>视频与音频目录</label><span>下载完成的媒体文件保存位置</span></div><div class="path-control"><input v-model="downloadPath" aria-label="视频与音频目录" /></div></div><div class="path-setting"><div><label>文字稿目录</label><span>转写完成后导出的 TXT 文件位置</span></div><div class="path-control"><input v-model="transcriptPath" aria-label="文字稿目录" /></div></div><div class="settings-tip folder-tip"><HardDriveDownload :size="15" /><span>保存后立即用于新下载任务；目录不存在时会自动创建；文字稿按 UP 主/合集或视频标题分类保存。</span></div></section>
            <section class="settings-card compact-settings panel"><div class="settings-card-heading"><div class="settings-heading-icon queue-icon"><ListChecks :size="18" /></div><div><h2>任务队列</h2><p>下载与转写任务使用同一个串行队列</p></div></div><div class="queue-setting-line"><span>同时执行的任务</span><span class="serial-value"><span class="live-dot"></span>1 个任务 <span class="locked-mini"><LockKeyhole :size="11" />第一版固定</span></span></div></section>
          <section class="settings-card debug-logs-card panel"><div class="settings-card-heading"><div class="settings-heading-icon logs-icon"><History :size="18" /></div><div><h2>调试与日志</h2><p>排查问题时可复制近期记录，或导出完整日志</p></div><span class="settings-status" :class="backendStatus === 'online' ? 'ok' : 'off'"><i></i>{{ backendStatus === 'online' ? '后台已连接' : '后台未运行' }}</span></div><div class="setting-divider"></div><div class="logs-location"><span>日志路径</span><code>{{ logPath }}</code></div><div class="logs-state"><span class="logs-state-dot" :class="backendStatus === 'online' && logAvailable ? 'ready' : ''"></span><span>{{ backendStatus !== 'online' ? '打开 BiliScribe 后即可查看日志。' : !logAvailable ? '日志文件目前为空，产生记录后即可使用日志工具。' : `日志已就绪 · 当前文件 ${logLineCount} 行` }}</span><small v-if="backendStatus === 'online'">{{ bbdownAvailable ? `BBDownNext v${bbdownVersion || '版本未知'} 已就绪` : '未找到 BBDownNext 可执行文件' }}</small></div><div class="logs-actions"><button class="outline-button" :disabled="backendStatus !== 'online' || !logAvailable || logLoading" @click="copyRecentLogs"><Copy :size="15" />复制最新日志</button><button class="outline-button" :disabled="backendStatus !== 'online' || !logAvailable" @click="exportLogs"><Download :size="15" />导出日志</button><button class="outline-button" :disabled="backendStatus !== 'online'" @click="openLogDirectory"><FolderOpen :size="15" />打开日志目录</button></div><p class="logs-note">日志保留最近约 300 行供复制；完整日志会自动轮换。日志中不会写入 API Key、B 站 Cookie 或访问令牌。</p></section>
          </div></div>
        </section>
      </div>
    </main>

    <div v-if="page === 'new' && parseState === 'success' && resultType === 'creator' && selectedCount" class="batch-bar"><div class="batch-selection"><div class="batch-selected-icon"><Check :size="16" /></div><div><strong>已选择 {{ selectedCount }} 个视频</strong><small v-if="creatorSearch.trim()">包含当前筛选外的选择</small><button @click="clearAll">清空选择</button></div></div><span class="batch-divider"></span><div class="batch-action-select"><span>添加为</span><button v-for="mode in modeOptions" :key="mode.id" :class="{ active: batchAction === mode.id, disabled: mode.disabled }" :disabled="mode.disabled" @click="batchAction = mode.id"><component :is="mode.icon" :size="15" />{{ mode.label }}<span v-if="mode.disabled" class="mode-disabled-label">下一阶段</span><span v-else class="radio-dot"><i></i></span></button></div><button class="primary-button batch-create" @click="createBatchTasks"><Plus :size="16" />创建 {{ selectedCount }} 个任务</button></div>

    <div v-if="confirmationDialog" class="modal-backdrop" @click.self="confirmation = null"><div class="confirm-modal panel" role="dialog" aria-modal="true" :aria-label="confirmationTitle"><button class="icon-button modal-close" aria-label="关闭" @click="confirmation = null"><X :size="18" /></button><div class="confirm-modal-icon"><CircleHelp :size="20" /></div><h2>{{ confirmationTitle }}</h2><p>{{ confirmationMessage }}</p><div class="confirm-actions"><button class="outline-button" @click="confirmation = null">返回</button><button class="primary-button confirm-danger" @click="confirmAction">{{ confirmation?.type === 'clear-history' ? '清除历史' : '确认取消' }}</button></div></div></div>
    <div v-if="qrDialog" class="modal-backdrop" @click.self="closeQrDialog"><div class="login-modal panel" role="dialog" aria-modal="true" aria-label="扫码登录 B 站"><button class="icon-button modal-close" aria-label="关闭" @click="closeQrDialog"><X :size="18" /></button><div class="login-modal-icon"><ScanLine :size="22" /></div><h2>扫码登录 B 站</h2><p>打开哔哩哔哩 App，扫描二维码完成登录</p><div class="real-qr" :class="{ 'qr-is-loading': qrStarting }"><img v-if="qrImage" :src="qrImage" alt="B 站登录二维码" /><div v-else class="qr-placeholder"><LoaderCircle v-if="qrStarting" class="spin" :size="24" /><ScanLine v-else :size="24" /></div></div><div class="qr-note" :class="`qr-${qrStatus}`"><span class="live-dot"></span>{{ qrStatusLabel }}</div><p v-if="qrMessage" class="qr-error-message">{{ qrMessage }}</p><button v-if="['expired', 'failed'].includes(qrStatus)" class="primary-button simulate-login" :disabled="qrStarting" @click="startQrLogin"><RefreshCw :size="16" />刷新二维码</button><small class="modal-disclaimer">登录信息仅保存在本机，不会发送给 BiliScribe 服务之外的站点。</small></div></div>

    <div v-if="logoutConfirm" class="modal-backdrop" @click.self="logoutConfirm = false"><div class="confirm-modal panel" role="dialog" aria-modal="true" aria-label="确认退出 B 站登录"><button class="icon-button modal-close" aria-label="关闭" @click="logoutConfirm = false"><X :size="18" /></button><div class="confirm-modal-icon"><LogOut :size="20" /></div><h2>退出 B 站登录？</h2><p>本机保存的 B 站登录状态将被移除，公开视频仍可解析。</p><div class="confirm-actions"><button class="outline-button" @click="logoutConfirm = false">返回</button><button class="primary-button confirm-danger" @click="logoutBilibili">退出登录</button></div></div></div>

    <Transition name="toast"><div v-if="toast" class="toast-message"><Check :size="15" />{{ toast }}</div></Transition>
  </div>
</template>
