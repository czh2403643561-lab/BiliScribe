import test from 'node:test'
import assert from 'node:assert/strict'
import {
  isAdaptiveTranscriptError,
  planAdaptiveTranscriptSplit,
  replaceAdaptiveTranscriptSegment,
} from './transcript-adaptive.js'

test('stop does not trigger splitting, while repetition and length do', () => {
  assert.equal(isAdaptiveTranscriptError('stop'), false)
  assert.equal(isAdaptiveTranscriptError('mimo_repetition_truncation'), true)
  assert.equal(isAdaptiveTranscriptError('mimo_output_truncated'), true)
})

test('a failed 77 minute segment is bisected and reports child duration', () => {
  const plan = planAdaptiveTranscriptSplit({ durationSeconds: 4631, splitDepth: 0 }, 480, 10)
  assert.deepEqual(plan, { canSplit: true, nextDepth: 1, childDurationSeconds: 2315.5 })
})

test('only the failed segment is replaced and completed checkpoint segments remain reusable', () => {
  const segments = [{ id: '001', splitDepth: 0 }, { id: '002', splitDepth: 0 }]
  const completed = new Set(['001'])
  const checkpoint = { segments, completedSegments: ['001'], segmentCount: 2, currentSegment: '002' }
  const children = [{ id: '002a', splitDepth: 1 }, { id: '002b', splitDepth: 1 }]

  replaceAdaptiveTranscriptSegment(segments, 1, children, checkpoint, completed)
  assert.deepEqual(segments.map((segment) => segment.id), ['001', '002a', '002b'])
  assert.deepEqual(checkpoint.completedSegments, ['001'])
  assert.equal(checkpoint.currentSegment, '002a')
  assert.equal(checkpoint.segmentCount, 3)
})

test('a child below the 8 minute minimum cannot be split again', () => {
  const plan = planAdaptiveTranscriptSplit({ durationSeconds: 575, splitDepth: 3 }, 480, 10)
  assert.deepEqual(plan, { canSplit: false, reason: 'minimum_duration' })
})
