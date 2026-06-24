// anthropic_retry.ts
// Reusable wrapper for calling the Anthropic Messages API with
// exponential backoff retry on transient (infrastructure) failures.

// HTTP status codes that are worth retrying.
//   429 = rate limited
//   500 = internal server error
//   502 = bad gateway
//   503 = service unavailable
//   529 = overloaded  (Anthropic-specific)
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 529]);

export interface AnthropicRetryOptions {
  apiUrl: string;
  apiKey: string;
  apiVersion: string;
  /** Maximum number of attempts (NOT retries). e.g. 5 = 1 initial + 4 retries */
  maxAttempts?: number;
  /** Base delay in seconds for the first backoff. Default 2s. */
  baseDelaySeconds?: number;
  /** Cap on any single delay, in seconds. Default 60s. */
  maxDelaySeconds?: number;
  /** Optional label used in log lines so you can tell callers apart. */
  label?: string;
}

// A custom error so callers can inspect what happened.
export class AnthropicError extends Error {
  status?: number;
  attempts: number;
  isRetryable: boolean;
  responseBody?: unknown;

  constructor(
    message: string,
    opts: { status?: number; attempts: number; isRetryable: boolean; responseBody?: unknown }
  ) {
    super(message);
    this.name = 'AnthropicError';
    this.status = opts.status;
    this.attempts = opts.attempts;
    this.isRetryable = opts.isRetryable;
    this.responseBody = opts.responseBody;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Compute the delay (in ms) before the next attempt.
 * Exponential backoff with full jitter, optionally honoring Retry-After.
 */
function computeDelayMs(
  attempt: number,                 // 1-based attempt that just failed
  baseDelaySeconds: number,
  maxDelaySeconds: number,
  retryAfterHeader: string | null
): number {
  // If Anthropic told us exactly how long to wait, respect it.
  if (retryAfterHeader) {
    const retryAfterSec = Number(retryAfterHeader);
    if (!Number.isNaN(retryAfterSec) && retryAfterSec > 0) {
      return Math.min(retryAfterSec, maxDelaySeconds) * 1000;
    }
  }

  // Exponential: base * 2^(attempt-1), capped, then full jitter.
  const exp = baseDelaySeconds * Math.pow(2, attempt - 1);
  const capped = Math.min(exp, maxDelaySeconds);
  const jittered = Math.random() * capped; // full jitter in [0, capped]
  return Math.max(jittered, 0) * 1000;
}

/**
 * Calls the Anthropic Messages API with retry on transient failures.
 *
 * @param requestBody  The JSON body for the Messages API (model, max_tokens, messages, ...)
 * @param options      API config + retry tuning.
 * @returns            The parsed JSON response from Anthropic on success.
 * @throws AnthropicError on non-retryable failure or once max attempts is exhausted.
 */
export async function callAnthropicWithRetry(
  // deno-lint-ignore no-explicit-any
  requestBody: Record<string, any>,
  options: AnthropicRetryOptions
  // deno-lint-ignore no-explicit-any
): Promise<any> {
  const {
    apiUrl,
    apiKey,
    apiVersion,
    maxAttempts = 5,
    baseDelaySeconds = 2,
    maxDelaySeconds = 60,
    label = 'anthropic',
  } = options;

  let lastError: AnthropicError | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      console.log(`[${label}] Anthropic call attempt ${attempt}/${maxAttempts}`);

      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': apiVersion,
        },
        body: JSON.stringify(requestBody),
      });

      if (response.ok) {
        console.log(`[${label}] Success on attempt ${attempt}`);
        return await response.json();
      }

      // Non-2xx. Try to read the body for diagnostics.
      let errorBody: unknown;
      try {
        errorBody = await response.json();
      } catch {
        errorBody = await response.text().catch(() => '<unreadable body>');
      }

      const retryable = RETRYABLE_STATUS.has(response.status);
      lastError = new AnthropicError(
        `Anthropic API error ${response.status}: ${JSON.stringify(errorBody)}`,
        {
          status: response.status,
          attempts: attempt,
          isRetryable: retryable,
          responseBody: errorBody,
        }
      );

      // Permanent error — fail fast, do not retry.
      if (!retryable) {
        console.error(`[${label}] Non-retryable error ${response.status} — aborting.`);
        throw lastError;
      }

      // Retryable, but if this was the last attempt, stop.
      if (attempt === maxAttempts) {
        console.error(`[${label}] Exhausted ${maxAttempts} attempts on status ${response.status}.`);
        break;
      }

      const delayMs = computeDelayMs(
        attempt,
        baseDelaySeconds,
        maxDelaySeconds,
        response.headers.get('retry-after')
      );
      console.warn(
        `[${label}] Retryable error ${response.status}. ` +
        `Waiting ${(delayMs / 1000).toFixed(1)}s before attempt ${attempt + 1}.`
      );
      await sleep(delayMs);

    } catch (err) {
      // If we already classified it as non-retryable above, rethrow immediately.
      if (err instanceof AnthropicError && !err.isRetryable) {
        throw err;
      }

      // Network-level failure (DNS, connection reset, timeout, etc.) — treat as retryable.
      lastError = new AnthropicError(
        `Network/transport error calling Anthropic: ${err instanceof Error ? err.message : String(err)}`,
        { attempts: attempt, isRetryable: true }
      );

      if (attempt === maxAttempts) {
        console.error(`[${label}] Exhausted ${maxAttempts} attempts after transport error.`);
        break;
      }

      const delayMs = computeDelayMs(attempt, baseDelaySeconds, maxDelaySeconds, null);
      console.warn(
        `[${label}] Transport error: ${lastError.message}. ` +
        `Waiting ${(delayMs / 1000).toFixed(1)}s before attempt ${attempt + 1}.`
      );
      await sleep(delayMs);
    }
  }

  // If we got here, every attempt failed.
  throw lastError ?? new AnthropicError('Anthropic call failed with no captured error', {
    attempts: maxAttempts,
    isRetryable: true,
  });
}