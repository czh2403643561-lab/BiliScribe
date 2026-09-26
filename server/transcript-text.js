export function cleanTranscriptText(value) {
  return String(value || '')
    .replace(/\r\n?/g, '\n')
    .replace(/(^|\n)[\t ]*\d+(?::\d{2})*(?:\.\d+)?[\t ]*-[\t ]*\d+(?::\d{2})*(?:\.\d+)?[\t ]*\|[\t ]*SPEAKER_\d+[\t ]*:[\t ]*/giu, '$1')
    .replace(/[\t\u00a0 ]+\n/g, '\n')
    .trim()
}
