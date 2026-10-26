import { eq, sql } from 'drizzle-orm';
import { evenRanks } from '@crm/domain';
import type { Db } from '../client';
import {
  contacts, deals, organizations, pipelineStages, pipelines, rolePermissions, roles, teamMembers, teams, users,
  workspaceMembers, workspaces,
} from '../schema';

export const DEMO_ORG = 'acme';
export const DEMO_PASSWORD = 'demo';

const ROLES = {
  super_admin: { name: 'Администратор', scope: 'all', permissions: ['deal:read', 'deal:create', 'deal:update', 'deal:reassign', 'settings:manage', 'audit:read'] },
  sales_lead: { name: 'Руководитель продаж', scope: 'team', permissions: ['deal:read', 'deal:create', 'deal:update', 'deal:reassign'] },
  sales_rep: { name: 'Менеджер', scope: 'own', permissions: ['deal:read', 'deal:create', 'deal:update'] },
} as const;

const USERS = [
  { key: 'admin', email: 'admin@acme.test', fullName: 'Анна Админова', role: 'super_admin' },
  { key: 'lead', email: 'lead@acme.test', fullName: 'Олег Лидов', role: 'sales_lead' },
  { key: 'rep1', email: 'rep1@acme.test', fullName: 'Мария Петрова', role: 'sales_rep' },
  { key: 'rep2', email: 'rep2@acme.test', fullName: 'Иван Сидоров', role: 'sales_rep' },
  { key: 'rep3', email: 'rep3@acme.test', fullName: 'Дмитрий Козлов', role: 'sales_rep' },
] as const;

type UserKey = (typeof USERS)[number]['key'];

const STAGES = [
  { key: 'new', name: 'Новый', kind: 'open', slaMinutes: 15 },
  { key: 'qualified', name: 'Квалификация', kind: 'open', slaMinutes: null },
  { key: 'proposal', name: 'КП отправлено', kind: 'open', slaMinutes: null },
  { key: 'negotiation', name: 'Переговоры', kind: 'open', slaMinutes: null },
  { key: 'won', name: 'Выиграно', kind: 'won', slaMinutes: null },
  { key: 'lost', name: 'Проиграно', kind: 'lost', slaMinutes: null },
] as const;

type StageKey = (typeof STAGES)[number]['key'];

const DEALS: { title: string; company: string; value: string; stage: StageKey; owner: UserKey | null }[] = [
  { title: 'Внедрение CRM на 40 мест', company: 'ООО «Северсталь-Сервис»', value: '480000', stage: 'new', owner: 'rep1' },
  { title: 'Аудит IT-инфраструктуры', company: 'АО «Техноплюс»', value: '150000', stage: 'new', owner: 'rep2' },
  { title: 'Годовое сопровождение', company: 'ИП Орлов', value: '96000', stage: 'new', owner: null },
  { title: 'Миграция в облако', company: 'ООО «Логистик Про»', value: '1200000', stage: 'new', owner: 'rep3' },
  { title: 'Пилот: 5 лицензий', company: 'ООО «Домострой»', value: '45000', stage: 'qualified', owner: 'rep1' },
  { title: 'Интеграция с 1С', company: 'АО «Агрохолдинг Юг»', value: '320000', stage: 'qualified', owner: 'rep2' },
  { title: 'Обучение персонала', company: 'ООО «Медлайн»', value: '78000', stage: 'qualified', owner: 'rep3' },
  { title: 'Расширение до 120 мест', company: 'ПАО «Энергосбыт»', value: '2400000', stage: 'proposal', owner: 'lead' },
  { title: 'Кастомная отчётность', company: 'ООО «Ритейл Групп»', value: '210000', stage: 'proposal', owner: 'rep1' },
  { title: 'Телефония + CRM', company: 'ООО «Автодом»', value: '380000', stage: 'negotiation', owner: 'rep2' },
  { title: 'Лицензии на 3 года', company: 'АО «Стройинвест»', value: '960000', stage: 'negotiation', owner: 'rep1' },
  { title: 'Поддержка 24/7', company: 'ООО «ФинТех Решения»', value: '540000', stage: 'won', owner: 'rep3' },
  { title: 'Внедрение под ключ', company: 'ООО «Альфа-Трейд»', value: '720000', stage: 'lost', owner: 'rep2' },
];

export interface DemoSeed {
  organizationId: string;
  workspaceId: string;
  pipelineId: string;
  users: Record<UserKey, string>;
  teams: { enterprise: string; smb: string };
  stages: Record<StageKey, string>;
}

/**
 * Демо-организация «acme»: workspace «Москва», команды Enterprise (лид + rep1, rep2) и SMB (rep3),
 * воронка из 6 этапов, 13 сделок. Выполняется под владельцем схемы (в обход RLS). Идемпотентна.
 */
