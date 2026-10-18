import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  buildLocalAudioPreparationArgs, inspectFirstAudioStream, isLocalMp4,
  isSupportedLocalMedia, isValidLocalMediaBatchSize, localMediaDialogFilter, localMp4AudioError,
} from './local-media.js'

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, timeout: 30_000 })
  if (result.error) throw result.error
  return result
}

const ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg'
const ffprobePath = process.env.FFPROBE_PATH || 'ffprobe'

test('accepts existing audio formats and MP4, and allows a 75 item batch', () => {
  for (const extension of ['mp3', 'm4a', 'wav', 'flac', 'ogg', 'mp4']) {
    assert.equal(isSupportedLocalMedia(`lesson.${extension}`), true)
  }
  assert.equal(isSupportedLocalMedia('lesson.mkv'), false)
  assert.equal(isLocalMp4('LESSON.MP4'), true)
  assert.match(localMediaDialogFilter, /\*\.mp4/)
  assert.equal(isValidLocalMediaBatchSize(75), true)
  assert.equal(isValidLocalMediaBatchSize(3001), false)
  assert.deepEqual(localMp4AudioError('missing'), { code: 'local_mp4_audio_missing', message: '此 MP4 不包含可读取的音轨，无法转写。' })
  assert.deepEqual(localMp4AudioError('unreadable'), { code: 'local_mp4_unreadable', message: '此 MP4 无法读取或已损坏，请检查文件后重试。' })
})

test('extracts the first audio track of an MP4 with the transcript audio settings', async (t) => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'biliscribe-local-media-'))
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }))
  const sourcePath = path.join(directory, 'with-audio.mp4')
  const outputPath = path.join(directory, 'prepared-audio.m4a')
  const fixture = run(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=64x64:d=1',
    '-f', 'lavfi', '-i', 'sine=frequency=1000:duration=1', '-c:v', 'mpeg4', '-c:a', 'aac', '-shortest', sourcePath,
  ])
  assert.equal(fixture.status, 0, fixture.stderr)
  const originalBefore = await fs.promises.readFile(sourcePath)
  assert.equal(inspectFirstAudioStream(ffprobePath, sourcePath), 'present')

  const args = buildLocalAudioPreparationArgs(sourcePath, outputPath, '32k')
  assert.deepEqual(args.slice(args.indexOf('-map'), args.indexOf('-map') + 3), ['-map', '0:a:0', '-vn'])
  assert.equal(args[args.indexOf('-ar') + 1], '16000')
  assert.equal(args[args.indexOf('-ac') + 1], '1')
  assert.equal(args[args.indexOf('-b:a') + 1], '32k')
  const extraction = run(ffmpegPath, args)
  assert.equal(extraction.status, 0, extraction.stderr)
  assert.ok((await fs.promises.stat(outputPath)).size > 0)
  assert.deepEqual(await fs.promises.readFile(sourcePath), originalBefore)
})

test('detects MP4 files with no audio and damaged MP4 files', async (t) => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'biliscribe-local-media-'))
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }))
  const silentPath = path.join(directory, 'silent.mp4')
  const damagedPath = path.join(directory, 'damaged.mp4')
  const fixture = run(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=64x64:d=1',
    '-c:v', 'mpeg4', silentPath,
  ])
  assert.equal(fixture.status, 0, fixture.stderr)
  await fs.promises.writeFile(damagedPath, 'not an mp4')
  assert.equal(inspectFirstAudioStream(ffprobePath, silentPath), 'missing')
  assert.equal(inspectFirstAudioStream(ffprobePath, damagedPath), 'unreadable')
})
