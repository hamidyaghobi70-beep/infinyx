export interface ModelCompletionRequest {
  readonly prompt: string;
  readonly signal: AbortSignal;
  readonly deadlineAt: number;
}

export interface ModelPort {
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
