import type { AutomationInput } from '@crm/contracts';
import { and, eq, sql } from 'drizzle-orm';
import { evenRanks } from '@crm/domain';
import type { Db } from '../client';
import type { SecretBox } from '../secrets';
import {
  assignmentPoolMembers, assignmentPools, automations, channels, contacts, deals, organizations, pipelineStages, pipelines, rolePermissions, roles, teamMembers, teams, users,
  workspaceMembers, workspaces,
} from '../schema';

export const DEMO_ORG = 'acme';
export const DEMO_PASSWORD = 'demo';

const ROLES = {
  super_admin: { name: 'Administrator', scope: 'all', permissions: ['deal:read', 'deal:create', 'deal:update', 'deal:reassign', 'settings:manage', 'audit:read'] },
  sales_lead: { name: 'Sales lead', scope: 'team', permissions: ['deal:read', 'deal:create', 'deal:update', 'deal:reassign'] },
  sales_rep: { name: 'Sales rep', scope: 'own', permissions: ['deal:read', 'deal:create', 'deal:update'] },
} as const;

const USERS = [
  { key: 'admin', email: 'admin@acme.test', fullName: 'Alice Morgan', role: 'super_admin' },
  { key: 'lead', email: 'lead@acme.test', fullName: 'Oliver Grant', role: 'sales_lead' },
  { key: 'rep1', email: 'rep1@acme.test', fullName: 'Maria Lopez', role: 'sales_rep' },
  { key: 'rep2', email: 'rep2@acme.test', fullName: 'Ethan Brooks', role: 'sales_rep' },
  { key: 'rep3', email: 'rep3@acme.test', fullName: 'Daniel Kim', role: 'sales_rep' },
] as const;

type UserKey = (typeof USERS)[number]['key'];

const STAGES = [
  { key: 'new', name: 'New', kind: 'open', slaMinutes: 15 },
  { key: 'qualified', name: 'Qualified', kind: 'open', slaMinutes: null },
  { key: 'proposal', name: 'Proposal sent', kind: 'open', slaMinutes: null },
  { key: 'negotiation', name: 'Negotiation', kind: 'open', slaMinutes: null },
  { key: 'won', name: 'Won', kind: 'won', slaMinutes: null },
  { key: 'lost', name: 'Lost', kind: 'lost', slaMinutes: null },
] as const;

type StageKey = (typeof STAGES)[number]['key'];

const DEALS: { title: string; company: string; value: string; stage: StageKey; owner: UserKey | null }[] = [
  { title: 'CRM rollout, 40 seats', company: 'Northwind Logistics', value: '48000', stage: 'new', owner: 'rep1' },
  { title: 'IT infrastructure audit', company: 'Contoso Ltd', value: '15000', stage: 'new', owner: 'rep2' },
  { title: 'Annual support plan', company: 'Fabrikam Studio', value: '9600', stage: 'new', owner: null },
  { title: 'Cloud migration', company: 'Tailspin Freight', value: '120000', stage: 'new', owner: 'rep3' },
  { title: 'Pilot: 5 licenses', company: 'Lakeside Homes', value: '4500', stage: 'qualified', owner: 'rep1' },
  { title: 'ERP integration', company: 'Greenfield Agro', value: '32000', stage: 'qualified', owner: 'rep2' },
  { title: 'Staff training', company: 'Medline Clinics', value: '7800', stage: 'qualified', owner: 'rep3' },
  { title: 'Expansion to 120 seats', company: 'Summit Energy', value: '240000', stage: 'proposal', owner: 'lead' },
  { title: 'Custom reporting', company: 'Bluebird Retail', value: '21000', stage: 'proposal', owner: 'rep1' },
  { title: 'Telephony + CRM', company: 'Autohaus Group', value: '38000', stage: 'negotiation', owner: 'rep2' },
  { title: '3-year license renewal', company: 'Ironclad Construction', value: '96000', stage: 'negotiation', owner: 'rep1' },
  { title: '24/7 support', company: 'Ledger Fintech', value: '54000', stage: 'won', owner: 'rep3' },
  { title: 'Turnkey implementation', company: 'Alpha Trade Co', value: '72000', stage: 'lost', owner: 'rep2' },
];

export interface DemoSeed {
  organizationId: string;
  workspaceId: string;
  pipelineId: string;
  users: Record<UserKey, string>;
  teams: { enterprise: string; smb: string };
  stages: Record<StageKey, string>;
  channels: { website: string; telegram: string };
  assignmentPool: string;
}

export const DEMO_WEBSITE_SECRET = 'demo-website-hmac-secret';
export const DEMO_TELEGRAM_SECRET = 'demo-telegram-secret-token';

const DEMO_CHANNELS = [
  { key: 'website', kind: 'website_form', name: 'Website form', secret: DEMO_WEBSITE_SECRET },
  { key: 'telegram', kind: 'telegram', name: 'Telegram bot', secret: DEMO_TELEGRAM_SECRET },
] as const;

/**
 * Демо-организация «acme»: workspace «Москва», команды Enterprise (лид + rep1, rep2) и SMB (rep3),
 * воронка из 6 этапов, 13 сделок. Выполняется под владельцем схемы (в обход RLS). Идемпотентна.
 */
