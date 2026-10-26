import { LOCK_TTL_MS, type LockHolder, type Viewer } from '@crm/contracts';
import type { Redis } from 'ioredis';

const PRESENCE_TTL_MS = 60_000;

// Захват или продление тем же пользователем — атомарно. Возвращает {1|0, текущий держатель}.
const ACQUIRE = `
local cur = redis.call('GET', KEYS[1])
if cur then
  local owner = cjson.decode(cur)
  local me = cjson.decode(ARGV[1])
  if owner.userId ~= me.userId then return {0, cur} end
end
redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
return {1, ARGV[1]}`;

// Отпустить можно только блокировку своего сокета: вкладка, у которой перехватили lock, не снимет чужой
const RELEASE = `
local cur = redis.call('GET', KEYS[1])
if cur and cjson.decode(cur).socketId == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0`;

const lockKey = (dealId: string) => `lock:deal:${dealId}`;
const presenceKey = (dealId: string) => `presence:deal:${dealId}`;

export function createDealSessions(redis: Redis) {
  return {
    async acquire(dealId: string, holder: Omit<LockHolder, 'expiresAt'>): Promise<{ acquired: boolean; lockedBy: LockHolder }> {
      const me: LockHolder = { ...holder, expiresAt: Date.now() + LOCK_TTL_MS };
      const [acquired, raw] = (await redis.eval(ACQUIRE, 1, lockKey(dealId), JSON.stringify(me), LOCK_TTL_MS)) as [number, string];
      return { acquired: acquired === 1, lockedBy: JSON.parse(raw) as LockHolder };
    },

    async release(dealId: string, socketId: string): Promise<boolean> {
      return (await redis.eval(RELEASE, 1, lockKey(dealId), socketId)) === 1;
    },

    async current(dealId: string): Promise<LockHolder | null> {
      const raw = await redis.get(lockKey(dealId));
      return raw ? (JSON.parse(raw) as LockHolder) : null;
    },

    /** Presence — хеш socketId → зритель. TTL на весь ключ страхует от сокетов упавшей реплики. */
    async join(dealId: string, socketId: string, viewer: Viewer): Promise<Viewer[]> {
      await redis.multi()
        .hset(presenceKey(dealId), socketId, JSON.stringify(viewer))
        .pexpire(presenceKey(dealId), PRESENCE_TTL_MS)
        .exec();
      return this.viewers(dealId);
    },

    async touch(dealId: string): Promise<void> {
      await redis.pexpire(presenceKey(dealId), PRESENCE_TTL_MS);
    },

    async leave(dealId: string, socketId: string): Promise<Viewer[]> {
      await redis.hdel(presenceKey(dealId), socketId);
      return this.viewers(dealId);
    },

    /** Один пользователь в двух вкладках — один зритель */
    async viewers(dealId: string): Promise<Viewer[]> {
      const all = Object.values(await redis.hgetall(presenceKey(dealId))).map((v) => JSON.parse(v) as Viewer);
      return [...new Map(all.map((v) => [v.userId, v])).values()];
    },
  };
}

export type DealSessions = ReturnType<typeof createDealSessions>;
