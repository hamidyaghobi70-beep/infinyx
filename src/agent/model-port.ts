export interface ModelCompletionRequest {
  readonly prompt: string;
  readonly signal: AbortSignal;
  readonly deadlineAt: number;
}

export interface ModelPort {
  /**
   * Requests a completion from the underlying model provider.
   *
   * The supplied AbortSignal is a cooperative cancellation request, not a
   * guarantee that provider work will terminate. A non-cooperative provider
   * may ignore the signal and its returned Promise may never settle. In that
   * case, AgentRuntime keeps this task's capacity slot reserved until the
   * Promise actually settles, potentially indefinitely. See
   * docs/agent-runtime-capacity.md.
   */
  complete(request: ModelCompletionRequest): Promise<string>;
}

export class ModelProviderDisabledError extends Error {
  readonly code = "MODEL_PROVIDER_DISABLED";

  constructor() {
    super("The model provider is disabled in this build.");
    this.name = "ModelProviderDisabledError";
  }
}

/** Safe default: no network client or live model provider is configured. */
export class DisabledModelPort implements ModelPort {
  async complete(_request: ModelCompletionRequest): Promise<string> {
    throw new ModelProviderDisabledError();
  }
}
