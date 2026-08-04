import { describe, expect, it } from 'vitest'
import { askUserQuestions, askUserQuestionInput } from '../src/conductor.js'

const input = {
  questions: [
    {
      question: 'How should agent messages get into the inbox?',
      header: 'Inbox',
      multiSelect: false,
      options: [
        { label: 'Reuse the existing bus', description: 'no new tables' },
        { label: 'New delivery table' },
      ],
    },
    {
      question: 'Which providers must be supported?',
      multiSelect: true,
      options: [{ label: 'claude' }, { label: 'codex' }],
    },
  ],
}

describe('AskUserQuestion board form (#97)', () => {
  it('parses tool input into board-renderable questions', () => {
    const questions = askUserQuestions(input)!
    expect(questions).toHaveLength(2)
    expect(questions[0]).toMatchObject({
      id: '0',
      header: 'Inbox',
      question: 'How should agent messages get into the inbox?',
      multiSelect: false,
      isOther: true,
    })
    expect(questions[0]!.options).toEqual([
      { label: 'Reuse the existing bus', description: 'no new tables' },
      { label: 'New delivery table' },
    ])
    expect(questions[1]).toMatchObject({ id: '1', multiSelect: true })
  })

  it('rejects malformed question payloads instead of guessing', () => {
    expect(askUserQuestions({})).toBeNull()
    expect(askUserQuestions({ questions: [] })).toBeNull()
    expect(askUserQuestions({ questions: [{ question: '' }] })).toBeNull()
    expect(askUserQuestions({ questions: [{ question: 42 }] })).toBeNull()
    expect(askUserQuestions({ questions: 'no' })).toBeNull()
  })

  it('tolerates option entries without labels', () => {
    const questions = askUserQuestions({
      questions: [{ question: 'Free form?', options: [{ label: '' }, 'junk'] }],
    })!
    expect(questions[0]!.options).toEqual([])
  })

  it('maps board answers into updatedInput.answers keyed by question text', () => {
    const questions = askUserQuestions(input)!
    const updated = askUserQuestionInput(input, questions, {
      0: ['Reuse the existing bus'],
      1: ['claude', 'codex'],
    })
    expect(updated.answers).toEqual({
      'How should agent messages get into the inbox?': 'Reuse the existing bus',
      'Which providers must be supported?': 'claude, codex',
    })
    expect(updated.questions).toBe(input.questions)
  })

  it('omits unanswered and blank questions from the answers map', () => {
    const questions = askUserQuestions(input)!
    const updated = askUserQuestionInput(input, questions, { 0: ['  '] })
    expect(updated.answers).toEqual({})
  })
})