export async function seedDemo(db: Db): Promise<DemoSeed> {
  const existing = await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.slug, DEMO_ORG));
  if (existing[0]) return loadDemo(db, existing[0].id);

  return db.transaction(async (tx) => {
    const [org] = await tx.insert(organizations).values({ name: 'Acme Services', slug: DEMO_ORG }).returning();
    const organizationId = org!.id;
    const [ws] = await tx.insert(workspaces).values({ organizationId, name: 'Москва' }).returning();
    const workspaceId = ws!.id;
    const tenant = { organizationId, workspaceId };

    const roleIds = {} as Record<keyof typeof ROLES, string>;
    for (const [key, def] of Object.entries(ROLES) as [keyof typeof ROLES, (typeof ROLES)[keyof typeof ROLES]][]) {
      const [role] = await tx.insert(roles)
        .values({ organizationId, key, name: def.name, scope: def.scope, isSystem: true }).returning();
      roleIds[key] = role!.id;
      await tx.insert(rolePermissions)
        .values(def.permissions.map((permission) => ({ organizationId, roleId: role!.id, permission })));
    }

    const userIds = {} as Record<UserKey, string>;
    for (const u of USERS) {
      const [row] = await tx.insert(users).values({
        organizationId,
        email: u.email,
        fullName: u.fullName,
        passwordHash: sql`crypt(${DEMO_PASSWORD}, gen_salt('bf', 8))`,
      }).returning({ id: users.id });
      userIds[u.key] = row!.id;
      await tx.insert(workspaceMembers).values({ ...tenant, userId: row!.id, roleId: roleIds[u.role] });
    }

    const [enterprise] = await tx.insert(teams).values({ ...tenant, name: 'Enterprise' }).returning();
    const [smb] = await tx.insert(teams).values({ ...tenant, name: 'SMB' }).returning();
    await tx.insert(teamMembers).values([
      { ...tenant, teamId: enterprise!.id, userId: userIds.lead, isLead: true },
      { ...tenant, teamId: enterprise!.id, userId: userIds.rep1 },
      { ...tenant, teamId: enterprise!.id, userId: userIds.rep2 },
      { ...tenant, teamId: smb!.id, userId: userIds.rep3 },
    ]);
    const teamOf = (owner: UserKey | null) => (owner === 'rep3' ? smb!.id : enterprise!.id);

    const [pipeline] = await tx.insert(pipelines).values({ ...tenant, name: 'Продажи' }).returning();
    const stageRanks = evenRanks(STAGES.length);
    const stageIds = {} as Record<StageKey, string>;
    for (const [i, s] of STAGES.entries()) {
      const [row] = await tx.insert(pipelineStages).values({
        ...tenant, pipelineId: pipeline!.id, name: s.name, kind: s.kind, slaMinutes: s.slaMinutes, rank: stageRanks[i]!,
      }).returning();
      stageIds[s.key] = row!.id;
    }

    for (const stage of STAGES) {
      const inStage = DEALS.filter((d) => d.stage === stage.key);
      const ranks = evenRanks(inStage.length);
      for (const [i, d] of inStage.entries()) {
        const ownerId = d.owner ? userIds[d.owner] : null;
        const [contact] = await tx.insert(contacts)
          .values({ ...tenant, fullName: d.company, companyName: d.company, ownerId }).returning();
        await tx.insert(deals).values({
          ...tenant,
          pipelineId: pipeline!.id,
          stageId: stageIds[stage.key],
          rank: ranks[i]!,
          title: d.title,
          value: d.value,
          contactId: contact!.id,
          ownerId,
          teamId: teamOf(d.owner),
          closedAt: stage.kind === 'open' ? null : sql`now()`,
        });
      }
    }

    return {
      organizationId,
      workspaceId,
      pipelineId: pipeline!.id,
      users: userIds,
      teams: { enterprise: enterprise!.id, smb: smb!.id },
      stages: stageIds,
    };
  });
}

async function loadDemo(db: Db, organizationId: string): Promise<DemoSeed> {
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.organizationId, organizationId));
  const [pipeline] = await db.select().from(pipelines).where(eq(pipelines.workspaceId, ws!.id));
  const userRows = await db.select({ id: users.id, email: users.email }).from(users)
    .where(eq(users.organizationId, organizationId));
  const teamRows = await db.select().from(teams).where(eq(teams.workspaceId, ws!.id));
  const stageRows = await db.select().from(pipelineStages).where(eq(pipelineStages.pipelineId, pipeline!.id));

  const byEmail = new Map(userRows.map((u) => [u.email, u.id]));
  const byName = new Map(stageRows.map((s) => [s.name, s.id]));
  return {
    organizationId,
    workspaceId: ws!.id,
    pipelineId: pipeline!.id,
    users: Object.fromEntries(USERS.map((u) => [u.key, byEmail.get(u.email)!])) as Record<UserKey, string>,
    teams: {
      enterprise: teamRows.find((t) => t.name === 'Enterprise')!.id,
      smb: teamRows.find((t) => t.name === 'SMB')!.id,
    },
    stages: Object.fromEntries(STAGES.map((s) => [s.key, byName.get(s.name)!])) as Record<StageKey, string>,
  };
}
