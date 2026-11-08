class HttpError extends Error {
  constructor(statusCode, code, message, options = {}) {
    super(message, options);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function asHttpError(error) {
  if (error instanceof HttpError) return error;
  if (error instanceof SyntaxError) return new HttpError(400, 'INVALID_JSON', 'invalid JSON body');
  return new HttpError(500, 'INTERNAL_ERROR', 'internal server error', { cause: error });
}

module.exports = { HttpError, asHttpError };
