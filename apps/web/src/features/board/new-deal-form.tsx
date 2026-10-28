'use client';

import { Plus } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Input } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-provider';
import { useCreateDeal } from './queries';

export function NewDealForm({ pipelineId, stageId }: { pipelineId: string; stageId: string }) {
  const [title, setTitle] = useState('');
  const create = useCreateDeal();
  const { t } = useI18n();

  function submit(e: FormEvent) {
    e.preventDefault();
    const value = title.trim();
    if (!value) return;
    create.mutate({ pipelineId, stageId, title: value, value: '0' }, { onSuccess: () => setTitle('') });
  }

  return (
    <form onSubmit={submit} className="relative px-2 pb-2">
      <Plus className="pointer-events-none absolute left-4.5 top-2.5 size-4 text-muted-foreground" aria-hidden />
      <Input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder={t('board.newDeal')}
        aria-label={t('board.newDealAria')}
        className="pl-8"
        disabled={create.isPending}
      />
    </form>
  );
}
