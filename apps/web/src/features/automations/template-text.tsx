'use client';

import { useRef, type ComponentProps } from 'react';
import { Input } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-provider';
import type { MessageKey } from '@/i18n/messages';

/** Переменные шаблонов уведомлений и задач — синхронно с renderTemplate в @crm/domain */
const VARIABLES: { token: string; label: MessageKey }[] = [
  { token: '{{deal.title}}', label: 'var.deal.title' },
  { token: '{{deal.value}}', label: 'var.deal.value' },
];

const SPLIT = new RegExp(`(${VARIABLES.map((v) => v.token.replace(/[{}.]/g, '\\$&')).join('|')})`);

function VariableChip({ label }: { label: string }) {
  return (
    <span className="mx-0.5 inline-flex items-center rounded bg-accent px-1.5 text-[0.85em] font-medium text-primary">
      {label}
    </span>
  );
}

/** Шаблон для чтения: вместо {{deal.title}} — подписанная метка на языке интерфейса */
export function TemplateText({ text }: { text: string }) {
  const { t } = useI18n();
  return (
    <>
      {text.split(SPLIT).map((part, i) => {
        const variable = VARIABLES.find((v) => v.token === part);
        return variable ? <VariableChip key={i} label={t(variable.label)} /> : part;
      })}
    </>
  );
}

/** Поле шаблона с кнопками вставки переменных в позицию курсора — фигурные скобки руками не набирать */
export function TemplateInput({ value, onChange, ...props }: Omit<ComponentProps<typeof Input>, 'onChange' | 'value'> & {
  value: string;
  onChange: (value: string) => void;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLInputElement>(null);

  function insert(token: string) {
    const input = ref.current;
    const start = input?.selectionStart ?? value.length;
    const end = input?.selectionEnd ?? value.length;
    onChange(value.slice(0, start) + token + value.slice(end));
    requestAnimationFrame(() => {
      input?.focus();
      input?.setSelectionRange(start + token.length, start + token.length);
    });
  }

  return (
    <div className="space-y-1">
      <Input ref={ref} value={value} onChange={(e) => onChange(e.target.value)} {...props} />
      <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
        {t('form.insertVariable')}
        {VARIABLES.map((v) => (
          <button key={v.token} type="button" onClick={() => insert(v.token)}
            className="rounded bg-accent px-1.5 py-0.5 font-medium text-primary hover:bg-primary hover:text-primary-foreground">
            + {t(v.label)}
          </button>
        ))}
      </div>
    </div>
  );
}
