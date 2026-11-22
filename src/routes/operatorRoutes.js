const express = require('express');
const rateLimit = require('express-rate-limit');
const argon2 = require('argon2');
const crypto = require('node:crypto');

const passwordHashOptions = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 };
const activationTtlHours = 48;

function createOperatorRouter(pool) {
  const router = express.Router();
  const operatorSecret = process.env.OPERATOR_PROVISIONING_SECRET || '';

  function requireOperator(req, res, next) {
    const supplied = req.get('x-operator-secret') || '';
    const expected = Buffer.from(operatorSecret);
    const actual = Buffer.from(supplied);
    if (expected.length < 32 || actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
      return res.status(404).json({ error: 'Not found.' });
    }
    return next();
  }

  const activationLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 8,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many activation attempts. Try again later.' }
  });

  // One-time bootstrap for the initial workspace. The route is inert unless a
  // 32+ byte operator secret is configured and no administrator exists yet.
  router.post('/bootstrap', requireOperator, async (req, res, next) => {
    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN');

      const admins = await client.query("SELECT id FROM users WHERE role = 'ADMIN' LIMIT 1 FOR UPDATE");
      if (admins.rowCount) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Initial administrator is already provisioned.' });
      }

      const definitions = [
        { name: 'Vasundhara Kadam', email: 'testvasu@gmail.com', role: 'ADMIN' },
        { name: 'Kimaya Kadam', email: 'testkimaya@gmail.com', role: 'BARBER' }
      ];
      const emails = definitions.map((item) => item.email);
      const existing = await client.query('SELECT email FROM users WHERE email = ANY($1::text[])', [emails]);
      if (existing.rowCount) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'One or more bootstrap email addresses already exist. Resolve the existing accounts before retrying.' });
      }

      const placeholderPassword = crypto.randomBytes(48).toString('base64url');
      const placeholderHash = await argon2.hash(placeholderPassword, passwordHashOptions);
      const created = [];
      for (const definition of definitions) {
        const result = await client.query(
          `INSERT INTO users (name, email, password_hash, role, is_active)
           VALUES ($1, $2, $3, $4, FALSE)
           RETURNING id, name, email, role`,
          [definition.name, definition.email, placeholderHash, definition.role]
        );
        created.push(result.rows[0]);
      }

      const shopResult = await client.query(
        `INSERT INTO shops (name, slug, address, timezone)
         VALUES ('Aai Ekveera', 'aai-ekveera', 'Hiwara, Maharashtra, India', 'Asia/Kolkata')
         ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, address = EXCLUDED.address,
           timezone = EXCLUDED.timezone, updated_at = NOW()
         RETURNING id, name, slug, address, timezone`
      );
      const barber = created.find((user) => user.role === 'BARBER');
      await client.query(
        `INSERT INTO shop_staff (shop_id, user_id, display_name)
         VALUES ($1, $2, $3)
         ON CONFLICT (shop_id, user_id) DO UPDATE SET display_name = EXCLUDED.display_name, is_active = TRUE`,
        [shopResult.rows[0].id, barber.id, barber.name]
      );

      const activations = [];
      for (const user of created) {
        await client.query('DELETE FROM account_activation_tokens WHERE user_id = $1', [user.id]);
        const token = crypto.randomBytes(32).toString('base64url');
        const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
        const expiresAt = new Date(Date.now() + activationTtlHours * 60 * 60 * 1000);
        await client.query(
          'INSERT INTO account_activation_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
          [user.id, tokenHash, expiresAt]
        );
        activations.push({ name: user.name, email: user.email, role: user.role, token, expiresAt: expiresAt.toISOString() });
      }

      await client.query('COMMIT');
      return res.status(201).json({
        message: 'Initial accounts and shop provisioned. Activation tokens are shown once; share each only with its intended user.',
        activationEndpoint: '/api/operator/activate',
        activationTokens: activations,
        shop: shopResult.rows[0],
        barberLinked: { name: barber.name, shop: shopResult.rows[0].name }
      });
    } catch (error) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      if (error.code === '23505') return res.status(409).json({ error: 'A conflicting account or shop record already exists.' });
      return next(error);
    } finally {
      if (client) client.release();
    }
  });

  router.post('/activate', activationLimiter, async (req, res, next) => {
    const { token, password } = req.body ?? {};
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{40,100}$/.test(token) ||
        typeof password !== 'string' || password.length < 12 || password.length > 128) {
      return res.status(400).json({ error: 'A valid activation token and a 12–128 character password are required.' });
    }

    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      const found = await client.query(
        `SELECT at.id, at.user_id, u.name, u.email, u.role
         FROM account_activation_tokens at
         JOIN users u ON u.id = at.user_id
         WHERE at.token_hash = $1 AND at.consumed_at IS NULL AND at.expires_at > NOW()
           AND u.is_active = FALSE
         FOR UPDATE OF at, u`,
        [tokenHash]
      );
      if (!found.rowCount) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Activation token is invalid, expired, or already used.' });
      }

      const passwordHash = await argon2.hash(password, passwordHashOptions);
      const user = found.rows[0];
      await client.query('UPDATE users SET password_hash = $2, is_active = TRUE, updated_at = NOW() WHERE id = $1', [user.user_id, passwordHash]);
      await client.query('UPDATE account_activation_tokens SET consumed_at = NOW() WHERE id = $1', [found.rows[0].id]);
      await client.query('COMMIT');
      return res.status(200).json({
        message: 'Account activated. You can now sign in.',
        user: { name: user.name, email: user.email, role: user.role }
      });
    } catch (error) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      return next(error);
    } finally {
      if (client) client.release();
    }
  });

  return router;
}

module.exports = { createOperatorRouter };
