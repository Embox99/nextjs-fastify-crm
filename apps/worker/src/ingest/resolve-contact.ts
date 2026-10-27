import type { NormalizedLead } from '@crm/contracts';
import { contactIdentities, contacts, mergeCandidates, type RlsContext, type Tx } from '@crm/db';
import { and, eq, or, sql } from 'drizzle-orm';

type IdentityKind = (typeof contactIdentities.$inferInsert)['kind'];

export interface Identity {
  kind: IdentityKind;
  value: string;
}

export function identitiesOf(lead: NormalizedLead): Identity[] {
  const result: Identity[] = [];
  if (lead.phone) result.push({ kind: 'phone', value: lead.phone });
  if (lead.email) result.push({ kind: 'email', value: lead.email });
  if (lead.telegramUserId) result.push({ kind: 'telegram', value: lead.telegramUserId });
  return result;
}

/**
 * Найти или создать контакт по идентификаторам лида.
 *
 * Гонка: два лида с одним телефоном обрабатываются параллельно, оба не находят контакт — получилось
 * бы два контакта. Поэтому транзакция берёт advisory-lock на каждый идентификатор: конкурируют только
 * лиды с общими идентификаторами, остальные идут параллельно. Ключи сортируются — против дедлоков,
 * когда один лид несёт (phone, email), а другой (email, phone). Unique-индекс на contact_identities —
 * последний рубеж, если кто-то обойдёт эту функцию.
 */
export async function resolveContact(tx: Tx, ctx: RlsContext, lead: NormalizedLead): Promise<{ contactId: string; created: boolean }> {
  const ids = identitiesOf(lead);
  const tenant = { organizationId: ctx.organizationId, workspaceId: ctx.workspaceId };

  for (const key of ids.map((i) => `${ctx.workspaceId}:${i.kind}:${i.value}`).sort()) {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
  }

  const matches = ids.length
    ? await tx.select({ contactId: contactIdentities.contactId }).from(contactIdentities)
      .where(and(
        eq(contactIdentities.workspaceId, ctx.workspaceId),
        or(...ids.map((i) => and(eq(contactIdentities.kind, i.kind), eq(contactIdentities.value, i.value)))),
      ))
    : [];
  const contactIds = [...new Set(matches.map((m) => m.contactId))].sort();

  if (contactIds.length === 0) {
    const [contact] = await tx.insert(contacts).values({ ...tenant, fullName: lead.name ?? null }).returning({ id: contacts.id });
    if (ids.length) await tx.insert(contactIdentities).values(ids.map((i) => ({ ...tenant, contactId: contact!.id, ...i })));
    return { contactId: contact!.id, created: true };
  }

  // Телефон указывает на один контакт, email — на другой: молча не склеиваем, ставим задачу на ревью
  if (contactIds.length > 1) {
    await tx.insert(mergeCandidates).values({ ...tenant, contactIds, reason: 'identity_conflict' }).onConflictDoNothing();
  }

  const primary = contactIds[0]!;
  // Новые идентификаторы прикрепляются к найденному контакту (например, лид из формы оставил ещё и email)
  await tx.insert(contactIdentities).values(ids.map((i) => ({ ...tenant, contactId: primary, ...i }))).onConflictDoNothing();
  return { contactId: primary, created: false };
}
