import { z } from 'zod';

/* ───────────── Доменные события (transactional outbox) ───────────── */

export type Actor =
  | { kind: 'user'; id: string }
  | { kind: 'system' }
  | { kind: 'automation'; automationId: string; depth: number };

export interface DomainEventPayloads {
  /** Новая сделка из входящего лида (вебхук) */
  'lead.created': { channelId: string };
  'deal.created': Record<string, never>;
  'deal.stage_changed': { fromStageId: string; toStageId: string; stageEnteredAt: string };
  'deal.assigned': { ownerId: string | null; previousOwnerId: string | null };
  /** Сделка пролежала в этапе дольше stage.sla_minutes */
  'deal.sla_breached': { stageId: string; minutesInStage: number };
}

export type DomainEventType = keyof DomainEventPayloads;

export interface DomainEvent<T extends DomainEventType = DomainEventType> {
  id: number;
  type: T;
  organizationId: string;
  workspaceId: string;
  dealId: string | null;
  payload: DomainEventPayloads[T];
  actor: Actor;
  createdAt: string;
}

/** Цепочка «автоматизация → событие → автоматизация» обрывается на этой глубине */
export const MAX_AUTOMATION_DEPTH = 5;

/* ───────────── Триггеры, условия, действия ───────────── */

const id = z.uuid();

export const Trigger = z.discriminatedUnion('type', [
  z.object({ type: z.literal('LeadCreated'), channelId: id.optional() }),
  z.object({ type: z.literal('StageChanged'), toStageId: id.optional(), fromStageId: id.optional() }),
  z.object({ type: z.literal('StageSlaBreached'), stageId: id.optional() }),
  z.object({ type: z.literal('NoActivityInDays'), days: z.number().int().min(1).max(90) }),
]);
export type Trigger = z.infer<typeof Trigger>;
export type TriggerType = Trigger['type'];

export const CONDITION_FIELDS = ['deal.value', 'deal.pipelineId', 'deal.stageId', 'deal.ownerId', 'deal.teamId', 'deal.currency'] as const;
export const ConditionField = z.enum(CONDITION_FIELDS);
export type ConditionField = z.infer<typeof ConditionField>;

export const ConditionOp = z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'isEmpty']);
export type ConditionOp = z.infer<typeof ConditionOp>;

/** Типизированное AST вместо строк с eval: безопасно хранить в БД и редактировать в UI */
export type Condition =
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition }
  | { field: ConditionField; op: ConditionOp; value?: string | number | null | (string | number)[] };

export const Condition: z.ZodType<Condition> = z.lazy(() => z.union([
  z.object({ all: z.array(Condition).max(20) }),
  z.object({ any: z.array(Condition).max(20) }),
  z.object({ not: Condition }),
  z.object({
    field: ConditionField,
    op: ConditionOp,
    value: z.union([z.string(), z.number(), z.null(), z.array(z.union([z.string(), z.number()])).max(50)]).optional(),
  }),
]));

export const Action = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('CreateTask'),
    title: z.string().trim().min(1).max(200),
    dueInMinutes: z.number().int().min(0).max(60 * 24 * 90),
    assignTo: z.enum(['owner', 'teamLead']),
  }),
  z.object({
    type: z.literal('SendNotification'),
    to: z.enum(['owner', 'teamLead', 'admins']),
    /** Шаблон: {{deal.title}}, {{deal.value}} */
    message: z.string().trim().min(1).max(500),
  }),
  z.object({ type: z.literal('AssignManager'), poolId: id }),
]);
export type Action = z.infer<typeof Action>;

export const AutomationInput = z.object({
  name: z.string().trim().min(1).max(200),
  trigger: Trigger,
  conditions: Condition.default({ all: [] }),
  actions: z.array(Action).min(1).max(10),
  enabled: z.boolean().default(true),
});
export type AutomationInput = z.infer<typeof AutomationInput>;

export interface AutomationDto extends AutomationInput {
  id: string;
  version: number;
  updatedAt: string;
  stats: { runs: number; failed: number; lastRunAt: string | null };
}

export interface AssignmentPoolDto {
  id: string;
  name: string;
  teamId: string;
  members: { userId: string; fullName: string; position: number; isAvailable: boolean }[];
}

export interface NotificationDto {
  id: string;
  title: string;
  body: string | null;
  dealId: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface TaskDto {
  id: string;
  dealId: string;
  title: string;
  assigneeId: string | null;
  dueAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

/* ───────────── Очереди движка ───────────── */

export interface ExecuteRunJob {
  runId: string;
  organizationId: string;
  workspaceId: string;
}

export interface SlaCheckJob {
  dealId: string;
  stageId: string;
  /** Токен конкретного пребывания в этапе: сделка могла уйти и вернуться */
  stageEnteredAt: string;
  slaMinutes: number;
  organizationId: string;
  workspaceId: string;
}

export const domainEventJobId = (eventId: number) => `evt-${eventId}`;
export const runJobId = (runId: string) => `run-${runId}`;
export const slaJobId = (dealId: string, stageId: string, enteredAt: string) => `sla-${dealId}-${stageId}-${Date.parse(enteredAt)}`;
