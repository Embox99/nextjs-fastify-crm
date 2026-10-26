import { z } from 'zod';

export const LoginInput = z.object({
  organization: z.string().trim().min(1),
  email: z.email().trim().toLowerCase(),
  password: z.string().min(1),
});
export type LoginInput = z.infer<typeof LoginInput>;

export const WorkspaceDto = z.object({ id: z.uuid(), name: z.string() });
export type WorkspaceDto = z.infer<typeof WorkspaceDto>;

export const LoginResponse = z.object({
  token: z.string(),
  user: z.object({ id: z.uuid(), fullName: z.string() }),
  workspaces: z.array(WorkspaceDto),
});
export type LoginResponse = z.infer<typeof LoginResponse>;

export const MeResponse = z.object({
  userId: z.uuid(),
  workspaceId: z.uuid(),
  scope: z.enum(['all', 'team', 'own']),
  permissions: z.array(z.string()),
});
export type MeResponse = z.infer<typeof MeResponse>;
