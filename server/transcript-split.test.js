import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  buildTranscriptSplitArgs, planTranscriptSplitRanges, promoteTranscriptSplitFiles, validateTranscriptSplitPart,
} from './transcript-split.js'

const ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg'
const ffprobePath = process.env.FFPROBE_PATH || 'ffprobe'

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, timeout: 120_000 })
  if (result.error) throw result.error
  return result
}

test('plans a continuous half split for 4570.048 seconds with checkpoint clock drift', () => {
  const ranges = planTranscriptSplitRanges({ startSeconds: 12.03, endSeconds: 4582.10 }, 4570.048)
  assert.equal(ranges[0].sourceDurationSeconds, 2285.024)
  assert.equal(ranges[1].sourceStartSeconds, ranges[0].sourceDurationSeconds)
  assert.equal(ranges[0].endSeconds, ranges[1].startSeconds)
  assert.equal(ranges[0].startSeconds, 12.03)
  assert.equal(ranges[1].endSeconds, 4582.10)
  assert.ok(Math.abs((ranges[0].endSeconds - ranges[0].startSeconds) - (ranges[1].endSeconds - ranges[1].startSeconds)) < 1e-9)
})

test('uses explicit input start and duration and keeps the established AAC settings', () => {
  const args = buildTranscriptSplitArgs('source.m4a', 'child.m4a', 2285.024, 2285.024, '32k')
  assert.deepEqual(args.slice(args.indexOf('-ss'), args.indexOf('-ss') + 4), ['-ss', '2285.024000', '-t', '2285.024000'])
  assert.equal(args[args.indexOf('-map') + 1], '0:a:0')
  assert.equal(args[args.indexOf('-ac') + 1], '1')
  assert.equal(args[args.indexOf('-ar') + 1], '16000')
  assert.equal(args[args.indexOf('-c:a') + 1], 'aac')
  assert.equal(args[args.indexOf('-b:a') + 1], '32k')
})

test('splits a 4570.048 second synthetic audio file into probeable continuous halves', async (t) => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'biliscribe-transcript-split-'))
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }))
  const input = path.join(directory, 'source.m4a')
  const outputs = [path.join(directory, 'first.m4a'), path.join(directory, 'second.m4a')]
  const source = run(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000',
    '-t', '4570.048', '-ac', '1', '-ar', '16000', '-c:a', 'aac', '-b:a', '32k', input,
  ])
  assert.equal(source.status, 0, source.stderr)
  const ranges = planTranscriptSplitRanges({ startSeconds: 0, endSeconds: 4570.06 }, 4570.048)
  for (let index = 0; index < ranges.length; index += 1) {
    const range = ranges[index]
    const result = run(ffmpegPath, buildTranscriptSplitArgs(input, outputs[index], range.sourceStartSeconds, range.sourceDurationSeconds, '32k'))
    assert.equal(result.status, 0, result.stderr)
  }
  const durations = outputs.map((file) => {
    const result = run(ffprobePath, ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name,sample_rate,channels:format=duration', '-of', 'json', file])
    assert.equal(result.status, 0, result.stderr)
    const details = JSON.parse(result.stdout)
    const stream = details.streams[0]
    const diagnostics = { durationSeconds: Number(details.format.duration), codec: stream.codec_name, sampleRate: Number(stream.sample_rate), channels: Number(stream.channels) }
    const stats = fs.statSync(file)
    assert.equal(validateTranscriptSplitPart(stats, diagnostics, rangeDuration(ranges, file, outputs), 40_000_000), null)
    return diagnostics.durationSeconds
  })
  assert.ok(Math.abs(durations[0] + durations[1] - 4570.048) < 1.5)
  assert.ok(outputs.every((file) => fs.statSync(file).size > 0))
})

test('rejects an invalid child before it can be accepted for checkpoint replacement', () => {
  assert.equal(validateTranscriptSplitPart({ size: 0 }, null, 10, 40_000_000), 'empty_file')
  assert.equal(validateTranscriptSplitPart({ size: 100 }, null, 10, 40_000_000), 'ffprobe_unreadable')
  assert.equal(validateTranscriptSplitPart({ size: 100 }, { durationSeconds: 9.5, codec: 'aac', sampleRate: 16000, channels: 1 }, 10, 40_000_000), 'duration_mismatch')
  assert.equal(validateTranscriptSplitPart({ size: 100 }, { durationSeconds: 10, codec: 'aac', sampleRate: 16000, channels: 1 }, 10, 40_000_000), null)
})

test('rolls back the first promoted child when promoting the second child fails', async () => {
  const removed = []
  const checkpoint = { segments: [{ id: '001' }], currentSegment: '001' }
  let renameCalls = 0
  await assert.rejects(promoteTranscriptSplitFiles(
    ['stage-a.m4a', 'stage-b.m4a'], ['segment-001a.m4a', 'segment-001b.m4a'],
    async () => { renameCalls += 1; if (renameCalls === 2) throw new Error('rename_failed') },
    async (filePath) => { removed.push(filePath) },
  ), /rename_failed/)
  assert.deepEqual(removed, ['segment-001a.m4a'])
  assert.deepEqual(checkpoint, { segments: [{ id: '001' }], currentSegment: '001' })
})

function rangeDuration(ranges, file, outputs) {
  return ranges[outputs.indexOf(file)].sourceDurationSeconds
}
