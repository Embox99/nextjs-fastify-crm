import { describe, expect, it } from 'vitest';
import { IgnoredEventError, normalize, normalizePhone, NormalizationError } from '../src/ingest/normalize';

describe('normalizePhone', () => {
  it.each([
    ['8 (916) 123-45-67', '+79161234567'],
    ['+7 916 123 45 67', '+79161234567'],
    ['9161234567', '+79161234567'],
    ['+44 20 7946 0958', '+442079460958'],
  ])('%s → %s', (input, expected) => {
    expect(normalizePhone(input)).toBe(expected);
  });

  it('невалидный номер не становится идентификатором', () => {
    expect(normalizePhone('12345')).toBeUndefined();
    expect(normalizePhone('позвоните мне')).toBeUndefined();
  });
});

describe('форма сайта', () => {
  it('нормализует телефон и email, тред — email', () => {
    expect(normalize('website_form', {
      name: ' Иван ', phone: '8 916 123-45-67', email: 'Ivan@Example.COM', message: 'Нужен аудит', title: 'Аудит',
    }, 'evt-1')).toEqual({
      threadId: 'ivan@example.com', messageId: 'evt-1', name: 'Иван', phone: '+79161234567',
      email: 'ivan@example.com', message: 'Нужен аудит', dealTitle: 'Аудит',
    });
  });

  it('без валидного телефона и email — NormalizationError (ретраи бессмысленны)', () => {
    expect(() => normalize('website_form', { name: 'x', phone: '123', email: 'not-an-email' }, 'e')).toThrow(NormalizationError);
    expect(() => normalize('website_form', 'garbage', 'e')).toThrow(NormalizationError);
  });
});

describe('Telegram', () => {
  const update = (message: object) => ({ update_id: 1, message: { message_id: 10, chat: { id: 555 }, from: { id: 42, first_name: 'Анна', last_name: 'К' }, ...message } });

  it('текст: тред — chat.id, идентификатор — telegram user id', () => {
    expect(normalize('telegram', update({ text: 'Привет' }), 'x')).toEqual({
      threadId: '555', messageId: '10', name: 'Анна К', telegramUserId: '42', message: 'Привет',
    });
  });

  it('пользователь поделился контактом — появляется телефон', () => {
    const lead = normalize('telegram', update({ contact: { phone_number: '79161234567' } }), 'x');
    expect(lead.phone).toBe('+79161234567');
    expect(lead.message).toBe('Поделился контактом');
  });

  it('апдейт без нового сообщения (edited_message, callback) — игнорируется', () => {
    expect(() => normalize('telegram', { update_id: 2, edited_message: {} }, 'x')).toThrow(IgnoredEventError);
  });
});
