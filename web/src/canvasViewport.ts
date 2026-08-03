export type CanvasPoint = { x: number; y: number }
export type CanvasViewport = CanvasPoint & { zoom: number }

export const MIN_CANVAS_ZOOM = 0.35
export const MAX_CANVAS_ZOOM = 2.5
export const DEFAULT_CANVAS_VIEWPORT: CanvasViewport = { x: 0, y: 0, zoom: 1 }
export const COMPACT_CANVAS_VIEWPORT: CanvasViewport = { x: 0, y: 0, zoom: 1 }

export function defaultCanvasViewport(compact: boolean): CanvasViewport {
  return { ...(compact ? COMPACT_CANVAS_VIEWPORT : DEFAULT_CANVAS_VIEWPORT) }
}

export function canvasViewportStorageKey(storageKey: string, compact: boolean) {
  return `${storageKey}:${compact ? 'compact-v2' : 'wide'}`
}

export function clampCanvasZoom(zoom: number) {
  return Math.min(MAX_CANVAS_ZOOM, Math.max(MIN_CANVAS_ZOOM, zoom))
}

export function screenToCanvas(viewport: CanvasViewport, point: CanvasPoint): CanvasPoint {
  return {
    x: (point.x - viewport.x) / viewport.zoom,
    y: (point.y - viewport.y) / viewport.zoom,
  }
}

export function screenToCanvasLocal(
  viewport: CanvasViewport,
  point: CanvasPoint,
  localOrigin: CanvasPoint,
): CanvasPoint {
  const canvasPoint = screenToCanvas(viewport, point)
  return {
    x: canvasPoint.x - localOrigin.x,
    y: canvasPoint.y - localOrigin.y,
  }
}

export function canvasSceneOffset(viewport: CanvasViewport, localOrigin: CanvasPoint): CanvasPoint {
  return {
    x: viewport.x + (viewport.zoom - 1) * localOrigin.x,
    y: viewport.y + (viewport.zoom - 1) * localOrigin.y,
  }
}

export function zoomCanvasAt(viewport: CanvasViewport, zoom: number, anchor: CanvasPoint): CanvasViewport {
  const nextZoom = clampCanvasZoom(zoom)
  const canvasPoint = screenToCanvas(viewport, anchor)
  return {
    x: anchor.x - canvasPoint.x * nextZoom,
    y: anchor.y - canvasPoint.y * nextZoom,
    zoom: nextZoom,
  }
}

export function panCanvasBy(viewport: CanvasViewport, delta: CanvasPoint): CanvasViewport {
  return { ...viewport, x: viewport.x + delta.x, y: viewport.y + delta.y }
}

export function canvasGrid(viewport: CanvasViewport, spacing = 18) {
  const size = spacing * viewport.zoom
  const wrap = (value: number) => ((value % size) + size) % size
  return { size, x: wrap(viewport.x), y: wrap(viewport.y) }
}
