const test = require('node:test');
const assert = require('node:assert/strict');
const { createTokenService } = require('../src/auth/tokens');

const tokenService = createTokenService({
  accessSecret: 'test-access-secret-which-is-at-least-32-bytes',
  refreshSecret: 'test-refresh-secret-which-is-different-and-long',
  issuer: 'barberpro-tests',
  audience: 'barberpro-api-tests',
  accessTtlSeconds: 900,
  refreshTtlSeconds: 604800
});

test('issues distinct access and refresh JWTs with the expected claims', () => {
  const pair = tokenService.issueTokenPair({ id: 42, role: 'CUSTOMER' });
  const access = tokenService.verifyAccessToken(pair.accessToken);
  const refresh = tokenService.verifyRefreshToken(pair.refreshToken);

  assert.equal(access.sub, '42');
  assert.equal(access.role, 'CUSTOMER');
  assert.equal(access.tokenUse, 'access');
  assert.equal(access.familyId, pair.familyId);
  assert.equal(refresh.sub, '42');
  assert.equal(refresh.tokenUse, 'refresh');
  assert.equal(refresh.jti, pair.refreshId);
  assert.equal(refresh.familyId, pair.familyId);
  assert.notEqual(pair.accessToken, pair.refreshToken);
});

test('rejects using a refresh token as an access token and vice versa', () => {
  const pair = tokenService.issueTokenPair({ id: 7, role: 'BARBER' });
  assert.throws(() => tokenService.verifyAccessToken(pair.refreshToken));
  assert.throws(() => tokenService.verifyRefreshToken(pair.accessToken));
});

test('detects token tampering and stores a one-way refresh-token digest', () => {
  const pair = tokenService.issueTokenPair({ id: 8, role: 'ADMIN' });
  const tampered = pair.refreshToken.slice(0, -1) + (pair.refreshToken.endsWith('a') ? 'b' : 'a');

  assert.throws(() => tokenService.verifyRefreshToken(tampered));
  assert.match(pair.refreshTokenHash, /^[a-f0-9]{64}$/);
  assert.notEqual(pair.refreshTokenHash, pair.refreshToken);
  assert.equal(tokenService.hashToken(pair.refreshToken), pair.refreshTokenHash);
});
