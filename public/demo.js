(()=>{'use strict';
const $=s=>document.querySelector(s);
const bookings=[
{id:1,time:'10:00',name:'Asha Sample',service:'Classic haircut',barber:'Arjun Shah',status:'Completed'},
{id:2,time:'10:30',name:'Rohan Sample',service:'Haircut + beard',barber:'Rohan Kulkarni',status:'In service'},
{id:3,time:'11:00',name:'Meera Sample',service:'Beard trim',barber:'Vivek More',status:'Waiting'}
];
const customers=[
['Asha Sample','18 Nov 2026','4','Classic haircut','₹1,400'],
['Rohan Sample','21 Nov 2026','3','Haircut + beard','₹1,500'],
['Meera Sample','24 Nov 2026','2','Beard trim','₹400']
];
let nextId=7,invoiceId=1025,served=12,sales=8450;
const money=n=>'₹'+Number(n).toLocaleString('en-IN');
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const statusClass=s=>s.toLowerCase().replace(/\s+/g,'-');
function renderBookingList(target,items){$(target).innerHTML=items.slice(0,5).map(b=>'<div class="booking-card"><div class="booking-time">'+esc(b.time)+'</div><div class="booking-person"><b>'+esc(b.name)+'</b><small>'+esc(b.service)+' · '+esc(b.barber)+'</small></div><span class="status '+statusClass(b.status)+'">'+esc(b.status)+'</span></div>').join('')}
function renderRows(){const filter=$('#status-filter').value;const rows=bookings.filter(b=>filter==='all'||b.status===filter).map(b=>'<tr><td>'+esc(b.time)+'</td><td><b>'+esc(b.name)+'</b></td><td>'+esc(b.service)+'</td><td>'+esc(b.barber)+'</td><td><span class="status '+statusClass(b.status)+'">'+esc(b.status)+'</span></td><td>'+(b.status==='Completed'?'—':'<button class="table-action" data-complete="'+b.id+'">'+(b.status==='Booked'?'Mark arrived':'Complete')+'</button>')+'</td></tr>').join('');$('#booking-rows').innerHTML=rows||'<tr><td colspan="6">No matching sample bookings.</td></tr>';$('#booking-count').textContent=bookings.length;$('#schedule-caption').textContent=bookings.length+' example appointments · changes stay in this demo';}
function render(){renderBookingList('#overview-bookings',bookings);renderRows();$('#metric-bookings').textContent=18+bookings.length-3;$('#metric-served').textContent=served;$('#metric-sales').textContent=money(sales);$('#metric-waiting').textContent=bookings.filter(b=>b.status==='Waiting').length;}
function showView(name){document.querySelectorAll('.view').forEach(v=>v.classList.toggle('active',v.id==='view-'+name));document.querySelectorAll('.nav-item').forEach(v=>v.classList.toggle('active',v.dataset.view===name));window.scrollTo({top:0,behavior:'smooth'});if(name==='bookings')renderRows()}
document.querySelectorAll('[data-view]').forEach(b=>b.addEventListener('click',()=>showView(b.dataset.view)));
document.querySelectorAll('[data-go]').forEach(b=>b.addEventListener('click',()=>showView(b.dataset.go)));
$('#show-booking-form').addEventListener('click',()=>{$('#booking-form').hidden=false;$('#booking-form').querySelector('input').focus()});
$('#cancel-booking').addEventListener('click',()=>{$('#booking-form').reset();$('#booking-form').hidden=true});
$('#booking-form').addEventListener('submit',e=>{e.preventDefault();const d=Object.fromEntries(new FormData(e.currentTarget));bookings.push({id:nextId++,time:d.time,name:d.name.trim(),service:d.service,barber:d.barber,status:'Booked'});e.currentTarget.reset();e.currentTarget.hidden=true;render();$('#status-filter').value='all';showView('bookings')});
$('#status-filter').addEventListener('change',renderRows);
$('#booking-rows').addEventListener('click',e=>{const id=Number(e.target.dataset.complete);if(!id)return;const b=bookings.find(x=>x.id===id);if(!b)return;if(b.status==='Booked')b.status='Waiting';else{b.status='Completed';served++;sales+=({ 'Classic haircut':350,'Beard trim':200,'Haircut + beard':500,'Hair spa':650}[b.service]||0)}render()});
function renderCustomers(q=''){const rows=customers.filter(c=>c.join(' ').toLowerCase().includes(q.toLowerCase())).map(c=>'<tr>'+c.map((v,i)=>'<td>'+(i===0?'<b>'+esc(v)+'</b>':esc(v))+'</td>').join('')+'</tr>').join('');$('#customer-rows').innerHTML=rows||'<tr><td colspan="5">No sample customer matches.</td></tr>'}
$('#customer-search').addEventListener('input',e=>renderCustomers(e.target.value));renderCustomers();
function updateBill(){const amount=Number($('#bill-service').value);$('#bill-subtotal').textContent=money(amount)+'.00';$('#bill-tax').textContent=money(amount*.18)+'.00';$('#bill-total').textContent=money(amount*1.18)+'.00'}
$('#bill-service').addEventListener('change',updateBill);updateBill();
$('#create-invoice').addEventListener('click',()=>{const total=Number($('#bill-service').value)*1.18,name=$('#bill-customer').value;const row=document.createElement('div');row.className='invoice-row';row.innerHTML='<div><b>BP-DEMO-'+invoiceId+++'</b><small>'+esc(name)+' · Just now</small></div><strong>'+money(total.toFixed(2))+'</strong>';$('#invoice-list').prepend(row);$('#invoice-status').textContent='Sample invoice created in this browser only. No payment or tax invoice was issued.'});
render();
})();