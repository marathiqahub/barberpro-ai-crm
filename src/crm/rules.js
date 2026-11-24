'use strict';

function validateLoyaltyTransaction(points, type, reason) {
  if (!Number.isSafeInteger(points) || points === 0 ||
      !['EARN', 'REDEEM', 'ADJUST'].includes(type) ||
      typeof reason !== 'string' || !reason.trim() || reason.trim().length > 240) return false;
  if (type === 'EARN') return points > 0;
  if (type === 'REDEEM') return points < 0;
  return true;
}

function nextLoyaltyBalance(currentBalance, points) {
  if (!Number.isSafeInteger(currentBalance) || currentBalance < 0 ||
      !Number.isSafeInteger(points) || points === 0) throw new TypeError('Invalid loyalty balance or points.');
  const next = currentBalance + points;
  if (!Number.isSafeInteger(next) || next < 0) throw new RangeError('Insufficient loyalty points.');
  return next;
}

function campaignCanBePrepared(channel, subject, message, audience) {
  return ['EMAIL', 'SMS'].includes(channel) &&
    (channel !== 'EMAIL' || (typeof subject === 'string' && subject.trim().length > 0 && subject.length <= 200)) &&
    typeof message === 'string' && message.trim().length > 0 && message.length <= 2000 &&
    ['ALL_CONSENTED', 'NO_VISIT_30_DAYS', 'LOYALTY_MEMBERS'].includes(audience);
}

module.exports = { validateLoyaltyTransaction, nextLoyaltyBalance, campaignCanBePrepared };
