'use client';

import type {
  Action, AssignmentPoolDto, AutomationDto, AutomationInput, Condition, ConditionField, ConditionOp, MemberDto, StageDto, TriggerType,
} from '@crm/contracts';
import { Plus, Trash2, X } from 'lucide-react';
import { useState, type FormEvent, type ReactNode } from 'react';
import { Button, Input, Label } from '@/components/ui';
import { cn } from '@/lib/utils';

/* ───────────── Справочники для UI ───────────── */

export const TRIGGER_LABEL: Record<TriggerType, string> = {
  LeadCreated: 'Пришёл новый лид',
  StageChanged: 'Сделка перешла в этап',
  StageSlaBreached: 'Сделка дольше SLA в этапе',
  NoActivityInDays: 'Нет активности N дней',
};

const FIELD_LABEL: Partial<Record<ConditionField, string>> = {
  'deal.value': 'Сумма сделки',
  'deal.stageId': 'Этап',
  'deal.ownerId': 'Ответственный',
  'deal.currency': 'Валюта',
};

const OP_LABEL: Record<ConditionOp, string> = {
  eq: '=', neq: '≠', gt: '>', gte: '≥', lt: '<', lte: '≤', in: 'одно из', isEmpty: 'не задано',
};

const NUMERIC_OPS: ConditionOp[] = ['gt', 'gte', 'lt', 'lte', 'eq', 'neq'];
const REF_OPS: ConditionOp[] = ['eq', 'neq', 'isEmpty'];
const opsFor = (field: ConditionField): ConditionOp[] =>
  field === 'deal.value' ? NUMERIC_OPS : field === 'deal.ownerId' ? REF_OPS : ['eq', 'neq'];

export const RECIPIENT_LABEL = { owner: 'ответственному', teamLead: 'руководителю команды', admins: 'администраторам' } as const;

/* ───────────── Черновик формы ⇄ AutomationInput ───────────── */

interface Row {
  field: ConditionField;
  op: ConditionOp;
  value: string;
}

interface Draft {
  name: string;
  triggerType: TriggerType;
  stageId: string;
  days: number;
  combinator: 'all' | 'any';
  rows: Row[];
  /** Вложенное условие, которое форма не умеет редактировать, — сохраняется как есть */
  rawConditions: Condition | null;
  actions: Action[];
}

function toDraft(a: AutomationDto | null): Draft {
  const empty: Draft = {
    name: '', triggerType: 'LeadCreated', stageId: '', days: 7, combinator: 'all', rows: [], rawConditions: null,
    actions: [{ type: 'SendNotification', to: 'owner', message: 'Сделка «{{deal.title}}» требует внимания' }],
  };
  if (!a) return empty;

  const t = a.trigger;
  const c = a.conditions;
  const combinator = 'any' in c ? 'any' : 'all';
  const items = 'all' in c ? c.all : 'any' in c ? c.any : null;
  const flat = items?.every((x) => 'field' in x) ? (items as Extract<Condition, { field: unknown }>[]) : null;

  return {
    name: a.name,
    triggerType: t.type,
    stageId: ('toStageId' in t ? t.toStageId : 'stageId' in t ? t.stageId : undefined) ?? '',
    days: t.type === 'NoActivityInDays' ? t.days : 7,
    combinator,
    rows: flat?.map((x) => ({ field: x.field, op: x.op, value: Array.isArray(x.value) ? x.value.join(', ') : String(x.value ?? '') })) ?? [],
    rawConditions: flat ? null : c,
    actions: a.actions,
  };
}

function toInput(d: Draft): AutomationInput {
  const stage = d.stageId || undefined;
  const trigger: AutomationInput['trigger'] =
    d.triggerType === 'StageChanged' ? { type: 'StageChanged', toStageId: stage }
      : d.triggerType === 'StageSlaBreached' ? { type: 'StageSlaBreached', stageId: stage }
        : d.triggerType === 'NoActivityInDays' ? { type: 'NoActivityInDays', days: d.days }
          : { type: 'LeadCreated' };

  const leaves: Condition[] = d.rows.map((r) => ({
    field: r.field,
    op: r.op,
    ...(r.op !== 'isEmpty' && { value: r.field === 'deal.value' ? Number(r.value) : r.value }),
  }));
  const conditions: Condition = d.rawConditions ?? (d.combinator === 'any' ? { any: leaves } : { all: leaves });

  return { name: d.name, trigger, conditions, actions: d.actions, enabled: true };
}

/* ───────────── Форма ───────────── */

interface FormProps {
  automation: AutomationDto | null;
  stages: StageDto[];
  members: MemberDto[];
  pools: AssignmentPoolDto[];
  saving: boolean;
  onSave: (input: AutomationInput) => void;
  onClose: () => void;
}

