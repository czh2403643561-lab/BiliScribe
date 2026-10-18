import path from 'node:path'
import { spawnSync } from 'node:child_process'

export const localMediaExtensions = new Set(['.mp3', '.m4a', '.wav', '.flac', '.ogg', '.mp4'])

export const localMediaDialogFilter = '支持的音视频文件|*.mp3;*.m4a;*.wav;*.flac;*.ogg;*.mp4'

export function isSupportedLocalMedia(filePath) {
  return localMediaExtensions.has(path.extname(filePath).toLowerCase())
}

export function isLocalMp4(filePath) {
  return path.extname(filePath).toLowerCase() === '.mp4'
}

export function isValidLocalMediaBatchSize(size) {
  return Number.isInteger(size) && size >= 1 && size <= 3000
}

export function buildLocalAudioPreparationArgs(sourcePath, outputPath, bitrate) {
  return [
    '-hide_banner', '-loglevel', 'error', '-y', '-i', sourcePath, '-map', '0:a:0', '-vn',
    '-ac', '1', '-ar', '16000', '-c:a', 'aac', '-b:a', bitrate, '-movflags', '+faststart', outputPath,
  ]
}

export function inspectFirstAudioStream(ffprobePath, sourcePath) {
  if (!ffprobePath) return 'unavailable'
  const result = spawnSync(ffprobePath, [
    '-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=index', '-of', 'json', sourcePath,
  ], { encoding: 'utf8', timeout: 15_000, windowsHide: true })
  if (result.error) return 'unavailable'
  if (result.status !== 0) return 'unreadable'
  try {
    const details = JSON.parse(result.stdout || '{}')
    return Array.isArray(details.streams) && details.streams.length ? 'present' : 'missing'
  } catch {
    return 'unreadable'
  }
}

export function localMp4AudioError(status) {
  if (status === 'missing') return { code: 'local_mp4_audio_missing', message: '此 MP4 不包含可读取的音轨，无法转写。' }
  if (status === 'unreadable') return { code: 'local_mp4_unreadable', message: '此 MP4 无法读取或已损坏，请检查文件后重试。' }
  return null
}
