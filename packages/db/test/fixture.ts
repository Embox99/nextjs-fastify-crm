import type { Db } from '../src/client';
import { loadAuthContext, type AuthContext } from '../src/auth-context';
import {
  contacts, deals, organizations, pipelineStages, pipelines, rolePermissions, roles, teamMembers, teams, users,
  workspaceMembers, workspaces,
} from '../src/schema';

/**
 * Org A
 *   Workspace W1
 *     T1 (лид L1; R1, R2) ── T1a (подкоманда; R4)
 *     T2 (R3)
 *     ADM — super_admin
 *   Workspace W2 — ADM; сделка dW2
 * Org B
 *   Workspace WB — B_ADM; сделка dB, контакт cB
 */
export interface RbacFixture {
  id(label: string): string;
  label(id: string): string;
  ctx(user: string, workspace?: string): Promise<AuthContext>;
}

const ROLE_DEFS = {
  super_admin: { scope: 'all', permissions: ['deal:read', 'deal:update', 'deal:reassign', 'settings:manage', 'audit:read'] },
  sales_lead: { scope: 'team', permissions: ['deal:read', 'deal:update', 'deal:reassign'] },
  sales_rep: { scope: 'own', permissions: ['deal:read', 'deal:update'] },
} as const;

type RoleKey = keyof typeof ROLE_DEFS;

export async function seedRbacFixture(admin: Db, appDb: Db): Promise<RbacFixture> {
  const ids = new Map<string, string>();
  const put = (label: string, id: string) => (ids.set(label, id), id);
  const get = (label: string) => {
    const id = ids.get(label);
    if (!id) throw new Error(`unknown fixture label ${label}`);
    return id;
  };

  async function org(label: string) {
    const [row] = await admin.insert(organizations).values({ name: label, slug: label.toLowerCase() }).returning();
    const orgId = put(label, row!.id);
    for (const [key, def] of Object.entries(ROLE_DEFS)) {
      const [role] = await admin.insert(roles)
        .values({ organizationId: orgId, key, name: key, scope: def.scope, isSystem: true }).returning();
      put(`${label}:${key}`, role!.id);
      await admin.insert(rolePermissions)
        .values(def.permissions.map((permission) => ({ organizationId: orgId, roleId: role!.id, permission })));
    }
    return orgId;
  }

  async function workspace(label: string, orgLabel: string) {
    const organizationId = get(orgLabel);
    const [ws] = await admin.insert(workspaces).values({ organizationId, name: label }).returning();
    put(label, ws!.id);
    const [p] = await admin.insert(pipelines).values({ organizationId, workspaceId: ws!.id, name: 'Sales' }).returning();
    put(`${label}:pipeline`, p!.id);
    const [s] = await admin.insert(pipelineStages)
      .values({ organizationId, workspaceId: ws!.id, pipelineId: p!.id, name: 'New', rank: 'a0' }).returning();
    put(`${label}:stage`, s!.id);
  }

  async function user(label: string, orgLabel: string) {
    const [row] = await admin.insert(users)
      .values({ organizationId: get(orgLabel), email: `${label.toLowerCase()}@test.dev`, fullName: label }).returning();
    put(label, row!.id);
  }

  const orgOf = (wsLabel: string) => (wsLabel === 'WB' ? 'B' : 'A');
  const tenant = (wsLabel: string) => ({ organizationId: get(orgOf(wsLabel)), workspaceId: get(wsLabel) });

  async function member(userLabel: string, wsLabel: string, role: RoleKey) {
    await admin.insert(workspaceMembers)
      .values({ ...tenant(wsLabel), userId: get(userLabel), roleId: get(`${orgOf(wsLabel)}:${role}`) });
  }

  async function team(label: string, wsLabel: string, parent?: string) {
    const [row] = await admin.insert(teams)
      .values({ ...tenant(wsLabel), name: label, parentTeamId: parent ? get(parent) : null }).returning();
    put(label, row!.id);
  }

  async function teamMember(teamLabel: string, userLabel: string, isLead = false) {
    await admin.insert(teamMembers).values({ ...tenant('W1'), teamId: get(teamLabel), userId: get(userLabel), isLead });
  }

  async function contact(label: string, wsLabel: string, owner?: string) {
    const [row] = await admin.insert(contacts)
      .values({ ...tenant(wsLabel), fullName: label, ownerId: owner ? get(owner) : null }).returning();
    put(label, row!.id);
  }

  async function deal(label: string, wsLabel: string, o: { owner?: string; team?: string; contact?: string } = {}) {
    const [row] = await admin.insert(deals).values({
      ...tenant(wsLabel),
      pipelineId: get(`${wsLabel}:pipeline`),
      stageId: get(`${wsLabel}:stage`),
      rank: 'a0',
      title: label,
      ownerId: o.owner ? get(o.owner) : null,
      teamId: o.team ? get(o.team) : null,
      contactId: o.contact ? get(o.contact) : null,
    }).returning();
    put(label, row!.id);
  }

  await org('A');
  await org('B');
  await workspace('W1', 'A');
  await workspace('W2', 'A');
  await workspace('WB', 'B');

  for (const u of ['ADM', 'L1', 'R1', 'R2', 'R3', 'R4']) await user(u, 'A');
  await user('B_ADM', 'B');

  await member('ADM', 'W1', 'super_admin');
  await member('ADM', 'W2', 'super_admin');
  await member('L1', 'W1', 'sales_lead');
  for (const r of ['R1', 'R2', 'R3', 'R4']) await member(r, 'W1', 'sales_rep');
  await member('B_ADM', 'WB', 'super_admin');

  await team('T1', 'W1');
  await team('T1a', 'W1', 'T1');
  await team('T2', 'W1');
  await teamMember('T1', 'L1', true);
  await teamMember('T1', 'R1');
  await teamMember('T1', 'R2');
  await teamMember('T1a', 'R4');
  await teamMember('T2', 'R3');

  await contact('cR1', 'W1');                 // без владельца, привязан к dR1
  await contact('cR2', 'W1');                 // без владельца, привязан к dR2
  await contact('cOwnR1', 'W1', 'R1');        // свой контакт R1 без сделок
  await contact('cB', 'WB');

  await deal('dR1', 'W1', { owner: 'R1', team: 'T1', contact: 'cR1' });
  await deal('dR2', 'W1', { owner: 'R2', team: 'T1', contact: 'cR2' });
  await deal('dR3', 'W1', { owner: 'R3', team: 'T2' });
  await deal('dR4', 'W1', { owner: 'R4', team: 'T1a' });
  await deal('dU', 'W1', { team: 'T1' });     // не распределена, в очереди команды
  await deal('dW2', 'W2', { owner: 'ADM' });
  await deal('dB', 'WB', { owner: 'B_ADM', contact: 'cB' });

  const labels = new Map([...ids].map(([l, i]) => [i, l]));

  return {
    id: get,
    label: (id) => labels.get(id) ?? id,
    ctx: (userLabel, wsLabel = userLabel === 'B_ADM' ? 'WB' : 'W1') => loadAuthContext(appDb, get(userLabel), get(wsLabel)),
  };
}
