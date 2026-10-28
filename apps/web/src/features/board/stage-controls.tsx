'use client';

import type { StageDto } from '@crm/contracts';
import { Plus, X } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { Button, Input, Label } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-provider';
import { useStageMutations } from './stage-queries';

/** Кнопка в конце доски: новая колонка встаёт после последней открытой (перед «Выиграно»/«Проиграно») */
export function AddStage({ pipelineId }: { pipelineId: string }) {
  const { t } = useI18n();
  const { create } = useStageMutations(pipelineId);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');

  function submit(e: FormEvent) {
    e.preventDefault();
    const value = name.trim();
    if (!value) return;
    create.mutate({ name: value }, {
      onSuccess: () => {
        setName('');
        setEditing(false);
      },
    });
  }

  if (!editing) {
    return (
      <Button variant="outline" className="h-10 w-56 shrink-0 border-dashed" onClick={() => setEditing(true)}>
        <Plus className="size-4" /> {t('stage.add')}
      </Button>
    );
  }
  return (
    <form onSubmit={submit} className="w-56 shrink-0 space-y-2">
      <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={t('stage.namePlaceholder')}
        aria-label={t('stage.namePlaceholder')} maxLength={100} disabled={create.isPending}
        onKeyDown={(e) => e.key === 'Escape' && setEditing(false)} />
      <div className="flex gap-2">
        <Button type="submit" disabled={create.isPending || !name.trim()}>{t('common.save')}</Button>
        <Button type="button" variant="ghost" onClick={() => setEditing(false)}>{t('common.cancel')}</Button>
      </div>
    </form>
  );
}

interface StageSheetProps {
  stage: StageDto;
  /** Все колонки воронки в порядке доски */
  stages: StageDto[];
  dealCount: number;
  onClose: () => void;
}

/**
 * Настройки колонки: название, SLA, положение, удаление. Удаление непустой колонки требует выбрать,
 * куда перенести сделки; ошибки сервера (колонка в автоматизациях, последняя открытая) — понятным текстом.
 */
export function StageSheet({ stage, stages, dealCount, onClose }: StageSheetProps) {
  const { t } = useI18n();
  const { update, move, remove } = useStageMutations(stage.pipelineId);
  const [name, setName] = useState(stage.name);
  const [sla, setSla] = useState(stage.slaMinutes?.toString() ?? '');
  const others = stages.filter((s) => s.id !== stage.id);
  const [target, setTarget] = useState(others.find((s) => s.kind === 'open')?.id ?? others[0]?.id ?? '');

  const index = stages.findIndex((s) => s.id === stage.id);
  const left = stages[index - 1];
  const right = stages[index + 1];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  function save(e: FormEvent) {
    e.preventDefault();
    update.mutate({ stageId: stage.id, name: name.trim(), slaMinutes: sla ? Number(sla) : null });
  }

  function destroy() {
    if (!window.confirm(t('stage.confirmDelete', { name: stage.name }))) return;
    remove.mutate({ stageId: stage.id, moveDealsTo: dealCount ? target : undefined }, { onSuccess: onClose });
  }

  return (
    <div className="fixed inset-0 z-40 flex justify-end" role="dialog" aria-modal="true" aria-label={t('stage.settingsAria')}>
      <button type="button" aria-label={t('common.close')} className="absolute inset-0 bg-black/30" onClick={onClose} />
      <aside className="relative flex h-full w-full max-w-md flex-col gap-6 overflow-y-auto border-l border-border bg-background p-6 shadow-xl">
        <div className="flex items-start justify-between gap-4">
          <h2 className="text-lg font-semibold leading-snug">{t('stage.settings', { name: stage.name })}</h2>
          <Button variant="ghost" className="size-8 px-0" onClick={onClose} aria-label={t('common.close')}><X className="size-4" /></Button>
        </div>
        {stage.kind !== 'open' && <p className="text-sm text-muted-foreground">{t('stage.closedNote')}</p>}

        <form onSubmit={save} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="stage-name">{t('stage.name')}</Label>
            <Input id="stage-name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="stage-sla">{t('stage.sla')}</Label>
            <Input id="stage-sla" type="number" min={1} max={129600} value={sla} onChange={(e) => setSla(e.target.value)} className="block w-32" />
            <p className="text-xs text-muted-foreground">{t('stage.slaHint')}</p>
          </div>
          <Button type="submit" disabled={update.isPending || !name.trim()}>{t('common.save')}</Button>
        </form>

        <section className="space-y-2">
          <h3 className="text-sm font-semibold">{t('stage.position')}</h3>
          <div className="flex gap-2">
            <Button variant="outline" disabled={!left || move.isPending}
              onClick={() => left && move.mutate({ stageId: stage.id, beforeId: stages[index - 2]?.id ?? null, afterId: left.id })}>
              {t('stage.moveLeft')}
            </Button>
            <Button variant="outline" disabled={!right || move.isPending}
              onClick={() => right && move.mutate({ stageId: stage.id, beforeId: right.id, afterId: stages[index + 2]?.id ?? null })}>
              {t('stage.moveRight')}
            </Button>
          </div>
        </section>

        <section className="mt-auto space-y-3 border-t border-border pt-4">
          <h3 className="text-sm font-semibold text-destructive">{t('stage.delete')}</h3>
          {dealCount > 0 ? (
            <label className="block space-y-2 text-sm">
              <span>{t('stage.dealsToMove', { count: dealCount })}</span>
              <select value={target} onChange={(e) => setTarget(e.target.value)} aria-label={t('stage.dealsToMove', { count: dealCount })}
                className="h-9 w-full rounded-md border border-border bg-card px-2 text-sm">
                {others.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </label>
          ) : (
            <p className="text-sm text-muted-foreground">{t('stage.empty')}</p>
          )}
          <Button variant="outline" className="border-destructive text-destructive hover:bg-destructive hover:text-white"
            disabled={remove.isPending} onClick={destroy}>
            {t('stage.delete')}
          </Button>
        </section>
      </aside>
    </div>
  );
}
