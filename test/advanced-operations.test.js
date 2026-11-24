'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {generateSecret,totpCode,verifyTotp,encryptSecret,decryptSecret}=require('../src/advanced/totp');
const {toCsv,parseCsv}=require('../src/advanced/csv');

test('TOTP matches the RFC 6238 SHA-1 test vector and accepts a bounded clock window',()=>{
 const secret='GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
 assert.equal(totpCode(secret,59000),'287082');
 assert.equal(verifyTotp(secret,'287082',59000,0),true);
 assert.equal(verifyTotp(secret,'287083',59000,0),false);
 assert.equal(verifyTotp(secret,totpCode(secret,119000),59000,1),false);
});

test('TOTP secrets are encrypted with authenticated AES-GCM and round-trip only with the key',()=>{
 const env={TOTP_ENCRYPTION_KEY:'a-random-encryption-key-with-at-least-32-bytes'};
 const secret=generateSecret(),stored=encryptSecret(secret,env);
 assert.notEqual(stored,secret);
 assert.equal(decryptSecret(stored,env),secret);
 assert.throws(()=>decryptSecret(stored,{TOTP_ENCRYPTION_KEY:'a-different-key-that-is-also-long-enough'}));
 assert.throws(()=>encryptSecret(secret,{}),{code:'TOTP_KEY_NOT_CONFIGURED'});
});

test('CSV import parser handles quoted commas, escaped quotes and line breaks',()=>{
 const parsed=parseCsv('Name,Email,Phone\r\n"Doe, Jane",jane@example.test,"+91 98765 43210"\r\n"Line\nBreak",line@example.test,');
 assert.equal(parsed[0].Name,'Doe, Jane');
 assert.equal(parsed[0].Phone,'+91 98765 43210');
 assert.equal(parsed[1].Name,'Line\nBreak');
});

test('accounting CSV escapes formula-like text and preserves delimiters safely',()=>{
 const csv=toCsv([{'Party Name':'=SUM(1,2)','Voucher Number':'BP-"001"'}],['Party Name','Voucher Number']);
 assert.equal(parseCsv(csv)[0]['Party Name'],"'=SUM(1,2)");
 assert.equal(parseCsv(csv)[0]['Voucher Number'],'BP-"001"');
});
