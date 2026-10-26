import type { LoginResponse } from '@crm/contracts';

export interface Session extends LoginResponse {
  workspaceId: string;
}

const KEY = 'crm.session';

/**
 * Токен в localStorage — осознанное упрощение: браузер ходит в API и WebSocket напрямую (другой origin).
 * Продакшен-вариант — httpOnly-cookie через BFF Next.js и короткоживущий WS-тикет.
 */
export function readSession(): Session | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

export function writeSession(session: Session) {
  try {
    localStorage.setItem(KEY, JSON.stringify(session));
  } catch {
    // приватный режим: сессия проживёт до перезагрузки вкладки
  }
}

export function clearSession() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}
