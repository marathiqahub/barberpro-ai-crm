'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  commissionForTaxableAmount,
  expectedCash,
  validateTenderAllocations
} = require('../src/financial/calculations');

test('commission uses basis points and rounds to whole paise', () => {
  assert.equal(commissionForTaxableAmount(10001, 1000), 1000);
  assert.equal(commissionForTaxableAmount(10000, 0), 0);
  assert.throws(() => commissionForTaxableAmount(-1, 100), TypeError);
  assert.throws(() => commissionForTaxableAmount(100, 10001), TypeError);
});

test('cash close reconciles float, receipts and outflows', () => {
  assert.equal(expectedCash({
    openingFloatPaise: 10000,
    cashReceivedPaise: 25000,
    cashRefundsPaise: 2000,
    cashPaidOutPaise: 3000,
    cashDepositedPaise: 10000
  }), 20000);
  assert.throws(() => expectedCash({
    openingFloatPaise: 0,
    cashReceivedPaise: 100,
    cashRefundsPaise: 101,
    cashPaidOutPaise: 0,
    cashDepositedPaise: 0
  }), RangeError);
});

test('tender allocations must exactly equal amount received', () => {
  assert.equal(validateTenderAllocations([
    { method: 'CASH', amountPaise: 1000 },
    { method: 'UPI', amountPaise: 2500 }
  ], 3500), true);
  assert.equal(validateTenderAllocations([{ method: 'CASH', amountPaise: 1000 }], 999), false);
  assert.equal(validateTenderAllocations([{ method: 'CHEQUE', amountPaise: 1000 }], 1000), false);
  assert.equal(validateTenderAllocations([{ method: 'UPI', amountPaise: 0 }], 0), false);
});
