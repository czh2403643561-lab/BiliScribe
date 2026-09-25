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
const currentPage = ref(1)
const creatorSearch = ref('')
const expandedAlbums = ref(new Set(['album-1']))
const selectedVideoIds = ref(new Set())
const batchAction = ref('video')

const creatorPages = [
  [
    { id: 'album-1', title: '八字入门 · 从零开始学命理', updated: '更新至 18 集', videos: [
      { id: 'v101', title: '第一课：什么是四柱八字？先把基础概念弄清楚', duration: '18:42', date: '09-18', views: '2.6万', art: 'ink', tag: '第 01 集' },
      { id: 'v102', title: '天干地支怎么记？一张图理解五行关系', duration: '26:15', date: '09-16', views: '1.9万', art: 'blue', tag: '第 02 集' },
      { id: 'v103', title: '排盘的基本方法：年柱、月柱、日柱与时柱', duration: '32:08', date: '09-12', views: '1.7万', art: 'sand', tag: '第 03 集' },
      { id: 'v104', title: '阴阳五行之间的生克关系，听完就能用', duration: '24:39', date: '09-09', views: '1.5万', art: 'green', tag: '第 04 集' },
    ] },
    { id: 'album-2', title: '十神与性格分析', updated: '共 12 集', videos: [
      { id: 'v201', title: '十神是什么？先理解日主和其他天干的关系', duration: '21:36', date: '09-06', views: '1.4万', art: 'rose', tag: '第 01 集' },
      { id: 'v202', title: '正官与七杀：规则感和行动力怎么看', duration: '29:18', date: '09-02', views: '1.2万', art: 'ink', tag: '第 02 集' },
      { id: 'v203', title: '食神、伤官的表达特点，结合例子讲清楚', duration: '27:51', date: '08-29', views: '1.1万', art: 'blue', tag: '第 03 集' },
    ] },
  ],
  [
    { id: 'album-3', title: '八字案例精讲', updated: '共 9 集', videos: [
      { id: 'v301', title: '案例一：先看日主旺衰，别急着定格局', duration: '34:05', date: '08-25', views: '9860', art: 'green', tag: '案例 01' },
      { id: 'v302', title: '案例二：用十神关系还原命局结构', duration: '31:44', date: '08-21', views: '9240', art: 'sand', tag: '案例 02' },
      { id: 'v303', title: '案例三：把大运和流年放回原局里看', duration: '38:12', date: '08-17', views: '8700', art: 'rose', tag: '案例 03' },
    ] },
    { id: 'album-4', title: '流年与运势观察', updated: '共 14 集', videos: [
      { id: 'v401', title: '大运如何排？顺排逆排和起运时间的算法', duration: '25:27', date: '08-13', views: '1.3万', art: 'blue', tag: '第 01 集' },
      { id: 'v402', title: '流年作用到原局时，先从哪里开始看', duration: '28:56', date: '08-09', views: '1.1万', art: 'ink', tag: '第 02 集' },
      { id: 'v403', title: '用一个完整例子看大运流年的组合', duration: '35:10', date: '08-05', views: '9840', art: 'sand', tag: '第 03 集' },
    ] },
  ],
  [
    { id: 'album-5', title: '干支基础知识', updated: '共 8 集', videos: [
      { id: 'v501', title: '十天干的阴阳属性与基础取象', duration: '19:24', date: '08-01', views: '1.0万', art: 'rose', tag: '第 01 集' },
      { id: 'v502', title: '十二地支藏干：用结构记忆更轻松', duration: '23:40', date: '07-28', views: '9260', art: 'green', tag: '第 02 集' },
      { id: 'v503', title: '地支六合、六冲与三合关系梳理', duration: '30:16', date: '07-24', views: '8110', art: 'blue', tag: '第 03 集' },
    ] },
  ],
]
const allVideos = computed(() => creatorPages.flat().flatMap((album) => album.videos))
const filteredCollections = computed(() => {
  const query = creatorSearch.value.trim().toLowerCase()
  return creatorPages.flat().flatMap((album) => {
    if (!query) return [album]
    const matchingVideos = album.videos.filter((video) => video.title.toLowerCase().includes(query))
    if (album.title.toLowerCase().includes(query)) return [album]
    return matchingVideos.length ? [{ ...album, videos: matchingVideos }] : []
  })
})
const filteredCreatorPages = computed(() => {
  const groups = []
  for (let index = 0; index < filteredCollections.value.length; index += 2) groups.push(filteredCollections.value.slice(index, index + 2))
  return groups
})
const creatorResultVideos = computed(() => filteredCollections.value.flatMap((album) => album.videos))
const currentAlbums = computed(() => filteredCreatorPages.value[currentPage.value - 1] || [])
const pageVideos = computed(() => currentAlbums.value.flatMap((album) => album.videos))
const selectedCount = computed(() => selectedVideoIds.value.size)
const pageAllSelected = computed(() => pageVideos.value.length > 0 && pageVideos.value.every((video) => selectedVideoIds.value.has(video.id)))
const allSelected = computed(() => creatorResultVideos.value.length > 0 && creatorResultVideos.value.every((video) => selectedVideoIds.value.has(video.id)))
watch(creatorSearch, () => { currentPage.value = 1 })
watch(url, () => { if (!isParsing.value) parseState.value = 'idle'; parseErrorKind.value = ''; parseErrorMessage.value = '' })

const creator = { name: '山间命理课', id: '山间命理课', avatar: '山', description: '把复杂的命理知识讲清楚 · 课程持续更新', videos: 16, collections: 5, followers: '8.6万' }
const singleVideo = ref({ title: '', bvid: '', owner: '', duration: '', date: '', views: null, cover: '', url: '' })

