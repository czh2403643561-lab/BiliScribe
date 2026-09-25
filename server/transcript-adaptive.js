export function isAdaptiveTranscriptError(code) {
  return code === 'mimo_output_truncated' || code === 'mimo_repetition_truncation'
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
