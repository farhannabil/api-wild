// Display and retry helpers only. Wallet credit is always fulfilled on the server.
export const CREDIT_PACK_NAMES = Object.freeze({smart:'SmarT', nerd:'NeRD', newton:'Newton', alien:'Alien'});
const terminalOrders = new Set(['paid','succeeded','settled','expired','failed','refunded','partially_refunded']);
const fail = () => {throw Error('Credit offers could not be verified. Please refresh.');};
const cents = value => Number.isSafeInteger(value) && value >= 0 && value <= 100000000;
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

export function verifiedCreditOffers(data) {
  if (!data || data.authority !== 'apiwild-owned-billing' || data.currency !== 'USD'
      || !data.promotion || !Array.isArray(data.packages) || data.packages.length !== 4) fail();
  const promotion = data.promotion;
  if (typeof promotion.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(promotion.id) || typeof promotion.active !== 'boolean') fail();
  const configured = promotion.startsAt !== null || promotion.endsAt !== null || promotion.checkoutClosesAt !== null;
  if (configured) {
    if (!date(promotion.startsAt) || !date(promotion.endsAt) || !date(promotion.checkoutClosesAt)
        || Date.parse(promotion.checkoutClosesAt) - Date.parse(promotion.startsAt) !== 15 * 86400000
        || Date.parse(promotion.endsAt) - Date.parse(promotion.checkoutClosesAt) !== 31 * 60000) fail();
  } else if (promotion.active) fail();
  const seen = new Set();
  const packages = data.packages.map(pack => {
    if (!pack || !Object.hasOwn(CREDIT_PACK_NAMES, pack.id) || CREDIT_PACK_NAMES[pack.id] !== pack.name
        || seen.has(pack.id) || !cents(pack.priceCents) || pack.priceCents < 3000 || !cents(pack.bonusCents)
        || !cents(pack.totalCreditCents) || pack.totalCreditCents !== pack.priceCents + pack.bonusCents
        || (!promotion.active && pack.bonusCents !== 0)) fail();
    seen.add(pack.id);
    return Object.freeze({id:pack.id, name:pack.name, priceCents:pack.priceCents, bonusCents:pack.bonusCents, totalCreditCents:pack.totalCreditCents});
  });
  return Object.freeze({authority:data.authority, currency:data.currency,
    promotion:Object.freeze({id:promotion.id, startsAt:promotion.startsAt, endsAt:promotion.endsAt, checkoutClosesAt:promotion.checkoutClosesAt, active:promotion.active}),
    packages:Object.freeze(packages)});
}

export function promotionalCheckoutRemaining(offers, now = Date.now()) {
  if (!Number.isFinite(now) || !offers?.promotion?.active || !offers.promotion.checkoutClosesAt) return 0;
  return Math.max(0, Date.parse(offers.promotion.checkoutClosesAt) - now);
}

// Optional authenticated offer. Invalid or expired data must never become a purchase button.
export function verifiedTemporaryCreditOffer(data, now = Date.now()) {
  if (!data || !Number.isFinite(now) || data.id !== 'launch-dollar' || data.name !== 'API WILD $1 credits'
      || data.priceCents !== 100 || data.bonusCents !== 0 || data.totalCreditCents !== 100
      || !date(data.endsAt) || Date.parse(data.endsAt) - 31 * 60000 <= now) return null;
  return Object.freeze({id:data.id, name:data.name, priceCents:100, bonusCents:0, totalCreditCents:100, endsAt:data.endsAt});
}

export function checkoutStorageKey({amountCents, packageId, promotionId}) {
  if (packageId !== undefined) {
    if (packageId === 'launch-dollar') {
      if (amountCents !== undefined || promotionId !== undefined) fail();
      return 'apiwild-owned-checkout-package-launch-dollar';
    }
    if (!Object.hasOwn(CREDIT_PACK_NAMES, packageId) || typeof promotionId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(promotionId)) fail();
    return `apiwild-owned-checkout-package-${promotionId}-${packageId}`;
  }
  if (!cents(amountCents) || amountCents < 3000) fail();
  return `apiwild-owned-checkout-${amountCents}`;
}

export function checkoutRequest(storage, identity, createId = () => crypto.randomUUID()) {
  const key = checkoutStorageKey(identity), raw = storage.getItem(key);
  let saved;
  if (raw !== null) {
    try {saved = JSON.parse(raw);} catch {throw Error('The saved checkout request could not be verified. It has been preserved.');}
    if (!saved || typeof saved.requestId !== 'string' || !/^[a-zA-Z0-9_-]{16,100}$/.test(saved.requestId)) throw Error('The saved checkout request could not be verified. It has been preserved.');
  } else {
    saved = {requestId:createId()};
    if (typeof saved.requestId !== 'string' || !/^[a-zA-Z0-9_-]{16,100}$/.test(saved.requestId)) fail();
    storage.setItem(key, JSON.stringify(saved));
  }
  return {key, requestId:saved.requestId,
    body:identity.packageId !== undefined ? {packageId:identity.packageId, requestId:saved.requestId} : {amountCents:identity.amountCents, requestId:saved.requestId}};
}

export function saveCheckoutOrder(storage, request, orderId) {
  if (typeof orderId === 'string' && orderId.length > 0 && orderId.length <= 100) storage.setItem(request.key, JSON.stringify({requestId:request.requestId, orderId}));
}

export function saveFailedCheckoutOrder(storage, request, error) {
  const data = error?.data;
  if (data?.creditsGranted === false && typeof data.orderId === 'string'
      && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(data.orderId)) {
    saveCheckoutOrder(storage, request, data.orderId);
  }
}

export function clearConfirmedCheckouts(storage, orders, currentPromotionId) {
  for (const order of orders) {
    if (!terminalOrders.has(order.status) || typeof order.id !== 'string') continue;
    let key;
    try {
      key = order.package_id === 'launch-dollar' ? checkoutStorageKey({packageId:order.package_id})
        : order.package_id ? checkoutStorageKey({packageId:order.package_id,promotionId:order.promotion_id??currentPromotionId}) : checkoutStorageKey({amountCents:order.amount_cents});
    } catch {continue;}
    const raw = storage.getItem(key);
    if (!raw) continue;
    try {if (JSON.parse(raw)?.orderId === order.id) storage.removeItem(key);} catch { /* Preserve ambiguous local requests. */ }
  }
}
