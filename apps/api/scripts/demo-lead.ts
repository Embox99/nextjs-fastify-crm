/**
 * Отправляет демо-лид в локальный API так, как это сделал бы сайт или Telegram:
 *   pnpm --filter @crm/api demo:lead                      — заявка с формы сайта
 *   pnpm --filter @crm/api demo:lead telegram "Текст"     — сообщение в Telegram-бот
 * Каналы берутся из API под демо-админом; секреты — демо-константы из seed.
 */
import { DEMO_ORG, DEMO_PASSWORD, DEMO_TELEGRAM_SECRET, DEMO_WEBSITE_SECRET } from '@crm/db';
import { signPayload } from '../src/modules/webhooks/signature';
import type { ChannelDto } from '../src/modules/channels/routes';

const API = process.env.API_URL ?? 'http://localhost:4000';
const [kind = 'website', text] = process.argv.slice(2);

const login = await fetch(`${API}/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ organization: DEMO_ORG, email: 'admin@acme.test', password: DEMO_PASSWORD }),
}).then((r) => r.json()) as { token: string; workspaces: { id: string }[] };

const channels = await fetch(`${API}/channels`, {
  headers: { authorization: `Bearer ${login.token}`, 'x-workspace-id': login.workspaces[0]!.id },
}).then((r) => r.json()) as ChannelDto[];

const channel = channels.find((c) => c.kind === (kind === 'telegram' ? 'telegram' : 'website_form'));
if (!channel) throw new Error(`No ${kind} channel — run pnpm db:seed`);

const n = Math.floor(Math.random() * 10_000);
let body: string;
let headers: Record<string, string>;

if (kind === 'telegram') {
  const chatId = 100_000 + (n % 5);   // несколько «постоянных» собеседников
  body = JSON.stringify({
    update_id: Date.now(),
    message: { message_id: Date.now() % 1e9, chat: { id: chatId }, from: { id: chatId, first_name: `Guest ${chatId % 100}` }, text: text ?? 'Hi! I would like to know more about your pricing' },
  });
  headers = { 'x-telegram-bot-api-secret-token': DEMO_TELEGRAM_SECRET };
} else {
  body = JSON.stringify({
    name: `Client ${n}`,
    phone: `+44 20 7946 ${String(n % 10_000).padStart(4, '0')}`,
    email: `client${n}@example.com`,
    title: 'Website request: CRM rollout',
    message: text ?? 'We need a CRM for 20 sales reps, please call us back',
  });
  headers = { 'x-signature': signPayload(body, DEMO_WEBSITE_SECRET), 'x-event-id': `demo-${Date.now()}` };
}

const res = await fetch(`${API}${channel.webhookPath}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body,
});
console.log(`${channel.name}: HTTP ${res.status}`, await res.text());
