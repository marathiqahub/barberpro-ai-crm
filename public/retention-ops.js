(()=>{'use strict';
const token=()=>localStorage.getItem('bp_access')||'';
const api=async(path,options={})=>{const r=await fetch('/api'+path,{...options,headers:{'Content-Type':'application/json',Authorization:'Bearer '+token(),...(options.headers||{})}});const d=await r.json().catch(()=>({}));if(!r.ok)throw Error(d.error||'Request failed');return d};
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=v=>'₹'+(Number(v||0)/100).toFixed(2);
const notice=(root,msg)=>{const el=root.querySelector('[data-status]');if(el)el.textContent=msg};
const selectedShop=()=>document.querySelector('#ops-shop')?.value||'';
async function mountAdmin(){
 const source=document.querySelector('#ops-shop'),shell=document.querySelector('#app .shell');
 if(!source||!shell||document.getElementById('bp-retention-admin'))return;
 const panel=document.createElement('section');panel.className='panel';panel.id='bp-retention-admin';
 panel.innerHTML=`<h2>Bookings, retention &amp; customer protection</h2>
 <p class="muted">Configure deposits, cancellation policy, review requests, retail pricing and customer data requests. WhatsApp/SMS delivery still requires approved provider templates and consent.</p>
 <div class="rowform"><label>Shop<select id="bp-retention-shop"></select></label><button type="button" id="bp-retention-refresh" class="primary">Refresh</button><a id="bp-queue-link" target="_blank" rel="noopener">Open live queue screen</a></div>
 <h3>Deposit and no-show policy</h3><form id="bp-policy" class="rowform">
 <label><input type="checkbox" name="depositEnabled"> Require booking deposit</label>
 <label>Deposit type<select name="depositType"><option value="FIXED">Fixed amount (₹)</option><option value="PERCENT">Percentage (%)</option></select></label>
 <label>Deposit value (₹ or %)<input name="depositValue" type="number" min="0" max="100" step=".01" value="0" required></label>
 <label>Cancellation notice (hours)<input name="cancellationNoticeHours" type="number" min="0" max="720" value="24"></label>
 <label>No-show fee (₹)<input name="noShowFee" type="number" min="0" step=".01" value="0"></label>
 <label><input type="checkbox" name="reviewRequestsEnabled"> Enable post-visit review prompts</label>
 <label>Google review URL<input name="googleReviewUrl" type="url" placeholder="https://g.page/r/..."></label>
 <label>Cancellation policy text<textarea name="policyText" rows="2" maxlength="2000"></textarea></label>
 <button class="primary">Save booking policy</button></form>
 <h3>Waitlist</h3><div id="bp-waitlist" class="list"></div>
 <h3>Failed reminders</h3><div id="bp-failed-reminders" class="list"></div><h3>Clients due for rebooking</h3><div id="bp-rebooking" class="list"></div>
 <h3>Retail products and stock</h3><div id="bp-retail" class="list"></div>
 <h3>Customer consent history</h3><div id="bp-consents" class="list"></div><h3>Customer data requests</h3><div id="bp-rights" class="list"></div>
 <p class="muted" data-status role="status"></p>`;
 source.closest('.panel')?.after(panel);if(!panel.isConnected)shell.append(panel);
 const shop=document.getElementById('bp-retention-shop');
 shop.innerHTML=[...source.options].map(o=>'<option value="'+esc(o.value)+'">'+esc(o.textContent)+'</option>').join('');
 shop.value=source.value;source.addEventListener('change',()=>{shop.value=source.value;loadAdmin()});
 shop.addEventListener('change',loadAdmin);document.getElementById('bp-retention-refresh').onclick=loadAdmin;panel.querySelector('[name=depositType]').addEventListener('change',e=>{panel.querySelector('[name=depositValue]').max=e.target.value==='PERCENT'?'100':'';});
 panel.querySelector('#bp-policy').onsubmit=async e=>{e.preventDefault();const f=new FormData(e.target);try{
  await api('/admin/shops/'+shop.value+'/booking-policy',{method:'PUT',body:JSON.stringify({
   depositEnabled:e.target.depositEnabled.checked,depositType:f.get('depositType'),depositValue:Math.round(Number(f.get('depositValue'))*100),
   cancellationNoticeHours:Number(f.get('cancellationNoticeHours')),noShowFeePaise:Math.round(Number(f.get('noShowFee'))*100),
   reviewRequestsEnabled:e.target.reviewRequestsEnabled.checked,googleReviewUrl:f.get('googleReviewUrl')||null,policyText:f.get('policyText')||null})});
  notice(panel,'Booking policy saved. Deposits are collected through Razorpay checkout; no-show fees are not auto-charged.');}catch(x){notice(panel,x.message)}};
 async function loadAdmin(){const id=shop.value;if(!id)return;document.getElementById('bp-queue-link').href='/queue/'+id;
  try{
   const p=await api('/admin/shops/'+id+'/booking-policy'),f=panel.querySelector('#bp-policy');
   f.depositEnabled.checked=!!p.policy.deposit_enabled;f.depositType.value=p.policy.deposit_type||'FIXED';f.depositValue.value=(Number(p.policy.deposit_value||0)/100).toFixed(2);f.depositValue.max=p.policy.deposit_type==='PERCENT'?'100':'';
   f.cancellationNoticeHours.value=p.policy.cancellation_notice_hours??24;f.noShowFee.value=(Number(p.policy.no_show_fee_paise||0)/100).toFixed(2);
   f.reviewRequestsEnabled.checked=!!p.policy.review_requests_enabled;f.googleReviewUrl.value=p.policy.google_review_url||'';f.policyText.value=p.policy.policy_text||'';
   const [w,d,r,products,consents,failed]=await Promise.all([
    api('/admin/shops/'+id+'/waitlist'),api('/admin/shops/'+id+'/rebooking-due'),
    api('/admin/shops/'+id+'/data-rights-requests'),api('/admin/shops/'+id+'/inventory/retail-products'),api('/admin/shops/'+id+'/consent-events'),api('/admin/shops/'+id+'/reminders/failed')
   ]);
   panel.querySelector('#bp-waitlist').innerHTML=w.entries.map(x=>'<div class="item"><div><strong>'+esc(x.customer_name)+' · '+esc(x.service_name)+'</strong><small>'+esc(x.requested_date)+' · '+esc(x.status)+' · '+esc(x.preferred_barber||'Any barber')+'</small></div></div>').join('')||'<div class="empty">No active waitlist entries.</div>';
   panel.querySelector('#bp-failed-reminders').innerHTML=failed.reminders.map(x=>'<div class="item"><div><strong>'+esc(x.customer_name)+' · '+esc(x.template_key)+'</strong><small>'+esc(x.channel)+' · '+esc(x.error_code||'DELIVERY_FAILED')+' · attempts '+esc(x.attempt_count)+'</small></div><button data-retry-reminder="'+x.id+'">Retry</button></div>').join('')||'<div class="empty">No failed reminders.</div>';
   panel.querySelectorAll('[data-retry-reminder]').forEach(b=>b.onclick=async()=>{try{await api('/admin/shops/'+id+'/reminders/'+b.dataset.retryReminder+'/retry',{method:'POST',body:'{}'});notice(panel,'Reminder requeued.');await loadAdmin()}catch(x){notice(panel,x.message)}});
   panel.querySelector('#bp-rebooking').innerHTML=d.customers.map(x=>'<div class="item"><div><strong>'+esc(x.name)+'</strong><small>Last visit '+esc(String(x.last_visit).slice(0,10))+' · interval '+esc(x.preferred_interval_days)+' days · due '+esc(String(x.due_at).slice(0,10))+'</small></div></div>').join('')||'<div class="empty">No customers are due for rebooking.</div>';
   panel.querySelector('#bp-retail').innerHTML=products.products.map(x=>'<form class="item bp-retail-price" data-id="'+x.id+'"><div><strong>'+esc(x.name)+' · '+esc(x.sku)+'</strong><small>Stock '+esc(x.quantity)+' '+esc(x.unit)+(x.low_stock?' · LOW STOCK':'')+'</small></div><label>Retail price ₹<input name="price" type="number" min="0" step=".01" value="'+(Number(x.retail_price_paise)/100).toFixed(2)+'"></label><button>Save price</button></form>').join('')||'<div class="empty">No stock items yet.</div>';
   panel.querySelectorAll('.bp-retail-price').forEach(form=>form.onsubmit=async e=>{e.preventDefault();try{await api('/admin/shops/'+id+'/inventory/items/'+form.dataset.id+'/retail-price',{method:'PUT',body:JSON.stringify({retailPricePaise:Math.round(Number(form.price.value)*100)})});notice(panel,'Retail price saved.');await loadAdmin()}catch(x){notice(panel,x.message)}});
   panel.querySelector('#bp-consents').innerHTML=consents.events.map(x=>'<div class="item"><div><strong>'+esc(x.customer_name)+' · '+esc(x.purpose)+(x.channel?' · '+esc(x.channel):'')+'</strong><small>'+(x.consent?'Granted':'Revoked')+' · '+esc(x.notice_version||'')+' · '+esc(String(x.recorded_at).slice(0,19))+'</small></div></div>').join('')||'<div class="empty">No consent events recorded.</div>';
   panel.querySelector('#bp-rights').innerHTML=r.requests.map(x=>'<div class="item"><div><strong>'+esc(x.request_type)+' · '+esc(x.customer_name)+'</strong><small>'+esc(x.email)+' · '+esc(x.status)+' · '+esc(String(x.requested_at).slice(0,10))+'</small></div><div class="actions">'+(x.status==='REQUESTED'||x.status==='IN_REVIEW'?'<button data-rights="'+x.id+'" data-status="IN_REVIEW">Review</button><button data-rights="'+x.id+'" data-status="COMPLETED">Complete</button><button data-rights="'+x.id+'" data-status="REJECTED">Reject</button>':'')+'</div></div>').join('')||'<div class="empty">No customer data requests.</div>';
   panel.querySelectorAll('[data-rights]').forEach(b=>b.onclick=async()=>{const note=prompt('Resolution note (required for audit):','Reviewed by shop administrator');if(note===null)return;try{await api('/admin/data-rights-requests/'+b.dataset.rights,{method:'PATCH',body:JSON.stringify({status:b.dataset.status,resolutionNote:note})});notice(panel,'Request status updated. No customer data was automatically deleted.');await loadAdmin()}catch(x){notice(panel,x.message)}});
  }catch(x){notice(panel,x.message)}
 }
 await loadAdmin();
}
async function mountCustomer(){
 const book=document.querySelector('#book'),bookings=document.querySelector('#bookings');
 if(!book||!bookings||document.getElementById('bp-customer-retention'))return;
 if(!document.getElementById('bp-ai-receptionist')){
  const receptionist=document.createElement('section');receptionist.className='panel';receptionist.id='bp-ai-receptionist';
  receptionist.innerHTML='<h2>AI receptionist</h2><p class="muted">Ask about services, prices or booking. It can hand you off to live slots, but it never creates a booking itself.</p><div id="bp-receptionist-reply" class="list" aria-live="polite"></div><form id="bp-receptionist-form" class="rowform"><label>Ask the receptionist<input name="message" maxlength="500" required placeholder="Do you have a haircut slot tomorrow?"></label><button class="primary">Ask</button></form><div id="bp-receptionist-handoff"></div>';
  book.closest('.panel')?.after(receptionist);
  const conversation=[];
  receptionist.querySelector('#bp-receptionist-form').onsubmit=async e=>{e.preventDefault();const input=e.target.message,message=input.value.trim();if(!message)return;input.value='';const out=receptionist.querySelector('#bp-receptionist-reply');out.textContent='Checking shop information…';try{const r=await fetch('/api/ai/receptionist',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({shopId:Number(book.shopId.value),message,conversation:conversation.slice(-8)})});const d=await r.json();if(!r.ok)throw Error(d.error||'Receptionist unavailable');conversation.push({role:'user',content:message},{role:'assistant',content:d.reply});out.textContent=d.reply;const handoff=receptionist.querySelector('#bp-receptionist-handoff');handoff.replaceChildren();if(d.bookingHandoff){const note=document.createElement('p');note.className='muted';note.textContent='Live availability is ready. Choose a service and time, then explicitly submit the booking; nothing has been booked yet.';const button=document.createElement('button');button.type='button';button.className='primary';button.textContent='Find live slots';button.onclick=()=>{const assistant=document.getElementById('bp-assistant');if(assistant)assistant.scrollIntoView({behavior:'smooth',block:'start'});else book.scrollIntoView({behavior:'smooth',block:'start'});};handoff.append(note,button);}}catch(x){out.textContent=x.message}};
 }
 const panel=document.createElement('section');panel.className='panel';panel.id='bp-customer-retention';
 panel.innerHTML=`<h2>Your preferences &amp; privacy</h2><p id="bp-cancel-policy" class="muted"></p>
 <form id="bp-preferences" class="rowform"><label>Preferred barber<select name="preferredStaffId"><option value="">No preference</option></select></label>
 <label>Preferred service<select name="preferredServiceId"><option value="">No preference</option></select></label>
 <label>Usual visit interval (days)<input name="preferredIntervalDays" type="number" min="7" max="180" value="21"></label>
 <label><input type="checkbox" name="profileNotesConsent"> I consent to storing my skin and allergy notes for appointment service</label><label>Skin preferences (optional)<textarea name="skinNotes" maxlength="1000" rows="2"></textarea></label>
 <label>Allergy notes (optional)<textarea name="allergyNotes" maxlength="1000" rows="2"></textarea></label>
 <label><input type="checkbox" name="photoConsent"> I consent to storing before/after photo references for my appointments</label>
 <label>Before photo URL<input name="beforePhotoUrl" type="url" placeholder="https://..."></label>
 <label>After photo URL<input name="afterPhotoUrl" type="url" placeholder="https://..."></label><button class="primary">Save preferences</button></form>
 <h3>Join a waitlist</h3><form id="bp-waitlist-form" class="rowform"><label>Service<select name="serviceId" required></select></label><label>Date<input name="requestedDate" type="date" required></label><label>Preferred barber<select name="preferredStaffId"><option value="">Any barber</option></select></label><label>From<input name="preferredTimeStart" type="time"></label><label>Until<input name="preferredTimeEnd" type="time"></label><button>Join waitlist</button></form><div id="bp-customer-waitlist" class="list"></div>
 <h3>Rate a completed visit</h3><form id="bp-review-form" class="rowform"><label>Completed appointment<select name="appointmentId" required></select></label><label>Rating<select name="rating"><option value="5">5 — Great</option><option value="4">4 — Good</option><option value="3">3 — Okay</option><option value="2">2 — Poor</option><option value="1">1 — Bad</option></select></label><label>Private comment<textarea name="comment" maxlength="1500" rows="2"></textarea></label><button class="primary">Submit feedback</button></form>
 <div class="actions"><button type="button" id="bp-export">Export my data</button><button type="button" id="bp-delete-request">Request account data deletion</button></div>
 <p class="muted" data-status role="status"></p>`;
 bookings.closest('.panel')?.after(panel);if(!panel.isConnected)bookings.parentElement.append(panel);
 const shop=book.shopId,service=book.serviceId;
 async function loadOptions(){
  const [services,staff,appointments,waitlist,policy]=await Promise.all([api('/shops/'+shop.value+'/services'),api('/shops/'+shop.value+'/staff'),api('/appointments/mine'),api('/customer/waitlist'),api('/shops/'+shop.value+'/booking-policy')]);
  const deposit=policy.policy.deposit_enabled?(policy.policy.deposit_type==='PERCENT'?'Deposit: '+(Number(policy.policy.deposit_value)/100).toFixed(2)+'%':'Fixed deposit: '+money(Number(policy.policy.deposit_value)/100)):'No booking deposit required';panel.querySelector('#bp-cancel-policy').textContent=deposit+' · Cancellation notice: '+policy.policy.cancellation_notice_hours+' hours. '+(policy.policy.policy_text||'');
  const sf=panel.querySelector('[name=preferredServiceId]'),st=panel.querySelector('[name=preferredStaffId]'),wf=panel.querySelector('#bp-waitlist-form [name=serviceId]'),wt=panel.querySelector('#bp-waitlist-form [name=preferredStaffId]');
  sf.innerHTML='<option value="">No preference</option>'+services.services.map(x=>'<option value="'+x.id+'">'+esc(x.name)+'</option>').join('');
  wf.innerHTML=services.services.map(x=>'<option value="'+x.id+'">'+esc(x.name)+'</option>').join('');
  st.innerHTML='<option value="">No preference</option>'+staff.staff.map(x=>'<option value="'+x.id+'">'+esc(x.display_name)+'</option>').join('');
  wt.innerHTML='<option value="">Any barber</option>'+staff.staff.map(x=>'<option value="'+x.id+'">'+esc(x.display_name)+'</option>').join('');
  const done=appointments.appointments.filter(x=>x.status==='COMPLETED');
  panel.querySelector('#bp-review-form [name=appointmentId]').innerHTML=done.map(x=>'<option value="'+x.id+'">'+esc(x.service_name)+' · '+esc(x.shop_name)+' · '+esc(String(x.starts_at).slice(0,10))+'</option>').join('');
  panel.querySelector('#bp-review-form button').disabled=!done.length;
  const active=waitlist.entries||[];panel.querySelector('#bp-customer-waitlist').innerHTML=active.map(x=>'<div class="item"><div><strong>'+esc(x.shop_name)+' · '+esc(x.service_name)+'</strong><small>'+esc(x.status)+' · '+esc(x.requested_date)+(x.offered_starts_at?' · offered '+esc(new Date(x.offered_starts_at).toLocaleString()):'')+'</small></div><div class="actions">'+(x.status==='OFFERED'?'<button data-wait-accept="'+x.id+'">Accept slot</button><button data-wait-decline="'+x.id+'">Decline</button>':'')+'</div></div>').join('')||'<div class="empty">You have no active waitlist entries.</div>';
  panel.querySelectorAll('[data-wait-accept]').forEach(b=>b.onclick=async()=>{try{const d=await api('/customer/waitlist/'+b.dataset.waitAccept+'/accept',{method:'POST',body:'{}'});notice(panel,'Waitlist slot booked. '+(Number(d.appointment.deposit_due_paise||0)>0?'Complete the deposit before confirmation.':''));await loadOptions()}catch(x){notice(panel,x.message)}});
  panel.querySelectorAll('[data-wait-decline]').forEach(b=>b.onclick=async()=>{try{await api('/customer/waitlist/'+b.dataset.waitDecline+'/decline',{method:'POST',body:'{}'});notice(panel,'Waitlist offer declined.');await loadOptions()}catch(x){notice(panel,x.message)}});
 }
 book.shopId.addEventListener('change',loadOptions);await loadOptions();
 panel.querySelector('#bp-preferences').onsubmit=async e=>{e.preventDefault();const f=new FormData(e.target);try{await api('/customer/shops/'+shop.value+'/preferences',{method:'PUT',body:JSON.stringify({
  preferredStaffId:f.get('preferredStaffId')||null,preferredServiceId:f.get('preferredServiceId')||null,preferredIntervalDays:Number(f.get('preferredIntervalDays')),profileNotesConsent:e.target.profileNotesConsent.checked,
  skinNotes:f.get('skinNotes'),allergyNotes:f.get('allergyNotes'),photoConsent:e.target.photoConsent.checked,noticeVersion:'v1',
  beforePhotoUrl:f.get('beforePhotoUrl')||null,afterPhotoUrl:f.get('afterPhotoUrl')||null})});notice(panel,'Preferences saved. Photo URLs are stored only when consent is checked.');}catch(x){notice(panel,x.message)}};
 panel.querySelector('#bp-waitlist-form').onsubmit=async e=>{e.preventDefault();const f=new FormData(e.target);try{await api('/shops/'+shop.value+'/waitlist',{method:'POST',body:JSON.stringify({
  serviceId:Number(f.get('serviceId')),requestedDate:f.get('requestedDate'),preferredStaffId:f.get('preferredStaffId')||null,
  preferredTimeStart:f.get('preferredTimeStart')||null,preferredTimeEnd:f.get('preferredTimeEnd')||null})});notice(panel,'You have joined the waitlist. We will contact you when a matching slot opens.');}catch(x){notice(panel,x.message)}};
 panel.querySelector('#bp-review-form').onsubmit=async e=>{e.preventDefault();const f=new FormData(e.target);try{const d=await api('/customer/appointments/'+f.get('appointmentId')+'/review',{method:'POST',body:JSON.stringify({rating:Number(f.get('rating')),comment:f.get('comment')})});notice(panel,d.route==='GOOGLE_REVIEW'?(d.googleReviewUrl?'Thanks for the rating. Please also share it on Google: '+d.googleReviewUrl:'Thanks for the rating. The shop has not configured its Google review link yet.'):'Thanks. Your feedback has been sent privately to the shop.');}catch(x){notice(panel,x.message)}};
 panel.querySelector('#bp-export').onclick=async()=>{try{const r=await fetch('/api/customer/data-export',{headers:{Authorization:'Bearer '+token()}});if(!r.ok)throw Error('Could not export customer data');const blob=await r.blob(),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='barberpro-personal-data.json';a.click();URL.revokeObjectURL(url);notice(panel,'Your data export was prepared.');}catch(x){notice(panel,x.message)}};
 panel.querySelector('#bp-delete-request').onclick=async()=>{if(!confirm('Submit a request for BarberPro to review deletion of your personal data? Some records may need to be retained for legal, tax, payment or dispute obligations.'))return;try{await api('/customer/data-rights-requests',{method:'POST',body:JSON.stringify({type:'DELETE'})});notice(panel,'Deletion request submitted for review. This does not immediately erase records.');}catch(x){notice(panel,x.message)}};
}
function mount(){if(!token())return;mountAdmin().catch(()=>{});mountCustomer().catch(()=>{})}
const root=document.getElementById('app');if(root){new MutationObserver(mount).observe(root,{childList:true,subtree:true});mount()}
})();