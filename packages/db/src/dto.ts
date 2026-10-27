import type { DealDto } from '@crm/contracts';
import type { deals } from './schema';

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
