import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { silenceCanUseToolShadowWarning } from '../src/sdk-warnings.js'

// The patch is installed once per process (it is idempotent by design), so it is
// installed for the whole file and the original restored at the end.
const original = process.emitWarning

// process warnings are delivered asynchronously, so collect across a macrotask.
async function warningsFrom(emit: () => void): Promise<string[]> {
  const seen: string[] = []
  const listener = (w: Error) => seen.push(w.message)
  process.on('warning', listener)
  try {
    emit()
    await new Promise((resolve) => setImmediate(resolve))
  } finally {
    process.off('warning', listener)
  }
  return seen
}

describe('silenceCanUseToolShadowWarning', () => {
  beforeAll(() => { silenceCanUseToolShadowWarning() })
  afterAll(() => { process.emitWarning = original })

  it('drops the SDK canUseTool-shadowed warning', async () => {
    expect(await warningsFrom(() => {
      process.emitWarning('canUseTool will not be invoked', { code: 'CLAUDE_SDK_CAN_USE_TOOL_SHADOWED' })
    })).toEqual([])
  })

  it('still prints every other warning', async () => {
    expect(await warningsFrom(() => {
      process.emitWarning('a real problem', { code: 'ORCHESTRA_TEST_WARNING' })
      process.emitWarning('an uncoded problem')
    })).toEqual(['a real problem', 'an uncoded problem'])
  })

  it('honours the positional (warning, type, code) signature', async () => {
    expect(await warningsFrom(() => {
      process.emitWarning('shadowed', 'Warning', 'CLAUDE_SDK_CAN_USE_TOOL_SHADOWED')
      process.emitWarning('kept', 'Warning', 'SOMETHING_ELSE')
    })).toEqual(['kept'])
  })

  it('is idempotent — a second install does not double-wrap or drop extra warnings', async () => {
    silenceCanUseToolShadowWarning()
    expect(await warningsFrom(() => {
      process.emitWarning('still here', { code: 'ORCHESTRA_TEST_WARNING' })
    })).toEqual(['still here'])
  })
})
