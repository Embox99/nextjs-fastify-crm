import { z } from 'zod';

const id = z.uuid();
/** numeric(14,2) передаётся строкой — без потери точности на больших суммах */
const money = z.string().regex(/^\d{1,12}(\.\d{1,2})?$/);

export const DealDto = z.object({
  id,
  workspaceId: id,
  pipelineId: id,
  stageId: id,
  rank: z.string(),
  title: z.string(),
  value: money,
  currency: z.string(),
  contactId: id.nullable(),
  ownerId: id.nullable(),
  teamId: id.nullable(),
  stageEnteredAt: z.iso.datetime({ offset: true }),
  version: z.number().int(),
  updatedAt: z.iso.datetime({ offset: true }),
});
export type DealDto = z.infer<typeof DealDto>;

export const StageDto = z.object({
  id,
  pipelineId: id,
  name: z.string(),
  rank: z.string(),
  kind: z.enum(['open', 'won', 'lost']),
  slaMinutes: z.number().int().nullable(),
});
export type StageDto = z.infer<typeof StageDto>;

const stageName = z.string().trim().min(1).max(100);
const slaMinutes = z.number().int().min(1).max(60 * 24 * 90).nullable();

export const CreateStageInput = z.object({
  name: stageName,
  slaMinutes: slaMinutes.optional(),
  /** После какой колонки вставить; не задано — после последней открытой (перед «Выиграно»/«Проиграно») */
  afterStageId: id.nullable().optional(),
});
export type CreateStageInput = z.infer<typeof CreateStageInput>;

export const UpdateStageInput = z.object({ name: stageName.optional(), slaMinutes: slaMinutes.optional() });
export type UpdateStageInput = z.infer<typeof UpdateStageInput>;

/** Перестановка колонки — как у карточек: соседи, а не готовый ключ */
export const MoveStageInput = z.object({ beforeId: id.nullable(), afterId: id.nullable() });
export type MoveStageInput = z.infer<typeof MoveStageInput>;

export const DeleteStageQuery = z.object({
  /** Куда перенести сделки удаляемой колонки; без него удаляется только пустая колонка */
  moveDealsTo: id.optional(),
});

export const PipelineDto = z.object({ id, name: z.string() });
export type PipelineDto = z.infer<typeof PipelineDto>;

export const MemberDto = z.object({ id, fullName: z.string() });
export type MemberDto = z.infer<typeof MemberDto>;

export const BoardDto = z.object({
  pipeline: PipelineDto,
  stages: z.array(StageDto),
  deals: z.array(DealDto),
  members: z.array(MemberDto),
});
export type BoardDto = z.infer<typeof BoardDto>;

export const MoveDealInput = z.object({
  toStageId: id,
  /** Карточка над местом вставки (null — в начало колонки) */
  beforeId: id.nullable(),
  /** Карточка под местом вставки (null — в конец колонки) */
  afterId: id.nullable(),
  /** Позволяет клиенту отличить эхо собственной мутации в WS-потоке */
  clientMutationId: z.string().min(1).max(64),
});
export type MoveDealInput = z.infer<typeof MoveDealInput>;

export const CreateDealInput = z.object({
  pipelineId: id,
  stageId: id.optional(),
  title: z.string().trim().min(1).max(200),
  value: money.default('0'),
  ownerId: id.nullable().optional(),
  teamId: id.nullable().optional(),
  clientMutationId: z.string().min(1).max(64).optional(),
});
export type CreateDealInput = z.infer<typeof CreateDealInput>;

export const UpdateDealInput = z.object({
  /** Optimistic concurrency: версия, которую видел клиент */
  version: z.number().int(),
  title: z.string().trim().min(1).max(200).optional(),
  value: money.optional(),
  ownerId: id.nullable().optional(),
  teamId: id.nullable().optional(),
  clientMutationId: z.string().min(1).max(64).optional(),
});
export type UpdateDealInput = z.infer<typeof UpdateDealInput>;
