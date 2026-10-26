'use client';

import { Plus } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Input } from '@/components/ui';
import { useCreateDeal } from './queries';

export function NewDealForm({ pipelineId, stageId }: { pipelineId: string; stageId: string }) {
  const [title, setTitle] = useState('');
  const create = useCreateDeal();

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
        placeholder="Новая сделка"
        aria-label="Название новой сделки"
        className="pl-8"
        disabled={create.isPending}
      />
    </form>
  );
}
