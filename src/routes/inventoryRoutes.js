const express=require('express');
const crypto=require('node:crypto');
const {createAuthMiddleware}=require('../auth/middleware');
function createInventoryRouter(pool,tokenService){
 const router=express.Router(),{authenticate,requireRole}=createAuthMiddleware(pool,tokenService),admin=[authenticate,requireRole('ADMIN')];
 const asyncRoute=fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);
 const id=v=>/^[1-9]\d*$/.test(String(v))&&Number.isSafeInteger(Number(v))?Number(v):null;
 const qty=v=>typeof v==='number'&&Number.isFinite(v)&&v>0&&v<=1000000&&Number(v.toFixed(3))===v;
 const validShop=async shopId=>(await pool.query('SELECT 1 FROM shops WHERE id=$1 AND is_active=TRUE',[shopId])).rowCount>0;

 router.get('/admin/shops/:shopId/inventory',...admin,asyncRoute(async(req,res)=>{
  const shopId=id(req.params.shopId);if(!shopId)return res.status(400).json({error:'Invalid shop id.'});
  if(!await validShop(shopId))return res.status(404).json({error:'Active shop not found.'});
  const [items,suppliers]=await Promise.all([
   pool.query('SELECT * FROM shop_inventory_items WHERE shop_id=$1 AND is_active=TRUE ORDER BY name',[shopId]),
   pool.query('SELECT * FROM shop_suppliers WHERE shop_id=$1 AND is_active=TRUE ORDER BY name',[shopId])
  ]);
  res.json({items:items.rows,suppliers:suppliers.rows,lowStock:items.rows.filter(x=>Number(x.quantity)<=Number(x.reorder_level))});
 }));
 router.post('/admin/shops/:shopId/inventory/items',...admin,asyncRoute(async(req,res)=>{
  const shopId=id(req.params.shopId),b=req.body||{};
  if(!shopId||typeof b.sku!=='string'||!b.sku.trim()||b.sku.length>64||typeof b.name!=='string'||!b.name.trim()||b.name.length>160||
   typeof (b.unit||'piece')!=='string'||(b.unit||'piece').length>24||
   !Number.isFinite(b.reorderLevel??0)||(b.reorderLevel??0)<0||!Number.isSafeInteger(b.unitCostPaise??0)||(b.unitCostPaise??0)<0)
   return res.status(400).json({error:'Provide valid SKU, item name, unit, reorder level and unit cost.'});
  if(!await validShop(shopId))return res.status(404).json({error:'Active shop not found.'});
  try{
   const r=await pool.query(`INSERT INTO shop_inventory_items(shop_id,sku,name,description,unit,reorder_level,unit_cost_paise)
    VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [shopId,b.sku.trim(),b.name.trim(),b.description||null,b.unit||'piece',b.reorderLevel??0,b.unitCostPaise??0]);
   res.status(201).json({item:r.rows[0]});
  }catch(e){if(e.code==='23505')return res.status(409).json({error:'SKU already exists for this shop.'});throw e;}
 }));
 router.post('/admin/shops/:shopId/inventory/suppliers',...admin,asyncRoute(async(req,res)=>{
  const shopId=id(req.params.shopId),b=req.body||{};
  if(!shopId||typeof b.name!=='string'||!b.name.trim()||b.name.length>160||
   (b.email&&(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email)||b.email.length>254))||
   (b.phone&&(typeof b.phone!=='string'||b.phone.length>30))||
   (b.gstin&&(typeof b.gstin!=='string'||!/^[0-9A-Z]{15}$/.test(b.gstin))))
   return res.status(400).json({error:'Provide a valid supplier name and optional contact details.'});
  if(!await validShop(shopId))return res.status(404).json({error:'Active shop not found.'});
  const r=await pool.query(`INSERT INTO shop_suppliers(shop_id,name,contact_name,email,phone,gstin,address)
   VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
   [shopId,b.name.trim(),b.contactName||null,b.email||null,b.phone||null,b.gstin||null,b.address||null]);
  res.status(201).json({supplier:r.rows[0]});
 }));
 router.post('/admin/shops/:shopId/inventory/adjustments',...admin,asyncRoute(async(req,res)=>{
  const shopId=id(req.params.shopId),b=req.body||{},itemId=id(b.itemId),delta=b.quantityDelta;
  if(!shopId||!itemId||typeof delta!=='number'||!Number.isFinite(delta)||delta===0||Math.abs(delta)>1000000||Number(delta.toFixed(3))!==delta||
    !['ADJUSTMENT','CONSUMPTION','RETURN','OPENING'].includes(b.movementType)||typeof b.note!=='string'||!b.note.trim()||b.note.length>500)
   return res.status(400).json({error:'Provide item, non-zero quantity delta, movement type and reason.'});
  const client=await pool.connect();
  try{
   await client.query('BEGIN');
   const item=await client.query('SELECT quantity,unit_cost_paise FROM shop_inventory_items WHERE id=$1 AND shop_id=$2 AND is_active=TRUE FOR UPDATE',[itemId,shopId]);
   if(!item.rowCount){await client.query('ROLLBACK');return res.status(404).json({error:'Active inventory item not found.'});}
   const next=Number(item.rows[0].quantity)+delta;
   if(next<0){await client.query('ROLLBACK');return res.status(400).json({error:'Stock cannot become negative.'});}
   await client.query('UPDATE shop_inventory_items SET quantity=$3,updated_at=NOW() WHERE id=$1 AND shop_id=$2',[itemId,shopId,next]);
   const movement=await client.query(`INSERT INTO shop_stock_movements(shop_id,item_id,movement_type,quantity_delta,unit_cost_paise,note,created_by)
    VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [shopId,itemId,b.movementType,delta,item.rows[0].unit_cost_paise,b.note.trim(),req.user.id]);
   await client.query('COMMIT');res.status(201).json({movement:movement.rows[0],quantity:next});
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
 }));
 router.post('/admin/shops/:shopId/purchase-orders',...admin,asyncRoute(async(req,res)=>{
  const shopId=id(req.params.shopId),b=req.body||{},supplierId=id(b.supplierId);
  if(!shopId||!supplierId||!Array.isArray(b.items)||!b.items.length||b.items.length>100||
   b.items.some(x=>!id(x.itemId)||!qty(x.quantity)||!Number.isSafeInteger(x.unitCostPaise)||x.unitCostPaise<0))
   return res.status(400).json({error:'Provide supplier and 1–100 valid item lines.'});
  const client=await pool.connect();
  try{
   await client.query('BEGIN');
   const supplier=await client.query('SELECT id FROM shop_suppliers WHERE id=$1 AND shop_id=$2 AND is_active=TRUE',[supplierId,shopId]);
   if(!supplier.rowCount){await client.query('ROLLBACK');return res.status(404).json({error:'Supplier not found for this shop.'});}
   const ids=b.items.map(x=>x.itemId);
   const found=await client.query('SELECT id FROM shop_inventory_items WHERE shop_id=$1 AND id=ANY($2::bigint[]) AND is_active=TRUE',[shopId,ids]);
   if(found.rowCount!==new Set(ids).size){await client.query('ROLLBACK');return res.status(400).json({error:'Every purchase item must be unique and belong to this shop.'});}
   const count=await client.query('SELECT COUNT(*)::int n FROM shop_purchase_orders WHERE shop_id=$1',[shopId]);
   const number='PO-'+Date.now().toString(36).toUpperCase()+'-'+crypto.randomBytes(3).toString('hex').toUpperCase();
   const po=await client.query(`INSERT INTO shop_purchase_orders(shop_id,supplier_id,order_number,status,notes,created_by)
    VALUES($1,$2,$3,'ORDERED',$4,$5) RETURNING *`,[shopId,supplierId,number,b.notes||null,req.user.id]);
   for(const line of b.items)await client.query(`INSERT INTO shop_purchase_order_lines(purchase_order_id,item_id,ordered_quantity,unit_cost_paise)
    VALUES($1,$2,$3,$4)`,[po.rows[0].id,line.itemId,line.quantity,line.unitCostPaise]);
   await client.query('COMMIT');res.status(201).json({purchaseOrder:po.rows[0]});
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
 }));
 router.post('/admin/shops/:shopId/purchase-orders/:orderId/receive',...admin,asyncRoute(async(req,res)=>{
  const shopId=id(req.params.shopId),orderId=id(req.params.orderId),received= req.body?.items;
  if(!shopId||!orderId||!Array.isArray(received)||!received.length||received.some(x=>!id(x.lineId)||!qty(x.quantity)))
   return res.status(400).json({error:'Provide purchase order lines and positive received quantities.'});
  const client=await pool.connect();
  try{
   await client.query('BEGIN');
   const po=await client.query('SELECT * FROM shop_purchase_orders WHERE id=$1 AND shop_id=$2 FOR UPDATE',[orderId,shopId]);
   if(!po.rowCount||['CANCELLED','RECEIVED'].includes(po.rows[0].status)){await client.query('ROLLBACK');return res.status(404).json({error:'Open purchase order not found.'});}
   for(const entry of received){
    const line=await client.query(`SELECT l.*,i.quantity FROM shop_purchase_order_lines l
     JOIN shop_inventory_items i ON i.id=l.item_id
     WHERE l.id=$1 AND l.purchase_order_id=$2 AND i.shop_id=$3 FOR UPDATE OF l,i`,[entry.lineId,orderId,shopId]);
    if(!line.rowCount){await client.query('ROLLBACK');return res.status(400).json({error:'Purchase order line does not belong to this shop and order.'});}
    const x=line.rows[0],remaining=Number(x.ordered_quantity)-Number(x.received_quantity);
    if(entry.quantity>remaining){await client.query('ROLLBACK');return res.status(400).json({error:'Received quantity exceeds outstanding order quantity.'});}
    await client.query('UPDATE shop_purchase_order_lines SET received_quantity=received_quantity+$2 WHERE id=$1',[entry.lineId,entry.quantity]);
    await client.query('UPDATE shop_inventory_items SET quantity=quantity+$2,unit_cost_paise=$3,updated_at=NOW() WHERE id=$1',[x.item_id,entry.quantity,x.unit_cost_paise]);
    await client.query(`INSERT INTO shop_stock_movements(shop_id,item_id,movement_type,quantity_delta,unit_cost_paise,reference,note,created_by)
     VALUES($1,$2,'PURCHASE',$3,$4,$5,'Purchase order receipt',$6)`,
     [shopId,x.item_id,entry.quantity,x.unit_cost_paise,po.rows[0].order_number,req.user.id]);
   }
   const state=await client.query(`SELECT BOOL_AND(received_quantity=ordered_quantity) complete,
    BOOL_OR(received_quantity>0) partial FROM shop_purchase_order_lines WHERE purchase_order_id=$1`,[orderId]);
   const status=state.rows[0].complete?'RECEIVED':state.rows[0].partial?'PART_RECEIVED':'ORDERED';
   await client.query('UPDATE shop_purchase_orders SET status=$2,updated_at=NOW() WHERE id=$1',[orderId,status]);
   await client.query('COMMIT');res.json({purchaseOrderId:orderId,status});
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
 }));
 router.get('/admin/shops/:shopId/purchase-orders',...admin,asyncRoute(async(req,res)=>{
  const shopId=id(req.params.shopId);if(!shopId)return res.status(400).json({error:'Invalid shop id.'});
  const r=await pool.query(`SELECT p.*,s.name supplier_name,
   (SELECT json_agg(json_build_object('id',l.id,'itemId',l.item_id,'orderedQuantity',l.ordered_quantity,'receivedQuantity',l.received_quantity,'unitCostPaise',l.unit_cost_paise))
    FROM shop_purchase_order_lines l WHERE l.purchase_order_id=p.id) items
   FROM shop_purchase_orders p JOIN shop_suppliers s ON s.id=p.supplier_id
   WHERE p.shop_id=$1 ORDER BY p.created_at DESC LIMIT 300`,[shopId]);
  res.json({purchaseOrders:r.rows});
 }));
 router.get('/admin/shops/:shopId/workforce/attendance',...admin,asyncRoute(async(req,res)=>{
  const shopId=id(req.params.shopId),from=req.query.from,to=req.query.to;
  if(!shopId||!/^\d{4}-\d{2}-\d{2}$/.test(from||'')||!/^\d{4}-\d{2}-\d{2}$/.test(to||'')||from>to)
   return res.status(400).json({error:'Provide shop and valid date range.'});
  const r=await pool.query(`SELECT a.*,s.display_name FROM shop_staff_attendance a JOIN shop_staff s ON s.id=a.staff_id
   WHERE a.shop_id=$1 AND a.work_date BETWEEN $2::date AND $3::date ORDER BY a.work_date DESC,s.display_name`,[shopId,from,to]);
  res.json({attendance:r.rows});
 }));
 router.post('/admin/shops/:shopId/workforce/attendance/clock-in',...admin,asyncRoute(async(req,res)=>{
  const shopId=id(req.params.shopId),staffId=id(req.body?.staffId);
  if(!shopId||!staffId)return res.status(400).json({error:'Valid staffId is required.'});
  const staff=await pool.query('SELECT id FROM shop_staff WHERE id=$1 AND shop_id=$2 AND is_active=TRUE',[staffId,shopId]);
  if(!staff.rowCount)return res.status(404).json({error:'Active staff member not found for this shop.'});
  const r=await pool.query(`INSERT INTO shop_staff_attendance(shop_id,staff_id,work_date,clock_in_at,recorded_by)
   VALUES($1,$2,(NOW() AT TIME ZONE 'Asia/Kolkata')::date,NOW(),$3)
   ON CONFLICT(staff_id,work_date) DO NOTHING RETURNING *`,[shopId,staffId,req.user.id]);
  if(!r.rowCount)return res.status(409).json({error:'Attendance already exists for this staff member today.'});
  res.status(201).json({attendance:r.rows[0]});
 }));
 router.post('/admin/shops/:shopId/workforce/attendance/:attendanceId/clock-out',...admin,asyncRoute(async(req,res)=>{
  const shopId=id(req.params.shopId),attendanceId=id(req.params.attendanceId);
  if(!shopId||!attendanceId)return res.status(400).json({error:'Invalid attendance id.'});
  const r=await pool.query(`UPDATE shop_staff_attendance SET clock_out_at=NOW()
   WHERE id=$1 AND shop_id=$2 AND clock_out_at IS NULL RETURNING *`,[attendanceId,shopId]);
  if(!r.rowCount)return res.status(404).json({error:'Open attendance record not found.'});
  res.json({attendance:r.rows[0]});
 }));
 return router;
}
module.exports={createInventoryRouter};
