import test from 'node:test'
import assert from 'node:assert/strict'
import { analyzeTranscriptOutput, cleanTranscriptText } from './transcript-text.js'

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

test('reports bounded transcript excerpts and detects repeated fragments', () => {
  const phrase = '这是一段用于诊断重复输出的示例文字内容，模型可能会反复生成同一段课程文本。'
  const diagnostics = analyzeTranscriptOutput(`${phrase}${phrase}`)

  assert.equal(diagnostics.outputCharacterCount, Array.from(`${phrase}${phrase}`).length)
  assert.ok(diagnostics.outputWordCount > 0)
  assert.ok(diagnostics.repetitionScore > 0)
  assert.ok(diagnostics.repeatedFragmentSample.length <= 200)
  assert.ok(Array.from(diagnostics.first100Characters).length <= 100)
  assert.ok(Array.from(diagnostics.last300Characters).length <= 300)
})

test('flags a long loop but accepts varied transcript text', () => {
  const loop = '讲师反复说明同一个格局判定条件及对应的行运规则。'.repeat(35)
  const varied = Array.from({ length: 800 }, (_, index) => String.fromCharCode(0x4e00 + index)).join('')
  assert.equal(analyzeTranscriptOutput(loop).repeatedOutput, true)
  assert.equal(analyzeTranscriptOutput(varied).repeatedOutput, false)
})
