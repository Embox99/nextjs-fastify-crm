import type { DealDto, StageDto } from '@crm/contracts';
import type { deals, pipelineStages } from './schema';

export const toStageDto = (s: typeof pipelineStages.$inferSelect): StageDto => ({
  id: s.id, pipelineId: s.pipelineId, name: s.name, rank: s.rank, kind: s.kind, slaMinutes: s.slaMinutes,
});

type DealRow = typeof deals.$inferSelect;

export const toDealDto = (d: DealRow): DealDto => ({
  id: d.id,
  workspaceId: d.workspaceId,
  pipelineId: d.pipelineId,
  stageId: d.stageId,
  rank: d.rank,
  title: d.title,
  value: d.value,
  currency: d.currency,
  contactId: d.contactId,
  ownerId: d.ownerId,
  teamId: d.teamId,
  stageEnteredAt: d.stageEnteredAt.toISOString(),
  version: d.version,
  updatedAt: d.updatedAt.toISOString(),
});
