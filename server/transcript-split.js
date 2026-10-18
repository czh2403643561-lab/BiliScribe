export function planTranscriptSplitRanges(segment, sourceDurationSeconds) {
  const sourceDuration = Number(sourceDurationSeconds)
  if (!Number.isFinite(sourceDuration) || sourceDuration <= 0) throw new Error('source_duration_unavailable')
  const sourceMidpoint = sourceDuration / 2
  const timelineStart = Number.isFinite(segment.startSeconds) ? segment.startSeconds : 0
  const timelineEnd = Number.isFinite(segment.endSeconds) && segment.endSeconds > timelineStart
    ? segment.endSeconds
    : timelineStart + sourceDuration
  const timelineMidpoint = timelineStart + (timelineEnd - timelineStart) / 2
  return [
    { sourceStartSeconds: 0, sourceDurationSeconds: sourceMidpoint, startSeconds: timelineStart, endSeconds: timelineMidpoint },
    { sourceStartSeconds: sourceMidpoint, sourceDurationSeconds: sourceDuration - sourceMidpoint, startSeconds: timelineMidpoint, endSeconds: timelineEnd },
  ]
}

export function buildTranscriptSplitArgs(inputPath, outputPath, startSeconds, durationSeconds, bitrate) {
  return [
    '-hide_banner', '-loglevel', 'error', '-y', '-i', inputPath,
    '-ss', startSeconds.toFixed(6), '-t', durationSeconds.toFixed(6),
    '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'aac', '-b:a', bitrate,
    outputPath,
  ]
}

export function validateTranscriptSplitPart(stats, diagnostics, expectedDurationSeconds, maxBase64Bytes) {
  if (!stats || !Number.isFinite(stats.size) || stats.size <= 0) return 'empty_file'
  if (Math.ceil(stats.size / 3) * 4 > maxBase64Bytes) return 'base64_limit'
  if (!diagnostics || !Number.isFinite(diagnostics.durationSeconds) || diagnostics.durationSeconds <= 0) return 'ffprobe_unreadable'
  const durationTolerance = Math.max(0.15, Math.min(1.5, expectedDurationSeconds * 0.001))
  if (Math.abs(diagnostics.durationSeconds - expectedDurationSeconds) > durationTolerance) return 'duration_mismatch'
  if (diagnostics.codec !== 'aac' || diagnostics.sampleRate !== 16000 || diagnostics.channels !== 1) return 'audio_format_mismatch'
  return null
}

export async function promoteTranscriptSplitFiles(stagedPaths, finalPaths, rename, remove) {
  const promoted = []
  try {
    for (let index = 0; index < stagedPaths.length; index += 1) {
      await rename(stagedPaths[index], finalPaths[index])
      promoted.push(finalPaths[index])
    }
  } catch (error) {
    await Promise.all(promoted.map((filePath) => remove(filePath).catch(() => {})))
    throw error
  }
}
