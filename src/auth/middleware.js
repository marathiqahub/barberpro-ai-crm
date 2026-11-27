function parseCookies(header='') {
  return Object.fromEntries(String(header).split(';').map(v=>v.trim()).filter(Boolean).map(v=>{const i=v.indexOf('=');return [decodeURIComponent(v.slice(0,i)),decodeURIComponent(v.slice(i+1))];}));
}
function createAuthMiddleware(pool, tokenService) {
 async function authenticate(req,res,next) {
  const header=req.get('authorization')||'',match=header.match(/^Bearer\s+(.+)$/i),cookies=parseCookies(req.headers.cookie);
  const accessToken=match?.[1]||cookies.bp_access;
  if(!accessToken)return res.status(401).json({error:'A valid session is required.'});
  if(!match&&!['GET','HEAD','OPTIONS'].includes(req.method)){
   const csrf=cookies.bp_csrf,provided=req.get('x-csrf-token');
   if(!csrf||!provided||csrf!==provided)return res.status(403).json({error:'CSRF validation failed.'});
  }
  let claims;try{claims=tokenService.verifyAccessToken(accessToken);}catch{return res.status(401).json({error:'Invalid or expired access token.'});}
  try{
   const result=await pool.query(`SELECT u.id,u.name,u.email,u.role FROM users u WHERE u.id=$1 AND u.is_active=TRUE
    AND EXISTS(SELECT 1 FROM refresh_tokens rt WHERE rt.user_id=u.id AND rt.family_id=$2 AND rt.revoked_at IS NULL AND rt.expires_at>NOW())`,[claims.sub,claims.familyId]);
   if(!result.rowCount)return res.status(401).json({error:'Authentication is no longer valid.'});
   req.user=result.rows[0];return next();
  }catch(e){return next(e);}
 }
 function requireRole(...roles){return(req,res,next)=>!req.user||!roles.includes(req.user.role)?res.status(403).json({error:'You do not have permission to perform this action.'}):next();}
 return {authenticate,requireRole};
}
module.exports={createAuthMiddleware,parseCookies};
