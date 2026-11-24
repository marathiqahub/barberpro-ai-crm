'use strict';
const crypto = require('node:crypto');
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Encode(buffer) {
  let bits=0,value=0,out='';
  for(const byte of buffer){value=(value<<8)|byte;bits+=8;while(bits>=5){out+=ALPHABET[(value>>>(bits-5))&31];bits-=5;}}
  if(bits)out+=ALPHABET[(value<<(5-bits))&31];
  return out;
}
function base32Decode(text) {
  let bits=0,value=0;const out=[];
  for(const char of String(text).toUpperCase().replace(/=+$/,'')){const idx=ALPHABET.indexOf(char);if(idx<0)throw new Error('Invalid base32 secret');value=(value<<5)|idx;bits+=5;if(bits>=8){out.push((value>>>(bits-8))&255);bits-=8;}}
  return Buffer.from(out);
}
function generateSecret(){return base32Encode(crypto.randomBytes(20));}
function totpCode(secret,at=Date.now(),step=30){
  const counter=Math.floor(at/1000/step),buf=Buffer.alloc(8);buf.writeBigUInt64BE(BigInt(counter));
  const digest=crypto.createHmac('sha1',base32Decode(secret)).update(buf).digest();
  const offset=digest[digest.length-1]&15;
  const binary=((digest[offset]&127)<<24)|(digest[offset+1]<<16)|(digest[offset+2]<<8)|digest[offset+3];
  return String(binary%1000000).padStart(6,'0');
}
function matchingTotpStep(secret,code,at=Date.now(),window=1){
  if(!/^\d{6}$/.test(String(code||'')))return null;
  const current=Math.floor(at/30000);
  for(let drift=-window;drift<=window;drift++){const step=current+drift;if(totpCode(secret,step*30000)===String(code))return step;}
  return null;
}
function verifyTotp(secret,code,at=Date.now(),window=1){return matchingTotpStep(secret,code,at,window)!==null;}
function encryptionKey(env=process.env){
  if(!env.TOTP_ENCRYPTION_KEY||Buffer.byteLength(env.TOTP_ENCRYPTION_KEY)<32)throw Object.assign(new Error('TOTP_ENCRYPTION_KEY must contain at least 32 bytes.'),{code:'TOTP_KEY_NOT_CONFIGURED',status:503});
  return crypto.createHash('sha256').update(env.TOTP_ENCRYPTION_KEY).digest();
}
function encryptSecret(secret,env=process.env){
  const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',encryptionKey(env),iv);
  const encrypted=Buffer.concat([cipher.update(secret,'utf8'),cipher.final()]);
  return [iv.toString('base64url'),cipher.getAuthTag().toString('base64url'),encrypted.toString('base64url')].join('.');
}
function decryptSecret(value,env=process.env){
  const [iv,tag,data]=String(value||'').split('.');
  const decipher=crypto.createDecipheriv('aes-256-gcm',encryptionKey(env),Buffer.from(iv,'base64url'));
  decipher.setAuthTag(Buffer.from(tag,'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(data,'base64url')),decipher.final()]).toString('utf8');
}
function otpauthUri(secret,account,issuer='BarberPro'){
  return 'otpauth://totp/'+encodeURIComponent(issuer+':'+account)+'?secret='+secret+'&issuer='+encodeURIComponent(issuer)+'&algorithm=SHA1&digits=6&period=30';
}
module.exports={base32Encode,base32Decode,generateSecret,totpCode,matchingTotpStep,verifyTotp,encryptSecret,decryptSecret,otpauthUri};