export function AutomationForm({ automation, stages, members, pools, saving, onSave, onClose }: FormProps) {
  const [d, setD] = useState<Draft>(() => toDraft(automation));
  const set = (patch: Partial<Draft>) => setD((prev) => ({ ...prev, ...patch }));
  const setAction = (i: number, a: Action) => set({ actions: d.actions.map((x, j) => (j === i ? a : x)) });

  function submit(e: FormEvent) {
    e.preventDefault();
    onSave(toInput(d));
  }

  const needsStage = d.triggerType === 'StageChanged' || d.triggerType === 'StageSlaBreached';

  return (
    <div className="fixed inset-0 z-40 flex justify-end" role="dialog" aria-modal="true" aria-label="Автоматизация">
      <button type="button" aria-label="Закрыть" className="absolute inset-0 bg-black/30" onClick={onClose} />
      <form onSubmit={submit} className="relative flex h-full w-full max-w-xl flex-col gap-5 overflow-y-auto border-l border-border bg-background p-6 shadow-xl">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">{automation ? 'Изменить автоматизацию' : 'Новая автоматизация'}</h2>
          <Button type="button" variant="ghost" className="size-8 px-0" onClick={onClose} aria-label="Закрыть"><X className="size-4" /></Button>
        </div>

        <div className="space-y-2">
          <Label htmlFor="a-name">Название</Label>
          <Input id="a-name" value={d.name} onChange={(e) => set({ name: e.target.value })} required maxLength={200} />
        </div>

        <Section title="Когда">
          <select aria-label="Триггер" value={d.triggerType} onChange={(e) => set({ triggerType: e.target.value as TriggerType })} className={selectCls}>
            {Object.entries(TRIGGER_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          {needsStage && (
            <select aria-label="Этап" value={d.stageId} onChange={(e) => set({ stageId: e.target.value })} className={selectCls}>
              <option value="">любой этап</option>
              {stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          )}
          {d.triggerType === 'NoActivityInDays' && (
            <label className="flex items-center gap-2 text-sm">
              Дней без активности
              <Input type="number" min={1} max={90} value={d.days} onChange={(e) => set({ days: Number(e.target.value) })} className="w-24" />
            </label>
          )}
        </Section>

        <Section title="Если" hint={d.rows.length === 0 && !d.rawConditions ? 'без условий — для каждой сделки' : undefined}>
          {d.rawConditions ? (
            <p className="text-sm text-muted-foreground">Составное условие настроено через API и сохранится без изменений.</p>
          ) : (
            <>
              {d.rows.length > 1 && (
                <select aria-label="Сочетание условий" value={d.combinator} onChange={(e) => set({ combinator: e.target.value as Draft['combinator'] })} className={cn(selectCls, 'w-auto')}>
                  <option value="all">выполнены все условия</option>
                  <option value="any">выполнено любое</option>
                </select>
              )}
              {d.rows.map((r, i) => (
                <div key={i} className="flex flex-wrap items-center gap-2">
                  <select aria-label="Поле" value={r.field} className={cn(selectCls, 'w-40')} onChange={(e) => {
                    const field = e.target.value as ConditionField;
                    set({ rows: d.rows.map((x, j) => (j === i ? { field, op: opsFor(field)[0]!, value: '' } : x)) });
                  }}>
                    {Object.entries(FIELD_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                  <select aria-label="Оператор" value={r.op} className={cn(selectCls, 'w-28')}
                    onChange={(e) => set({ rows: d.rows.map((x, j) => (j === i ? { ...x, op: e.target.value as ConditionOp } : x)) })}>
                    {opsFor(r.field).map((op) => <option key={op} value={op}>{OP_LABEL[op]}</option>)}
                  </select>
                  {r.op !== 'isEmpty' && (
                    <ValueInput row={r} stages={stages} members={members}
                      onChange={(value) => set({ rows: d.rows.map((x, j) => (j === i ? { ...x, value } : x)) })} />
                  )}
                  <Button type="button" variant="ghost" className="size-8 px-0" aria-label="Удалить условие"
                    onClick={() => set({ rows: d.rows.filter((_, j) => j !== i) })}><Trash2 className="size-4" /></Button>
                </div>
              ))}
              <Button type="button" variant="outline" className="self-start"
                onClick={() => set({ rows: [...d.rows, { field: 'deal.value', op: 'gt', value: '100000' }] })}>
                <Plus className="size-4" /> Условие
              </Button>
            </>
          )}
        </Section>

        <Section title="То">
          {d.actions.map((a, i) => (
            <div key={i} className="space-y-2 rounded-lg border border-border bg-card p-3">
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-muted-foreground">{i + 1}.</span>
                <select aria-label="Действие" value={a.type} className={selectCls} onChange={(e) => setAction(i, defaultAction(e.target.value as Action['type'], pools))}>
                  <option value="AssignManager">Назначить менеджера (round-robin)</option>
                  <option value="SendNotification">Отправить уведомление</option>
                  <option value="CreateTask">Создать задачу</option>
                </select>
                <Button type="button" variant="ghost" className="size-8 px-0" aria-label="Удалить действие" disabled={d.actions.length === 1}
                  onClick={() => set({ actions: d.actions.filter((_, j) => j !== i) })}><Trash2 className="size-4" /></Button>
              </div>
              <ActionFields action={a} pools={pools} onChange={(next) => setAction(i, next)} />
            </div>
          ))}
          <Button type="button" variant="outline" className="self-start" disabled={d.actions.length >= 10}
            onClick={() => set({ actions: [...d.actions, defaultAction('CreateTask', pools)] })}>
            <Plus className="size-4" /> Действие
          </Button>
          <p className="text-xs text-muted-foreground">Действия выполняются по порядку. В текстах доступны {'{{deal.title}}'} и {'{{deal.value}}'}.</p>
        </Section>

        <div className="mt-auto flex gap-2 pt-2">
          <Button type="submit" disabled={saving}>Сохранить</Button>
          <Button type="button" variant="outline" onClick={onClose}>Отмена</Button>
        </div>
      </form>
    </div>
  );
}

const selectCls = 'h-9 w-full rounded-md border border-border bg-card px-2 text-sm';

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-2 text-sm font-semibold">
        {title} {hint && <span className="font-normal text-muted-foreground">— {hint}</span>}
      </legend>
      {children}
    </fieldset>
  );
}

function ValueInput({ row, stages, members, onChange }: { row: Row; stages: StageDto[]; members: MemberDto[]; onChange: (v: string) => void }) {
  if (row.field === 'deal.stageId') {
    return (
      <select aria-label="Значение" value={row.value} onChange={(e) => onChange(e.target.value)} className={cn(selectCls, 'w-44')}>
        <option value="" disabled>этап…</option>
        {stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>
    );
  }
  if (row.field === 'deal.ownerId') {
    return (
      <select aria-label="Значение" value={row.value} onChange={(e) => onChange(e.target.value)} className={cn(selectCls, 'w-44')}>
        <option value="" disabled>сотрудник…</option>
        {members.map((m) => <option key={m.id} value={m.id}>{m.fullName}</option>)}
      </select>
    );
  }
  return (
    <Input aria-label="Значение" value={row.value} onChange={(e) => onChange(e.target.value)} className="w-36"
      inputMode={row.field === 'deal.value' ? 'decimal' : undefined} required />
  );
}

function defaultAction(type: Action['type'], pools: AssignmentPoolDto[]): Action {
  switch (type) {
    case 'AssignManager': return { type, poolId: pools[0]?.id ?? '' };
    case 'SendNotification': return { type, to: 'owner', message: 'Сделка «{{deal.title}}» требует внимания' };
    case 'CreateTask': return { type, title: 'Связаться с клиентом: {{deal.title}}', dueInMinutes: 60, assignTo: 'owner' };
  }
}

function ActionFields({ action, pools, onChange }: { action: Action; pools: AssignmentPoolDto[]; onChange: (a: Action) => void }) {
  switch (action.type) {
    case 'AssignManager':
      return (
        <select aria-label="Пул" value={action.poolId} onChange={(e) => onChange({ ...action, poolId: e.target.value })} className={selectCls} required>
          {pools.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.members.filter((m) => m.isAvailable).length} в ротации)</option>)}
        </select>
      );
    case 'SendNotification':
      return (
        <div className="space-y-2">
          <select aria-label="Кому" value={action.to} onChange={(e) => onChange({ ...action, to: e.target.value as typeof action.to })} className={selectCls}>
            {Object.entries(RECIPIENT_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <Input aria-label="Текст уведомления" value={action.message} onChange={(e) => onChange({ ...action, message: e.target.value })} required maxLength={500} />
        </div>
      );
    case 'CreateTask':
      return (
        <div className="space-y-2">
          <Input aria-label="Задача" value={action.title} onChange={(e) => onChange({ ...action, title: e.target.value })} required maxLength={200} />
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <select aria-label="Исполнитель" value={action.assignTo} onChange={(e) => onChange({ ...action, assignTo: e.target.value as typeof action.assignTo })} className={cn(selectCls, 'w-auto')}>
              <option value="owner">ответственный</option>
              <option value="teamLead">руководитель команды</option>
            </select>
            срок через
            <Input type="number" min={0} max={129600} value={action.dueInMinutes} className="w-24" aria-label="Срок, минут"
              onChange={(e) => onChange({ ...action, dueInMinutes: Number(e.target.value) })} />
            мин
          </div>
        </div>
      );
  }
}
