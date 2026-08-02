export type RuntimeMutationResult<T> =
  | { performed: false }
  | { performed: true; value: T }

export async function runRuntimeMutation<T>(
  readOnly: boolean,
  mutation: () => Promise<T>,
): Promise<RuntimeMutationResult<T>> {
  if (readOnly) return { performed: false }
  return { performed: true, value: await mutation() }
}
