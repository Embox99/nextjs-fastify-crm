import type { BoardDto, CreateDealInput, DealDto, MeResponse, MoveDealInput, PipelineDto, UpdateDealInput } from '@crm/contracts';
import { applyDealUpsert, applyMove } from '@crm/domain';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ApiError, apiFetch } from '@/lib/api';
import { useI18n } from '@/i18n/i18n-provider';
import { newMutationId } from '@/lib/utils';

export const boardKeys = {
  all: ['board'] as const,
  board: (pipelineId: string) => ['board', pipelineId] as const,
};

/**
 * clientMutationId собственных мутаций в полёте. WS-эхо своей мутации игнорируется:
 * актуальное состояние придёт в HTTP-ответе, а эхо могло бы откатить более позднее оптимистичное изменение.
 */
export const pendingMutations = new Set<string>();

export const usePipelines = () =>
  useQuery({ queryKey: ['pipelines'], queryFn: () => apiFetch<PipelineDto[]>('/pipelines') });

export const useMe = () => useQuery({ queryKey: ['me'], queryFn: () => apiFetch<MeResponse>('/me') });

export const useBoard = (pipelineId: string | undefined) =>
  useQuery({
    queryKey: boardKeys.board(pipelineId ?? ''),
    queryFn: () => apiFetch<BoardDto>(`/pipelines/${pipelineId}/board`),
    enabled: Boolean(pipelineId),
  });

/** Применить актуальную версию сделки ко всем загруженным доскам */
export function upsertDealInCache(qc: QueryClient, deal: DealDto) {
  qc.setQueriesData<BoardDto>({ queryKey: boardKeys.all }, (b) => (b ? applyDealUpsert(b, deal) : b));
}

type MoveVars = Omit<MoveDealInput, 'clientMutationId'> & { dealId: string };

/**
 * Перемещение карточки. Оптимистичное изменение применяется синхронно в момент drop —
 * до того как TanStack Query асинхронно вызовет onMutate, иначе карточка «мигнёт» на старом месте.
 */
export function useMoveDeal(pipelineId: string) {
  const qc = useQueryClient();
  const { t } = useI18n();
  const key = boardKeys.board(pipelineId);

  const mutation = useMutation({
    mutationFn: ({ dealId, ...input }: MoveVars & { clientMutationId: string; snapshot?: BoardDto }) =>
      apiFetch<DealDto>(`/deals/${dealId}/move`, {
        method: 'POST',
        body: { toStageId: input.toStageId, beforeId: input.beforeId, afterId: input.afterId, clientMutationId: input.clientMutationId },
      }),
    onSuccess: (deal) => upsertDealInCache(qc, deal),
    onError: (err, vars) => {
      if (vars.snapshot) qc.setQueryData(key, vars.snapshot);
      toast.error(t(err instanceof ApiError && err.status === 409 ? 'board.moveConflict' : 'board.moveFailed'));
      void qc.invalidateQueries({ queryKey: key });
    },
    onSettled: (_d, _e, vars) => pendingMutations.delete(vars.clientMutationId),
  });

  return (vars: MoveVars) => {
    const snapshot = qc.getQueryData<BoardDto>(key);
    const clientMutationId = newMutationId();
    pendingMutations.add(clientMutationId);
    if (snapshot) qc.setQueryData(key, applyMove(snapshot, vars.dealId, vars));
    void qc.cancelQueries({ queryKey: key });
    mutation.mutate({ ...vars, clientMutationId, snapshot });
  };
}

export function useCreateDeal() {
  const qc = useQueryClient();
  const { t } = useI18n();
  return useMutation({
    mutationFn: (input: Omit<CreateDealInput, 'clientMutationId'>) => {
      const clientMutationId = newMutationId();
      pendingMutations.add(clientMutationId);
      return apiFetch<DealDto>('/deals', { method: 'POST', body: { ...input, clientMutationId } })
        .finally(() => pendingMutations.delete(clientMutationId));
    },
    onSuccess: (deal) => upsertDealInCache(qc, deal),
    onError: () => toast.error(t('board.createFailed')),
  });
}

export function useUpdateDeal() {
  const qc = useQueryClient();
  const { t } = useI18n();
  return useMutation({
    mutationFn: ({ dealId, ...input }: Omit<UpdateDealInput, 'clientMutationId'> & { dealId: string }) => {
      const clientMutationId = newMutationId();
      pendingMutations.add(clientMutationId);
      return apiFetch<DealDto>(`/deals/${dealId}`, { method: 'PATCH', body: { ...input, clientMutationId } })
        .finally(() => pendingMutations.delete(clientMutationId));
    },
    onSuccess: (deal) => upsertDealInCache(qc, deal),
    onError: (err) => {
      if (err instanceof ApiError && err.status === 409) {
        const current = err.body.current as DealDto | undefined;
        if (current) upsertDealInCache(qc, current);
        toast.warning(t('board.updateConflict'));
      } else {
        toast.error(t(err instanceof ApiError && err.status === 403 ? 'common.forbidden' : 'common.saveFailed'));
      }
    },
  });
}
