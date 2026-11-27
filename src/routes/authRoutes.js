const express = require('express');
const rateLimit = require('express-rate-limit');
const { loadAuthConfig } = require('../auth/config');
const { createAuthController } = require('../controllers/authController');
const { createAuthMiddleware, parseCookies } = require('../auth/middleware');
const crypto = require('node:crypto');

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

  const secure = process.env.NODE_ENV === 'production';
  const cookieOptions = { httpOnly: true, secure, sameSite: 'lax', path: '/' };
  const csrfOptions = { httpOnly: false, secure, sameSite: 'lax', path: '/' };
  router.use((req,res,next)=>{
    const original=res.json.bind(res);
    res.json=(data)=>{
      if(data?.tokens){
        const pair=data.tokens;
        res.cookie('bp_access',pair.accessToken,{...cookieOptions,maxAge:15*60*1000});
        res.cookie('bp_refresh',pair.refreshToken,{...cookieOptions,maxAge:7*24*60*60*1000});
        res.cookie('bp_csrf',crypto.randomBytes(24).toString('hex'),{...csrfOptions,maxAge:7*24*60*60*1000});
        const {tokens,...safe}=data; return original({...safe,authenticated:true});
      }
      return original(data);
    };
    next();
  });
  const csrfForRefresh=(req,res,next)=>{
    const cookies=parseCookies(req.headers.cookie);
    if(!cookies.bp_refresh)return res.status(401).json({error:'Session expired.'});
    if(!cookies.bp_csrf||req.get('x-csrf-token')!==cookies.bp_csrf)return res.status(403).json({error:'CSRF validation failed.'});
    req.body={...(req.body||{}),refreshToken:cookies.bp_refresh};next();
  };
  router.post('/register', registerLimiter, controller.register);
  router.post('/login', loginLimiter, controller.login);
  router.post('/refresh', refreshLimiter, csrfForRefresh, controller.refresh);
  router.post('/logout', refreshLimiter, csrfForRefresh, controller.logout);

  router.get('/me', authenticate, controller.me);
  router.post('/logout', refreshLimiter, csrfForRefresh, controller.logout);

  return router;
}

module.exports = { createAuthRouter };