function setDemoLink(kind) {
  const samples = {
    video: 'https://www.bilibili.com/video/BV1eQNL6JEV2/',
    creator: 'https://space.bilibili.com/349327328',
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
    const response = await fetch('/api/videos/parse', {
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
    singleVideo.value = result.video
    resultType.value = 'video'
    parseState.value = 'success'
    notify('视频解析完成')
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
function clearAll() { selectedVideoIds.value = new Set() }
function toggleAlbum(album) {
  const next = new Set(expandedAlbums.value)
  next.has(album.id) ? next.delete(album.id) : next.add(album.id)
  expandedAlbums.value = next
}
function albumChecked(album) { return album.videos.every((video) => selectedVideoIds.value.has(video.id)) }
function toggleAlbumSelection(album) { setVideos(album.videos.map((video) => video.id), !albumChecked(album)) }

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
const taskFilter = ref('全部')
const taskFilters = ['全部', '进行中', '等待', '已完成', '失败']
const filteredTasks = computed(() => {
  const map = { 进行中: ['running'], 等待: ['waiting'], 已完成: ['completed'], 失败: ['failed'] }
  return tasks.value.filter((task) => taskFilter.value === '全部' || map[taskFilter.value]?.includes(task.status))
})
const runningTask = computed(() => tasks.value.find((task) => task.status === 'running'))
const waitingTasks = computed(() => tasks.value.filter((task) => task.status === 'waiting'))
const completedCount = computed(() => tasks.value.filter((task) => task.status === 'completed').length)
const queueCount = computed(() => waitingTasks.value.length)

function formatFileSize(bytes) {
  const size = Number(bytes) || 0
  if (size < 1) return '—'
  if (size < 1024 ** 2) return `${(size / 1024).toFixed(1)} KB`
  if (size < 1024 ** 3) return `${(size / 1024 ** 2).toFixed(1)} MB`
  return `${(size / 1024 ** 3).toFixed(2)} GB`
}

async function refreshTasks() {
  try {
    const response = await fetch('/api/tasks')
    if (!response.ok) throw new Error('任务列表读取失败')
    const result = await response.json()
    tasks.value = result.tasks || []
    if (result.downloadDirectory && !settingsDirty.value) {
      downloadPath.value = result.downloadDirectory
      savedDownloadPath.value = result.downloadDirectory
    }
    return true
  } catch {
    return false
  }
}

async function addSingleTask(mode = batchAction.value) {
  if (!['video', 'audio'].includes(mode) || !singleVideo.value.bvid) return
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

async function cancelTask(task) {
  try {
    const response = await fetch(`/api/tasks/${task.id}/cancel`, { method: 'POST' })
    const result = await response.json()
    if (!response.ok) throw new Error(result.error?.message || '取消任务失败。')
    await refreshTasks()
    notify('已请求取消，队列会继续执行')
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
  } catch (error) { notify(error.message || '无法打开文件位置。') }
}

const transcriptText = `今天我们先从最基础的地方开始讲，拿到一个八字，不要着急去判断这个人好还是不好。我们先把四柱摆清楚，年柱、月柱、日柱、时柱，每一个位置都代表不同的信息。\n\n日柱的天干是日主，也就是我们接下来分析时的中心。其他的天干地支，都是围绕日主来看的。你先记住这个顺序：先认日主，再看月令，然后看整个命局里面五行之间怎么流通。\n\n这个地方我们先不要急着下结论。看到一个五行多，不代表它一定就是好，也不能直接说少的那个就一定不好。还是要回到原局，看它在什么位置，跟其他干支是什么关系。我们学习的时候一步一步来，先把每个字认清楚，再慢慢把它们连起来。\n\n比如说现在这个盘，日主是甲木，我们先看月令是不是对它有帮助，再看地支里面有没有根，天干上有没有同类帮扶。这里说的旺衰，是一个基础的观察方法，不是最后的答案。后面我们还要结合十神、组合关系和大运流年来看。\n\n再往下看月令，月令是我们观察季节气候的一个入口。甲木生在不同的月份，它周围的环境不一样，不能拿同一把尺子直接量。看到这里，大家可以先停一下，把月支圈出来，想一想这个季节里面木的状态是什么。先说你看见了什么，再说它对日主有什么影响。\n\n地支里面还有藏干，所以一个地支不能只看表面那个字。我们把藏干写出来以后，再看这些字跟日主之间是什么关系。这个时候十神的概念就可以慢慢用起来了。刚开始记不住没有关系，我们先用表格查，重复几次以后，自然就熟悉了。\n\n大家容易遇到的一个问题，就是只盯着某一个字看。比如说看到一个冲，就马上觉得一定发生什么事情；看到一个合，就马上觉得它们都合住了。实际分析的时候，要把位置、力量和其他关系一起摆出来。现在先不用记复杂判断，我们先把每一步看完整。\n\n做案例的时候，先不要看答案。你按顺序把四柱写出来，标好阴阳和五行，再找日主和月令，最后把天干地支之间的关系连起来。把你看到的写在纸上，然后对照讲解，看看自己在哪一步漏了。这样练，比一上来背结论更有用。\n\n大家做练习的时候，可以先把四柱写出来，在旁边标上每个字的五行和阴阳。刚开始慢一点没有关系，把基础的步骤做对，后面分析才不会乱。今天这节课先到这里，下一节我们接着讲十天干的特点。`
const transcripts = ref([
  { id: 'tr-1', title: '八字入门第一课：四柱与五行基础概念', creator: '山间命理课', date: '2026-09-18', duration: '18:42', text: transcriptText },
  { id: 'tr-2', title: '十神是什么？日主与其他天干的关系', creator: '山间命理课', date: '2026-09-06', duration: '21:36', text: transcriptText.replaceAll('日主', '日元') },
  { id: 'tr-3', title: '排盘的基本方法：四柱怎么排', creator: '山间命理课', date: '2026-09-12', duration: '32:08', text: transcriptText.replaceAll('月令', '月支') },
])
const activeTranscriptId = ref('tr-1')
const transcriptQuery = ref('')
const visibleTranscripts = computed(() => transcripts.value.filter((item) => `${item.title} ${item.creator}`.toLowerCase().includes(transcriptQuery.value.trim().toLowerCase())))
const activeTranscript = computed(() => transcripts.value.find((item) => item.id === activeTranscriptId.value) || transcripts.value[0])
function addTranscript(task) {
  const id = `tr-${Date.now()}`
  transcripts.value.unshift({ id, title: task.title, creator: task.owner, date: new Date().toLocaleDateString('zh-CN'), duration: '18:42', text: transcriptText })
}
async function copyTranscript() {
  try {
    await navigator.clipboard.writeText(activeTranscript.value.text)
    notify('全文已复制')
  } catch { notify('浏览器未授权剪贴板，请手动选择正文复制') }
}
function exportTranscript() {
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
const savedApiKey = ref('')
const apiTesting = ref(false)
const apiTested = ref(false)
const downloadPath = ref('')
const transcriptPath = ref('D:\\BiliScribe\\文字稿')
const savedDownloadPath = ref(downloadPath.value)
const savedTranscriptPath = ref(transcriptPath.value)
const settingsDirty = computed(() => apiKey.value !== savedApiKey.value || downloadPath.value !== savedDownloadPath.value || transcriptPath.value !== savedTranscriptPath.value)
const backendStatus = ref('connecting')
const bbdownAvailable = ref(null)
const bbdownVersion = ref('')
const logPath = ref('项目目录/logs/biliscribe.log')
const logAvailable = ref(false)
const logLineCount = ref(0)
const logLoading = ref(false)
async function saveSettings() {
  try {
    const response = await fetch('/api/settings/download', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ downloadDirectory: downloadPath.value }),
    })
    const result = await response.json()
    if (!response.ok) throw new Error(result.error?.message || '下载目录保存失败。')
    downloadPath.value = result.downloadDirectory
    savedDownloadPath.value = result.downloadDirectory
    savedApiKey.value = apiKey.value
    savedTranscriptPath.value = transcriptPath.value
    notify('下载目录已保存到本机，后续任务将使用此位置')
  } catch (error) { notify(error.message || '保存下载目录失败。') }
}

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

function testApi() {
  if (!apiKey.value.trim()) { apiTested.value = false; notify('请先填写 MiMo API Key'); return }
  apiTesting.value = true
  apiTested.value = false
  setTimeout(() => { apiTesting.value = false; apiTested.value = true; notify('连接测试成功（演示）') }, 850)
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

onMounted(() => { refreshBackendStatus(); refreshLoginStatus(); refreshTasks(); taskPollTimer = setInterval(refreshTasks, 1200) })
onUnmounted(() => { clearInterval(taskPollTimer); clearInterval(qrPollTimer); clearTimeout(qrSuccessCloseTimer); clearTimeout(toastTimer) })
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
            <div class="link-panel-title"><div class="step-icon"><Link2 :size="18" /></div><div><strong>添加 B 站视频链接</strong><span>目前支持单个视频解析</span></div><span class="supported-tag">Bilibili</span></div>
            <div class="link-entry"><div class="url-input-wrap"><Link2 :size="17" /><input v-model="url" aria-label="B站单视频链接" placeholder="粘贴 B 站单视频链接" @keydown.enter="parseLink" /><button v-if="url" class="input-clear" aria-label="清空链接" @click="url = ''"><X :size="15" /></button></div><button class="primary-button parse-button" :disabled="isParsing" @click="parseLink"><LoaderCircle v-if="isParsing" class="spin" :size="16" /><Search v-else :size="16" />{{ isParsing ? '解析中' : '解析链接' }}</button></div>
            <div class="demo-hints"><span class="hint-label">快速测试</span><button @click="setDemoLink('video')">测试视频</button><i></i><button @click="setDemoLink('failed')">无效视频</button><i></i><button @click="setDemoLink('invalid')">非法链接</button><span class="hint-footnote">通过本地后台调用 BBDownNext</span></div>
          </div>

          <div v-if="parseState !== 'success'" class="empty-state panel parse-state" :class="{ 'parse-loading': parseState === 'loading' }"><div class="empty-state-icon"><LoaderCircle v-if="parseState === 'loading'" class="spin" :size="19" /><XCircle v-else-if="parseState === 'invalid' || parseState === 'failed'" :size="19" /><Link2 v-else :size="19" /></div><strong>{{ parseState === 'loading' ? '正在解析视频' : parseState === 'empty' ? '请先粘贴 B 站视频链接' : parseState === 'idle' ? '等待解析' : parseErrorKind === 'backend_unavailable' ? '本地后台未连接' : parseErrorKind === 'bbdown_unavailable' ? 'BBDownNext 未就绪' : parseState === 'invalid' ? '链接无效或暂不支持' : '视频解析失败' }}</strong><span>{{ parseState === 'loading' ? '正在调用本地后台解析视频信息。' : parseState === 'empty' ? '粘贴 B 站单视频链接，再点击“解析链接”。' : parseState === 'idle' ? '输入 B 站单视频链接后开始解析。' : parseErrorMessage || '请检查链接后重试。' }}</span><button v-if="parseState === 'failed' && parseErrorKind !== 'backend_unavailable' && parseErrorKind !== 'bbdown_unavailable'" class="outline-button empty-retry" @click="parseLink"><RefreshCw :size="14" />重试解析</button></div>

          <template v-else-if="resultType === 'creator'">
            <div class="creator-panel panel">
              <div class="creator-cover"><div class="creator-cover-decoration"></div><div class="creator-profile"><div class="creator-avatar">山<span class="verified"><Check :size="10" /></span></div><div class="creator-main"><div class="creator-name-row"><h2>{{ creator.name }}</h2><span class="up-tag">UP 主</span></div><div class="creator-description">{{ creator.description }}</div><div class="creator-id">UID：349327328 <span>·</span> 粉丝 {{ creator.followers }}</div></div></div><div class="creator-stats"><div><strong>{{ creator.videos }}</strong><span>视频</span></div><div><strong>{{ creator.collections }}</strong><span>合集</span></div></div></div>
              <div class="creator-toolbar">
                <div class="toolbar-left"><h3>视频与合集</h3><span class="toolbar-count">{{ creatorResultVideos.length }} 个视频</span><span class="toolbar-divider"></span><button class="text-action" @click="selectAll"><CheckCheck :size="15" />{{ creatorSearch.trim() ? '全选筛选结果' : '全选全部结果' }} <small>({{ creatorResultVideos.length }})</small></button><button class="text-action" @click="setVideos(pageVideos.map((v) => v.id), true)"><Check :size="15" />全选当前页</button><button class="text-action muted" @click="clearAll"><XCircle :size="15" />取消全部</button><button class="text-action muted" @click="setVideos(pageVideos.map((v) => v.id), false)"><X :size="15" />取消当前页</button></div><label class="creator-search"><Search :size="15" /><input v-model="creatorSearch" placeholder="搜索视频标题" aria-label="搜索视频标题" /><button v-if="creatorSearch" type="button" aria-label="清空搜索" @click="creatorSearch = ''"><X :size="13" /></button></label>
              </div>
              <div class="selection-line"><label class="check-label"><input type="checkbox" :checked="pageAllSelected" @change="setVideos(pageVideos.map((v) => v.id), $event.target.checked)" /><span class="custom-check"><Check :size="12" /></span><span>本页全选</span></label><span v-if="creatorResultVideos.length">第 {{ currentPage }} 页 · {{ pageVideos.length }} 个视频</span><span v-else>当前没有匹配的视频</span><span v-if="allSelected" class="selection-success">已选择全部 {{ creatorResultVideos.length }} 个视频<span v-if="creatorSearch.trim()">（当前筛选结果）</span></span><span v-else-if="selectedCount" class="selection-count">已选 {{ selectedCount }} 个<span>{{ creatorSearch.trim() ? '（包含筛选外选择）' : '（全部页面）' }}</span></span></div>

              <div v-if="creatorResultVideos.length" class="album-list">
                <article v-for="album in currentAlbums" :key="album.id" class="album-card">
                  <div class="album-heading">
                    <label class="album-check check-label" :title="`选择${album.title}内全部视频`"><input type="checkbox" :checked="albumChecked(album)" @change="toggleAlbumSelection(album)" /><span class="custom-check"><Check :size="12" /></span></label>
                    <button class="album-cover thumb-art" :class="album.videos[0].art" @click="toggleAlbum(album)"><span class="art-orbit"></span><span class="art-copy"><small>{{ album.videos[0].tag }}</small><b>{{ album.title.split(' · ')[0] }}</b></span><span class="album-cover-count">{{ album.videos.length }} 集</span></button>
                    <button class="album-info" @click="toggleAlbum(album)"><span class="album-title-row"><strong>{{ album.title }}</strong><span class="album-tag"><Archive :size="12" />合集</span></span><span class="album-subtitle">{{ album.updated }} <i>·</i> 山间命理课</span></button>
                    <button class="album-expand" @click="toggleAlbum(album)"><span>{{ expandedAlbums.has(album.id) ? '收起' : '展开' }}</span><ChevronDown :size="16" :class="{ rotated: expandedAlbums.has(album.id) }" /></button>
                  </div>
                  <div v-if="expandedAlbums.has(album.id)" class="video-list">
                    <div v-for="video in album.videos" :key="video.id" class="video-row" :class="{ selected: selectedVideoIds.has(video.id) }">
                      <label class="check-label video-checkbox"><input type="checkbox" :checked="selectedVideoIds.has(video.id)" @change="toggleVideo(video.id)" /><span class="custom-check"><Check :size="12" /></span></label>
                      <div class="video-thumb thumb-art" :class="video.art"><span class="art-orbit"></span><span class="art-copy"><small>{{ video.tag }}</small><b>{{ video.title.split('：')[0] }}</b></span><span class="thumb-duration">{{ video.duration }}</span></div>
                      <div class="video-details"><strong>{{ video.title }}</strong><div class="video-meta"><span><UserRound :size="12" />山间命理课</span><span><CirclePlay :size="12" />{{ video.views }} 播放</span><span>{{ video.date }}</span></div></div>
                      <div class="video-trailing"><span class="format-label"><Video :size="13" />视频</span><button class="icon-button row-more" title="更多操作"><MoreHorizontal :size="17" /></button></div>
                    </div>
                  </div>
                </article>
              </div>
              <div v-else class="empty-state search-empty"><div class="empty-state-icon"><Search :size="18" /></div><strong>没有找到匹配的视频</strong><span>试试其他标题关键词。</span></div>
              <div v-if="creatorResultVideos.length" class="list-footer"><div class="result-count">共 <strong>{{ creatorResultVideos.length }}</strong> 个匹配视频，分为 <strong>{{ filteredCreatorPages.length }}</strong> 页</div><div class="pagination"><button class="page-arrow" :disabled="currentPage === 1" aria-label="上一页" @click="currentPage--"><ChevronLeft :size="16" /></button><button v-for="number in filteredCreatorPages.length" :key="number" class="page-number" :class="{ active: currentPage === number }" @click="currentPage = number">{{ number }}</button><button class="page-arrow" :disabled="currentPage === filteredCreatorPages.length" aria-label="下一页" @click="currentPage++"><ChevronRight :size="16" /></button><span class="page-total">共 {{ filteredCreatorPages.length }} 页</span></div></div>
            </div>
          </template>

          <div v-else class="single-result panel">
            <div class="section-heading"><div><div class="eyebrow">解析结果</div><h2>单个视频</h2></div><span class="result-chip"><Check :size="14" />已识别</span></div>
            <div class="single-video-card"><div class="single-cover thumb-art" :class="singleVideo.cover ? 'has-real-cover' : 'cover-unavailable'"><img v-if="singleVideo.cover" class="real-cover" :src="singleVideo.cover" alt="视频封面" /><span v-else class="cover-placeholder">封面暂不可用</span><span class="thumb-duration">{{ singleVideo.duration }}</span></div><div class="single-video-info"><span class="video-eyebrow"><Radio :size="13" />真实解析结果</span><h3>{{ singleVideo.title }}</h3><div class="single-meta"><span><UserRound :size="14" />{{ singleVideo.owner }}</span><span v-if="singleVideo.bvid">{{ singleVideo.bvid }}</span><span v-if="singleVideo.date">{{ singleVideo.date }}</span><span v-if="singleVideo.views !== null">{{ Number(singleVideo.views).toLocaleString('zh-CN') }} 播放</span></div><div class="single-divider"></div><div class="mode-label">选择处理方式</div><div class="mode-options"><button v-for="mode in modeOptions" :key="mode.id" class="mode-option" :class="{ active: batchAction === mode.id }" @click="batchAction = mode.id"><component :is="mode.icon" :size="17" /><span>{{ mode.label }}</span><span class="mode-radio"><i></i></span></button></div><button class="primary-button single-action" @click="addSingleTask(batchAction)"><Plus :size="16" />创建任务</button></div></div>
          </div>
        </section>

        <section v-else-if="page === 'tasks'" class="page-content tasks-page">
          <div class="page-heading"><div><div class="eyebrow">TASK CENTER</div><h1>任务</h1><p>视频与音频下载按加入顺序串行执行，一次只处理一个任务。</p></div><button class="outline-button" :disabled="!tasks.some((task) => ['completed', 'failed', 'cancelled'].includes(task.status))" @click="requestClearHistory"><Trash2 :size="15" />清除历史</button></div>
          <div class="task-overview"><div class="overview-card active-overview"><div class="overview-icon"><Activity :size="18" /></div><div><span>当前执行</span><strong>{{ runningTask ? '1' : '0' }}<small> 个任务</small></strong></div><span class="overview-live"><i></i>单任务</span></div><div class="overview-card"><div class="overview-icon queue"><Clock3 :size="18" /></div><div><span>等待队列</span><strong>{{ queueCount }}<small> 个任务</small></strong></div></div><div class="overview-card"><div class="overview-icon done"><Check :size="18" /></div><div><span>已完成</span><strong>{{ completedCount }}<small> 个任务</small></strong></div></div><div class="serial-note"><LockKeyhole :size="16" /><span>串行处理</span><small>当前任务完成后自动开始下一项</small></div></div>
          <div class="task-section panel"><div class="task-toolbar"><div class="filter-tabs"><button v-for="filter in taskFilters" :key="filter" :class="{ active: taskFilter === filter }" @click="taskFilter = filter">{{ filter }}<span v-if="filter === '等待' && queueCount">{{ queueCount }}</span></button></div></div>
            <div v-if="!filteredTasks.length" class="empty-state task-empty"><div class="empty-state-icon"><ListChecks :size="19" /></div><strong>{{ tasks.length ? '没有符合条件的任务' : '还没有任务' }}</strong><span>{{ tasks.length ? '切换筛选条件查看其他任务。' : '创建一个新任务后，它会显示在这里。' }}</span></div>
            <template v-else>
              <div v-if="taskFilter === '全部' || taskFilter === '进行中'" class="task-group current-task-group"><div class="task-group-heading"><div><span class="group-dot running"></span><strong>正在执行</strong><span class="group-hint">当前唯一任务</span></div><span class="group-count">{{ runningTask ? '01' : '00' }}</span></div><div v-if="runningTask" class="task-row running-row"><div class="task-type-icon" :class="runningTask.mode"><component :is="taskIcon[runningTask.mode]" :size="18" /></div><div class="task-main"><div class="task-title-row"><strong>{{ runningTask.title }}</strong><span class="task-status running"><LoaderCircle class="spin" :size="12" />{{ runningTask.phase || '准备中' }}</span></div><div class="task-subtitle">{{ runningTask.owner }} <i>·</i> {{ taskNames[runningTask.mode] }}</div><div class="task-progress-line"><span class="phase-indicator"></span><span>{{ runningTask.phase || '准备中' }}</span></div></div><button class="cancel-button" :disabled="runningTask.phase === '正在取消'" @click="requestCancelRunning(runningTask)"><X :size="14" />{{ runningTask.phase === '正在取消' ? '正在取消' : '取消' }}</button></div><div v-else class="empty-inline"><CheckCheck :size="18" />当前没有正在执行的任务</div></div>
              <div v-if="taskFilter === '全部' || taskFilter === '等待'" class="task-group"><div class="task-group-heading"><div><span class="group-dot waiting"></span><strong>等待队列</strong><span class="group-hint">按加入顺序执行</span></div><span class="group-count">{{ String(waitingTasks.length).padStart(2, '0') }}</span></div><div v-if="waitingTasks.length" class="waiting-list"><div v-for="(task, index) in waitingTasks" :key="task.id" class="task-row waiting-row"><div class="queue-index">{{ String(index + 1).padStart(2, '0') }}</div><div class="task-type-icon" :class="task.mode"><component :is="taskIcon[task.mode]" :size="18" /></div><div class="task-main"><div class="task-title-row"><strong>{{ task.title }}</strong><span class="task-status waiting"><Clock3 :size="12" />等待中</span></div><div class="task-subtitle">{{ task.owner }} <i>·</i> {{ taskNames[task.mode] }} <i>·</i> 加入队列</div></div><button class="remove-button" @click="removeWaitingTask(task)"><Trash2 :size="14" />移除</button></div></div><div v-else class="empty-inline"><Clock3 :size="18" />队列中没有等待任务</div></div>
              <div v-if="taskFilter !== '进行中' && taskFilter !== '等待'" class="task-group history-group"><div class="task-group-heading"><div><span class="group-dot history"></span><strong>任务记录</strong><span class="group-hint">已完成、失败与取消</span></div><span class="group-count">{{ String(filteredTasks.filter((task) => ['completed', 'failed', 'cancelled'].includes(task.status)).length).padStart(2, '0') }}</span></div><div v-if="filteredTasks.some((task) => ['completed', 'failed', 'cancelled'].includes(task.status))" class="history-list"><div v-for="task in filteredTasks.filter((item) => ['completed', 'failed', 'cancelled'].includes(item.status))" :key="task.id" class="task-row history-row"><div class="task-type-icon" :class="task.mode"><component :is="taskIcon[task.mode]" :size="18" /></div><div class="task-main"><div class="task-title-row"><strong>{{ task.title }}</strong><span class="task-status" :class="task.status"><Check v-if="task.status === 'completed'" :size="12" /><XCircle v-else :size="12" />{{ task.status === 'completed' ? '已完成' : task.status === 'failed' ? '失败' : '已取消' }}</span></div><div class="task-subtitle">{{ task.owner }} <i>·</i> {{ taskNames[task.mode] }} <i>·</i> {{ task.status === 'completed' ? formatFileSize(task.fileSize) : task.error || task.phase }}</div><div v-if="task.outputPath && task.status === 'completed'" class="task-output-path" :title="task.outputPath">{{ task.outputPath }}</div></div><button v-if="task.status === 'completed'" class="outline-button task-open-button" @click="openTaskLocation(task)"><FolderOpen :size="14" />打开位置</button><button v-if="task.status === 'failed'" class="retry-button" @click="retryTask(task)"><RefreshCw :size="14" />重试</button></div></div><div v-else class="empty-inline"><History :size="18" />暂无符合条件的历史记录</div></div>
            </template>
          </div>
          <div class="task-footnote"><Zap :size="14" /><span>一次只运行一个 BBDownNext 下载进程；取消当前任务后会自动继续队列，未确认归属的临时文件不会自动删除。</span></div>
        </section>

        <section v-else-if="page === 'transcripts'" class="page-content transcripts-page">
          <div class="page-heading"><div><div class="eyebrow">TRANSCRIPT LIBRARY</div><h1>文字稿</h1><p>查看、复制或导出已完成的文字稿。</p></div><div class="transcript-total"><BookOpenText :size="16" /><strong>{{ transcripts.length }}</strong> 篇文字稿</div></div>
          <div v-if="transcripts.length" class="transcript-workspace panel"><aside class="transcript-sidebar"><div class="transcript-sidebar-head"><div><strong>全部文字稿</strong><span>{{ transcripts.length }} 篇</span></div><button class="icon-button" title="搜索文字稿"><Search :size="16" /></button></div><div class="transcript-search"><Search :size="15" /><input v-model="transcriptQuery" placeholder="搜索标题或 UP 主" /></div><div class="transcript-items"><button v-for="item in visibleTranscripts" :key="item.id" class="transcript-item" :class="{ active: activeTranscriptId === item.id }" @click="activeTranscriptId = item.id"><span class="transcript-item-icon"><FileText :size="16" /></span><span class="transcript-item-copy"><strong>{{ item.title }}</strong><small>{{ item.creator }} <i>·</i> {{ item.date }}</small></span><ChevronRight :size="15" class="transcript-item-arrow" /></button><div v-if="!visibleTranscripts.length" class="empty-state transcript-no-results"><div class="empty-state-icon"><Search :size="15" /></div><strong>没有找到匹配的文字稿</strong><span>试试其他标题或 UP 主名称。</span></div></div><div class="transcript-sidebar-foot"><span class="storage-icon"><HardDriveDownload :size="15" /></span><span>文字稿保存位置</span><button @click="page = 'settings'">查看设置<ChevronRight :size="13" /></button></div></aside>
            <article class="transcript-reader"><div class="reader-top"><div class="reader-breadcrumb"><FileText :size="15" /><span>文字稿</span><ChevronRight :size="13" /><strong>{{ activeTranscript.title }}</strong></div><div class="reader-actions"><button class="outline-button" @click="copyTranscript"><Copy :size="15" />复制全文</button><button class="primary-button export-button" @click="exportTranscript"><Download :size="15" />导出 TXT</button></div></div><div class="reader-document"><div class="document-type"><span>课程转写</span><span class="document-dot"></span><span>完整文字稿</span></div><h2>{{ activeTranscript.title }}</h2><div class="document-meta"><span><UserRound :size="14" />{{ activeTranscript.creator }}</span><span><CalendarIcon />{{ activeTranscript.date }}</span><span><Clock3 :size="14" />{{ activeTranscript.duration }}</span></div><div class="document-rule"></div><div class="transcript-body"><p v-for="(paragraph, index) in activeTranscript.text.split('\n\n')" :key="index">{{ paragraph }}</p></div><div class="document-end"><span></span><small>正文结束</small><span></span></div></div><div class="reader-footer"><span><ShieldCheck :size="14" />保留讲师原话 · 未做总结和改写</span><span>共 {{ activeTranscript.text.length }} 字</span></div></article></div>
          <div v-else class="empty-state panel transcript-page-empty"><div class="empty-state-icon"><BookOpenText :size="19" /></div><strong>还没有文字稿</strong><span>完成一次转写后，文字稿会显示在这里。</span></div>
        </section>

        <section v-else class="page-content settings-page">
          <div class="page-heading"><div><div class="eyebrow">PREFERENCES</div><h1>设置</h1><p>管理登录状态、转写服务和文件保存位置。</p></div><span v-if="settingsDirty" class="unsaved-pill">未保存</span><button class="primary-button save-settings" @click="saveSettings"><Check :size="16" />保存设置</button></div>
          <div class="settings-layout"><aside class="settings-nav panel"><span class="settings-nav-label">偏好设置</span><a class="settings-nav-item active"><UserRound :size="16" />账号与服务</a><a class="settings-nav-item"><FolderOpen :size="16" />文件与目录</a><a class="settings-nav-item"><SlidersIcon />任务处理</a><div class="settings-nav-divider"></div><div class="settings-nav-help"><CircleHelp :size="16" /><span>遇到问题？<small>查看使用说明</small></span><ExternalLink :size="13" /></div></aside><div class="settings-content">
            <section class="settings-card panel"><div class="settings-card-heading"><div class="settings-heading-icon bilibili-icon">哔</div><div><h2>B 站账号</h2><p>登录后可访问需要登录的视频内容</p></div><span class="settings-status" :class="loginState ? 'ok' : 'off'"><i></i>{{ loginLoading ? '检查中' : loginState ? '已登录' : '未登录' }}</span></div><div class="setting-divider"></div><div class="account-row"><div class="account-avatar"><img v-if="loginAccount?.avatar" :src="loginAccount.avatar" alt="" />{{ loginAccount?.avatar ? '' : loginState ? (loginAccount?.name?.slice(0, 1) || 'B') : 'B' }}<span :class="{ online: loginState }"></span></div><div class="account-info"><strong>{{ loginAccount?.name || (loginState ? 'B 站账号' : '尚未登录 B 站') }}</strong><span>{{ loginAccount?.uid ? `UID：${loginAccount.uid}` : loginState ? '已使用本机保存的登录状态' : '扫码登录以使用完整解析能力' }}</span></div><button class="outline-button account-button" @click="openQrDialog"><ScanLine :size="15" />{{ loginState ? '重新登录' : '扫码登录' }}</button><button v-if="loginState" class="outline-button account-button logout-account-button" @click="logoutConfirm = true"><LogOut :size="15" />退出登录</button></div><div class="settings-tip"><ShieldCheck :size="15" /><span>登录凭据仅保存在本机，并由 BBDownNext 管理；公开视频仍可在未登录时解析。</span></div></section>
            <section class="settings-card panel"><div class="settings-card-heading"><div class="settings-heading-icon model-icon"><Sparkles :size="18" /></div><div><h2>文字稿模型</h2><p>用于将视频音频转换为课程文字稿</p></div><span class="fixed-tag"><LockKeyhole :size="12" />固定模型</span></div><div class="model-field"><label>模型</label><div class="model-select"><span class="model-dot"></span><strong>MiMo V2.6 Flash</strong><span class="model-subtle">快速 · 低成本</span><ChevronDown :size="16" /></div><small>转写结果忠实保留原话，不总结、不重写。</small></div><div class="api-key-field"><div class="api-label"><label for="api-key">MiMo API Key</label><a href="#" @click.prevent="notify('API Key 申请链接为演示内容')">如何获取？<ExternalLink :size="12" /></a></div><div class="api-input-row"><div class="key-input"><KeyRound :size="16" /><input id="api-key" v-model="apiKey" :type="showApiKey ? 'text' : 'password'" autocomplete="off" placeholder="输入你的 API Key" @input="apiTested = false" /><button type="button" class="key-visibility" :aria-label="showApiKey ? '隐藏 API Key' : '显示 API Key'" @click="showApiKey = !showApiKey"><component :is="showApiKey ? EyeOff : Eye" :size="15" /></button></div><button class="outline-button test-api-button" :disabled="apiTesting" @click="testApi"><LoaderCircle v-if="apiTesting" class="spin" :size="15" /><Activity v-else :size="15" />{{ apiTesting ? '测试中' : '测试连接' }}</button></div><div class="api-feedback"><span v-if="apiTested" class="success-text"><Check :size="13" />连接成功（演示）</span><span v-else-if="!apiKey.trim()"><LockKeyhole :size="12" />尚未配置 API Key</span><span v-else-if="settingsDirty"><CircleHelp :size="13" />有未保存的更改</span><span v-else><Check :size="13" />已保存到当前演示会话</span></div><div v-if="!apiKey.trim()" class="empty-state api-empty-state"><div class="empty-state-icon"><KeyRound :size="16" /></div><strong>API 尚未配置</strong><span>填写并保存 API Key 后，才可测试连接。</span></div></div></section>
            <section class="settings-card panel"><div class="settings-card-heading"><div class="settings-heading-icon folder-icon"><FolderOpen :size="18" /></div><div><h2>文件与目录</h2><p>设置下载文件和文字稿的保存位置</p></div></div><div class="setting-divider"></div><div class="path-setting"><div><label>视频与音频目录</label><span>下载完成的媒体文件保存位置</span></div><div class="path-control"><input v-model="downloadPath" aria-label="视频与音频目录" /></div></div><div class="path-setting"><div><label>文字稿目录</label><span>转写完成后导出的 TXT 文件位置</span></div><div class="path-control"><input v-model="transcriptPath" aria-label="文字稿目录" /></div></div><div class="settings-tip folder-tip"><HardDriveDownload :size="15" /><span>保存后立即用于新下载任务；目录不存在时会自动创建。文字稿目录暂未接入。</span></div></section>
            <section class="settings-card compact-settings panel"><div class="settings-card-heading"><div class="settings-heading-icon queue-icon"><ListChecks :size="18" /></div><div><h2>任务队列</h2><p>下载与转写任务使用同一个串行队列</p></div></div><div class="queue-setting-line"><span>同时执行的任务</span><span class="serial-value"><span class="live-dot"></span>1 个任务 <span class="locked-mini"><LockKeyhole :size="11" />第一版固定</span></span></div></section>
          <section class="settings-card debug-logs-card panel"><div class="settings-card-heading"><div class="settings-heading-icon logs-icon"><History :size="18" /></div><div><h2>调试与日志</h2><p>排查问题时可复制近期记录，或导出完整日志</p></div><span class="settings-status" :class="backendStatus === 'online' ? 'ok' : 'off'"><i></i>{{ backendStatus === 'online' ? '后台已连接' : '后台未运行' }}</span></div><div class="setting-divider"></div><div class="logs-location"><span>日志路径</span><code>{{ logPath }}</code></div><div class="logs-state"><span class="logs-state-dot" :class="backendStatus === 'online' && logAvailable ? 'ready' : ''"></span><span>{{ backendStatus !== 'online' ? '打开 BiliScribe 后即可查看日志。' : !logAvailable ? '日志文件目前为空，产生记录后即可使用日志工具。' : `日志已就绪 · 当前文件 ${logLineCount} 行` }}</span><small v-if="backendStatus === 'online'">{{ bbdownAvailable ? `BBDownNext v${bbdownVersion || '版本未知'} 已就绪` : '未找到 BBDownNext 可执行文件' }}</small></div><div class="logs-actions"><button class="outline-button" :disabled="backendStatus !== 'online' || !logAvailable || logLoading" @click="copyRecentLogs"><Copy :size="15" />复制最新日志</button><button class="outline-button" :disabled="backendStatus !== 'online' || !logAvailable" @click="exportLogs"><Download :size="15" />导出日志</button><button class="outline-button" :disabled="backendStatus !== 'online'" @click="openLogDirectory"><FolderOpen :size="15" />打开日志目录</button></div><p class="logs-note">日志保留最近约 300 行供复制；完整日志会自动轮换。日志中不会写入 API Key、B 站 Cookie 或访问令牌。</p></section>
          </div></div>
        </section>
      </div>
    </main>

    <div v-if="page === 'new' && parseState === 'success' && resultType === 'creator' && selectedCount" class="batch-bar"><div class="batch-selection"><div class="batch-selected-icon"><Check :size="16" /></div><div><strong>已选择 {{ selectedCount }} 个视频</strong><small v-if="creatorSearch.trim()">包含当前筛选外的选择</small><button @click="clearAll">清空选择</button></div></div><span class="batch-divider"></span><div class="batch-action-select"><span>添加为</span><button v-for="mode in modeOptions" :key="mode.id" :class="{ active: batchAction === mode.id }" @click="batchAction = mode.id"><component :is="mode.icon" :size="15" />{{ mode.label }}<span class="radio-dot"><i></i></span></button></div><button class="primary-button batch-create" disabled title="UP 主批量下载暂未接入"><Plus :size="16" />UP 主批量下载暂未接入</button></div>

    <div v-if="confirmationDialog" class="modal-backdrop" @click.self="confirmation = null"><div class="confirm-modal panel" role="dialog" aria-modal="true" :aria-label="confirmationTitle"><button class="icon-button modal-close" aria-label="关闭" @click="confirmation = null"><X :size="18" /></button><div class="confirm-modal-icon"><CircleHelp :size="20" /></div><h2>{{ confirmationTitle }}</h2><p>{{ confirmationMessage }}</p><div class="confirm-actions"><button class="outline-button" @click="confirmation = null">返回</button><button class="primary-button confirm-danger" @click="confirmAction">{{ confirmation?.type === 'clear-history' ? '清除历史' : '确认取消' }}</button></div></div></div>
    <div v-if="qrDialog" class="modal-backdrop" @click.self="closeQrDialog"><div class="login-modal panel" role="dialog" aria-modal="true" aria-label="扫码登录 B 站"><button class="icon-button modal-close" aria-label="关闭" @click="closeQrDialog"><X :size="18" /></button><div class="login-modal-icon"><ScanLine :size="22" /></div><h2>扫码登录 B 站</h2><p>打开哔哩哔哩 App，扫描二维码完成登录</p><div class="real-qr" :class="{ 'qr-is-loading': qrStarting }"><img v-if="qrImage" :src="qrImage" alt="B 站登录二维码" /><div v-else class="qr-placeholder"><LoaderCircle v-if="qrStarting" class="spin" :size="24" /><ScanLine v-else :size="24" /></div></div><div class="qr-note" :class="`qr-${qrStatus}`"><span class="live-dot"></span>{{ qrStatusLabel }}</div><p v-if="qrMessage" class="qr-error-message">{{ qrMessage }}</p><button v-if="['expired', 'failed'].includes(qrStatus)" class="primary-button simulate-login" :disabled="qrStarting" @click="startQrLogin"><RefreshCw :size="16" />刷新二维码</button><small class="modal-disclaimer">登录信息仅保存在本机，不会发送给 BiliScribe 服务之外的站点。</small></div></div>

    <div v-if="logoutConfirm" class="modal-backdrop" @click.self="logoutConfirm = false"><div class="confirm-modal panel" role="dialog" aria-modal="true" aria-label="确认退出 B 站登录"><button class="icon-button modal-close" aria-label="关闭" @click="logoutConfirm = false"><X :size="18" /></button><div class="confirm-modal-icon"><LogOut :size="20" /></div><h2>退出 B 站登录？</h2><p>本机保存的 B 站登录状态将被移除，公开视频仍可解析。</p><div class="confirm-actions"><button class="outline-button" @click="logoutConfirm = false">返回</button><button class="primary-button confirm-danger" @click="logoutBilibili">退出登录</button></div></div></div>

    <Transition name="toast"><div v-if="toast" class="toast-message"><Check :size="15" />{{ toast }}</div></Transition>
  </div>
</template>
