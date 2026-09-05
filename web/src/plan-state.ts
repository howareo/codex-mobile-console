export type PlanStepStatus = "pending" | "inProgress" | "completed";

export interface PlanStep {
  step: string;
  status: PlanStepStatus;
}

export interface PlanSnapshot {
  threadId: string;
  turnId: string;
  explanation?: string | null;
  plan: PlanStep[];
}

export interface PlanProgress {
  completed: number;
  currentStep: number;
  total: number;
}

type RecordValue = Record<string, unknown>;

function recordValue(value: unknown): RecordValue | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as RecordValue : null;
}

function planStatus(value: unknown): PlanStepStatus | null {
  return value === "pending" || value === "inProgress" || value === "completed" ? value : null;
}

function planSteps(value: unknown): PlanStep[] | null {
  if (!Array.isArray(value)) return null;
  const steps: PlanStep[] = [];
  for (const entry of value) {
    const item = recordValue(entry);
    const step = typeof item?.step === "string" ? item.step.trim() : "";
    const status = planStatus(item?.status);
    if (!step || !status) return null;
    steps.push({ step, status });
  }
  return steps;
}

export function planNotification(notification: unknown): PlanSnapshot | null {
  const event = recordValue(notification);
  if (event?.method !== "turn/plan/updated") return null;
  const params = recordValue(event.params);
  const threadId = typeof params?.threadId === "string" ? params.threadId : "";
  const turnId = typeof params?.turnId === "string" ? params.turnId : "";
  const plan = planSteps(params?.plan);
  if (!threadId || !turnId || !plan || plan.length === 0) return null;
  return {
    threadId,
    turnId,
    explanation: typeof params?.explanation === "string" ? params.explanation : null,
    plan
  };
}

export function parsePlanText(text: unknown): PlanStep[] | null {
  if (typeof text !== "string") return null;
  const plan: PlanStep[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const match = rawLine.match(/^\s*(?:[-*+]\s+)\[([ xX])\]\s+(.+?)\s*$/);
    if (!match) continue;
    const step = match[2]?.trim() ?? "";
    if (!step) continue;
    plan.push({ step, status: (match[1] ?? "").toLowerCase() === "x" ? "completed" : "pending" });
  }
  return plan.length > 0 ? plan : null;
}

export function planProgress(plan: readonly PlanStep[]): PlanProgress {
  const completed = plan.filter(step => step.status === "completed").length;
  const inProgressIndex = plan.findIndex(step => step.status === "inProgress");
  const pendingIndex = plan.findIndex(step => step.status === "pending");
  const currentStep = inProgressIndex >= 0 ? inProgressIndex + 1 : pendingIndex >= 0 ? pendingIndex + 1 : plan.length;
  return { completed, currentStep, total: plan.length };
}

export function latestPlanFromTurn(turn: unknown): PlanStep[] | null {
  const record = recordValue(turn);
  const items = Array.isArray(record?.items) ? record.items : [];
  for (let index = items.length - 1; index >= 0; index--) {
    const item = recordValue(items[index]);
    if (item?.type !== "plan") continue;
    const parsed = parsePlanText(item.text);
    if (parsed) return parsed;
  }
  return null;
}

export function planSnapshotKey(threadId: string, turnId: string): string {
  return `${threadId}:${turnId}`;
}
