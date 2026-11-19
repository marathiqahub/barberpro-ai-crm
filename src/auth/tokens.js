const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');

function createTokenService(config) {
  function issueTokenPair(user, familyId = crypto.randomUUID()) {
    const accessToken = jwt.sign(
      { role: user.role, tokenUse: 'access' },
      config.accessSecret,
      {
        algorithm: 'HS256',
        subject: String(user.id),
        issuer: config.issuer,
        audience: config.audience,
        expiresIn: config.accessTtlSeconds
      }
    );

    const refreshId = crypto.randomUUID();
    const refreshToken = jwt.sign(
      { tokenUse: 'refresh', familyId },
      config.refreshSecret,
      {
        algorithm: 'HS256',
        subject: String(user.id),
        jwtid: refreshId,
        issuer: config.issuer,
        audience: config.audience,
        expiresIn: config.refreshTtlSeconds
      }
    );
    const refreshClaims = jwt.decode(refreshToken);

    return {
      accessToken,
      refreshToken,
      refreshId,
      familyId,
      refreshTokenHash: crypto.createHash('sha256').update(refreshToken).digest('hex'),
      refreshExpiresAt: new Date(refreshClaims.exp * 1000)
    };
  }

  function verifyAccessToken(token) {
    const claims = jwt.verify(token, config.accessSecret, {
      algorithms: ['HS256'],
      issuer: config.issuer,
      audience: config.audience
    });
    if (claims.tokenUse !== 'access') throw new Error('Wrong token type.');
    return claims;
  }

  function verifyRefreshToken(token, ignoreExpiration = false) {
    const claims = jwt.verify(token, config.refreshSecret, {
      algorithms: ['HS256'],
      issuer: config.issuer,
      audience: config.audience,
      ignoreExpiration
    });
    if (claims.tokenUse !== 'refresh' || !claims.jti || !claims.familyId) {
      throw new Error('Invalid refresh token.');
    }
    return claims;
  }

  function hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  return { issueTokenPair, verifyAccessToken, verifyRefreshToken, hashToken };
}

module.exports = { createTokenService };
