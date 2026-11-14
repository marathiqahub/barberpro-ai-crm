const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const port = Number(process.env.PORT) || 3000;

app.disable('x-powered-by');
app.use(helmet());
app.use(express.json({ limit: '10kb' }));

app.post(
  '/api/customers',
  rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false }),
  async (req, res, next) => {
    const { name, email, phone } = req.body ?? {};
    const errors = {};

    if (typeof name !== 'string' || name.trim().length < 1 || name.trim().length > 120) {
      errors.name = 'Name is required and must be at most 120 characters.';
    }

    const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
    if (normalizedEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      errors.email = 'A valid email address is required.';
    }

    let normalizedPhone = null;
    if (phone !== undefined && phone !== null && phone !== '') {
      if (typeof phone !== 'string' || phone.trim().length > 30 || !/^[+\d().\-\s]{7,30}$/.test(phone.trim())) {
        errors.phone = 'Phone must contain 7–30 digits or common phone number characters.';
      } else {
        normalizedPhone = phone.trim();
      }
    }

    if (Object.keys(errors).length) {
      return res.status(400).json({ error: 'Validation failed.', details: errors });
    }

    try {
      const result = await pool.query(
        `INSERT INTO customers (name, email, phone)
         VALUES ($1, $2, $3)
         RETURNING id, name, email, phone, created_at`,
        [name.trim(), normalizedEmail, normalizedPhone]
      );
      return res.status(201).json({ customer: result.rows[0] });
    } catch (error) {
      if (error.code === '23505') {
        return res.status(409).json({ error: 'A customer with this email already exists.' });
      }
      return next(error);
    }
  }
);

app.use((error, req, res, next) => {
  if (error.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Request body must be valid JSON.' });
  }
  if (error.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request body is too large.' });
  }
  console.error('Request failed:', error.message);
  return res.status(500).json({ error: 'Internal server error.' });
});

const server = app.listen(port, () => {
  console.log(`Customer API listening on port ${port}`);
});

async function shutdown() {
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
