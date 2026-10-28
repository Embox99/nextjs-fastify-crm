'use client';

import type { Action, AutomationDto, Condition, StageDto } from '@crm/contracts';
import { Pencil, Plus, Trash2, Zap } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Button } from '@/components/ui';
import { useI18n, type I18n } from '@/i18n/i18n-provider';
import { cn } from '@/lib/utils';
import { useBoard, usePipelines } from '../board/queries';
import { AutomationForm, OP_SYMBOL } from './automation-form';
import { useAutomations, useDeleteAutomation, usePools, useSaveAutomation, useToggleAutomation } from './queries';
import { TemplateText } from './template-text';

export function Automations() {
  const i18n = useI18n();
  const { t } = i18n;
  const automations = useAutomations();
  const pools = usePools();
  const pipelines = usePipelines();
  const board = useBoard(pipelines.data?.[0]?.id);
  const save = useSaveAutomation();
  const toggle = useToggleAutomation();
  const remove = useDeleteAutomation();
  const [editing, setEditing] = useState<AutomationDto | 'new' | null>(null);

  const stages = board.data?.stages ?? [];
  const stageName = (id?: string) => stages.find((s) => s.id === id)?.name ?? '…';
  const poolName = (id: string) => pools.data?.find((p) => p.id === id)?.name ?? t('automations.pool');

  return (
    <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">{t('automations.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('automations.subtitle')}</p>
        </div>
        <Button onClick={() => setEditing('new')}><Plus className="size-4" /> {t('automations.new')}</Button>
      </div>

      {automations.isPending && <p className="text-sm text-muted-foreground">{t('common.loading')}</p>}
      <ul className="space-y-3">
        {automations.data?.map((a) => (
          <li key={a.id} className={cn('rounded-xl border border-border bg-card p-4', !a.enabled && 'opacity-60')}>
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 space-y-2">
                <h2 className="flex items-center gap-2 font-medium"><Zap className="size-4 text-primary" aria-hidden />{a.name}</h2>
                <p className="text-sm">
                  <span className="text-muted-foreground">{t('automations.when')}:</span> {describeTrigger(a, stageName, i18n)}
                  {!isEmpty(a.conditions) && (
                    <><br /><span className="text-muted-foreground">{t('automations.if')}:</span> {describeConditions(a.conditions, stages, i18n)}</>
                  )}
                </p>
                <ol className="list-inside list-decimal text-sm">
                  {a.actions.map((action, i) => <li key={i}>{describeAction(action, poolName, i18n)}</li>)}
                </ol>
                <p className="text-xs text-muted-foreground">
                  {t('automations.runs', { count: a.stats.runs })}
                  {a.stats.failed > 0 && <span className="text-destructive"> · {t('automations.failedRuns', { count: a.stats.failed })}</span>}
                  {a.stats.lastRunAt && <> · {t('automations.lastRun', { when: i18n.format.ago(a.stats.lastRunAt) })}</>}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <label className="mr-2 inline-flex cursor-pointer items-center gap-2 text-sm">
                  <input type="checkbox" role="switch" checked={a.enabled} className="peer sr-only"
                    onChange={(e) => toggle.mutate({ id: a.id, enabled: e.target.checked })} aria-label={t('automations.enable', { name: a.name })} />
                  <span className="relative h-5 w-9 rounded-full bg-muted transition-colors after:absolute after:left-0.5 after:top-0.5 after:size-4 after:rounded-full after:bg-card after:shadow after:transition-transform peer-checked:bg-primary peer-checked:after:translate-x-4 peer-focus-visible:ring-2 peer-focus-visible:ring-ring" />
                </label>
                <Button variant="ghost" className="size-8 px-0" aria-label={t('common.edit')} onClick={() => setEditing(a)}><Pencil className="size-4" /></Button>
                <Button variant="ghost" className="size-8 px-0" aria-label={t('common.delete')}
                  onClick={() => window.confirm(t('automations.confirmDelete', { name: a.name })) && remove.mutate(a.id)}><Trash2 className="size-4" /></Button>
              </div>
            </div>
          </li>
        ))}
      </ul>

      {editing && (
        <AutomationForm
          automation={editing === 'new' ? null : editing}
          stages={stages}
          members={board.data?.members ?? []}
          pools={pools.data ?? []}
          saving={save.isPending}
          onClose={() => setEditing(null)}
          onSave={(input) => save.mutate(
            { id: editing === 'new' ? undefined : editing.id, input: editing === 'new' ? input : { ...input, enabled: editing.enabled } },
            { onSuccess: () => setEditing(null) },
          )}
        />
      )}
    </div>
  );
}

function describeTrigger(a: AutomationDto, stageName: (id?: string) => string, { t }: I18n) {
  const tr = a.trigger;
  switch (tr.type) {
    case 'StageChanged': return tr.toStageId ? t('trigger.stageChangedTo', { stage: stageName(tr.toStageId) }) : t('trigger.StageChanged').toLowerCase();
    case 'StageSlaBreached': return tr.stageId ? t('trigger.slaIn', { stage: stageName(tr.stageId) }) : t('trigger.StageSlaBreached').toLowerCase();
    case 'NoActivityInDays': return t('trigger.noActivityDays', { days: tr.days });
    default: return t(`trigger.${tr.type}`).toLowerCase();
  }
}

const isEmpty = (c: Condition) => ('all' in c && c.all.length === 0) || ('any' in c && c.any.length === 0);

function describeConditions(c: Condition, stages: StageDto[], i18n: I18n): string {
  const { t } = i18n;
  if ('all' in c) return c.all.map((x) => describeConditions(x, stages, i18n)).join(t('cond.and'));
  if ('any' in c) return c.any.map((x) => describeConditions(x, stages, i18n)).join(t('cond.or'));
  if ('not' in c) return t('cond.not', { inner: describeConditions(c.not, stages, i18n) });

  const label = t(`field.${c.field}`).toLowerCase();
  if (c.op === 'isEmpty') return `${label} ${t('op.isEmpty')}`;
  const value = c.field === 'deal.value' ? i18n.format.number(Number(c.value))
    : c.field === 'deal.stageId' ? stages.find((s) => s.id === c.value)?.name ?? '…'
      : Array.isArray(c.value) ? c.value.join(', ') : String(c.value ?? '');
  return `${label} ${c.op === 'in' ? t('op.in') : OP_SYMBOL[c.op]} ${value}`;
}

function describeAction(a: Action, poolName: (id: string) => string, { t, format }: I18n): ReactNode {
  // Перевод фразы с плейсхолдером «{message}» и вставка шаблона пользователя с метками переменных
  const withTemplate = (phrase: string, template: string, slot: string) => {
    const [before, after] = phrase.split(slot) as [string, string?];
    return <>{before}<TemplateText text={template} />{after}</>;
  };
  switch (a.type) {
    case 'AssignManager':
      return t('action.describe.assign', { pool: poolName(a.poolId) });
    case 'SendNotification':
      return withTemplate(t('action.describe.notify', { to: t(`recipient.${a.to}`), message: '\u0000' }), a.message, '\u0000');
    case 'CreateTask':
      return withTemplate(
        t(a.assignTo === 'owner' ? 'action.describe.taskOwner' : 'action.describe.taskLead', { title: '\u0000', due: format.duration(a.dueInMinutes) }),
        a.title, '\u0000',
      );
  }
}
