import { describe, expect, it } from 'vitest';
import { agent, app, createUser, signedInAgent } from './helpers.js';
import request from 'supertest';
import { prisma } from '../src/lib/prisma.js';

const CREDENTIALS = { email: 'sam@example.com', password: 'correct-horse-battery' };

function refreshCookie(res: request.Response): string | undefined {
  const cookies = res.headers['set-cookie'] as unknown as string[] | undefined;
  return cookies?.find((c) => c.startsWith('refresh_token='));
}

describe('POST /api/auth/register', () => {
  it('creates an account and returns an access token', async () => {
    const res = await request(app).post('/api/auth/register').send(CREDENTIALS).expect(201);

    expect(res.body.user.email).toBe('sam@example.com');
    expect(res.body.user.role).toBe('CUSTOMER');
    expect(res.body.accessToken).toEqual(expect.any(String));
    // The password hash must never be serialised to the client.
    expect(JSON.stringify(res.body)).not.toContain('passwordHash');
  });

  it('puts the refresh token in an httpOnly cookie, not the body', async () => {
    const res = await request(app).post('/api/auth/register').send(CREDENTIALS).expect(201);

    const cookie = refreshCookie(res);
    expect(cookie).toBeDefined();
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(res.body.refreshToken).toBeUndefined();
  });

  it('normalises the email to lower case', async () => {
    await request(app)
      .post('/api/auth/register')
      .send({ ...CREDENTIALS, email: 'SAM@Example.COM' })
      .expect(201);

    expect(await prisma.user.findUnique({ where: { email: 'sam@example.com' } })).not.toBeNull();
  });

  it('rejects a duplicate email', async () => {
    await request(app).post('/api/auth/register').send(CREDENTIALS).expect(201);
    const res = await request(app).post('/api/auth/register').send(CREDENTIALS).expect(409);

    expect(res.body.error.code).toBe('EMAIL_TAKEN');
  });

  it('rejects a password shorter than 10 characters', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'short@example.com', password: 'abc123' })
      .expect(422);

    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('POST /api/auth/login', () => {
  it('signs in with correct credentials', async () => {
    await createUser(CREDENTIALS);
    const res = await request(app).post('/api/auth/login').send(CREDENTIALS).expect(200);
    expect(res.body.accessToken).toEqual(expect.any(String));
  });

  it('gives the same error for a wrong password and an unknown account', async () => {
    await createUser(CREDENTIALS);

    const wrongPassword = await request(app)
      .post('/api/auth/login')
      .send({ ...CREDENTIALS, password: 'not-the-password' })
      .expect(401);

    const unknownUser = await request(app)
      .post('/api/auth/login')
      .send({ email: 'nobody@example.com', password: 'not-the-password' })
      .expect(401);

    // Identical responses, so login cannot be used to enumerate accounts.
    expect(wrongPassword.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(unknownUser.body.error).toEqual(wrongPassword.body.error);
  });
});

describe('POST /api/auth/refresh', () => {
  it('rotates the refresh token and issues a new access token', async () => {
    const client = agent();
    await client.post('/api/auth/register').send(CREDENTIALS).expect(201);

    const first = await client.post('/api/auth/refresh').expect(200);
    expect(first.body.accessToken).toEqual(expect.any(String));

    // Rotation means the stored token changed, and the old one is revoked.
    const tokens = await prisma.refreshToken.findMany({ orderBy: { createdAt: 'asc' } });
    expect(tokens).toHaveLength(2);
    expect(tokens[0]!.revokedAt).not.toBeNull();
    expect(tokens[1]!.revokedAt).toBeNull();
  });

  it('revokes every session when a rotated token is replayed', async () => {
    const client = agent();
    const registered = await client.post('/api/auth/register').send(CREDENTIALS).expect(201);
    const stolen = refreshCookie(registered)!.split(';')[0]!;

    // Legitimate rotation invalidates the original token.
    await client.post('/api/auth/refresh').expect(200);

    // An attacker replays the token they captured earlier.
    const replay = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', stolen)
      .expect(401);

    expect(replay.body.error.code).toBe('REFRESH_TOKEN_REUSED');

    // The whole family is now dead, including the honest client's token.
    const live = await prisma.refreshToken.count({ where: { revokedAt: null } });
    expect(live).toBe(0);
    await client.post('/api/auth/refresh').expect(401);
  });

  it('rejects a request with no refresh cookie', async () => {
    const res = await request(app).post('/api/auth/refresh').expect(401);
    expect(res.body.error.code).toBe('REFRESH_TOKEN_MISSING');
  });
});

describe('GET /api/auth/me', () => {
  it('returns the signed-in user', async () => {
    const { accessToken } = await signedInAgent(CREDENTIALS);
    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    expect(res.body.user.email).toBe(CREDENTIALS.email);
  });

  it('rejects a missing or malformed token', async () => {
    await request(app).get('/api/auth/me').expect(401);
    await request(app).get('/api/auth/me').set('Authorization', 'Bearer nonsense').expect(401);
  });
});

describe('password reset', () => {
  it('resets the password and revokes existing sessions', async () => {
    const client = agent();
    await client.post('/api/auth/register').send(CREDENTIALS).expect(201);

    const forgot = await request(app)
      .post('/api/auth/forgot-password')
      .send({ email: CREDENTIALS.email })
      .expect(200);

    // Email delivery is deferred, so the token is surfaced outside production.
    const token = forgot.body.devToken as string;
    expect(token).toEqual(expect.any(String));

    await request(app)
      .post('/api/auth/reset-password')
      .send({ token, password: 'a-brand-new-password' })
      .expect(200);

    await request(app)
      .post('/api/auth/login')
      .send({ ...CREDENTIALS, password: 'a-brand-new-password' })
      .expect(200);

    await request(app).post('/api/auth/login').send(CREDENTIALS).expect(401);

    // Changing the password signs out everywhere.
    await client.post('/api/auth/refresh').expect(401);
  });

  it('does not reveal whether an address is registered', async () => {
    const res = await request(app)
      .post('/api/auth/forgot-password')
      .send({ email: 'nobody@example.com' })
      .expect(200);

    expect(res.body.message).toMatch(/if an account exists/i);
    expect(res.body.devToken).toBeUndefined();
  });

  it('refuses to reuse a spent reset token', async () => {
    await createUser(CREDENTIALS);
    const forgot = await request(app)
      .post('/api/auth/forgot-password')
      .send({ email: CREDENTIALS.email })
      .expect(200);

    const token = forgot.body.devToken as string;
    await request(app)
      .post('/api/auth/reset-password')
      .send({ token, password: 'first-new-password' })
      .expect(200);

    const second = await request(app)
      .post('/api/auth/reset-password')
      .send({ token, password: 'second-new-password' })
      .expect(401);

    expect(second.body.error.code).toBe('RESET_TOKEN_INVALID');
  });
});

describe('POST /api/auth/logout', () => {
  it('revokes the refresh token', async () => {
    const client = agent();
    await client.post('/api/auth/register').send(CREDENTIALS).expect(201);

    await client.post('/api/auth/logout').expect(204);
    await client.post('/api/auth/refresh').expect(401);
  });
});
