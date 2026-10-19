// API errors. Every error response is { error: { code, message, requestId, details? } }.

export class ApiError extends Error {
  /**
   * @param {number} status HTTP status
   * @param {string} code   stable machine code, snake_case
   * @param {string} message human sentence, safe to show
   * @param {object} [details]
   */
  constructor(status, code, message, details) {
    super(message);
    this.statusCode = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message, details) => new ApiError(400, 'bad_request', message, details);
export const validationFailed = (message, details) => new ApiError(400, 'validation_failed', message, details);
export const unauthenticated = (message = 'Sign in first.') => new ApiError(401, 'unauthenticated', message);
export const forbidden = (message = 'You do not have permission to do that.') => new ApiError(403, 'forbidden', message);
export const notFound = (message = 'Not found.') => new ApiError(404, 'not_found', message);
export const conflict = (message, details) => new ApiError(409, 'conflict', message, details);
export const tooLarge = (message) => new ApiError(413, 'too_large', message);
