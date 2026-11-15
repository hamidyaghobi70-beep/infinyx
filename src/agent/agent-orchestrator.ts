import type { ModelPort } from "./model-port.js";
import { TaskPlanner } from "./task-planner.js";

export class AgentOrchestrator {
  constructor(
    private readonly planner: TaskPlanner,
    private readonly model: ModelPort
  ) {}

  run(prompt: string, signal: AbortSignal, deadlineAt: number): Promise<string> {
    const request = this.planner.createRequest(prompt, signal, deadlineAt);
    return this.model.complete(request);
  }
}