export async function seedDemo(db: Db, secrets: SecretBox): Promise<DemoSeed> {
  const existing = await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.slug, DEMO_ORG));
  const core = existing[0] ? await loadDemo(db, existing[0].id) : await seedCore(db);
  return {
    ...core,
    channels: await ensureChannels(db, core, secrets),
    assignmentPool: await ensureAutomations(db, core),
  };
}

/**
 * Пул round-robin (rep1, rep2 → команда Enterprise) и демо-автоматизации на все четыре триггера.
 * Как и каналы — отдельным идемпотентным шагом, чтобы догнать базу, засеянную раньше.
 */
async function ensureAutomations(db: Db, core: CoreSeed): Promise<string> {
  const tenant = { organizationId: core.organizationId, workspaceId: core.workspaceId };
  const [existingPool] = await db.select({ id: assignmentPools.id }).from(assignmentPools)
    .where(eq(assignmentPools.workspaceId, core.workspaceId));
  if (existingPool) return existingPool.id;

  return db.transaction(async (tx) => {
    const [pool] = await tx.insert(assignmentPools)
      .values({ ...tenant, name: 'Inbound leads → Enterprise', teamId: core.teams.enterprise }).returning({ id: assignmentPools.id });
    await tx.insert(assignmentPoolMembers).values([
      { ...tenant, poolId: pool!.id, userId: core.users.rep1, position: 0 },
      { ...tenant, poolId: pool!.id, userId: core.users.rep2, position: 1 },
    ]);

    const demo: (Omit<AutomationInput, 'enabled'> & { enabled?: boolean })[] = [
      {
        name: 'Route new leads',
        trigger: { type: 'LeadCreated' },
        conditions: { all: [] },
        actions: [
          { type: 'AssignManager', poolId: pool!.id },
          { type: 'SendNotification', to: 'owner', message: 'New lead assigned to you: {{deal.title}}' },
        ],
      },
      {
        name: 'SLA: lead untouched for 15 minutes',
        trigger: { type: 'StageSlaBreached', stageId: core.stages.new },
        conditions: { all: [] },
        actions: [
          { type: 'SendNotification', to: 'teamLead', message: 'Lead "{{deal.title}}" has been waiting for over 15 minutes' },
          { type: 'CreateTask', title: 'Contact ASAP: {{deal.title}}', dueInMinutes: 30, assignTo: 'owner' },
        ],
      },
      {
        name: 'Large deal: proposal sent',
        trigger: { type: 'StageChanged', toStageId: core.stages.proposal },
        conditions: { all: [{ field: 'deal.value', op: 'gt', value: 10000 }] },
        actions: [
          { type: 'CreateTask', title: 'Follow up on the proposal: {{deal.title}}', dueInMinutes: 2 * 24 * 60, assignTo: 'owner' },
          { type: 'SendNotification', to: 'teamLead', message: 'Large deal "{{deal.title}}" worth {{deal.value}}: proposal sent' },
        ],
      },
      {
        name: 'Deal idle for 7 days',
        trigger: { type: 'NoActivityInDays', days: 7 },
        conditions: { all: [] },
        actions: [{ type: 'SendNotification', to: 'owner', message: 'Deal "{{deal.title}}" has had no activity for a week' }],
      },
    ];
    await tx.insert(automations).values(demo.map((a) => ({
      ...tenant, name: a.name, trigger: a.trigger, triggerType: a.trigger.type, conditions: a.conditions, actions: a.actions,
    })));
    return pool!.id;
  });
}

/**
 * Каналы демо-организации с известными секретами — чтобы `pnpm demo:lead` мог подписывать запросы.
 * Отдельный шаг: база, засеянная до появления каналов, получает их при повторном запуске.
 */
async function ensureChannels(db: Db, core: CoreSeed, secrets: SecretBox): Promise<DemoSeed['channels']> {
  const result = {} as DemoSeed['channels'];
  for (const def of DEMO_CHANNELS) {
    const [found] = await db.select({ id: channels.id }).from(channels)
      .where(and(eq(channels.workspaceId, core.workspaceId), eq(channels.name, def.name)));
    if (found) {
      result[def.key] = found.id;
      continue;
    }
    const [created] = await db.insert(channels).values({
      organizationId: core.organizationId,
      workspaceId: core.workspaceId,
      kind: def.kind,
      name: def.name,
      webhookSecret: secrets.seal(def.secret),
      defaultPipelineId: core.pipelineId,
    }).returning({ id: channels.id });
    result[def.key] = created!.id;
  }
  return result;
}

type CoreSeed = Omit<DemoSeed, 'channels' | 'assignmentPool'>;

async function seedCore(db: Db): Promise<CoreSeed> {
  return db.transaction(async (tx) => {
    const [org] = await tx.insert(organizations).values({ name: 'Acme Services', slug: DEMO_ORG }).returning();
    const organizationId = org!.id;
    const [ws] = await tx.insert(workspaces).values({ organizationId, name: 'New York' }).returning();
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

    const [pipeline] = await tx.insert(pipelines).values({ ...tenant, name: 'Sales' }).returning();
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

async function loadDemo(db: Db, organizationId: string): Promise<CoreSeed> {
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
