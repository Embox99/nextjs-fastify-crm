'use client';

import type { Action, AutomationDto, Condition, StageDto } from '@crm/contracts';
import { Pencil, Plus, Trash2, Zap } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui';
import { cn } from '@/lib/utils';
import { useBoard, usePipelines } from '../board/queries';
import { AutomationForm, RECIPIENT_LABEL, TRIGGER_LABEL } from './automation-form';
import { useAutomations, useDeleteAutomation, usePools, useSaveAutomation, useToggleAutomation } from './queries';

const relative = new Intl.RelativeTimeFormat('ru-RU', { numeric: 'auto' });
function ago(iso: string) {
  const minutes = Math.round((Date.parse(iso) - Date.now()) / 60_000);
  return Math.abs(minutes) < 60 ? relative.format(minutes, 'minute')
    : Math.abs(minutes) < 1440 ? relative.format(Math.round(minutes / 60), 'hour')
      : relative.format(Math.round(minutes / 1440), 'day');
}

export function Automations() {
  const automations = useAutomations();
  const pools = usePools();
  const pipelines = usePipelines();
  const board = useBoard(pipelines.data?.[0]?.id);
  const save = useSaveAutomation();
  const toggle = useToggleAutomation();
  const remove = useDeleteAutomation();
  const [editing, setEditing] = useState<AutomationDto | 'new' | null>(null);

  const stages = board.data?.stages ?? [];
  const stageName = (id?: string) => stages.find((s) => s.id === id)?.name;
  const poolName = (id: string) => pools.data?.find((p) => p.id === id)?.name ?? 'пул';

  return (
    <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">Автоматизации</h1>
          <p className="text-sm text-muted-foreground">Регламенты, которые выполняются сами: распределение лидов, SLA, напоминания.</p>
        </div>
        <Button onClick={() => setEditing('new')}><Plus className="size-4" /> Новая</Button>
      </div>

      {automations.isPending && <p className="text-sm text-muted-foreground">Загружаем…</p>}
      <ul className="space-y-3">
        {automations.data?.map((a) => (
          <li key={a.id} className={cn('rounded-xl border border-border bg-card p-4', !a.enabled && 'opacity-60')}>
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 space-y-2">
                <h2 className="flex items-center gap-2 font-medium"><Zap className="size-4 text-primary" aria-hidden />{a.name}</h2>
                <p className="text-sm">
                  <span className="text-muted-foreground">Когда:</span> {describeTrigger(a, stageName)}
                  {!isEmpty(a.conditions) && <><br /><span className="text-muted-foreground">Если:</span> {describeConditions(a.conditions, stages)}</>}
                </p>
                <ol className="list-inside list-decimal text-sm">
                  {a.actions.map((action, i) => <li key={i}>{describeAction(action, poolName)}</li>)}
                </ol>
                <p className="text-xs text-muted-foreground">
                  Запусков: {a.stats.runs}
                  {a.stats.failed > 0 && <span className="text-destructive"> · с ошибкой: {a.stats.failed}</span>}
                  {a.stats.lastRunAt && <> · последний {ago(a.stats.lastRunAt)}</>}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <label className="mr-2 inline-flex cursor-pointer items-center gap-2 text-sm">
                  <input type="checkbox" role="switch" checked={a.enabled} className="peer sr-only"
                    onChange={(e) => toggle.mutate({ id: a.id, enabled: e.target.checked })} aria-label={`Включить «${a.name}»`} />
                  <span className="relative h-5 w-9 rounded-full bg-muted transition-colors after:absolute after:left-0.5 after:top-0.5 after:size-4 after:rounded-full after:bg-card after:shadow after:transition-transform peer-checked:bg-primary peer-checked:after:translate-x-4 peer-focus-visible:ring-2 peer-focus-visible:ring-ring" />
                </label>
                <Button variant="ghost" className="size-8 px-0" aria-label="Изменить" onClick={() => setEditing(a)}><Pencil className="size-4" /></Button>
                <Button variant="ghost" className="size-8 px-0" aria-label="Удалить"
                  onClick={() => window.confirm(`Удалить «${a.name}»?`) && remove.mutate(a.id)}><Trash2 className="size-4" /></Button>
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

function describeTrigger(a: AutomationDto, stageName: (id?: string) => string | undefined) {
  const t = a.trigger;
  switch (t.type) {
    case 'StageChanged': return t.toStageId ? `сделка перешла в этап «${stageName(t.toStageId) ?? '…'}»` : TRIGGER_LABEL[t.type].toLowerCase();
    case 'StageSlaBreached': return t.stageId ? `сделка дольше SLA в этапе «${stageName(t.stageId) ?? '…'}»` : TRIGGER_LABEL[t.type].toLowerCase();
    case 'NoActivityInDays': return `нет активности ${t.days} дн.`;
    default: return TRIGGER_LABEL[t.type].toLowerCase();
  }
}

const isEmpty = (c: Condition) => ('all' in c && c.all.length === 0) || ('any' in c && c.any.length === 0);

function describeConditions(c: Condition, stages: StageDto[]): string {
  if ('all' in c) return c.all.map((x) => describeConditions(x, stages)).join(' и ');
  if ('any' in c) return c.any.map((x) => describeConditions(x, stages)).join(' или ');
  if ('not' in c) return `не (${describeConditions(c.not, stages)})`;
  const label = { 'deal.value': 'сумма', 'deal.stageId': 'этап', 'deal.ownerId': 'ответственный', 'deal.currency': 'валюта', 'deal.pipelineId': 'воронка', 'deal.teamId': 'команда' }[c.field];
  const ops = { eq: '=', neq: '≠', gt: '>', gte: '≥', lt: '<', lte: '≤', in: 'в', isEmpty: 'не задан' } as const;
  const value = c.field === 'deal.value' ? Number(c.value).toLocaleString('ru-RU')
    : c.field === 'deal.stageId' ? stages.find((s) => s.id === c.value)?.name ?? '…' : c.value ?? '';
  return c.op === 'isEmpty' ? `${label} ${ops.isEmpty}` : `${label} ${ops[c.op]} ${value}`;
}

function describeAction(a: Action, poolName: (id: string) => string) {
  switch (a.type) {
    case 'AssignManager': return `назначить менеджера из «${poolName(a.poolId)}» по кругу`;
    case 'SendNotification': return `уведомить ${RECIPIENT_LABEL[a.to]}: «${a.message}»`;
    case 'CreateTask': return `задача ${a.assignTo === 'owner' ? 'ответственному' : 'руководителю'}: «${a.title}», срок ${formatDuration(a.dueInMinutes)}`;
  }
}

function formatDuration(minutes: number) {
  if (minutes < 60) return `${minutes} мин`;
  if (minutes % 1440 === 0) return `${minutes / 1440} дн.`;
  return minutes % 60 === 0 ? `${minutes / 60} ч` : `${Math.floor(minutes / 60)} ч ${minutes % 60} мин`;
}
