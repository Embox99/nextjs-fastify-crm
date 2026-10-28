import type { NotificationDto, TaskDto } from '@crm/contracts';
import { activities, deals, notifications } from '@crm/db';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

const toNotificationDto = (n: typeof notifications.$inferSelect): NotificationDto => ({
  id: n.id, title: n.title, body: n.body, dealId: n.dealId,
  readAt: n.readAt?.toISOString() ?? null, createdAt: n.createdAt.toISOString(),
});

export async function notificationsRoutes(app: FastifyInstance) {
  // RLS отдаёт только уведомления текущего пользователя — даже администратору
  app.get('/notifications', async (req) => req.tx(async (tx) => {
    const [items, [unread]] = await Promise.all([
      tx.select().from(notifications).orderBy(desc(notifications.createdAt)).limit(50),
      tx.select({ n: sql<number>`count(*)::int` }).from(notifications).where(isNull(notifications.readAt)),
    ]);
    return { items: items.map(toNotificationDto), unread: unread?.n ?? 0 };
  }));

  app.post('/notifications/:notificationId/read', async (req, reply) => {
    const { notificationId } = z.object({ notificationId: z.uuid() }).parse(req.params);
    await req.tx((tx) => tx.update(notifications).set({ readAt: sql`now()` })
      .where(and(eq(notifications.id, notificationId), isNull(notifications.readAt))));
    return reply.code(204).send();
  });

  app.post('/notifications/read-all', async (req, reply) => {
    await req.tx((tx) => tx.update(notifications).set({ readAt: sql`now()` }).where(isNull(notifications.readAt)));
    return reply.code(204).send();
  });

  // Задачи сделки (в том числе созданные автоматизациями) — видимость наследуется от сделки
  app.get('/deals/:dealId/tasks', async (req): Promise<TaskDto[]> => {
    const { dealId } = z.object({ dealId: z.uuid() }).parse(req.params);
    const rows = await req.tx((tx) => tx.select().from(activities)
      .where(and(eq(activities.dealId, dealId), eq(activities.type, 'task')))
      .orderBy(activities.completedAt, activities.dueAt));
    return rows.map((t) => ({
      id: t.id, dealId: t.dealId!, title: (t.payload as { title?: string }).title ?? 'Task',
      assigneeId: t.assigneeId, dueAt: t.dueAt?.toISOString() ?? null,
      completedAt: t.completedAt?.toISOString() ?? null, createdAt: t.createdAt.toISOString(),
    }));
  });

  app.post('/tasks/:taskId/complete', async (req, reply) => {
    const { taskId } = z.object({ taskId: z.uuid() }).parse(req.params);
    const done = await req.tx(async (tx) => {
      const [task] = await tx.update(activities).set({ completedAt: sql`now()`, updatedAt: sql`now()` })
        .where(and(eq(activities.id, taskId), eq(activities.type, 'task'), isNull(activities.completedAt)))
        .returning({ dealId: activities.dealId });
      // Закрытая задача — активность по сделке: сбрасывает счётчик «нет активности N дней»
      if (task?.dealId) await tx.update(deals).set({ lastActivityAt: sql`now()` }).where(eq(deals.id, task.dealId));
      return task;
    });
    return done ? reply.code(204).send() : reply.notFound();
  });
}
