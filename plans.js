// Central place to configure your subscription tiers.
// Prices are in paise (100 paise = ₹1).
//
// Pricing model (per the BuddySite Shopify Competitive Upgrade Spec, v1.0):
// flat monthly pricing from day one -- no discounted "first month" gimmick,
// and no separate free-trial promotion. The Free plan itself is the entry
// point. first_month_paise is kept equal to amount_paise so the billing
// code (written for a two-price model) still works, but the UI hides the
// "intro price" badge/strikethrough whenever the two are equal.
//
// Commission model (per the BuddySite Final Pricing & Transaction Commission
// Specification, v2.0, 26 Aug 2026): FIXED transaction/platform commission
// -- Free 2%, Starter 2%, Grow 3.5%, Pro 5%. These are the final values from
// the product owner and must not be changed, optimized, or reinterpreted.
// This is a BuddySite platform commission, NOT GST and not a substitute for
// any tax the seller may owe -- see commission-engine.js.

const PLANS = {
  free: {
    key: 'free',
    name: 'Free',
    first_month_paise: 0,
    amount_paise: 0,
    max_sites: 1,
    max_products: 10,
    categories: true,
    categoryImages: false,
    videoBackgrounds: false,
    availableThemes: ['simple'],
    watermark: true,
    whatsapp: false,
    coupons: false,
    analytics: 'basic',
    platformFeePercent: 2,
    blurb: 'Start selling for free. Great for testing an idea with a handful of products.'
  },
  starter: {
    key: 'starter',
    name: 'Starter',
    first_month_paise: 9900,
    amount_paise: 9900,
    max_sites: 1,
    max_products: 50,
    categories: true,
    categoryImages: true,
    videoBackgrounds: false,
    availableThemes: ['simple', 'bold'],
    watermark: false,
    whatsapp: true,
    coupons: true,
    analytics: 'basic',
    platformFeePercent: 2,
    blurb: 'Remove branding, add category photos, and unlock WhatsApp sharing and coupons.'
  },
  grow: {
    key: 'grow',
    name: 'Grow',
    first_month_paise: 29900,
    amount_paise: 29900,
    max_sites: 1,
    max_products: 500,
    categories: true,
    categoryImages: true,
    videoBackgrounds: true,
    availableThemes: ['simple', 'bold', 'aesthetic'],
    watermark: false,
    whatsapp: true,
    coupons: true,
    analytics: 'advanced',
    platformFeePercent: 3.5,
    blurb: 'The full Pro homepage toolkit -- slider, search, sliding rows, category sections -- plus deeper analytics.'
  },
  pro: {
    key: 'pro',
    name: 'Pro',
    first_month_paise: 59900,
    amount_paise: 59900,
    max_sites: 3,
    max_products: 100000,
    categories: true,
    categoryImages: true,
    videoBackgrounds: true,
    availableThemes: ['simple', 'bold', 'aesthetic'],
    watermark: false,
    whatsapp: true,
    coupons: true,
    analytics: 'advanced',
    platformFeePercent: 5,
    blurb: 'Unlimited products, up to 3 stores, and BuddySite\'s full advanced feature set.'
  }
};

// No marketing strikethrough under the new flat-pricing model -- kept as a
// field (equal to the real price) so existing UI code that reads
// original_amount_paise doesn't break; the UI hides the strikethrough
// whenever it equals amount_paise.
Object.values(PLANS).forEach(p => { p.original_amount_paise = p.amount_paise; });

const DISCOUNT_PERCENT = 0;

// Central commission configuration, derived from PLANS so there is a single
// source of truth (per spec section 10 -- "Do not hard-code commission
// percentages throughout the application"). Rate is a decimal fraction.
// FREE=0.02, STARTER=0.02, GROW=0.035, PRO=0.05
const COMMISSION_RATES = {};
Object.values(PLANS).forEach(p => { COMMISSION_RATES[p.key] = p.platformFeePercent / 100; });

function commissionRateForPlan(planKey) {
  const rate = COMMISSION_RATES[planKey];
  return typeof rate === 'number' ? rate : COMMISSION_RATES.free;
}

module.exports = { PLANS, DISCOUNT_PERCENT, COMMISSION_RATES, commissionRateForPlan };
