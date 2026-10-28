'use client';

import type {
  Action, AssignmentPoolDto, AutomationDto, AutomationInput, Condition, ConditionField, ConditionOp, MemberDto, StageDto, TriggerType,
} from '@crm/contracts';
import { Plus, Trash2, X } from 'lucide-react';
import { useState, type FormEvent, type ReactNode } from 'react';
import { Button, Input, Label } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-provider';
import { cn } from '@/lib/utils';
import { TemplateInput } from './template-text';

/* ───────────── Справочники для UI ───────────── */

const TRIGGERS: TriggerType[] = ['LeadCreated', 'StageChanged', 'StageSlaBreached', 'NoActivityInDays'];
const FORM_FIELDS: ConditionField[] = ['deal.value', 'deal.stageId', 'deal.ownerId', 'deal.currency'];
const RECIPIENTS = ['owner', 'teamLead', 'admins'] as const;

export const OP_SYMBOL: Record<Exclude<ConditionOp, 'in' | 'isEmpty'>, string> = {
  eq: '=', neq: '≠', gt: '>', gte: '≥', lt: '<', lte: '≤',
};

const NUMERIC_OPS: ConditionOp[] = ['gt', 'gte', 'lt', 'lte', 'eq', 'neq'];
const REF_OPS: ConditionOp[] = ['eq', 'neq', 'isEmpty'];
const opsFor = (field: ConditionField): ConditionOp[] =>
  field === 'deal.value' ? NUMERIC_OPS : field === 'deal.ownerId' ? REF_OPS : ['eq', 'neq'];

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

