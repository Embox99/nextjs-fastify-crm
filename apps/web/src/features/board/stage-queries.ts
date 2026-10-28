import type { BoardDto, CreateStageInput, StageDto, UpdateStageInput } from '@crm/contracts';
import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useI18n } from '@/i18n/i18n-provider';
import { ApiError, apiFetch } from '@/lib/api';
import { boardKeys } from './queries';

/** Колонка (новая или изменённая) — в доски этой воронки, с сохранением порядка по rank */
export function upsertStageInCache(qc: QueryClient, stage: StageDto) {
  qc.setQueriesData<BoardDto>({ queryKey: boardKeys.all }, (b) => {
    if (!b || b.pipeline.id !== stage.pipelineId) return b;
    const stages = [...b.stages.filter((s) => s.id !== stage.id), stage].sort((x, y) => (x.rank < y.rank ? -1 : x.rank > y.rank ? 1 : 0));
    return { ...b, stages };
  });
}

/** Ошибка API в понятный текст: 409 со списком автоматизаций или числом сделок */
function describeStageError(err: unknown, t: ReturnType<typeof useI18n>['t']): string {
  if (!(err instanceof ApiError)) return t('common.saveFailed');
  const automations = err.body.automations as string[] | undefined;
  if (automations?.length) return t('stage.usedByAutomations', { names: automations.join(', ') });
  if (typeof err.body.dealCount === 'number') return t('stage.hasDeals', { count: err.body.dealCount });
  if (err.status === 422 && /last open/.test(err.message)) return t('stage.lastOpen');
  return err.status === 403 ? t('common.forbidden') : err.message;
}

export function useStageMutations(pipelineId: string) {
  const qc = useQueryClient();
  const { t } = useI18n();
  const onError = (err: unknown) => toast.error(describeStageError(err, t));

  return {
    create: useMutation({
      mutationFn: (input: CreateStageInput) =>
        apiFetch<StageDto>(`/pipelines/${pipelineId}/stages`, { method: 'POST', body: input }),
      onSuccess: (stage) => upsertStageInCache(qc, stage),
      onError,
    }),
    update: useMutation({
      mutationFn: ({ stageId, ...input }: UpdateStageInput & { stageId: string }) =>
        apiFetch<StageDto>(`/stages/${stageId}`, { method: 'PATCH', body: input }),
      onSuccess: (stage) => upsertStageInCache(qc, stage),
      onError,
    }),
    move: useMutation({
      mutationFn: ({ stageId, beforeId, afterId }: { stageId: string; beforeId: string | null; afterId: string | null }) =>
        apiFetch<StageDto>(`/stages/${stageId}/move`, { method: 'POST', body: { beforeId, afterId } }),
      onSuccess: (stage) => upsertStageInCache(qc, stage),
      onError,
    }),
    remove: useMutation({
      mutationFn: ({ stageId, moveDealsTo }: { stageId: string; moveDealsTo?: string }) =>
        apiFetch<void>(`/stages/${stageId}${moveDealsTo ? `?moveDealsTo=${moveDealsTo}` : ''}`, { method: 'DELETE' }),
      onSuccess: () => qc.invalidateQueries({ queryKey: boardKeys.board(pipelineId) }),
      onError,
    }),
  };
}
