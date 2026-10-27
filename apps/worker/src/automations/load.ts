import { Action, Condition, Trigger, type Action as ActionT, type Condition as ConditionT, type Trigger as TriggerT } from '@crm/contracts';
import { automations, deals, type Tx } from '@crm/db';
import type { Facts } from '@crm/domain';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

export interface LoadedAutomation {
  id: string;
  version: number;
  trigger: TriggerT;
  conditions: ConditionT;
  actions: ActionT[];
}

const Stored = z.object({ trigger: Trigger, conditions: Condition, actions: z.array(Action) });

/**
 * JSON из БД снова проходит через zod: автоматизация, сохранённая старой версией схемы
 * или поправленная руками в БД, не исполнится вслепую.
 */
export function parseAutomation(row: typeof automations.$inferSelect): LoadedAutomation | null {
  const parsed = Stored.safeParse(row);
  if (!parsed.success) return null;
  return { id: row.id, version: row.version, ...parsed.data };
}

export type DealRow = typeof deals.$inferSelect;

export const dealFacts = (d: DealRow): Facts => ({
  'deal.value': d.value,
  'deal.pipelineId': d.pipelineId,
  'deal.stageId': d.stageId,
  'deal.ownerId': d.ownerId,
  'deal.teamId': d.teamId,
  'deal.currency': d.currency,
});

export async function loadAutomationRow(tx: Tx, id: string) {
  const [row] = await tx.select().from(automations).where(eq(automations.id, id));
  return row ?? null;
}
