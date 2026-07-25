import type { WorkspaceProcess } from './osApi'

const resizableProcessStatuses = new Set(['starting', 'running'])

export function isResizableProcess(
  process: Pick<WorkspaceProcess, 'id' | 'status'> | null | undefined,
): process is Pick<WorkspaceProcess, 'id' | 'status'> {
  return Boolean(process && resizableProcessStatuses.has(process.status))
}
