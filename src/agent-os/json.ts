import { ValidationError } from './errors.js'

export function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value === '') return fallback
  try { return JSON.parse(value) as T } catch { return fallback }
}

export function stringArray(value: unknown, field: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new ValidationError(`${field} must be an array of strings`)
  }
  return [...new Set(value.map((item) => item.trim()).filter(Boolean))]
}

export function integerArray(value: unknown, field: string): number[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((item) => !Number.isInteger(item) || Number(item) <= 0)) {
    throw new ValidationError(`${field} must be an array of positive integer ids`)
  }
  return [...new Set(value.map(Number))]
}

export function objectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError('request body must be an object')
  }
  return value as Record<string, unknown>
}

export function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new ValidationError(`${field} is required`)
  return value.trim()
}

export function optionalInteger(value: unknown, field: string): number | null {
  if (value === undefined || value === null || value === '') return null
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new ValidationError(`${field} must be a non-negative integer`)
  return parsed
}

export function positiveId(value: unknown, field = 'id'): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new ValidationError(`${field} must be a positive integer`)
  return parsed
}

export function timestamp(): string {
  return new Date().toISOString()
}
