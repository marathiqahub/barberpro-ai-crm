'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateLoyaltyTransaction, nextLoyaltyBalance, campaignCanBePrepared } = require('../src/crm/rules');

test('loyalty transactions enforce type, direction and reason', () => {
  assert.equal(validateLoyaltyTransaction(100, 'EARN', 'Completed service'), true);
  assert.equal(validateLoyaltyTransaction(-25, 'REDEEM', 'Reward redemption'), true);
  assert.equal(validateLoyaltyTransaction(-25, 'EARN', 'Wrong direction'), false);
  assert.equal(validateLoyaltyTransaction(0, 'ADJUST', 'Zero'), false);
  assert.equal(validateLoyaltyTransaction(10, 'UNKNOWN', 'Reason'), false);
  assert.equal(validateLoyaltyTransaction(10, 'ADJUST', '  '), false);
});

test('loyalty balances cannot become negative or exceed safe integer range', () => {
  assert.equal(nextLoyaltyBalance(100, -30), 70);
  assert.equal(nextLoyaltyBalance(10, 15), 25);
  assert.throws(() => nextLoyaltyBalance(10, -11), RangeError);
  assert.throws(() => nextLoyaltyBalance(Number.MAX_SAFE_INTEGER, 1), RangeError);
});

test('campaigns require supported channel, consent audience and email subject', () => {
  assert.equal(campaignCanBePrepared('EMAIL', 'Spring offer', 'Welcome back', 'ALL_CONSENTED'), true);
  assert.equal(campaignCanBePrepared('SMS', null, 'Visit this week', 'NO_VISIT_30_DAYS'), true);
  assert.equal(campaignCanBePrepared('EMAIL', '', 'Hello', 'ALL_CONSENTED'), false);
  assert.equal(campaignCanBePrepared('WHATSAPP', null, 'Hello', 'ALL_CONSENTED'), false);
  assert.equal(campaignCanBePrepared('SMS', null, 'Hello', 'EVERYONE'), false);
});
