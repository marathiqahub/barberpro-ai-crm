const express = require('express');
const argon2 = require('argon2');
const crypto = require('node:crypto');
const { createAuthMiddleware } = require('../auth/middleware');
const { commissionForTaxableAmount, expectedCash, validateTenderAllocations } = require('../financial/calculations');
const { offerWaitlistEntry } = require('./retentionRoutes');

function createOperationsRouter(pool, tokenService) {
  const router = express.Router();
  const { authenticate, requireRole } = createAuthMiddleware(pool, tokenService);
  const frontDesk = [authenticate, requireRole('ADMIN', 'FRONT_DESK')];
  const admin = [authenticate, requireRole('ADMIN')];
  const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  const id = value => { const n=Number(value); return /^[1-9]\d*$/.test(String(value)) && Number.isSafeInteger(n) ? n : null; };
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
    if(!shopId||!name||name.length>120||email.length>254||! /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({error:'Provide a valid name, email and shopId.'});
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
         typeof b.stateCode!=='string' || !/^\d{2}$/.test(b.stateCode))) ||
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
       !/^\d{4}-\d{2}-\d{2}$/.test(b.issueDate||'') || (b.amountPaidPaise!==undefined && (!Number.isSafeInteger(b.amountPaidPaise)||b.amountPaidPaise<0))) {
      return res.status(400).json({error:'Provide customerName, issueDate and 1–50 valid invoice items.'});
    }
    const client=await pool.connect();
    try {
      await client.query('BEGIN');
      const shop=await client.query(
        `SELECT s.id, COALESCE(t.gst_registered,FALSE) gst_registered,t.gstin,t.state_code,t.invoice_prefix,t.legal_name,t.trade_name,t.address
         FROM shops s LEFT JOIN shop_tax_profiles t ON t.shop_id=s.id WHERE s.id=$1 AND s.is_active=TRUE FOR UPDATE OF s`,[shopId]);
      if(!shop.rowCount){await client.query('ROLLBACK');return res.status(404).json({error:'Active shop not found.'});}
      const profile=shop.rows[0], date=b.issueDate, fy=financialYear(date);
      const dayClose=await client.query('SELECT id FROM shop_daily_closures WHERE shop_id=$1 AND business_date=$2',[shopId,date]);
      if(dayClose.rowCount){await client.query('ROLLBACK');return res.status(409).json({error:'This business day is already closed. Reopen it through the authorized close-review process before issuing another invoice.'});}
      const docType=profile.gst_registered?'TAX_INVOICE':'BILL_OF_SUPPLY';
      const place=typeof b.placeOfSupplyStateCode==='string' && /^\d{2}$/.test(b.placeOfSupplyStateCode)?b.placeOfSupplyStateCode:null;
      if(profile.gst_registered && !place){await client.query('ROLLBACK');return res.status(400).json({error:'Place of supply state code is required for a GST tax invoice.'});}
      let subtotal=0,discount=0,taxable=0,cgst=0,sgst=0,igst=0;
      const lines=[];
      for(const item of b.items){
        const qty=Number(item.quantity),inventoryItemId=item.inventoryItemId===undefined||item.inventoryItemId===null||item.inventoryItemId===''?null:id(item.inventoryItemId);
        let price=Number(item.unitPricePaise),description=typeof item.description==='string'?item.description.trim():'';
        const disc=Number(item.discountPaise||0),rate=profile.gst_registered?Number(item.taxRateBps||0):0;
        if((item.inventoryItemId!==undefined&&item.inventoryItemId!==null&&item.inventoryItemId!==''&&!inventoryItemId)||
           (!inventoryItemId&&!description)||!Number.isFinite(qty)||qty<=0||qty>10000||
           !Number.isSafeInteger(disc)||disc<0||!Number.isInteger(rate)||rate<0||rate>10000||
           (item.hsnSacCode && !/^[A-Za-z0-9]{4,8}$/.test(item.hsnSacCode))) {
          await client.query('ROLLBACK');return res.status(400).json({error:'Each item needs a description, valid quantity, unit price, discount, tax rate and optional HSN/SAC code.'});
        }
        if(inventoryItemId){
          if(item.serviceId!==undefined&&item.serviceId!==null&&item.serviceId!==''){await client.query('ROLLBACK');return res.status(400).json({error:'A retail product line cannot also reference a service.'});}
          const product=await client.query('SELECT id,name,quantity,retail_price_paise FROM shop_inventory_items WHERE id=$1 AND shop_id=$2 AND is_active=TRUE FOR UPDATE',[inventoryItemId,shopId]);
          if(!product.rowCount){await client.query('ROLLBACK');return res.status(400).json({error:'Retail product must be active in this shop.'});}
          if(Number(product.rows[0].quantity)<qty){await client.query('ROLLBACK');return res.status(409).json({error:'Insufficient retail stock for '+product.rows[0].name+'.'});}
          price=Number(product.rows[0].retail_price_paise);description=product.rows[0].name;
        }
        if(!Number.isSafeInteger(price)||price<0||(inventoryItemId&&price<1)){await client.query('ROLLBACK');return res.status(400).json({error:'Each item needs a valid unit price or a retail product with a configured selling price.'});}
        const gross=Math.round(qty*price);
        if(disc>gross){await client.query('ROLLBACK');return res.status(400).json({error:'Line discount cannot exceed its gross amount.'});}
        const base=gross-disc, tax=Math.round(base*rate/10000);
        const intra=profile.gst_registered && place===profile.state_code;
        let staffId=null,commissionRate=0;
        if(item.staffId!==undefined&&item.staffId!==null&&item.staffId!==''){
          staffId=id(item.staffId);
          if(!staffId){await client.query('ROLLBACK');return res.status(400).json({error:'Invalid barber assignment on invoice item.'});}
          const staff=await client.query('SELECT commission_rate_bps FROM shop_staff WHERE id=$1 AND shop_id=$2 AND is_active=TRUE',[staffId,shopId]);
          if(!staff.rowCount){await client.query('ROLLBACK');return res.status(400).json({error:'Invoice barber must be active at this shop.'});}
          commissionRate=Number(staff.rows[0].commission_rate_bps);
        }
        const serviceId=item.serviceId===undefined||item.serviceId===null||item.serviceId===''?null:id(item.serviceId);
        if(item.serviceId!==undefined&&item.serviceId!==null&&item.serviceId!==''&&!serviceId){await client.query('ROLLBACK');return res.status(400).json({error:'Invalid service catalogue reference.'});}
        if(serviceId){const svc=await client.query('SELECT id FROM services WHERE id=$1 AND shop_id=$2 AND is_active=TRUE',[serviceId,shopId]);if(!svc.rowCount){await client.query('ROLLBACK');return res.status(400).json({error:'Invoice service must be active in this shop.'});}}
        const tip=Number(item.tipPaise||0);if(!Number.isSafeInteger(tip)||tip<0||tip>10000000){await client.query('ROLLBACK');return res.status(400).json({error:'Tip must be a non-negative whole amount in paise.'});}
        const line={description,hsn:item.hsnSacCode||null,quantity:qty,price,discount:disc,rate,base,cgst:intra?Math.floor(tax/2):0,sgst:intra?tax-Math.floor(tax/2):0,igst:profile.gst_registered&&!intra?tax:0,total:base+tax,staffId,commissionRate,commission:commissionForTaxableAmount(base,commissionRate),serviceId,inventoryItemId,tip};
        subtotal+=gross;discount+=disc;taxable+=base;cgst+=line.cgst;sgst+=line.sgst;igst+=line.igst;lines.push(line);
      }
      const total=taxable+cgst+sgst+igst, paid=b.amountPaidPaise||0;
      if(total<1){await client.query('ROLLBACK');return res.status(400).json({error:'Invoice total must be at least ₹0.01.'});}
      if(paid>total){await client.query('ROLLBACK');return res.status(400).json({error:'Amount paid cannot exceed invoice total.'});}
      const prefix=profile.invoice_prefix||'BP', invoiceNumber=await nextNumber(client,shopId,'INVOICE',fy,prefix);
      const mode=['CASH','UPI','CARD','RAZORPAY','MIXED','UNPAID'].includes(b.paymentMode)?b.paymentMode:(paid?'MIXED':'UNPAID');
      if(mode==='MIXED'&&paid>0&&(!Array.isArray(b.paymentBreakdown)||!b.paymentBreakdown.length)){await client.query('ROLLBACK');return res.status(400).json({error:'Provide paymentBreakdown for mixed payments so each tender can be reconciled.'});}
      const inserted=await client.query(
        `INSERT INTO sales_invoices (shop_id,invoice_number,financial_year,document_type,issue_date,seller_gstin,seller_legal_name,seller_trade_name,seller_address,seller_state_code,customer_name,customer_email,customer_phone,customer_gstin,place_of_supply_state_code,subtotal_paise,discount_paise,taxable_paise,cgst_paise,sgst_paise,igst_paise,total_paise,amount_paid_paise,payment_mode,created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25) RETURNING *`,
        [shopId,invoiceNumber,fy,docType,date,profile.gstin,profile.legal_name,profile.trade_name,profile.address,profile.state_code,b.customerName.trim(),b.customerEmail||null,b.customerPhone||null,b.customerGstin||null,place,subtotal,discount,taxable,cgst,sgst,igst,total,paid,mode,req.user.id]);
      const invoice=inserted.rows[0];
      for(const line of lines) await client.query(
        `INSERT INTO sales_invoice_lines (invoice_id,description,hsn_sac_code,quantity,unit_price_paise,discount_paise,tax_rate_bps,taxable_paise,cgst_paise,sgst_paise,igst_paise,total_paise,staff_id,commission_rate_bps,commission_paise,service_id,tip_paise,inventory_item_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
        [invoice.id,line.description,line.hsn,line.quantity,line.price,line.discount,line.rate,line.base,line.cgst,line.sgst,line.igst,line.total,line.staffId,line.commissionRate,line.commission,line.serviceId,line.tip,line.inventoryItemId]);
      for(const line of lines){
        if(line.inventoryItemId){
          const stock=await client.query('UPDATE shop_inventory_items SET quantity=quantity-$3,updated_at=NOW() WHERE id=$1 AND shop_id=$2 AND is_active=TRUE AND quantity >= $3 RETURNING unit_cost_paise',[line.inventoryItemId,shopId,line.quantity]);
          if(!stock.rowCount){await client.query('ROLLBACK');return res.status(409).json({error:'Retail product stock changed before checkout. Refresh and try again.'});}
          await client.query(`INSERT INTO shop_stock_movements(shop_id,item_id,movement_type,quantity_delta,unit_cost_paise,note,created_by)
            VALUES($1,$2,'CONSUMPTION',$3,$4,$5,$6)`,
            [shopId,line.inventoryItemId,-line.quantity,stock.rows[0].unit_cost_paise,'Retail sale invoice '+invoice.rows[0].invoice_number,req.user.id]);
          continue;
        }
        if(!line.serviceId)continue;const recipe=await client.query('SELECT item_id,quantity_per_service FROM shop_service_inventory_recipes WHERE shop_id=$1 AND service_id=$2 AND is_active=TRUE ORDER BY item_id',[shopId,line.serviceId]);for(const part of recipe.rows){const consume=Number((Number(part.quantity_per_service)*line.quantity).toFixed(3));const stock=await client.query('UPDATE shop_inventory_items SET quantity=quantity-$3,updated_at=NOW() WHERE id=$1 AND shop_id=$2 AND is_active=TRUE AND quantity >= $3 RETURNING quantity',[part.item_id,shopId,consume]);if(!stock.rowCount){await client.query('ROLLBACK');return res.status(409).json({error:'Insufficient stock to complete this invoice service.'});}await client.query(`INSERT INTO shop_stock_movements(shop_id,item_id,movement_type,quantity_delta,unit_cost_paise,reference,note,created_by) SELECT $1,$2,'CONSUMPTION',$3,unit_cost_paise,$4,$5,$6 FROM shop_inventory_items WHERE id=$2 AND shop_id=$1`,[shopId,part.item_id,-consume,'invoice:'+invoice.id,'Automatic service consumption',req.user.id]);}}
      const allocations=Array.isArray(b.paymentBreakdown)?b.paymentBreakdown:[];
      if(allocations.length){
        const methods=['CASH','UPI','CARD','RAZORPAY'];
        let allocated=0;
        for(const payment of allocations){
          if(!methods.includes(payment.method)||!Number.isSafeInteger(payment.amountPaise)||payment.amountPaise<1||
             (payment.reference!==undefined&&(typeof payment.reference!=='string'||payment.reference.length>120))){
            await client.query('ROLLBACK');return res.status(400).json({error:'Each payment allocation needs a supported method and positive amount.'});
          }
          allocated+=payment.amountPaise;
        }
        if(!validateTenderAllocations(allocations,paid)){await client.query('ROLLBACK');return res.status(400).json({error:'Payment allocations must add up exactly to amountPaidPaise.'});}
        for(const payment of allocations) await client.query(
          `INSERT INTO sales_invoice_payments(invoice_id,method,amount_paise,reference,received_by)
           VALUES($1,$2,$3,$4,$5)`,
          [invoice.id,payment.method,payment.amountPaise,payment.reference||null,req.user.id]);
      } else if(paid>0 && mode!=='MIXED') {
        await client.query(
          `INSERT INTO sales_invoice_payments(invoice_id,method,amount_paise,received_by)
           VALUES($1,$2,$3,$4)`,
          [invoice.id,mode,paid,req.user.id]);
      }
      await client.query('COMMIT');
      res.status(201).json({invoice});
    } catch(error){await client.query('ROLLBACK');throw error;} finally{client.release();}
  }));


  router.get('/shops/:shopId/invoices', ...frontDesk, asyncRoute(async(req,res)=>{
    const shopId=id(req.params.shopId),from=req.query.from,to=req.query.to;
    if(!shopId||!validDate(from)||!validDate(to)||from>to||
       (new Date(to+'T00:00:00Z')-new Date(from+'T00:00:00Z'))/86400000>366)
      return res.status(400).json({error:'Provide a valid shop and date range of at most one year.'});
    if(!await shopAccess(req.user,shopId))return res.status(404).json({error:'Shop not found.'});
    const result=await pool.query(
      `SELECT i.id,i.invoice_number,i.document_type,i.issue_date,i.customer_name,i.subtotal_paise,
       i.discount_paise,i.taxable_paise,i.cgst_paise,i.sgst_paise,i.igst_paise,i.total_paise,
       i.amount_paid_paise,i.payment_mode,i.status,
       COALESCE((SELECT SUM(p.amount_paise) FROM sales_invoice_payments p WHERE p.invoice_id=i.id),0)::bigint allocated_paid_paise
       FROM sales_invoices i WHERE i.shop_id=$1 AND i.issue_date BETWEEN $2::date AND $3::date
       ORDER BY i.issue_date DESC,i.id DESC LIMIT 1000`,[shopId,from,to]);
    res.json({invoices:result.rows});
  }));

  router.get('/invoices/:invoiceId', ...frontDesk, asyncRoute(async(req,res)=>{
    const invoiceId=id(req.params.invoiceId);
    if(!invoiceId)return res.status(400).json({error:'Invalid invoice ID.'});
    const result=await pool.query('SELECT * FROM sales_invoices WHERE id=$1',[invoiceId]);
    if(!result.rowCount||!await shopAccess(req.user,Number(result.rows[0].shop_id)))return res.status(404).json({error:'Invoice not found.'});
    const [lines,payments,credits]=await Promise.all([
      pool.query('SELECT * FROM sales_invoice_lines WHERE invoice_id=$1 ORDER BY id',[invoiceId]),
      pool.query('SELECT method,amount_paise,reference,received_at FROM sales_invoice_payments WHERE invoice_id=$1 ORDER BY id',[invoiceId]),
      pool.query('SELECT * FROM sales_credit_notes WHERE invoice_id=$1 ORDER BY issue_date,id',[invoiceId])
    ]);
    res.json({invoice:result.rows[0],lines:lines.rows,payments:payments.rows,creditNotes:credits.rows});
  }));


  router.put('/admin/shops/:shopId/staff/:staffId/commission', ...admin, asyncRoute(async(req,res)=>{
    const shopId=id(req.params.shopId),staffId=id(req.params.staffId),rate=req.body?.commissionRateBps;
    if(!shopId||!staffId||!Number.isInteger(rate)||rate<0||rate>10000)
      return res.status(400).json({error:'Commission rate must be a whole number from 0 to 10000 basis points.'});
    const result=await pool.query(
      `UPDATE shop_staff SET commission_rate_bps=$3
       WHERE shop_id=$1 AND id=$2 AND is_active=TRUE
       RETURNING id,shop_id,display_name,commission_rate_bps`,[shopId,staffId,rate]);
    if(!result.rowCount)return res.status(404).json({error:'Active barber not found in this shop.'});
    res.json({staff:result.rows[0]});
  }));

  router.get('/admin/shops/:shopId/staff-earnings', ...admin, asyncRoute(async(req,res)=>{
    const shopId=id(req.params.shopId),from=req.query.from,to=req.query.to;
    if(!shopId||!validDate(from)||!validDate(to)||from>to)return res.status(400).json({error:'Provide a valid shop and date range.'});
    const result=await pool.query(
      `SELECT st.id staff_id,st.display_name,
       COUNT(DISTINCT i.id)::int invoice_count,
       COALESCE(SUM(l.taxable_paise),0)::bigint service_sales_paise,
       COALESCE(SUM(l.commission_paise),0)::bigint commission_paise
       FROM sales_invoice_lines l JOIN sales_invoices i ON i.id=l.invoice_id
       JOIN shop_staff st ON st.id=l.staff_id
       WHERE i.shop_id=$1 AND st.shop_id=$1 AND i.issue_date BETWEEN $2::date AND $3::date
         AND i.status='ISSUED'
       GROUP BY st.id,st.display_name ORDER BY commission_paise DESC,st.display_name`,
      [shopId,from,to]);
    res.json({shopId,from,to,staffEarnings:result.rows});
  }));

  router.get('/front-desk/shops/:shopId/retail-products',...frontDesk,asyncRoute(async(req,res)=>{
    const shopId=id(req.params.shopId);if(!shopId||!await shopAccess(req.user,shopId))return res.status(404).json({error:'Shop not found.'});
    const result=await pool.query(`SELECT id,sku,name,unit,quantity,reorder_level,retail_price_paise
      FROM shop_inventory_items WHERE shop_id=$1 AND is_active=TRUE ORDER BY name`,[shopId]);
    res.json({products:result.rows});
  }));

  router.post('/shops/:shopId/daily-close', ...frontDesk, asyncRoute(async(req,res)=>{
    const shopId=id(req.params.shopId),b=req.body||{},date=b.businessDate;
    const amounts=['openingFloatPaise','cashRefundsPaise','cashPaidOutPaise','cashDepositedPaise','cashCountedPaise'];
    if(!shopId||!validDate(date)||amounts.some(k=>!Number.isSafeInteger(b[k])||b[k]<0)||
       (b.note!==undefined&&(typeof b.note!=='string'||b.note.length>1000)))
      return res.status(400).json({error:'Provide a business date and non-negative whole-paise cash figures.'});
    if(!await shopAccess(req.user,shopId))return res.status(404).json({error:'Shop not found.'});
    const cash=await pool.query(
      `SELECT COALESCE(SUM(p.amount_paise),0)::bigint cash_received_paise
       FROM sales_invoice_payments p JOIN sales_invoices i ON i.id=p.invoice_id
       JOIN shops s ON s.id=i.shop_id
       WHERE i.shop_id=$1 AND p.method='CASH'
         AND (p.received_at AT TIME ZONE s.timezone)::date=$2::date
         AND i.status='ISSUED'`,[shopId,date]);
    const received=Number(cash.rows[0].cash_received_paise);
    let expected;
    try{expected=expectedCash({openingFloatPaise:b.openingFloatPaise,cashReceivedPaise:received,cashRefundsPaise:b.cashRefundsPaise,cashPaidOutPaise:b.cashPaidOutPaise,cashDepositedPaise:b.cashDepositedPaise});}
    catch(error){return res.status(400).json({error:error.message});}
    try{
      const result=await pool.query(
        `INSERT INTO shop_daily_closures
         (shop_id,business_date,opening_float_paise,cash_refunds_paise,cash_paid_out_paise,cash_deposited_paise,cash_counted_paise,expected_cash_paise,variance_paise,note,closed_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [shopId,date,b.openingFloatPaise,b.cashRefundsPaise,b.cashPaidOutPaise,b.cashDepositedPaise,b.cashCountedPaise,expected,b.cashCountedPaise-expected,b.note||null,req.user.id]);
      res.status(201).json({closure:result.rows[0],cashReceivedPaise:received});
    }catch(error){if(error.code==='23505')return res.status(409).json({error:'This shop and business date have already been closed.'});throw error;}
  }));

  router.get('/shops/:shopId/daily-close', ...frontDesk, asyncRoute(async(req,res)=>{
    const shopId=id(req.params.shopId),date=req.query.businessDate;
    if(!shopId||!validDate(date))return res.status(400).json({error:'Provide shopId and businessDate.'});
    if(!await shopAccess(req.user,shopId))return res.status(404).json({error:'Shop not found.'});
    const result=await pool.query('SELECT * FROM shop_daily_closures WHERE shop_id=$1 AND business_date=$2::date',[shopId,date]);
    res.json({closure:result.rows[0]||null});
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


  router.get('/shops/:shopId/gst-returns/summary', ...admin, asyncRoute(async(req,res)=>{
    const shopId=id(req.params.shopId),from=req.query.from,to=req.query.to;
    if(!shopId||!validDate(from)||!validDate(to)||from>to)return res.status(400).json({error:'Provide a valid shop and date range.'});
    const shop=await pool.query('SELECT id FROM shops WHERE id=$1 AND is_active=TRUE',[shopId]);
    if(!shop.rowCount)return res.status(404).json({error:'Active shop not found.'});
    const result=await pool.query(
      `SELECT
       COALESCE(SUM(i.taxable_paise),0)::bigint invoice_taxable_paise,
       COALESCE(SUM(i.cgst_paise),0)::bigint invoice_cgst_paise,
       COALESCE(SUM(i.sgst_paise),0)::bigint invoice_sgst_paise,
       COALESCE(SUM(i.igst_paise),0)::bigint invoice_igst_paise,
       COALESCE(SUM(i.total_paise),0)::bigint invoice_total_paise,
       (SELECT COALESCE(SUM(c.taxable_paise),0)::bigint FROM sales_credit_notes c JOIN sales_invoices ci ON ci.id=c.invoice_id
         WHERE ci.document_type='TAX_INVOICE' AND c.shop_id=$1 AND c.issue_date BETWEEN $2::date AND $3::date) credit_taxable_paise,
       (SELECT COALESCE(SUM(c.cgst_paise),0)::bigint FROM sales_credit_notes c JOIN sales_invoices ci ON ci.id=c.invoice_id
         WHERE ci.document_type='TAX_INVOICE' AND c.shop_id=$1 AND c.issue_date BETWEEN $2::date AND $3::date) credit_cgst_paise,
       (SELECT COALESCE(SUM(c.sgst_paise),0)::bigint FROM sales_credit_notes c JOIN sales_invoices ci ON ci.id=c.invoice_id
         WHERE ci.document_type='TAX_INVOICE' AND c.shop_id=$1 AND c.issue_date BETWEEN $2::date AND $3::date) credit_sgst_paise,
       (SELECT COALESCE(SUM(c.igst_paise),0)::bigint FROM sales_credit_notes c JOIN sales_invoices ci ON ci.id=c.invoice_id
         WHERE ci.document_type='TAX_INVOICE' AND c.shop_id=$1 AND c.issue_date BETWEEN $2::date AND $3::date) credit_igst_paise,
       (SELECT COALESCE(SUM(c.total_paise),0)::bigint FROM sales_credit_notes c JOIN sales_invoices ci ON ci.id=c.invoice_id
         WHERE ci.document_type='TAX_INVOICE' AND c.shop_id=$1 AND c.issue_date BETWEEN $2::date AND $3::date) credit_total_paise
       FROM sales_invoices i
       WHERE i.shop_id=$1 AND i.issue_date BETWEEN $2::date AND $3::date
         AND i.document_type='TAX_INVOICE' AND i.status='ISSUED'`,
      [shopId,from,to]);
    const x=result.rows[0];
    const net=(a,b)=>String(Number(x[a])-Number(x[b]));
    res.json({shopId,from,to,filingStatus:'PREPARATION_ONLY',filingPerformed:false,summary:{
      invoiceTaxablePaise:x.invoice_taxable_paise,invoiceCgstPaise:x.invoice_cgst_paise,
      invoiceSgstPaise:x.invoice_sgst_paise,invoiceIgstPaise:x.invoice_igst_paise,invoiceTotalPaise:x.invoice_total_paise,
      creditTaxablePaise:x.credit_taxable_paise,creditCgstPaise:x.credit_cgst_paise,
      creditSgstPaise:x.credit_sgst_paise,creditIgstPaise:x.credit_igst_paise,creditTotalPaise:x.credit_total_paise,
      netTaxablePaise:net('invoice_taxable_paise','credit_taxable_paise'),
      netCgstPaise:net('invoice_cgst_paise','credit_cgst_paise'),
      netSgstPaise:net('invoice_sgst_paise','credit_sgst_paise'),
      netIgstPaise:net('invoice_igst_paise','credit_igst_paise')
    }});
  }));

  router.get('/shops/:shopId/gst-returns/export', ...admin, asyncRoute(async(req,res)=>{
    const shopId=id(req.params.shopId),from=req.query.from,to=req.query.to;
    if(!shopId||!/^\d{4}-\d{2}-\d{2}$/.test(from||'')||!/^\d{4}-\d{2}-\d{2}$/.test(to||'')||from>to) return res.status(400).json({error:'Provide shopId and a valid date range.'});
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
    res.send('\uFEFF'+lines.map(row=>row.map(csv).join(',')).join('\\r\\n'));
  }));

  // Phase 1: shop-scoped front-desk calendar and walk-in operations.
  const frontDeskRoles = [authenticate, requireRole('ADMIN', 'FRONT_DESK')];
  const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(value + 'T00:00:00Z')) &&
    new Date(value + 'T00:00:00Z').toISOString().slice(0,10) === value;


  router.get('/front-desk/shops', ...frontDeskRoles, asyncRoute(async(req,res)=>{
    if(req.user.role==='ADMIN'){
      const all=await pool.query('SELECT id,name,timezone FROM shops WHERE is_active=TRUE ORDER BY name');
      return res.json({shops:all.rows});
    }
    const assigned=await pool.query(
      `SELECT s.id,s.name,s.timezone FROM shops s JOIN shop_front_desk f ON f.shop_id=s.id
       WHERE f.user_id=$1 AND f.is_active=TRUE AND s.is_active=TRUE ORDER BY s.name`,[req.user.id]);
    res.json({shops:assigned.rows});
  }));

  router.get('/front-desk/customers', ...frontDeskRoles, asyncRoute(async(req,res)=>{
    const q=typeof req.query.q==='string'?req.query.q.trim():'';
    const shopId=id(req.query.shopId);
    if(!shopId||!await shopAccess(req.user,shopId)) return res.status(404).json({error:'Shop not found.'});
    if(q.length<2||q.length>100) return res.status(400).json({error:'Search with at least 2 characters.'});
    const result=await pool.query(
      `SELECT id,name,email FROM users WHERE role='CUSTOMER' AND is_active=TRUE
       AND (name ILIKE $1 OR email ILIKE $1)
       AND EXISTS(SELECT 1 FROM appointments a WHERE a.customer_id=users.id AND a.shop_id=$2)
       ORDER BY name LIMIT 20`,['%'+q+'%',shopId]);
    res.json({customers:result.rows});
  }));

  router.get('/front-desk/appointments', ...frontDeskRoles, asyncRoute(async(req,res)=>{
    const shopId=id(req.query.shopId), from=req.query.from, to=req.query.to;
    if(!shopId || !validDate(from) || !validDate(to) || from>to ||
       (new Date(to+'T00:00:00Z')-new Date(from+'T00:00:00Z'))/86400000>31)
      return res.status(400).json({error:'Provide shopId and a valid date range of at most 32 calendar days.'});
    if(!await shopAccess(req.user,shopId)) return res.status(404).json({error:'Shop not found.'});
    const result=await pool.query(
      `SELECT a.id,a.shop_id,a.staff_id,st.display_name staff_name,a.service_id,sv.name service_name,
              sv.duration_minutes,a.customer_id,u.name customer_name,u.email customer_email,
              a.starts_at,a.ends_at,a.status,a.customer_notes,a.created_at
       FROM appointments a JOIN shop_staff st ON st.id=a.staff_id
       JOIN services sv ON sv.id=a.service_id JOIN users u ON u.id=a.customer_id
       WHERE a.shop_id=$1 AND (a.starts_at AT TIME ZONE (SELECT timezone FROM shops WHERE id=$1))::date BETWEEN $2::date AND $3::date
       ORDER BY a.starts_at,st.display_name`,
      [shopId,from,to]);
    res.json({shopId,from,to,appointments:result.rows});
  }));

  router.post('/front-desk/walk-ins', ...frontDeskRoles, asyncRoute(async(req,res)=>{
    const b=req.body||{},shopId=id(b.shopId),staffId=id(b.staffId),serviceId=id(b.serviceId),customerId=id(b.customerId);
    const startsAt=typeof b.startsAt==='string'?new Date(b.startsAt):null;
    if(!shopId||!staffId||!serviceId||!customerId||!startsAt||Number.isNaN(startsAt.getTime())||
       startsAt.getTime()<Date.now()-5*60*1000||startsAt.getTime()>Date.now()+86400000||
       (b.customerNotes!==undefined&&(typeof b.customerNotes!=='string'||b.customerNotes.length>1000)))
      return res.status(400).json({error:'Provide valid shop, staff, service, customer and a walk-in start time within the next 24 hours.'});
    if(!await shopAccess(req.user,shopId)) return res.status(404).json({error:'Shop not found.'});
    const client=await pool.connect();
    try{
      await client.query('BEGIN');
      const context=await client.query(
        `SELECT st.id staff_id,sv.id service_id,sv.duration_minutes
         FROM shop_staff st JOIN services sv ON sv.shop_id=st.shop_id
         JOIN users u ON u.id=$4 AND u.role='CUSTOMER' AND u.is_active=TRUE
         WHERE st.id=$2 AND sv.id=$3 AND st.shop_id=$1 AND st.is_active=TRUE AND sv.is_active=TRUE
           AND (NOT EXISTS(SELECT 1 FROM staff_services ss WHERE ss.staff_id=st.id)
                OR EXISTS(SELECT 1 FROM staff_services ss WHERE ss.staff_id=st.id AND ss.service_id=sv.id))
         FOR UPDATE OF st`,
        [shopId,staffId,serviceId,customerId]);
      if(!context.rowCount){await client.query('ROLLBACK');return res.status(400).json({error:'Customer, service or barber is not active for this shop.'});}
      const endsAt=new Date(startsAt.getTime()+Number(context.rows[0].duration_minutes)*60000);
      const working=await client.query(
        `SELECT 1 FROM staff_working_hours wh JOIN shop_staff st ON st.id=wh.staff_id
         JOIN shops sh ON sh.id=st.shop_id
         WHERE wh.staff_id=$1 AND wh.is_active=TRUE
           AND wh.day_of_week=EXTRACT(DOW FROM ($2::timestamptz AT TIME ZONE sh.timezone))::int
           AND ($2::timestamptz AT TIME ZONE sh.timezone)::time>=wh.opens_at
           AND ($3::timestamptz AT TIME ZONE sh.timezone)::time<=wh.closes_at`,
        [staffId,startsAt.toISOString(),endsAt.toISOString()]);
      if(!working.rowCount){await client.query('ROLLBACK');return res.status(409).json({error:'Barber is outside their working hours.'});}
      const off=await client.query(
        'SELECT 1 FROM staff_time_off WHERE staff_id=$1 AND tstzrange(starts_at,ends_at,\'[)\') && tstzrange($2::timestamptz,$3::timestamptz,\'[)\')',
        [staffId,startsAt.toISOString(),endsAt.toISOString()]);
      if(off.rowCount){await client.query('ROLLBACK');return res.status(409).json({error:'Barber is unavailable during this time.'});}
      const inserted=await client.query(
        `INSERT INTO appointments(shop_id,staff_id,service_id,customer_id,starts_at,ends_at,status,customer_notes)
         VALUES($1,$2,$3,$4,$5,$6,'CONFIRMED',$7) RETURNING *`,
        [shopId,staffId,serviceId,customerId,startsAt.toISOString(),endsAt.toISOString(),b.customerNotes||'Walk-in']);
      await client.query(
        `INSERT INTO appointment_events(appointment_id,shop_id,actor_user_id,event_type,to_status,details)
         VALUES($1,$2,$3,'WALK_IN_CREATED','CONFIRMED',$4)`,
        [inserted.rows[0].id,shopId,req.user.id,JSON.stringify({source:'front-desk'})]);
      await client.query('COMMIT');
      res.status(201).json({appointment:inserted.rows[0]});
    }catch(error){
      await client.query('ROLLBACK');
      if(error.code==='23P01') return res.status(409).json({error:'This barber already has an appointment at that time.'});
      throw error;
    }finally{client.release();}
  }));

  router.patch('/front-desk/appointments/:appointmentId/status', ...frontDeskRoles, asyncRoute(async(req,res)=>{
    const appointmentId=id(req.params.appointmentId),shopId=id(req.body?.shopId),nextStatus=req.body?.status;
    const allowed={
      BOOKED:['CONFIRMED','CANCELLED','NO_SHOW'],
      CONFIRMED:['IN_PROGRESS','CANCELLED','NO_SHOW'],
      IN_PROGRESS:['READY_TO_BILL','CANCELLED'],
      READY_TO_BILL:['COMPLETED','CANCELLED']
    };
    if(!appointmentId||!shopId||!Object.hasOwn(allowed,req.body?.fromStatus)||!allowed[req.body.fromStatus].includes(nextStatus))
      return res.status(400).json({error:'Invalid appointment status transition.'});
    if(!await shopAccess(req.user,shopId)) return res.status(404).json({error:'Shop not found.'});
    if(nextStatus==='NO_SHOW'){
      const missed=await pool.query('SELECT ends_at FROM appointments WHERE id=$1 AND shop_id=$2',[appointmentId,shopId]);
      if(missed.rowCount&&new Date(missed.rows[0].ends_at).getTime()>=Date.now())
        return res.status(409).json({error:'A no-show fee can only be recorded after the appointment end time.'});
    }
    if(nextStatus==='CONFIRMED'){
      const deposit=await pool.query('SELECT deposit_due_paise,deposit_paid_paise FROM appointments WHERE id=$1 AND shop_id=$2',[appointmentId,shopId]);
      if(deposit.rowCount&&Number(deposit.rows[0].deposit_due_paise)>Number(deposit.rows[0].deposit_paid_paise))
        return res.status(409).json({error:'The booking deposit must be paid before confirming this appointment.'});
    }
    const client=await pool.connect();
    try{
      await client.query('BEGIN');
      const updated=await client.query(
        `UPDATE appointments SET status=$3,
         no_show_fee_due_paise=CASE WHEN $3='NO_SHOW' THEN COALESCE((SELECT no_show_fee_paise FROM shop_booking_policies WHERE shop_id=$2),0) ELSE no_show_fee_due_paise END,
         no_show_fee_status=CASE WHEN $3='NO_SHOW' AND COALESCE((SELECT no_show_fee_paise FROM shop_booking_policies WHERE shop_id=$2),0)>0 THEN 'DUE' WHEN $3='NO_SHOW' THEN 'NOT_DUE' ELSE no_show_fee_status END,
         updated_at=NOW() WHERE id=$1 AND shop_id=$2 AND status=$4 RETURNING *`,
        [appointmentId,shopId,nextStatus,req.body.fromStatus]);
      if(!updated.rowCount){await client.query('ROLLBACK');return res.status(409).json({error:'Appointment not found or its status changed. Refresh the calendar and try again.'});}
      await client.query(
        `INSERT INTO appointment_events(appointment_id,shop_id,actor_user_id,event_type,from_status,to_status)
         VALUES($1,$2,$3,'STATUS_CHANGED',$4,$5)`,
        [appointmentId,shopId,req.user.id,req.body.fromStatus,nextStatus]);
      await client.query('COMMIT');
      if(['CANCELLED','NO_SHOW'].includes(nextStatus))await pool.query("UPDATE shop_customer_reminders SET status='CANCELLED',processing_at=NULL WHERE appointment_id=$1 AND template_key IN('APPOINTMENT_REMINDER_24H','APPOINTMENT_REMINDER_2H') AND status IN('PENDING','PROCESSING')",[appointmentId]);
      let waitlistOfferQueued=false;
      if(nextStatus==='CANCELLED'){try{waitlistOfferQueued=Boolean(await offerWaitlistEntry(pool,shopId,null,appointmentId))}catch(e){console.error('Front-desk waitlist auto-fill failed',appointmentId,e.message)}}
      res.json({appointment:updated.rows[0],waitlistOfferQueued});
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  }));

  return router;
}
module.exports={createOperationsRouter};
