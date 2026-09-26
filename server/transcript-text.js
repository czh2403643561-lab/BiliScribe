export function cleanTranscriptText(value) {
  return String(value || '')
    .replace(/\r\n?/g, '\n')
    .replace(/(^|\n)[\t ]*\d+(?::\d{2})*(?:\.\d+)?[\t ]*-[\t ]*\d+(?::\d{2})*(?:\.\d+)?[\t ]*\|[\t ]*SPEAKER_\d+[\t ]*:[\t ]*/giu, '$1')
    .replace(/[\t\u00a0 ]+\n/g, '\n')
    .trim()
}

export function analyzeTranscriptOutput(value) {
  const text = String(value || '')
  const characters = Array.from(text)
  const words = text.match(/[\p{Script=Han}]|[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) || []
  const normalized = text.replace(/\s+/gu, '')
  const points = Array.from(normalized)
  const windowSize = 32
  const step = 1
  const seen = new Set()
  let repeatedCharacters = 0
  let repeatedFragmentSample = ''

  for (let index = 0; index + windowSize <= points.length; index += step) {
    const fragment = points.slice(index, index + windowSize).join('')
    if (seen.has(fragment)) {
      repeatedCharacters += step
      if (!repeatedFragmentSample) repeatedFragmentSample = fragment.slice(0, 200)
    } else seen.add(fragment)
  }

  return {
    outputCharacterCount: characters.length,
    outputWordCount: words.length,
    first100Characters: characters.slice(0, 100).join(''),
    last300Characters: characters.slice(-300).join(''),
    repetitionScore: points.length ? Math.min(1, repeatedCharacters / points.length) : 0,
    repeatedFragmentSample: repeatedFragmentSample.slice(0, 200),
  }
}
