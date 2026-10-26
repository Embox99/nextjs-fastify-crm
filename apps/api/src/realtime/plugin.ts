import type { ClientToServerEvents, ServerToClientEvents } from '@crm/contracts';
import { deals, users, withRls, type AuthContext } from '@crm/db';
import { rooms, viewerRooms, type OwnedRow } from '@crm/domain';
import { createAdapter } from '@socket.io/redis-adapter';
import { eq } from 'drizzle-orm';
import fp from 'fastify-plugin';
import { Server, type Socket } from 'socket.io';
import { createDealSessions } from './locks';
import { createPublisher, type Publisher } from './publisher';

declare module 'fastify' {
  interface FastifyInstance {
    realtime: Publisher;
  }
}

interface SocketData {
  auth: AuthContext;
  name: string;
  /** Открытые карточки: id → владелец/команда (для адресации lock-событий) */
  openDeals: Map<string, OwnedRow & { id: string }>;
  editing: Set<string>;
}

type AppSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;

/**
 * Socket.io на том же http.Server, что и Fastify. Redis-адаптер раздаёт события между репликами:
 * publisher на реплике 1 доставляет событие сокетам, подключённым к реплике 2.
 */
export const realtimePlugin = fp<{ corsOrigin: string[] }>(async (app, opts) => {
  const pub = app.redis.duplicate();
  const sub = app.redis.duplicate();

  const io = new Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>(app.server, {
    cors: { origin: opts.corsOrigin, credentials: true },
    transports: ['websocket'],
    adapter: createAdapter(pub, sub),
  });
  const publisher = createPublisher(io);
  const sessions = createDealSessions(app.redis);
  app.decorate('realtime', publisher);
  /** Снятие блокировок/presence при отключении — асинхронное; при остановке его нужно дождаться до закрытия Redis */
  const pendingCleanups = new Set<Promise<unknown>>();

  io.use(async (socket, next) => {
    try {
      const { token, workspaceId } = socket.handshake.auth as { token?: string; workspaceId?: string };
      const auth = await app.authResolver.resolve(token, workspaceId);
      const [me] = await withRls(app.db, auth, (tx) =>
        tx.select({ fullName: users.fullName }).from(users).where(eq(users.id, auth.userId)));
      socket.data = { auth, name: me?.fullName ?? 'Unknown', openDeals: new Map(), editing: new Set() };
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket: AppSocket) => {
    const { auth } = socket.data;
    void socket.join(viewerRooms(auth));

    /** Карточку можно открыть, только если она видна под RLS */
    async function resolveDeal(dealId: string) {
      const cached = socket.data.openDeals.get(dealId);
      if (cached) return cached;
      const [row] = await withRls(app.db, auth, (tx) =>
        tx.select({ id: deals.id, workspaceId: deals.workspaceId, ownerId: deals.ownerId, teamId: deals.teamId })
          .from(deals).where(eq(deals.id, dealId)));
      return row ?? null;
    }

    const viewer = () => ({ userId: auth.userId, name: socket.data.name });
    const holder = () => ({ ...viewer(), socketId: socket.id });

    socket.on('deal.open', async ({ dealId }, ack) => {
      const deal = await resolveDeal(dealId).catch(() => null);
      if (!deal) return ack({ ok: false, error: 'not_found' });

      socket.data.openDeals.set(dealId, deal);
      await socket.join(rooms.deal(deal.workspaceId, dealId));
      const viewers = await sessions.join(dealId, socket.id, viewer());
      publisher.dealPresence(deal, viewers);
      ack({ ok: true, viewers, lockedBy: await sessions.current(dealId) });
    });

    socket.on('deal.close', async ({ dealId }) => {
      await closeDeal(dealId);
    });

    socket.on('deal.edit.start', async ({ dealId }, ack) => {
      const deal = socket.data.openDeals.get(dealId);
      if (!deal) return ack({ ok: false, error: 'deal_not_open' });

      const result = await sessions.acquire(dealId, holder());
      if (result.acquired) {
        socket.data.editing.add(dealId);
        publisher.dealLock(deal, result.lockedBy);
      }
      ack({ ok: true, ...result });
    });

    // Heartbeat продлевает блокировку и рассылает новый expiresAt: если реплика упадёт,
    // клиенты сами погасят индикатор по истечении времени.
    socket.on('deal.edit.heartbeat', async ({ dealId }) => {
      const deal = socket.data.openDeals.get(dealId);
      if (!deal) return;
      await sessions.touch(dealId);
      if (!socket.data.editing.has(dealId)) return;
      const result = await sessions.acquire(dealId, holder());
      if (result.acquired) publisher.dealLock(deal, result.lockedBy);
      else socket.data.editing.delete(dealId);
    });

    socket.on('deal.edit.stop', async ({ dealId }) => {
      await stopEditing(dealId);
    });

    socket.on('disconnect', () => {
      const cleanup = Promise.allSettled([...socket.data.openDeals.keys()].map(closeDeal))
        .finally(() => pendingCleanups.delete(cleanup));
      pendingCleanups.add(cleanup);
    });

    async function stopEditing(dealId: string) {
      const deal = socket.data.openDeals.get(dealId);
      socket.data.editing.delete(dealId);
      if (deal && (await sessions.release(dealId, socket.id))) publisher.dealLock(deal, null);
    }

    async function closeDeal(dealId: string) {
      const deal = socket.data.openDeals.get(dealId);
      if (!deal) return;
      await stopEditing(dealId);
      socket.data.openDeals.delete(dealId);
      await socket.leave(rooms.deal(deal.workspaceId, dealId));
      publisher.dealPresence(deal, await sessions.leave(dealId, socket.id));
    }
  });

  // Сокеты держат соединения открытыми — без этого server.close() ждал бы их бесконечно.
  // http.Server закрывает сам Fastify, поэтому io.close() (который закрыл бы его повторно) не вызываем.
  app.addHook('preClose', async () => {
    io.local.disconnectSockets(true);
    io.engine.close();
    await Promise.allSettled([...pendingCleanups]);
  });
  app.addHook('onClose', async () => {
    await Promise.all([pub.quit(), sub.quit()]);
  });
});
