'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');

const {applyStock,receivedStatus}=require('../src/inventory/rules');
function attendanceDurationMinutes(clockIn,clockOut){
 const start=Date.parse(clockIn),end=Date.parse(clockOut);
 if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start)throw new RangeError('Clock-out must be after clock-in.');
 return Math.floor((end-start)/60000);
}
test('stock movements allow receipt/return and block negative stock',()=>{
 assert.equal(applyStock(10,2.125),12.125);
 assert.equal(applyStock(10,-3),7);
 assert.throws(()=>applyStock(2,-3),RangeError);
 assert.throws(()=>applyStock(1,0),TypeError);
});
test('purchase order state reflects partial and complete receipts',()=>{
 assert.equal(receivedStatus([{ordered:5,received:0}]),'ORDERED');
 assert.equal(receivedStatus([{ordered:5,received:2}]),'PART_RECEIVED');
 assert.equal(receivedStatus([{ordered:5,received:5}]),'RECEIVED');
 assert.throws(()=>receivedStatus([{ordered:5,received:6}]),TypeError);
});
test('attendance duration requires clock-out after clock-in',()=>{
 assert.equal(attendanceDurationMinutes('2026-11-24T09:00:00Z','2026-11-24T17:30:00Z'),510);
 assert.throws(()=>attendanceDurationMinutes('2026-11-24T09:00:00Z','2026-11-24T08:59:00Z'),RangeError);
});
