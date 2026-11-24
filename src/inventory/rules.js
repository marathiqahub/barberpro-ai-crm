'use strict';
function applyStock(current,delta){
 if(!Number.isFinite(current)||current<0||!Number.isFinite(delta)||delta===0)throw new TypeError('Invalid stock movement.');
 const next=Number((current+delta).toFixed(3));
 if(next<0)throw new RangeError('Stock cannot become negative.');
 return next;
}
function receivedStatus(lines){
 if(!Array.isArray(lines)||!lines.length)throw new TypeError('Purchase order requires lines.');
 if(lines.some(x=>!Number.isFinite(x.ordered)||x.ordered<=0||!Number.isFinite(x.received)||x.received<0||x.received>x.ordered))throw new TypeError('Invalid purchase order quantities.');
 if(lines.every(x=>x.received===x.ordered))return 'RECEIVED';
 if(lines.some(x=>x.received>0))return 'PART_RECEIVED';
 return 'ORDERED';
}
module.exports={applyStock,receivedStatus};
