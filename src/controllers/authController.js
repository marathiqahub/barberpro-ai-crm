const argon2 = require('argon2');
const { createTokenService } = require('../auth/tokens');
const crypto = require('node:crypto');
const { generateSecret, encryptSecret, decryptSecret, verifyTotp, otpauthUri } = require('../advanced/totp');

const passwordHashOptions = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 };
const dummyPasswordHashPromise = argon2.hash('not-a-real-user-password-for-timing-equalization', passwordHashOptions);

function createAuthController(pool, authConfig) {
  const tokens = createTokenService(authConfig);

  function tokenResponse(pair) {
    return {
      accessToken: pair.accessToken,
      refreshToken: pair.refreshToken,
      tokenType: 'Bearer',
      expiresIn: authConfig.accessTtlSeconds,
      refreshExpiresAt: pair.refreshExpiresAt.toISOString()
    };
  }

  async function saveRefreshToken(client, userId, pair) {
    await client.query(
      `INSERT INTO refresh_tokens (id, user_id, family_id, token_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [pair.refreshId, userId, pair.familyId, pair.refreshTokenHash, pair.refreshExpiresAt]
    );
  }

  async function register(req, res, next) {
    const { name, email, password, phone = null } = req.body ?? {};
    const normalizedName = typeof name === 'string' ? name.trim() : '';
    const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
    const errors = {};

    if (!normalizedName || normalizedName.length > 120) {
      errors.name = 'Name is required and must be at most 120 characters.';
    }
    if (normalizedEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      errors.email = 'A valid email address is required.';
    }
    if (phone !== null && phone !== '' && (typeof phone !== 'string' || phone.length > 30 || !/^[+\\d().\\-\\s]{7,30}$/.test(phone.trim()))) errors.phone = 'Provide a valid phone number.';\n    if (typeof password !== 'string' || password.length < 12 || password.length > 128) {
      errors.password = 'Password must be between 12 and 128 characters.';
    }
    if (Object.keys(errors).length) {
      return res.status(400).json({ error: 'Validation failed.', details: errors });
    }

    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      const passwordHash = await argon2.hash(password, {
        type: argon2.argon2id,
        memoryCost: 19456,
        timeCost: 2,
        parallelism: 1
      });
      const pending = await client.query(
        `SELECT id FROM users WHERE email=$1 AND role='CUSTOMER' AND imported_pending_activation=TRUE FOR UPDATE`,
        [normalizedEmail]
      );
      const inserted = pending.rowCount
        ? await client.query(
            `UPDATE users SET name=$2,phone=COALESCE(NULLIF($3,''),phone),password_hash=$4,
               imported_pending_activation=FALSE,is_active=TRUE,updated_at=NOW()
             WHERE id=$1 RETURNING id,name,email,role`,
            [pending.rows[0].id,normalizedName,phone||'',passwordHash]
          )
        : await client.query(
            `INSERT INTO users (name,email,phone,password_hash,role)
             VALUES ($1,$2,NULLIF($3,''),$4,'CUSTOMER')
             RETURNING id,name,email,role`,
            [normalizedName,normalizedEmail,phone||'',passwordHash]
          );
      const user = inserted.rows[0];
      const pair = tokens.issueTokenPair(user);
      await saveRefreshToken(client, user.id, pair);
      await client.query('COMMIT');
      return res.status(201).json({ user, tokens: tokenResponse(pair) });
    } catch (error) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      if (error.code === '23505') {
        return res.status(409).json({ error: 'An account with this email already exists.' });
      }
      return next(error);
    } finally {
      if (client) client.release();
    }
  }

  async function login(req, res, next) {
    const { email, password } = req.body ?? {};
    const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
    if (!normalizedEmail || normalizedEmail.length > 254 || typeof password !== 'string' || password.length > 128) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    try {
      const found = await pool.query(
        `SELECT u.id,u.name,u.email,u.role,u.password_hash,u.is_active,COALESCE(t.enabled,FALSE) totp_enabled,t.secret_encrypted
         FROM users u LEFT JOIN user_totp t ON t.user_id=u.id WHERE u.email=$1`,
        [normalizedEmail]
      );
      const user = found.rows[0];
      const hashToVerify = user ? user.password_hash : await dummyPasswordHashPromise;
      const passwordMatches = await argon2.verify(hashToVerify, password);
      if (!user || !user.is_active || !passwordMatches) {
        return res.status(401).json({ error: 'Invalid email or password.' });
      }
      if (['ADMIN','BARBER'].includes(user.role) && process.env.TOTP_REQUIRED_FOR_PRIVILEGED==='true' && !user.totp_enabled) {
        const secret=generateSecret(),enrollmentToken=crypto.randomBytes(32).toString('base64url');
        await pool.query(`INSERT INTO user_totp(user_id,pending_secret_encrypted,enrollment_token_hash,enrollment_expires_at,updated_at)
          VALUES($1,$2,$3,NOW()+INTERVAL '10 minutes',NOW())
          ON CONFLICT(user_id) DO UPDATE SET pending_secret_encrypted=EXCLUDED.pending_secret_encrypted,
            enrollment_token_hash=EXCLUDED.enrollment_token_hash,enrollment_expires_at=EXCLUDED.enrollment_expires_at,updated_at=NOW()`,
          [user.id,encryptSecret(secret),crypto.createHash('sha256').update(enrollmentToken).digest('hex')]);
        return res.status(403).json({error:'Authenticator setup is required before sign-in.',mfaSetupRequired:true,
          enrollmentToken,secret,otpauthUri:otpauthUri(secret,user.email)});
      }
      if (['ADMIN','BARBER'].includes(user.role) && user.totp_enabled) {
        if (!req.body?.totpCode || !verifyTotp(decryptSecret(user.secret_encrypted),req.body.totpCode))
          return res.status(401).json({error:'A valid authenticator code is required.',mfaRequired:true});
      }

      const pair = tokens.issueTokenPair(user);
      await pool.query(
        `INSERT INTO refresh_tokens (id, user_id, family_id, token_hash, expires_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [pair.refreshId, user.id, pair.familyId, pair.refreshTokenHash, pair.refreshExpiresAt]
      );
      return res.status(200).json({
        user: { id: user.id, name: user.name, email: user.email, role: user.role },
        tokens: tokenResponse(pair)
      });
    } catch (error) {
      return next(error);
    }
  }

  async function refresh(req, res, next) {
    const { refreshToken } = req.body ?? {};
    if (typeof refreshToken !== 'string' || !refreshToken) {
      return res.status(400).json({ error: 'refreshToken is required.' });
    }

    let claims;
    try {
      claims = tokens.verifyRefreshToken(refreshToken);
    } catch {
      return res.status(401).json({ error: 'Invalid or expired refresh token.' });
    }

    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      const found = await client.query(
        `SELECT rt.id, rt.user_id, rt.family_id, rt.token_hash, rt.expires_at,
                rt.revoked_at, u.name, u.email, u.role, u.is_active
         FROM refresh_tokens rt
         JOIN users u ON u.id = rt.user_id
         WHERE rt.id = $1 AND rt.user_id = $2
         FOR UPDATE OF rt`,
        [claims.jti, claims.sub]
      );
      const current = found.rows[0];
      if (!current || current.family_id !== claims.familyId || current.token_hash !== tokens.hashToken(refreshToken)) {
        await client.query('ROLLBACK');
        return res.status(401).json({ error: 'Invalid or expired refresh token.' });
      }
      if (current.revoked_at) {
        await client.query(
          'UPDATE refresh_tokens SET revoked_at = COALESCE(revoked_at, NOW()) WHERE family_id = $1',
          [current.family_id]
        );
        await client.query('COMMIT');
        return res.status(401).json({ error: 'Refresh token reuse detected; this session has been revoked.' });
      }
      if (new Date(current.expires_at) <= new Date() || !current.is_active) {
        await client.query(
          'UPDATE refresh_tokens SET revoked_at = COALESCE(revoked_at, NOW()) WHERE family_id = $1',
          [current.family_id]
        );
        await client.query('COMMIT');
        return res.status(401).json({ error: 'Refresh token is no longer valid.' });
      }

      const user = { id: current.user_id, name: current.name, email: current.email, role: current.role };
      const pair = tokens.issueTokenPair(user, current.family_id);
      await saveRefreshToken(client, user.id, pair);
      await client.query(
        'UPDATE refresh_tokens SET revoked_at = NOW(), replaced_by = $2 WHERE id = $1',
        [current.id, pair.refreshId]
      );
      await client.query('COMMIT');
      return res.status(200).json({ user, tokens: tokenResponse(pair) });
    } catch (error) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      return next(error);
    } finally {
      if (client) client.release();
    }
  }

  async function logout(req, res, next) {
    const { refreshToken } = req.body ?? {};
    if (typeof refreshToken !== 'string' || !refreshToken) {
      return res.status(204).end();
    }

    let claims;
    try {
      claims = tokens.verifyRefreshToken(refreshToken, true);
    } catch {
      return res.status(204).end();
    }
    try {
      await pool.query(
        `UPDATE refresh_tokens
         SET revoked_at = COALESCE(revoked_at, NOW())
         WHERE family_id = $1 AND user_id = $2`,
        [claims.familyId, claims.sub]
      );
      return res.status(204).end();
    } catch (error) {
      return next(error);
    }
  }

  async function me(req, res, next) {
    try {
      const result = await pool.query(
        `SELECT id, name, email, role, created_at
         FROM users WHERE id = $1 AND is_active = TRUE`,
        [req.user.id]
      );
      if (!result.rowCount) return res.status(404).json({ error: 'User not found.' });
      return res.status(200).json({ user: result.rows[0] });
    } catch (error) {
      return next(error);
    }
  }

  return { register, login, refresh, logout, me, tokens };
}

module.exports = { createAuthController };
