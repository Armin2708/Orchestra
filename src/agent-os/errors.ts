export class AgentOsError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
    readonly code = 'agent_os_error',
  ) {
    super(message)
    this.name = new.target.name
  }
}

export class ValidationError extends AgentOsError {
  constructor(message: string) { super(message, 400, 'validation_error') }
}

export class NotFoundError extends AgentOsError {
  constructor(message: string) { super(message, 404, 'not_found') }
}

export class ConflictError extends AgentOsError {
  constructor(message: string) { super(message, 409, 'conflict') }
}

export class ForbiddenError extends AgentOsError {
  constructor(message: string) { super(message, 403, 'forbidden') }
}

export class UnsupportedError extends AgentOsError {
  constructor(message: string) { super(message, 501, 'not_supported') }
}
