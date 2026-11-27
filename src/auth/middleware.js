function createAuthMiddleware(pool, tokenService) {
  async function authenticate(req, res, next) {
    const header = req.get('authorization') || '';
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (!match) {
      return res.status(401).json({ error: 'A valid Bearer access token is required.' });
    }

    let claims;
    try {
      claims = tokenService.verifyAccessToken(accessToken);
    } catch {
      return res.status(401).json({ error: 'Invalid or expired access token.' });
    }

    try {
      const result = await pool.query(
        `SELECT u.id, u.name, u.email, u.role
         FROM users u
         WHERE u.id = $1 AND u.is_active = TRUE
           AND EXISTS (
             SELECT 1 FROM refresh_tokens rt
             WHERE rt.user_id = u.id AND rt.family_id = $2
               AND rt.revoked_at IS NULL AND rt.expires_at > NOW()
           )`,
        [claims.sub, claims.familyId]
      );
      if (!result.rowCount) {
        return res.status(401).json({ error: 'Authentication is no longer valid.' });
      }
      req.user = result.rows[0];
      return next();
    } catch (error) {
      return next(error);
    }
  }

  function requireRole(...roles) {
    return (req, res, next) => {
      if (!req.user || !roles.includes(req.user.role)) {
        return res.status(403).json({ error: 'You do not have permission to perform this action.' });
      }
      return next();
    };
  }

  return { authenticate, requireRole };
}

module.exports = { createAuthMiddleware };
