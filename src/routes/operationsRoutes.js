const express = require('express');
const argon2 = require('argon2');
const crypto = require('node:crypto');
const { createAuthMiddleware } = require('../auth/middleware');

function createOperationsRouter(pool, tokenService) {
  const router = express.Router();
  const { authenticate, requireRole } = createAuthMiddleware(pool, tokenService);
  const frontDesk = [authenticate, requireRole('ADMIN', 'FRONT_DESK')];
  const admin = [authenticate, requireRole('ADMIN')];
  const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  const id = value => /^[1-9]\\d*$/.test(String(value)) ? Number(value) : null;
  const csv = value => '"' + String(value ?? '').replace(/"/g, '""') + '"';
  const financialYear = date => {
    const d = new Date(date + 'T00:00:00Z');
    const start = d.getUTCMonth() >= 3 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
    return start + '-' + String(start + 1).slice(-2);
  };
  async function shopAccess(user, shopId) {
    if (user.role === 'ADMIN') return true;
    const result = await pool.query(
      'SELECT 1 FROM shop_front_desk WHERE shop_id=$1 AND user_id=$2 AND is_active=TRUE',
      [shopId, user.id]
    );
    return result.rowCount > 0;
  }
  async function nextNumber(client, shopId, type, fy, prefix) {
    const result = await client.query(
      `INSERT INTO shop_document_sequences (shop_id,document_type,financial_year,last_number)
       VALUES ($1,$2,$3,1)
       ON CONFLICT (shop_id,document_type,financial_year)
       DO UPDATE SET last_number=shop_document_sequences.last_number+1
       RETURNING last_number`,
      [shopId, type, fy]
    );
    return prefix + '/' + fy + '/' + String(result.rows[0].last_number).padStart(4, '0');
  }

  router.post('/admin/front-desk-users', ...admin, asyncRoute(async(req,res)=>{
    const b=req.body||{},name=typeof b.name==='string'?b.name.trim():'',email=typeof b.email==='string'?b.email.trim().toLowerCase():'',shopId=id(b.shopId);
    if(!shopId||!name||name.length>120||email.length>254||! /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email)) return res.status(400).json({error:'Provide a valid name, email and shopId.'});
    const client=await pool.connect();
    try{
      await client.query('BEGIN');
      const shop=await client.query('SELECT id FROM shops WHERE id=$1 AND is_active=TRUE',[shopId]);
      if(!shop.rowCount){await client.query('ROLLBACK');return res.status(404).json({error:'Active shop not found.'});}
      const exists=await client.query('SELECT id FROM users WHERE email=$1',[email]);
      if(exists.rowCount){await client.query('ROLLBACK');return res.status(409).json({error:'An account with this email already exists.'});}
      const placeholder=await argon2.hash(crypto.randomBytes(48).toString('base64url'),{type:argon2.argon2id,memoryCost:19456,timeCost:2,parallelism:1});
      const created=await client.query(
        `INSERT INTO users (name,email,password_hash,role,is_active) VALUES ($1,$2,$3,'FRONT_DESK',FALSE) RETURNING id,name,email,role`,
        [name,email,placeholder]);
      await client.query('INSERT INTO shop_front_desk (shop_id,user_id) VALUES ($1,$2)',[shopId,created.rows[0].id]);
      const token=crypto.randomBytes(32).toString('base64url'),hash=crypto.createHash('sha256').update(token).digest('hex');
      const expiresAt=new Date(Date.now()+48*60*60*1000);
      await client.query('INSERT INTO account_activation_tokens (user_id,token_hash,expires_at) VALUES ($1,$2,$3)',[created.rows[0].id,hash,expiresAt]);
      await client.query('COMMIT');
      return res.status(201).json({user:created.rows[0],shopId,activationEndpoint:'/api/operator/activate',activationToken:token,expiresAt:expiresAt.toISOString(),message:'Share this one-time activation token securely with the intended front-desk user. It expires in 48 hours.'});
    }catch(error){await client.query('ROLLBACK');if(error.code==='23505')return res.status(409).json({error:'Account or shop assignment already exists.'});throw error;}finally{client.release();}
  }));

  router.get('/shops/:shopId/tax-profile', ...frontDesk, asyncRoute(async (req,res) => {
    const shopId=id(req.params.shopId);
    if (!shopId || !await shopAccess(req.user,shopId)) return res.status(404).json({error:'Shop not found.'});
    const result=await pool.query('SELECT shop_id,gst_registered,gstin,legal_name,trade_name,address,state_code,invoice_prefix FROM shop_tax_profiles WHERE shop_id=$1',[shopId]);
    res.json({taxProfile:result.rows[0] || {shop_id:shopId,gst_registered:false,invoice_prefix:'BP'}});
  }));

  router.put('/shops/:shopId/tax-profile', ...admin, asyncRoute(async (req,res) => {
    const shopId=id(req.params.shopId), b=req.body || {};
    if (!shopId || typeof b.gstRegistered!=='boolean' ||
        (b.gstRegistered && (typeof b.gstin!=='string' || !/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(b.gstin.trim().toUpperCase()) ||
         typeof b.stateCode!=='string' || !/^\\d{2}$/.test(b.stateCode))) ||
        typeof (b.invoicePrefix ?? 'BP')!=='string' || !/^[A-Z0-9]{1,12}$/.test(b.invoicePrefix ?? 'BP')) {
      return res.status(400).json({error:'Provide valid GST registration details and an invoice prefix.'});
    }
    const result=await pool.query(
      `INSERT INTO shop_tax_profiles (shop_id,gst_registered,gstin,legal_name,trade_name,address,state_code,invoice_prefix,updated_at)
       SELECT id,$2,$3,$4,$5,$6,$7,$8,NOW() FROM shops WHERE id=$1 AND is_active=TRUE
       ON CONFLICT (shop_id) DO UPDATE SET gst_registered=EXCLUDED.gst_registered,gstin=EXCLUDED.gstin,
       legal_name=EXCLUDED.legal_name,trade_name=EXCLUDED.trade_name,address=EXCLUDED.address,
       state_code=EXCLUDED.state_code,invoice_prefix=EXCLUDED.invoice_prefix,updated_at=NOW()
       RETURNING shop_id,gst_registered,gstin,legal_name,trade_name,address,state_code,invoice_prefix`,
      [shopId,b.gstRegistered,b.gstRegistered?b.gstin.trim().toUpperCase():null,b.legalName||null,b.tradeName||null,b.address||null,b.gstRegistered?b.stateCode:null,b.invoicePrefix??'BP']);
    if(!result.rowCount) return res.status(404).json({error:'Active shop not found.'});
    res.json({taxProfile:result.rows[0]});
  }));

  router.post('/shops/:shopId/invoices', ...frontDesk, asyncRoute(async (req,res) => {
    const shopId=id(req.params.shopId), b=req.body||{};
    if(!shopId || !await shopAccess(req.user,shopId)) return res.status(404).json({error:'Shop not found.'});
    if(typeof b.customerName!=='string' || !b.customerName.trim() || !Array.isArray(b.items) || !b.items.length || b.items.length>50 ||
       !/^\\d{4}-\\d{2}-\\d{2}$/.test(b.issueDate||'') || (b.amountPaidPaise!==undefined && (!Number.isSafeInteger(b.amountPaidPaise)||b.amountPaidPaise<0))) {
      return res.status(400).json({error:'Provide customerName, issueDate and 1–50 valid invoice items.'});
    }
    const client=await pool.connect();
    try {
      await client.query('BEGIN');
      const shop=await client.query(
        `SELECT s.id, COALESCE(t.gst_registered,FALSE) gst_registered,t.gstin,t.state_code,t.invoice_prefix
         FROM shops s LEFT JOIN shop_tax_profiles t ON t.shop_id=s.id WHERE s.id=$1 AND s.is_active=TRUE FOR UPDATE OF s`,[shopId]);
      if(!shop.rowCount){await client.query('ROLLBACK');return res.status(404).json({error:'Active shop not found.'});}
      const profile=shop.rows[0], date=b.issueDate, fy=financialYear(date);
      const docType=profile.gst_registered?'TAX_INVOICE':'BILL_OF_SUPPLY';
      const place=typeof b.placeOfSupplyStateCode==='string' && /^\\d{2}$/.test(b.placeOfSupplyStateCode)?b.placeOfSupplyStateCode:null;
      if(profile.gst_registered && !place){await client.query('ROLLBACK');return res.status(400).json({error:'Place of supply state code is required for a GST tax invoice.'});}
      let subtotal=0,discount=0,taxable=0,cgst=0,sgst=0,igst=0;
      const lines=[];
      for(const item of b.items){
        const qty=Number(item.quantity),price=Number(item.unitPricePaise),disc=Number(item.discountPaise||0),rate=profile.gst_registered?Number(item.taxRateBps||0):0;
        if(typeof item.description!=='string'||!item.description.trim()||!Number.isFinite(qty)||qty<=0||qty>10000||
           !Number.isSafeInteger(price)||price<0||!Number.isSafeInteger(disc)||disc<0||!Number.isInteger(rate)||rate<0||rate>10000||
           (item.hsnSacCode && !/^[A-Za-z0-9]{4,8}$/.test(item.hsnSacCode))) {
          await client.query('ROLLBACK');return res.status(400).json({error:'Each item needs a description, valid quantity, unit price, discount, tax rate and optional HSN/SAC code.'});
        }
        const gross=Math.round(qty*price);
        if(disc>gross){await client.query('ROLLBACK');return res.status(400).json({error:'Line discount cannot exceed its gross amount.'});}
        const base=gross-disc, tax=Math.round(base*rate/10000);
        const intra=profile.gst_registered && place===profile.state_code;
        const line={description:item.description.trim(),hsn:item.hsnSacCode||null,quantity:qty,price,discount:disc,rate,base,cgst:intra?Math.floor(tax/2):0,sgst:intra?tax-Math.floor(tax/2):0,igst:profile.gst_registered&&!intra?tax:0,total:base+tax};
        subtotal+=gross;discount+=disc;taxable+=base;cgst+=line.cgst;sgst+=line.sgst;igst+=line.igst;lines.push(line);
      }
      const total=taxable+cgst+sgst+igst, paid=b.amountPaidPaise||0;
      if(paid>total){await client.query('ROLLBACK');return res.status(400).json({error:'Amount paid cannot exceed invoice total.'});}
      const prefix=profile.invoice_prefix||'BP', invoiceNumber=await nextNumber(client,shopId,'INVOICE',fy,prefix);
      const mode=['CASH','UPI','CARD','RAZORPAY','MIXED','UNPAID'].includes(b.paymentMode)?b.paymentMode:(paid?'MIXED':'UNPAID');
      const inserted=await client.query(
        `INSERT INTO sales_invoices (shop_id,invoice_number,financial_year,document_type,issue_date,customer_name,customer_email,customer_phone,customer_gstin,place_of_supply_state_code,subtotal_paise,discount_paise,taxable_paise,cgst_paise,sgst_paise,igst_paise,total_paise,amount_paid_paise,payment_mode,created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING *`,
        [shopId,invoiceNumber,fy,docType,date,b.customerName.trim(),b.customerEmail||null,b.customerPhone||null,b.customerGstin||null,place,subtotal,discount,taxable,cgst,sgst,igst,total,paid,mode,req.user.id]);
      const invoice=inserted.rows[0];
      for(const line of lines) await client.query(
        `INSERT INTO sales_invoice_lines (invoice_id,description,hsn_sac_code,quantity,unit_price_paise,discount_paise,tax_rate_bps,taxable_paise,cgst_paise,sgst_paise,igst_paise,total_paise)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [invoice.id,line.description,line.hsn,line.quantity,line.price,line.discount,line.rate,line.base,line.cgst,line.sgst,line.igst,line.total]);
      await client.query('COMMIT');
      res.status(201).json({invoice});
    } catch(error){await client.query('ROLLBACK');throw error;} finally{client.release();}
  }));

  router.post('/invoices/:invoiceId/credit-notes', ...frontDesk, asyncRoute(async(req,res)=>{
    const invoiceId=id(req.params.invoiceId),reason=typeof req.body?.reason==='string'?req.body.reason.trim():'';
    const amount=Number(req.body?.amountPaise);
    if(!invoiceId||reason.length<3||reason.length>240||!Number.isSafeInteger(amount)||amount<1) return res.status(400).json({error:'Provide a valid credit amount and reason.'});
    const client=await pool.connect();
    try{
      await client.query('BEGIN');
      const found=await client.query(
        `SELECT i.*,COALESCE(t.invoice_prefix,'BP') invoice_prefix FROM sales_invoices i
         LEFT JOIN shop_tax_profiles t ON t.shop_id=i.shop_id WHERE i.id=$1 AND i.status='ISSUED' FOR UPDATE OF i`,[invoiceId]);
      if(!found.rowCount||!await shopAccess(req.user,Number(found.rows[0].shop_id))){await client.query('ROLLBACK');return res.status(404).json({error:'Issued invoice not found.'});}
      const inv=found.rows[0],prior=await client.query('SELECT COALESCE(SUM(total_paise),0)::bigint total FROM sales_credit_notes WHERE invoice_id=$1',[invoiceId]);
      const remaining=Number(inv.total_paise)-Number(prior.rows[0].total);
      if(amount>remaining){await client.query('ROLLBACK');return res.status(400).json({error:'Credit note exceeds the uncredited invoice balance.'});}
      const ratio=amount/Number(inv.total_paise),taxable=Math.round(Number(inv.taxable_paise)*ratio),cgst=Math.round(Number(inv.cgst_paise)*ratio),sgst=Math.round(Number(inv.sgst_paise)*ratio);
      const igst=amount-taxable-cgst-sgst,fy=financialYear(new Date().toISOString().slice(0,10));
      const number=await nextNumber(client,Number(inv.shop_id),'CREDIT_NOTE',fy,inv.invoice_prefix+'-CN');
      const result=await client.query(
        `INSERT INTO sales_credit_notes (shop_id,invoice_id,credit_note_number,financial_year,issue_date,reason,taxable_paise,cgst_paise,sgst_paise,igst_paise,total_paise,created_by)
         VALUES ($1,$2,$3,$4,CURRENT_DATE,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [inv.shop_id,invoiceId,number,fy,reason,taxable,cgst,sgst,igst,amount,req.user.id]);
      await client.query('COMMIT');res.status(201).json({creditNote:result.rows[0]});
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  }));

  router.get('/shops/:shopId/gst-returns/export', ...admin, asyncRoute(async(req,res)=>{
    const shopId=id(req.params.shopId),from=req.query.from,to=req.query.to;
    if(!shopId||!/^\\d{4}-\\d{2}-\\d{2}$/.test(from||'')||!/^\\d{4}-\\d{2}-\\d{2}$/.test(to||'')||from>to) return res.status(400).json({error:'Provide shopId and a valid date range.'});
    const docs=await pool.query(
      `SELECT 'INVOICE' document_kind,i.invoice_number document_number,i.issue_date,i.document_type,i.customer_name,i.customer_gstin,i.place_of_supply_state_code,
       l.hsn_sac_code,l.description,l.quantity,l.tax_rate_bps,l.taxable_paise,l.cgst_paise,l.sgst_paise,l.igst_paise,l.total_paise
       FROM sales_invoices i JOIN sales_invoice_lines l ON l.invoice_id=i.id
       WHERE i.shop_id=$1 AND i.issue_date BETWEEN $2::date AND $3::date AND i.status='ISSUED'
       UNION ALL
       SELECT 'CREDIT_NOTE',c.credit_note_number,c.issue_date,'CREDIT_NOTE',i.customer_name,i.customer_gstin,i.place_of_supply_state_code,
       NULL,c.reason,1,0,c.taxable_paise,c.cgst_paise,c.sgst_paise,c.igst_paise,c.total_paise
       FROM sales_credit_notes c JOIN sales_invoices i ON i.id=c.invoice_id
       WHERE c.shop_id=$1 AND c.issue_date BETWEEN $2::date AND $3::date
       ORDER BY issue_date,document_number`,[shopId,from,to]);
    const header=['Document kind','Document number','Date','Document type','Customer','Customer GSTIN','Place of supply state code','HSN/SAC','Description','Quantity','Tax rate (basis points)','Taxable value (paise)','CGST (paise)','SGST (paise)','IGST (paise)','Total (paise)'];
    const lines=[header,...docs.rows.map(r=>[r.document_kind,r.document_number,r.issue_date,r.document_type,r.customer_name,r.customer_gstin,r.place_of_supply_state_code,r.hsn_sac_code,r.description,r.quantity,r.tax_rate_bps,r.taxable_paise,r.cgst_paise,r.sgst_paise,r.igst_paise,r.total_paise])];
    res.set('Content-Type','text/csv; charset=utf-8');res.set('Content-Disposition',`attachment; filename="barberpro-gst-sales-register-${from}-to-${to}.csv"`);
    res.send('\\uFEFF'+lines.map(row=>row.map(csv).join(',')).join('\\r\\n'));
  }));
  return router;
}
module.exports={createOperationsRouter};
