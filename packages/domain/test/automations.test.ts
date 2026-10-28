import { Action, AutomationInput, Condition, type DomainEvent } from '@crm/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { evaluate, nextInRotation, renderTemplate, triggerMatches, type Facts } from '../src/automations';

const facts: Facts = {
  'deal.value': '150000.00',
  'deal.pipelineId': 'p1',
  'deal.stageId': 's1',
  'deal.ownerId': null,
  'deal.teamId': 't1',
  'deal.currency': 'RUB',
};

describe('evaluate', () => {
  it.each([
    [{ field: 'deal.value', op: 'gt', value: 100000 }, true],
    [{ field: 'deal.value', op: 'gt', value: '150000' }, false],
    [{ field: 'deal.value', op: 'gte', value: 150000 }, true],
    [{ field: 'deal.value', op: 'lt', value: 'not a number' }, false],
    [{ field: 'deal.pipelineId', op: 'eq', value: 'p1' }, true],
    [{ field: 'deal.pipelineId', op: 'neq', value: 'p1' }, false],
    [{ field: 'deal.stageId', op: 'in', value: ['s0', 's1'] }, true],
    [{ field: 'deal.ownerId', op: 'isEmpty' }, true],
    [{ field: 'deal.ownerId', op: 'eq', value: null }, false],
  ] as [Condition, boolean][])('%j → %s', (condition, expected) => {
    expect(evaluate(condition, facts)).toBe(expected);
  });

  it('композиция all / any / not', () => {
    const bigInPipeline: Condition = { all: [
      { field: 'deal.value', op: 'gt', value: 100000 },
      { any: [{ field: 'deal.pipelineId', op: 'eq', value: 'p1' }, { field: 'deal.pipelineId', op: 'eq', value: 'p2' }] },
      { not: { field: 'deal.ownerId', op: 'eq', value: 'u1' } },
    ] };
    expect(evaluate(bigInPipeline, facts)).toBe(true);
    expect(evaluate({ all: [] }, facts)).toBe(true);
    expect(evaluate({ any: [] }, facts)).toBe(false);
  });

  it('схема отвергает неизвестные поля и операторы — в БД не попадёт мусор', () => {
    expect(Condition.safeParse({ field: 'deal.secret', op: 'eq', value: 1 }).success).toBe(false);
    expect(Condition.safeParse({ field: 'deal.value', op: 'regex', value: '.*' }).success).toBe(false);
    expect(Action.safeParse({ type: 'RunScript', code: 'rm -rf /' }).success).toBe(false);
    expect(AutomationInput.safeParse({ name: 'x', trigger: { type: 'LeadCreated' }, actions: [] }).success).toBe(false);
  });
});

describe('triggerMatches', () => {
  const event = <T extends DomainEvent['type']>(type: T, payload: DomainEvent<T>['payload']): DomainEvent =>
    ({ id: 1, type, payload, organizationId: 'o', workspaceId: 'w', dealId: 'd', actor: { kind: 'system' }, createdAt: '' }) as DomainEvent;

  it('StageChanged с фильтром по целевому этапу', () => {
    const moved = event('deal.stage_changed', { fromStageId: 'a', toStageId: 'b', stageEnteredAt: '' });
    expect(triggerMatches({ type: 'StageChanged' }, moved)).toBe(true);
    expect(triggerMatches({ type: 'StageChanged', toStageId: '00000000-0000-4000-8000-000000000000' }, moved)).toBe(false);
    expect(triggerMatches({ type: 'LeadCreated' }, moved)).toBe(false);
  });

  it('LeadCreated по каналу; NoActivityInDays событиями не запускается', () => {
    const lead = event('lead.created', { channelId: 'c1' });
    expect(triggerMatches({ type: 'LeadCreated' }, lead)).toBe(true);
    expect(triggerMatches({ type: 'NoActivityInDays', days: 3 }, lead)).toBe(false);
  });
});

describe('renderTemplate', () => {
  it('подставляет название и сумму в валюте сделки', () => {
    expect(renderTemplate('Deal "{{deal.title}}" worth {{deal.value}}', { title: 'Audit', value: '150000.00', currency: 'USD' }))
      .toBe('Deal "Audit" worth $150,000');
    expect(renderTemplate('{{deal.value}}', { title: '', value: '150000', currency: 'EUR' })).toBe('€150,000');
  });
});

describe('nextInRotation', () => {
  const members = [
    { userId: 'a', position: 0, isAvailable: true },
    { userId: 'b', position: 1, isAvailable: false },
    { userId: 'c', position: 2, isAvailable: true },
  ];

  it('по кругу, пропуская недоступных', () => {
    expect(nextInRotation(members, -1)?.userId).toBe('a');
    expect(nextInRotation(members, 0)?.userId).toBe('c');
    expect(nextInRotation(members, 2)?.userId).toBe('a');
    expect(nextInRotation([{ ...members[1]! }], -1)).toBeNull();
  });

  it('за N·k назначений каждый доступный участник получает ровно k', () => {
    fc.assert(fc.property(
      fc.array(fc.boolean(), { minLength: 1, maxLength: 12 }),
      fc.integer({ min: 1, max: 20 }),
      (availability, k) => {
        const pool = availability.map((isAvailable, position) => ({ userId: `u${position}`, position, isAvailable }));
        const available = pool.filter((m) => m.isAvailable);
        if (available.length === 0) return;

        const counts = new Map<string, number>();
        let last = -1;
        for (let i = 0; i < available.length * k; i++) {
          const next = nextInRotation(pool, last)!;
          counts.set(next.userId, (counts.get(next.userId) ?? 0) + 1);
          last = next.position;
        }
        expect([...counts.values()].every((c) => c === k)).toBe(true);
        expect(counts.size).toBe(available.length);
      },
    ));
  });
});