function toDraft(a: AutomationDto | null, defaultMessage: string): Draft {
  const empty: Draft = {
    name: '', triggerType: 'LeadCreated', stageId: '', days: 7, combinator: 'all', rows: [], rawConditions: null,
    actions: [{ type: 'SendNotification', to: 'owner', message: defaultMessage }],
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
  const { t } = useI18n();
  const [d, setD] = useState<Draft>(() => toDraft(automation, t('action.defaultMessage')));
  const set = (patch: Partial<Draft>) => setD((prev) => ({ ...prev, ...patch }));
  const setAction = (i: number, a: Action) => set({ actions: d.actions.map((x, j) => (j === i ? a : x)) });

  const defaultAction = (type: Action['type']): Action => {
    switch (type) {
      case 'AssignManager': return { type, poolId: pools[0]?.id ?? '' };
      case 'SendNotification': return { type, to: 'owner', message: t('action.defaultMessage') };
      case 'CreateTask': return { type, title: t('action.defaultTask'), dueInMinutes: 60, assignTo: 'owner' };
    }
  };

  function submit(e: FormEvent) {
    e.preventDefault();
    onSave(toInput(d));
  }

  const needsStage = d.triggerType === 'StageChanged' || d.triggerType === 'StageSlaBreached';

  return (
    <div className="fixed inset-0 z-40 flex justify-end" role="dialog" aria-modal="true" aria-label={t(automation ? 'form.titleEdit' : 'form.titleNew')}>
      <button type="button" aria-label={t('common.close')} className="absolute inset-0 bg-black/30" onClick={onClose} />
      <form onSubmit={submit} className="relative flex h-full w-full max-w-xl flex-col gap-5 overflow-y-auto border-l border-border bg-background p-6 shadow-xl">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">{t(automation ? 'form.titleEdit' : 'form.titleNew')}</h2>
          <Button type="button" variant="ghost" className="size-8 px-0" onClick={onClose} aria-label={t('common.close')}><X className="size-4" /></Button>
        </div>

        <div className="space-y-2">
          <Label htmlFor="a-name">{t('form.name')}</Label>
          <Input id="a-name" value={d.name} onChange={(e) => set({ name: e.target.value })} required maxLength={200} />
        </div>

        <Section title={t('automations.when')}>
          <select aria-label={t('form.trigger')} value={d.triggerType} onChange={(e) => set({ triggerType: e.target.value as TriggerType })} className={selectCls}>
            {TRIGGERS.map((v) => <option key={v} value={v}>{t(`trigger.${v}`)}</option>)}
          </select>
          {needsStage && (
            <select aria-label={t('form.stage')} value={d.stageId} onChange={(e) => set({ stageId: e.target.value })} className={selectCls}>
              <option value="">{t('form.anyStage')}</option>
              {stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          )}
          {d.triggerType === 'NoActivityInDays' && (
            <label className="flex items-center gap-2 text-sm">
              {t('form.daysWithoutActivity')}
              <Input type="number" min={1} max={90} value={d.days} onChange={(e) => set({ days: Number(e.target.value) })} className="w-24" />
            </label>
          )}
        </Section>

        <Section title={t('automations.if')} hint={d.rows.length === 0 && !d.rawConditions ? t('form.noConditions') : undefined}>
          {d.rawConditions ? (
            <p className="text-sm text-muted-foreground">{t('form.complexCondition')}</p>
          ) : (
            <>
              {d.rows.length > 1 && (
                <select aria-label={t('form.combinator')} value={d.combinator} onChange={(e) => set({ combinator: e.target.value as Draft['combinator'] })} className={cn(selectCls, 'w-auto')}>
                  <option value="all">{t('form.all')}</option>
                  <option value="any">{t('form.any')}</option>
                </select>
              )}
              {d.rows.map((r, i) => (
                <div key={i} className="flex flex-wrap items-center gap-2">
                  <select aria-label={t('form.field')} value={r.field} className={cn(selectCls, 'w-40')} onChange={(e) => {
                    const field = e.target.value as ConditionField;
                    set({ rows: d.rows.map((x, j) => (j === i ? { field, op: opsFor(field)[0]!, value: '' } : x)) });
                  }}>
                    {FORM_FIELDS.map((v) => <option key={v} value={v}>{t(`field.${v}`)}</option>)}
                  </select>
                  <select aria-label={t('form.operator')} value={r.op} className={cn(selectCls, 'w-32')}
                    onChange={(e) => set({ rows: d.rows.map((x, j) => (j === i ? { ...x, op: e.target.value as ConditionOp } : x)) })}>
                    {opsFor(r.field).map((op) => (
                      <option key={op} value={op}>{op === 'in' ? t('op.in') : op === 'isEmpty' ? t('op.isEmpty') : OP_SYMBOL[op]}</option>
                    ))}
                  </select>
                  {r.op !== 'isEmpty' && (
                    <ValueInput row={r} stages={stages} members={members}
                      onChange={(value) => set({ rows: d.rows.map((x, j) => (j === i ? { ...x, value } : x)) })} />
                  )}
                  <Button type="button" variant="ghost" className="size-8 px-0" aria-label={t('form.removeCondition')}
                    onClick={() => set({ rows: d.rows.filter((_, j) => j !== i) })}><Trash2 className="size-4" /></Button>
                </div>
              ))}
              <Button type="button" variant="outline" className="self-start"
                onClick={() => set({ rows: [...d.rows, { field: 'deal.value', op: 'gt', value: '10000' }] })}>
                <Plus className="size-4" /> {t('form.addCondition')}
              </Button>
            </>
          )}
        </Section>

        <Section title={t('automations.then')}>
          {d.actions.map((a, i) => (
            <div key={i} className="space-y-2 rounded-lg border border-border bg-card p-3">
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-muted-foreground">{i + 1}.</span>
                <select aria-label={t('form.action')} value={a.type} className={selectCls} onChange={(e) => setAction(i, defaultAction(e.target.value as Action['type']))}>
                  <option value="AssignManager">{t('action.AssignManager')}</option>
                  <option value="SendNotification">{t('action.SendNotification')}</option>
                  <option value="CreateTask">{t('action.CreateTask')}</option>
                </select>
                <Button type="button" variant="ghost" className="size-8 px-0" aria-label={t('form.removeAction')} disabled={d.actions.length === 1}
                  onClick={() => set({ actions: d.actions.filter((_, j) => j !== i) })}><Trash2 className="size-4" /></Button>
              </div>
              <ActionFields action={a} pools={pools} onChange={(next) => setAction(i, next)} />
            </div>
          ))}
          <Button type="button" variant="outline" className="self-start" disabled={d.actions.length >= 10}
            onClick={() => set({ actions: [...d.actions, defaultAction('CreateTask')] })}>
            <Plus className="size-4" /> {t('form.addAction')}
          </Button>
          <p className="text-xs text-muted-foreground">{t('form.actionsHint')}</p>
        </Section>

        <div className="mt-auto flex gap-2 pt-2">
          <Button type="submit" disabled={saving}>{t('common.save')}</Button>
          <Button type="button" variant="outline" onClick={onClose}>{t('common.cancel')}</Button>
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
  const { t } = useI18n();
  if (row.field === 'deal.stageId') {
    return (
      <select aria-label={t('form.value')} value={row.value} onChange={(e) => onChange(e.target.value)} className={cn(selectCls, 'w-44')}>
        <option value="" disabled>{t('form.pickStage')}</option>
        {stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>
    );
  }
  if (row.field === 'deal.ownerId') {
    return (
      <select aria-label={t('form.value')} value={row.value} onChange={(e) => onChange(e.target.value)} className={cn(selectCls, 'w-44')}>
        <option value="" disabled>{t('form.pickMember')}</option>
        {members.map((m) => <option key={m.id} value={m.id}>{m.fullName}</option>)}
      </select>
    );
  }
  return (
    <Input aria-label={t('form.value')} value={row.value} onChange={(e) => onChange(e.target.value)} className="w-36"
      inputMode={row.field === 'deal.value' ? 'decimal' : undefined} required />
  );
}

function ActionFields({ action, pools, onChange }: { action: Action; pools: AssignmentPoolDto[]; onChange: (a: Action) => void }) {
  const { t } = useI18n();
  switch (action.type) {
    case 'AssignManager':
      return (
        <select aria-label={t('form.pool')} value={action.poolId} onChange={(e) => onChange({ ...action, poolId: e.target.value })} className={selectCls} required>
          {pools.map((p) => (
            <option key={p.id} value={p.id}>{p.name} ({t('form.inRotation', { count: p.members.filter((m) => m.isAvailable).length })})</option>
          ))}
        </select>
      );
    case 'SendNotification':
      return (
        <div className="space-y-2">
          <select aria-label={t('form.recipient')} value={action.to} onChange={(e) => onChange({ ...action, to: e.target.value as typeof action.to })} className={selectCls}>
            {RECIPIENTS.map((v) => <option key={v} value={v}>{t(`recipient.${v}`)}</option>)}
          </select>
          <TemplateInput aria-label={t('form.message')} value={action.message} onChange={(message) => onChange({ ...action, message })} required maxLength={500} />
        </div>
      );
    case 'CreateTask':
      return (
        <div className="space-y-2">
          <TemplateInput aria-label={t('form.task')} value={action.title} onChange={(title) => onChange({ ...action, title })} required maxLength={200} />
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <select aria-label={t('form.assignee')} value={action.assignTo} onChange={(e) => onChange({ ...action, assignTo: e.target.value as typeof action.assignTo })} className={cn(selectCls, 'w-auto')}>
              <option value="owner">{t('assignee.owner')}</option>
              <option value="teamLead">{t('assignee.teamLead')}</option>
            </select>
            {t('form.dueIn')}
            <Input type="number" min={0} max={129600} value={action.dueInMinutes} className="w-24" aria-label={t('form.dueMinutesAria')}
              onChange={(e) => onChange({ ...action, dueInMinutes: Number(e.target.value) })} />
            {t('form.minutesUnit')}
          </div>
        </div>
      );
  }
}
