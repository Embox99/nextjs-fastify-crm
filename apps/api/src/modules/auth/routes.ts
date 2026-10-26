import { LoginInput, type LoginResponse, type MeResponse } from '@crm/contracts';
import { authenticate, listUserWorkspaces } from '@crm/db';
import type { FastifyInstance } from 'fastify';

export async function authRoutes(app: FastifyInstance) {
  app.post('/auth/login', {
    config: { public: true },
  }, async (req, reply): Promise<LoginResponse | void> => {
    const input = LoginInput.parse(req.body);
    const user = await authenticate(app.db, input);
    if (!user) return reply.code(401).send({ error: 'Unauthorized', message: 'Invalid credentials' });

    return {
      token: await app.tokens.sign({ userId: user.userId, organizationId: user.organizationId }),
      user: { id: user.userId, fullName: user.fullName },
      workspaces: await listUserWorkspaces(app.db, user.userId),
    };
  });

  app.get('/me', async (req): Promise<MeResponse> => ({
    userId: req.auth.userId,
    workspaceId: req.auth.workspaceId,
    scope: req.auth.scope,
    permissions: [...req.auth.permissions].sort(),
  }));
}
