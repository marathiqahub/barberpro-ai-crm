const express = require('express');
const rateLimit = require('express-rate-limit');
const { loadAuthConfig } = require('../auth/config');
const { createAuthController } = require('../controllers/authController');
const { createAuthMiddleware } = require('../auth/middleware');

function createAuthRouter(pool) {
  const router = express.Router();
  const config = loadAuthConfig();
  const controller = createAuthController(pool, config);
  const { authenticate } = createAuthMiddleware(pool, controller.tokens);

  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.set('Pragma', 'no-cache');
    return next();
  });

  const registerLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 5,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many registration attempts. Try again later.' }
  });
  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many login attempts. Try again later.' }
  });
  const refreshLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many token requests. Try again later.' }
  });

  router.post('/register', registerLimiter, controller.register);
  router.post('/login', loginLimiter, controller.login);
  router.post('/refresh', refreshLimiter, controller.refresh);
  router.post('/logout', refreshLimiter, controller.logout);
  router.get('/me', authenticate, controller.me);

  return router;
}

module.exports = { createAuthRouter };
