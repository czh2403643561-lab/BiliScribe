export function isAdaptiveTranscriptError(code) {
  return code === 'mimo_output_truncated' || code === 'mimo_repetition_truncation' || code === 'mimo_content_filtered'
}

export function planAdaptiveTranscriptSplit(segment, minimumDurationSeconds, maxSplitDepth) {
  const nextDepth = (segment.splitDepth || 0) + 1
  const childDurationSeconds = Number(segment.durationSeconds) / 2
  if (!Number.isFinite(childDurationSeconds) || childDurationSeconds < minimumDurationSeconds) {
    return { canSplit: false, reason: 'minimum_duration' }
  }
  if (nextDepth > maxSplitDepth) return { canSplit: false, reason: 'maximum_depth' }
  return { canSplit: true, nextDepth, childDurationSeconds }
}

export function replaceAdaptiveTranscriptSegment(segments, cursor, children, checkpoint, completed) {
  segments.splice(cursor, 1, ...children)
  checkpoint.segments = segments
  checkpoint.segmentCount = segments.length
  checkpoint.completedSegments = segments.filter((segment) => completed.has(segment.id)).map((segment) => segment.id)
  checkpoint.currentSegment = children[0].id
  return checkpoint
}

export function ensureTranscriptSegmentTimeRanges(segments) {
  let cursorSeconds = 0
  for (const segment of segments) {
    const hasRange = Number.isFinite(segment.startSeconds)
      && Number.isFinite(segment.endSeconds)
      && segment.endSeconds >= segment.startSeconds
    if (!hasRange) {
      segment.startSeconds = cursorSeconds
      segment.endSeconds = cursorSeconds + Math.max(0, Number(segment.durationSeconds) || 0)
    }
    cursorSeconds = segment.endSeconds
  }
}

export function formatTranscriptTimeRange(segment) {
  const startSeconds = Number.isFinite(segment.startSeconds) ? segment.startSeconds : 0
  const endSeconds = Number.isFinite(segment.endSeconds)
    ? segment.endSeconds
    : startSeconds + (Number(segment.durationSeconds) || 0)
  const format = (seconds) => {
    const value = Math.max(0, Math.floor(seconds))
    const hours = String(Math.floor(value / 3600)).padStart(2, '0')
    const minutes = String(Math.floor((value % 3600) / 60)).padStart(2, '0')
    const remainder = String(value % 60).padStart(2, '0')
    return `${hours}:${minutes}:${remainder}`
  }
  return `${format(startSeconds)}–${format(endSeconds)}`
}
