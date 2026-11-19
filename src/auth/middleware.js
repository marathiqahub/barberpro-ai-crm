function createAuthMiddleware(pool, tokenService) {
  async function authenticate(req, res, next) {
    const header = req.get('authorization') || '';
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (!match) {
      return res.status(401).json({ error: 'A valid Bearer access token is required.' });
    }

    try {
      const claims = tokenService.verifyAccessToken(match[1]);
      const result = await pool.query(
        'SELECT id, name, email, role FROM users WHERE id = $1 AND is_active = TRUE',
        [claims.sub]
      );
      if (!result.rowCount) {
        return res.status(401).json({ error: 'Authentication is no longer valid.' });
      }
      req.user = result.rows[0];
      return next();
    } catch {
      return res.status(401).json({ error: 'Invalid or expired access token.' });
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
