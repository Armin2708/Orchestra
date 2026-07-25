type CardDrawerSelection = {
  boardId: number | null
  cardId: number | null
}

type LocationParts = {
  pathname: string
  hash?: string
}

const positiveIdFromSearch = (search: string, key: string): number | null => {
  const value = new URLSearchParams(search).get(key)
  if (value === null || !/^[1-9]\d*$/.test(value)) return null
  const id = Number(value)
  return Number.isSafeInteger(id) ? id : null
}

export const boardIdFromSearch = (search: string): number | null =>
  positiveIdFromSearch(search, 'board')

export const cardIdFromSearch = (search: string): number | null =>
  positiveIdFromSearch(search, 'card')

export const cardDrawerDeepLink = (
  search: string,
  selection: CardDrawerSelection,
  locationParts: LocationParts = { pathname: '/', hash: '' },
) => {
  const params = new URLSearchParams(search)
  if (selection.boardId === null) params.delete('board')
  else params.set('board', String(selection.boardId))
  if (selection.cardId === null) params.delete('card')
  else params.set('card', String(selection.cardId))
  const query = params.toString()
  return `${locationParts.pathname}${query ? `?${query}` : ''}${locationParts.hash ?? ''}`
}
