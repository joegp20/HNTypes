// A permanent, non-retryable failure. The worker will DLQ + delete immediately.
class TerminalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TerminalError';
  }
}
