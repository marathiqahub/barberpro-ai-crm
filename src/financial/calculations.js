'use strict';

function commissionForTaxableAmount(taxablePaise, rateBps) {
  if (!Number.isSafeInteger(taxablePaise) || taxablePaise < 0 ||
      !Number.isInteger(rateBps) || rateBps < 0 || rateBps > 10000) {
    throw new TypeError('Taxable amount and commission rate are invalid.');
  }
  return Math.round(taxablePaise * rateBps / 10000);
}

function expectedCash({ openingFloatPaise, cashReceivedPaise, cashRefundsPaise, cashPaidOutPaise, cashDepositedPaise }) {
  const values = [openingFloatPaise, cashReceivedPaise, cashRefundsPaise, cashPaidOutPaise, cashDepositedPaise];
  if (values.some(value => !Number.isSafeInteger(value) || value < 0)) {
    throw new TypeError('Cash reconciliation amounts must be non-negative whole paise values.');
  }
  const expected = openingFloatPaise + cashReceivedPaise - cashRefundsPaise - cashPaidOutPaise - cashDepositedPaise;
  if (!Number.isSafeInteger(expected) || expected < 0) {
    throw new RangeError('Cash outflows exceed opening float and recorded cash receipts.');
  }
  return expected;
}

function validateTenderAllocations(allocations, amountPaidPaise) {
  if (!Array.isArray(allocations) || !Number.isSafeInteger(amountPaidPaise) || amountPaidPaise < 0) return false;
  const methods = new Set(['CASH', 'UPI', 'CARD', 'RAZORPAY']);
  let total = 0;
  for (const payment of allocations) {
    if (!payment || !methods.has(payment.method) || !Number.isSafeInteger(payment.amountPaise) || payment.amountPaise < 1) return false;
    total += payment.amountPaise;
    if (!Number.isSafeInteger(total)) return false;
  }
  return total === amountPaidPaise;
}

module.exports = { commissionForTaxableAmount, expectedCash, validateTenderAllocations };
