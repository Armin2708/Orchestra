import { describe, expect, it } from 'vitest'
import {
  MAX_CANVAS_ZOOM,
  MIN_CANVAS_ZOOM,
  canvasViewportStorageKey,
  canvasGrid,
  canvasSceneOffset,
  clampCanvasZoom,
  defaultCanvasViewport,
  panCanvasBy,
  screenToCanvas,
  screenToCanvasLocal,
  zoomCanvasAt,
} from '../web/src/canvasViewport.js'

describe('board canvas viewport math', () => {
  it('starts wide and compact screens at a readable full scale', () => {
    expect(defaultCanvasViewport(false)).toEqual({ x: 0, y: 0, zoom: 1 })
    expect(defaultCanvasViewport(true)).toEqual({ x: 0, y: 0, zoom: 1 })
  })

  it('keeps compact and wide viewport preferences separate', () => {
    expect(canvasViewportStorageKey('project-1', false)).toBe('project-1:wide')
    expect(canvasViewportStorageKey('project-1', true)).toBe('project-1:compact-v2')
  })

  it('clamps zoom to a useful range', () => {
    expect(clampCanvasZoom(0.01)).toBe(MIN_CANVAS_ZOOM)
    expect(clampCanvasZoom(1.4)).toBe(1.4)
    expect(clampCanvasZoom(9)).toBe(MAX_CANVAS_ZOOM)
  })

  it('keeps the canvas point under the pointer while zooming', () => {
    const before = { x: -120, y: 80, zoom: 0.8 }
    const pointer = { x: 310, y: 240 }
    const canvasPoint = screenToCanvas(before, pointer)
    const after = zoomCanvasAt(before, 1.6, pointer)

    expect(screenToCanvas(after, pointer)).toEqual(canvasPoint)
  })

  it('keeps the pointer anchor stable when zoom hits a limit', () => {
    const before = { x: 40, y: -25, zoom: 1 }
    const pointer = { x: 180, y: 90 }
    const canvasPoint = screenToCanvas(before, pointer)
    const after = zoomCanvasAt(before, 20, pointer)

    expect(after.zoom).toBe(MAX_CANVAS_ZOOM)
    expect(screenToCanvas(after, pointer)).toEqual(canvasPoint)
  })

  it('pans without changing zoom', () => {
    expect(panCanvasBy({ x: 10, y: 20, zoom: 0.75 }, { x: -30, y: 12 }))
      .toEqual({ x: -20, y: 32, zoom: 0.75 })
  })

  it('maps a transformed pointer back into the fixed network local space', () => {
    const viewport = { x: -80, y: 50, zoom: 0.5 }
    const networkOrigin = { x: 300, y: 120 }
    const pointer = { x: 270, y: 230 }

    expect(screenToCanvasLocal(viewport, pointer, networkOrigin))
      .toEqual({ x: 400, y: 240 })
  })

  it('aligns a fixed network scene with global board coordinates', () => {
    const viewport = { x: -80, y: 50, zoom: 0.5 }
    const networkOrigin = { x: 300, y: 120 }
    const localPoint = { x: 400, y: 240 }
    const offset = canvasSceneOffset(viewport, networkOrigin)

    expect(offset).toEqual({ x: -230, y: -10 })
    expect({
      x: networkOrigin.x + offset.x + localPoint.x * viewport.zoom,
      y: networkOrigin.y + offset.y + localPoint.y * viewport.zoom,
    }).toEqual({ x: 270, y: 230 })
  })

  it('moves and scales the dotted grid with the whole canvas', () => {
    expect(canvasGrid({ x: -5, y: 41, zoom: 0.5 }))
      .toEqual({ size: 9, x: 4, y: 5 })
  })
})
