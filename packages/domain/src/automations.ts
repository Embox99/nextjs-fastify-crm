import type { Condition, ConditionField, DomainEvent, Trigger } from '@crm/contracts';

export type Facts = Record<ConditionField, string | number | null>;

const toNumber = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : Number.NaN);
// Значения из UI приходят строками, из БД — строками (numeric) или uuid: сравниваем в строковой форме
const same = (a: unknown, b: unknown) => a !== null && a !== undefined && String(a) === String(b);

/** Вычисление условия. Пустые all/any — истина/ложь по математическим соглашениям. */
export function evaluate(c: Condition, facts: Facts): boolean {
  if ('all' in c) return c.all.every((x) => evaluate(x, facts));
  if ('any' in c) return c.any.some((x) => evaluate(x, facts));
  if ('not' in c) return !evaluate(c.not, facts);

  const actual = facts[c.field];
  switch (c.op) {
    case 'eq': return same(actual, c.value);
    case 'neq': return !same(actual, c.value);
    case 'gt': return toNumber(actual) > toNumber(c.value);
    case 'gte': return toNumber(actual) >= toNumber(c.value);
    case 'lt': return toNumber(actual) < toNumber(c.value);
    case 'lte': return toNumber(actual) <= toNumber(c.value);
    case 'in': return Array.isArray(c.value) && c.value.some((v) => same(actual, v));
    case 'isEmpty': return actual === null || actual === '';
  }
}

/** Подходит ли событие под триггер. NoActivityInDays событиями не запускается — его ведёт сканер. */
export function triggerMatches(trigger: Trigger, event: DomainEvent): boolean {
  switch (trigger.type) {
    case 'LeadCreated': {
      if (event.type !== 'lead.created') return false;
      const { channelId } = event.payload as DomainEvent<'lead.created'>['payload'];
      return !trigger.channelId || trigger.channelId === channelId;
    }
    case 'StageChanged': {
      if (event.type !== 'deal.stage_changed') return false;
      const p = event.payload as DomainEvent<'deal.stage_changed'>['payload'];
      return (!trigger.toStageId || trigger.toStageId === p.toStageId)
        && (!trigger.fromStageId || trigger.fromStageId === p.fromStageId);
    }
    case 'StageSlaBreached': {
      if (event.type !== 'deal.sla_breached') return false;
      const p = event.payload as DomainEvent<'deal.sla_breached'>['payload'];
      return !trigger.stageId || trigger.stageId === p.stageId;
    }
    case 'NoActivityInDays':
      return false;
  }
}

/**
 * Подстановка в шаблон уведомления. Сумма — в валюте сделки. Неизвестные плейсхолдеры остаются как есть —
 * видно опечатку. Текст сохраняется в уведомлении один раз, поэтому формат не зависит от языка получателя.
 */
export function renderTemplate(template: string, deal: { title: string; value: string; currency: string }): string {
  const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: deal.currency, maximumFractionDigits: 0 });
  return template
    .replaceAll('{{deal.title}}', deal.title)
    .replaceAll('{{deal.value}}', money.format(Number(deal.value)));
}

export interface RotationMember {
  userId: string;
  position: number;
  isAvailable: boolean;
}

/**
 * Round-robin: первый доступный участник после позиции последнего назначенного, по кругу.
 * Недоступные (отпуск) пропускаются, их место в очереди сохраняется. Та же логика — в SQL
 * (pickNextAssignee), эта версия — эталон для тестов.
 */
export function nextInRotation(members: readonly RotationMember[], lastPosition: number): RotationMember | null {
  const available = members.filter((m) => m.isAvailable).sort((a, b) => a.position - b.position);
  return available.find((m) => m.position > lastPosition) ?? available[0] ?? null;
}
