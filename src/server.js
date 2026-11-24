const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const swaggerUi = require('swagger-ui-express');
const openapiSpec = require('./openapi.json');
const { createAuthRouter } = require('./routes/authRoutes');
const { createBookingRouter } = require('./routes/bookingRoutes');
const { createDashboardRouter } = require('./routes/dashboardRoutes');
const { createPaymentRouter } = require('./routes/paymentRoutes');
const { createOperatorRouter } = require('./routes/operatorRoutes');
const { createAiRouter } = require('./routes/aiRoutes');
const { createReceptionistRouter } = require('./routes/receptionistRoutes');
const { createOperationsRouter } = require('./routes/operationsRoutes');
const { createMarketingRouter } = require('./routes/marketingRoutes');
const { createCrmRouter } = require('./routes/crmRoutes');
const { createInventoryRouter } = require('./routes/inventoryRoutes');
const { createCommercialRouter } = require('./routes/commercialRoutes');
const { createPayrollRouter } = require('./routes/payrollRoutes');
const { createMessagingRouter } = require('./routes/messagingRoutes');
const { createBookingAssistantRouter } = require('./routes/bookingAssistantRoutes');
const { createWhatsAppRouter } = require('./routes/whatsappRoutes');
const { createRetentionRouter } = require('./routes/retentionRoutes');
const { loadAuthConfig } = require('./auth/config');
const { createTokenService } = require('./auth/tokens');
const { Pool } = require('pg');
const fs = require('node:fs');
require('dotenv').config();

const app = express();
const poolOptions = process.env.DB_PASSWORD_FILE
  ? {
      host: process.env.PGHOST,
      port: Number(process.env.PGPORT) || 5432,
      database: process.env.PGDATABASE,
      user: process.env.PGUSER,
      password: fs.readFileSync(process.env.DB_PASSWORD_FILE, 'utf8').trimEnd()
    }
  : { connectionString: process.env.DATABASE_URL };
const pool = new Pool({ ...poolOptions, max: 10, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000 });
const port = Number(process.env.PORT) || 3000;
let shuttingDown = false;

app.disable('x-powered-by');
// Render terminates TLS and forwards client IPs through one trusted proxy.
// This must be set before express-rate-limit middleware reads X-Forwarded-For.
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: { directives: { scriptSrc: ["'self'", 'https://checkout.razorpay.com'], frameSrc: ["'self'", 'https://checkout.razorpay.com', 'https://api.razorpay.com'], connectSrc: ["'self'", 'https://api.razorpay.com'] } } }));
const bookingTokens = createTokenService(loadAuthConfig());
const paymentRouter = createPaymentRouter(pool, bookingTokens);
app.use('/api/payments', (req, res, next) => req.path === '/webhook' ? paymentRouter(req, res, next) : next()); // raw webhook only before express.json
app.use(express.json({ limit: '1mb', verify: (req, res, buffer) => { req.rawBody = Buffer.from(buffer); } }));

app.get('/health/live', (req, res) => res.status(200).json({ status: 'ok' }));
app.get('/health/ready', async (req, res) => {
  if (shuttingDown) return res.status(503).json({ status: 'not ready' });
  try {
    await pool.query('SELECT 1');
    return res.status(200).json({ status: 'ok' });
  } catch {
    return res.status(503).json({ status: 'not ready' });
  }
});

app.get('/openapi.json', (req, res) => res.json(openapiSpec));
// Swagger UI uses an inline initialization script; relax CSP only for this documentation route.
app.use('/api-docs', (req, res, next) => {
  res.removeHeader('Content-Security-Policy');
  next();
});
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(openapiSpec));

app.use('/api/auth', createAuthRouter(pool));
app.use('/api/operator', createOperatorRouter(pool));
app.use('/api', createBookingRouter(pool, bookingTokens));
app.use('/api', createDashboardRouter(pool, bookingTokens));
app.use('/api', createAiRouter(pool, bookingTokens));
app.use('/api', createReceptionistRouter(pool));
app.use('/api', createOperationsRouter(pool, bookingTokens));
app.use('/api', createCrmRouter(pool, bookingTokens));
app.use('/api', createInventoryRouter(pool, bookingTokens));
app.use('/api', createCommercialRouter(pool, bookingTokens));
app.use('/api', createPayrollRouter(pool, bookingTokens));
app.use('/api', createMessagingRouter(pool, bookingTokens));
app.use('/api', createBookingAssistantRouter(pool, bookingTokens));
app.use('/api', createWhatsAppRouter(pool));
app.use('/api', createRetentionRouter(pool, bookingTokens));
app.use('/api/payments', paymentRouter);
app.use('/api/marketing', createMarketingRouter(pool, bookingTokens));

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

const publicDir = require('node:path').join(__dirname, '..', 'public');
app.get('/queue/:shopId', (req,res) => { if (!/^[1-9]\\d*$/.test(req.params.shopId)) return res.sendStatus(404); res.set('Cache-Control','no-store'); res.sendFile(require('node:path').join(publicDir,'queue.html')); });
const appHostname = (process.env.APP_HOSTNAME || '').trim().toLowerCase();
const marketingHostname = (process.env.MARKETING_HOSTNAME || '').trim().toLowerCase();
const appBaseUrl = (process.env.APP_BASE_URL || '').trim().replace(/\/$/, '');
const marketingBaseUrl = (process.env.MARKETING_BASE_URL || '').trim().replace(/\/$/, '');
const isAppHost = req => Boolean(appHostname && req.hostname.toLowerCase() === appHostname);
const isMarketingHost = req => Boolean(marketingHostname && req.hostname.toLowerCase() === marketingHostname);
const workspacePage = (req, res) => res.sendFile(require('node:path').join(publicDir, 'workspace.html'));

// Keep the legacy /app path working, while sending marketing-site visitors to the
// dedicated application hostname once the owner has configured the custom domain.
app.get(['/app', '/app/*'], (req, res) => {
  if (isMarketingHost(req) && appBaseUrl) return res.redirect(302, appBaseUrl + req.originalUrl);
  return workspacePage(req, res);
});
app.get('/demo', (req, res) => {
  if (isAppHost(req) && marketingBaseUrl) return res.redirect(302, marketingBaseUrl + '/demo');
  return res.sendFile(require('node:path').join(publicDir, 'demo.html'));
});
// On app.barberpro.in, the root is the authenticated CRM entry point. On the
// marketing hostname (and on the current legacy host) the root remains public.
app.get(['/', '/index.html'], (req, res, next) => isAppHost(req) ? workspacePage(req, res) : next());
app.use(express.static(publicDir, { index: 'index.html' }));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  return isAppHost(req) ? workspacePage(req, res) : res.sendFile(require('node:path').join(publicDir, 'index.html'));
});
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

const server = app.listen(port, '0.0.0.0', () => {
  console.log(`BarberPro API listening on port ${port}`);
});
server.headersTimeout = 10_000;
server.requestTimeout = 30_000;
server.keepAliveTimeout = 5_000;

let shutdownStarted = false;
async function shutdown() {
  if (shutdownStarted) return;
  shutdownStarted = true;
  shuttingDown = true;
  const forceExit = setTimeout(() => process.exit(1), 10_000);
  forceExit.unref();
  server.close(async () => {
    try {
      await pool.end();
      clearTimeout(forceExit);
      process.exit(0);
    } catch (error) {
      console.error('Shutdown failed:', error.message);
      process.exit(1);
    }
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
