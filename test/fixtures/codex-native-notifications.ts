import type { CodexServerNotification } from '../../src/codex/protocol.js'

export const codexNativeNotifications = {
  turnStarted: {
    method: 'turn/started',
    params: {
      threadId: 'thread-native-1',
      turn: { id: 'turn-native-1', items: [], status: 'inProgress', error: null },
    },
    receivedAt: '2026-07-24T08:00:00.000Z',
  },
  assistantDelta: {
    method: 'item/agentMessage/delta',
    params: {
      threadId: 'thread-native-1',
      turnId: 'turn-native-1',
      itemId: 'message-native-1',
      delta: 'Durable hello',
    },
    receivedAt: '2026-07-24T08:00:00.100Z',
  },
  toolCompleted: {
    method: 'item/completed',
    params: {
      threadId: 'thread-native-1',
      turnId: 'turn-native-1',
      item: {
        type: 'commandExecution',
        id: 'command-native-1',
        command: 'npm test -- --runInBand',
        aggregatedOutput: 'all tests passed',
        exitCode: 0,
      },
    },
    receivedAt: '2026-07-24T08:00:00.200Z',
  },
  usage: {
    method: 'thread/tokenUsage/updated',
    params: {
      threadId: 'thread-native-1',
      turnId: 'turn-native-1',
      tokenUsage: {
        total: {
          totalTokens: 144,
          inputTokens: 100,
          cachedInputTokens: 30,
          outputTokens: 44,
          reasoningOutputTokens: 12,
        },
        last: {
          totalTokens: 44,
          inputTokens: 20,
          cachedInputTokens: 5,
          outputTokens: 24,
          reasoningOutputTokens: 6,
        },
        modelContextWindow: 200_000,
      },
    },
    receivedAt: '2026-07-24T08:00:00.300Z',
  },
  unknown: {
    method: 'future/threadFeature',
    params: {
      threadId: 'thread-native-1',
      turnId: 'turn-native-1',
      itemId: 'future-native-1',
      futureValue: true,
      unredactedSecret: 'must-never-be-stored',
    },
    receivedAt: '2026-07-24T08:00:00.400Z',
  },
  childThreadStarted: {
    method: 'thread/started',
    params: {
      thread: {
        id: 'thread-native-child',
        parentThreadId: 'thread-native-1',
        status: { type: 'active', activeFlags: [] },
        cwd: '/codex-native',
        turns: [],
        agentNickname: 'reviewer',
        agentRole: 'review',
      },
    },
    receivedAt: '2026-07-24T08:00:00.450Z',
  },
  turnCompleted: {
    method: 'turn/completed',
    params: {
      threadId: 'thread-native-1',
      turn: {
        id: 'turn-native-1',
        items: [],
        status: 'completed',
        error: null,
        completedAt: 1_795_418_401,
      },
    },
    receivedAt: '2026-07-24T08:00:00.500Z',
  },
  assistantCompleted: {
    method: 'item/completed',
    params: {
      threadId: 'thread-native-1',
      turnId: 'turn-native-1',
      item: {
        type: 'agentMessage',
        id: 'message-native-final',
        text: 'Canonical final answer',
      },
    },
    receivedAt: '2026-07-24T08:00:01.000Z',
  },
  assistantCompletedChanged: {
    method: 'item/completed',
    params: {
      threadId: 'thread-native-1',
      turnId: 'turn-native-1',
      item: {
        type: 'agentMessage',
        id: 'message-native-final',
        text: 'Conflicting final answer',
      },
    },
    receivedAt: '2026-07-24T08:00:09.000Z',
  },
} satisfies Record<string, CodexServerNotification>
