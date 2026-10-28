import type { AssignmentPoolDto, AutomationDto, AutomationInput, NotificationDto, TaskDto } from '@crm/contracts';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useI18n } from '@/i18n/i18n-provider';
import { ApiError, apiFetch } from '@/lib/api';

export const automationKeys = {
  list: ['automations'] as const,
  pools: ['assignment-pools'] as const,
  notifications: ['notifications'] as const,
  tasks: (dealId: string) => ['tasks', dealId] as const,
};

export const useAutomations = () =>
  useQuery({ queryKey: automationKeys.list, queryFn: () => apiFetch<AutomationDto[]>('/automations') });

export const usePools = () =>
  useQuery({ queryKey: automationKeys.pools, queryFn: () => apiFetch<AssignmentPoolDto[]>('/assignment-pools') });

export function useSaveAutomation() {
  const qc = useQueryClient();
  const { t } = useI18n();
  return useMutation({
    mutationFn: ({ id, input }: { id?: string; input: AutomationInput }) =>
      apiFetch<AutomationDto>(id ? `/automations/${id}` : '/automations', { method: id ? 'PATCH' : 'POST', body: input }),
    onSuccess: () => {
      toast.success(t('automations.saved'));
      void qc.invalidateQueries({ queryKey: automationKeys.list });
    },
    onError: (err) => toast.error(err instanceof ApiError ? t('automations.saveFailed', { reason: err.message }) : t('common.saveFailed')),
  });
}

export function useToggleAutomation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      apiFetch<AutomationDto>(`/automations/${id}`, { method: 'PATCH', body: { enabled } }),
    onMutate: ({ id, enabled }) => {
      qc.setQueryData<AutomationDto[]>(automationKeys.list, (list) => list?.map((a) => (a.id === id ? { ...a, enabled } : a)));
    },
    onSettled: () => qc.invalidateQueries({ queryKey: automationKeys.list }),
  });
}

export function useDeleteAutomation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/automations/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: automationKeys.list }),
  });
}

/* ───────────── Уведомления ───────────── */

interface NotificationsPage {
  items: NotificationDto[];
  unread: number;
}

export const useNotifications = () =>
  useQuery({ queryKey: automationKeys.notifications, queryFn: () => apiFetch<NotificationsPage>('/notifications') });

export function prependNotification(qc: QueryClient, notification: NotificationDto) {
  qc.setQueryData<NotificationsPage>(automationKeys.notifications, (page) => page && {
    items: [notification, ...page.items.filter((n) => n.id !== notification.id)].slice(0, 50),
    unread: page.unread + 1,
  });
}

export function useMarkAllRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<void>('/notifications/read-all', { method: 'POST', body: {} }),
    onMutate: () => {
      const now = new Date().toISOString();
      qc.setQueryData<NotificationsPage>(automationKeys.notifications, (page) => page && {
        items: page.items.map((n) => ({ ...n, readAt: n.readAt ?? now })), unread: 0,
      });
    },
  });
}

/* ───────────── Задачи сделки ───────────── */

export const useDealTasks = (dealId: string) =>
  useQuery({ queryKey: automationKeys.tasks(dealId), queryFn: () => apiFetch<TaskDto[]>(`/deals/${dealId}/tasks`) });

export function useCompleteTask(dealId: string) {
  const qc = useQueryClient();
  const { t } = useI18n();
  return useMutation({
    mutationFn: (taskId: string) => apiFetch<void>(`/tasks/${taskId}/complete`, { method: 'POST', body: {} }),
    onMutate: (taskId) => {
      qc.setQueryData<TaskDto[]>(automationKeys.tasks(dealId), (list) =>
        list?.map((t) => (t.id === taskId ? { ...t, completedAt: new Date().toISOString() } : t)));
    },
    onError: () => {
      toast.error(t('deal.taskFailed'));
      void qc.invalidateQueries({ queryKey: automationKeys.tasks(dealId) });
    },
  });
}
