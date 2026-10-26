import { jwtVerify, SignJWT } from 'jose';

export interface TokenClaims {
  userId: string;
  organizationId: string;
}

const ISSUER = 'crm-api';
const TTL = '12h';

export function createTokenService(secret: string) {
  const key = new TextEncoder().encode(secret);

  return {
    sign: (claims: TokenClaims) =>
      new SignJWT({ org: claims.organizationId })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(claims.userId)
        .setIssuer(ISSUER)
        .setIssuedAt()
        .setExpirationTime(TTL)
        .sign(key),

    async verify(token: string): Promise<TokenClaims> {
      const { payload } = await jwtVerify(token, key, { issuer: ISSUER, algorithms: ['HS256'] });
      if (typeof payload.sub !== 'string' || typeof payload.org !== 'string') throw new Error('malformed token');
      return { userId: payload.sub, organizationId: payload.org };
    },
  };
}

export type TokenService = ReturnType<typeof createTokenService>;
