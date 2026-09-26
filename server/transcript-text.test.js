import test from 'node:test'
import assert from 'node:assert/strict'
import { cleanTranscriptText } from './transcript-text.js'

test('removes a timestamp and speaker prefix without changing the transcript body', () => {
  assert.equal(cleanTranscriptText('0.19-11.33 | SPEAKER_00: 大家好'), '大家好')
})

test('removes repeated line prefixes while preserving the spoken text and order', () => {
  assert.equal(
    cleanTranscriptText('0.19-11.33 | SPEAKER_00: 大家好\n11.33-15.2 | SPEAKER_01: 我们开始'),
    '大家好\n我们开始',
  )
})

test('keeps lines without a timestamp and speaker prefix unchanged', () => {
  assert.equal(cleanTranscriptText('大家好，今天开始。'), '大家好，今天开始。')
})
