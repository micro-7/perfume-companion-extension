export class LlmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Gemini rate or quota limit hit (HTTP 429 / RESOURCE_EXHAUSTED). */
export class QuotaExceededError extends LlmError {
  constructor(public retryDelayMs: number | null, message = 'Gemini quota exhausted') {
    super(message);
  }
}

/** Bad or missing API key / permission problem. Never triggers the Ollama fallback. */
export class AuthError extends LlmError {}

export class ServerError extends LlmError {
  /** False for errors that retrying will not fix soon (for example a request that timed out). */
  constructor(message: string, public retryable = true) {
    super(message);
  }
}

/** The model's answer was not usable JSON for the expected shape. */
export class BadResponseError extends LlmError {}

export class OllamaUnreachableError extends LlmError {}

/** Ollama answered 403: the extension's origin is not in OLLAMA_ORIGINS. */
export class OriginNotAllowedError extends LlmError {
  constructor(public origin: string) {
    super(`Ollama rejected the origin ${origin}`);
  }
}

/** A request needed Google Search grounding while Gemini is unavailable. */
export class SearchUnavailableError extends LlmError {
  constructor() {
    super('Search is unavailable right now');
  }
}

/** Neither Gemini nor Ollama could answer. */
export class NoProviderError extends LlmError {
  constructor(
    public ollamaCause: unknown,
    public hadGeminiKey: boolean,
    /** Why Gemini did not answer: its quota ran out, or it was busy or unreachable. */
    public geminiProblem?: 'quota' | 'busy',
  ) {
    super('No AI provider is reachable');
  }
}

/** Short text for the user. */
export function describeError(e: unknown): string {
  if (e instanceof NoProviderError) {
    const c = e.ollamaCause;
    if (c instanceof OriginNotAllowedError) {
      return `Ollama is running but blocked this extension. Set OLLAMA_ORIGINS to include ${c.origin} and restart Ollama.`;
    }
    if (e.geminiProblem === 'busy') {
      return 'Gemini is busy or not reachable right now, and Ollama is not reachable either. Try again in a moment, or start Ollama (see Options).';
    }
    return e.hadGeminiKey
      ? 'Gemini is out of quota and Ollama is not reachable. Start Ollama (see Options) or try again later.'
      : 'No AI provider is reachable. Add a Gemini API key or start Ollama (see Options).';
  }
  if (e instanceof AuthError) return 'Gemini rejected the API key. Check it in Options.';
  if (e instanceof OriginNotAllowedError) {
    return `Ollama blocked this extension. Set OLLAMA_ORIGINS to include ${e.origin} and restart Ollama.`;
  }
  if (e instanceof OllamaUnreachableError) return e.message;
  if (e instanceof BadResponseError) return 'The AI returned an answer I could not read. Try again.';
  if (e instanceof ServerError) return `The AI service had a problem: ${e.message}`;
  if (e instanceof SearchUnavailableError) return e.message;
  return e instanceof Error ? e.message : 'Something went wrong.';
}
