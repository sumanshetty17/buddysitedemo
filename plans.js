// Central place to configure your subscription tiers.
// No free tier -- a customer must pay before they can build a store.
// Prices are in paise (100 paise = ₹1).
//
// Pricing model: each plan has a discounted FIRST month price, then
// switches to the regular price from month 2 onward via auto-pay.
// The regular price is marketed with a permanent "70% off" strikethrough
// (display_original_paise), computed as regular / 0.3.

const DISCOUNT_PERCENT = 70;

function originalPriceFor(regularPaise) {
  // regular = original * (1 - discount%), so original = regular / (1 - discount%)
  return Math.round((regularPaise / (1 - DISCOUNT_PERCENT / 100)) / 100) * 100;
}

const PLANS = {
  basic: {
    key: 'basic',
    name: 'Basic',
    first_month_paise: 2000,   // ₹20 -- charged once, for month 1 only
    amount_paise: 9900,        // ₹99/month -- regular price from month 2 onward
    max_sites: 1,
    max_products: 20,
    categories: false,
    videoBackgrounds: false,
    availableThemes: ['simple'],
    watermark: true,
    blurb: 'Add products, set up payments, and start selling. Includes About & Contact pages.'
  },
  growth: {
    key: 'growth',
    name: 'Grow',
    first_month_paise: 5900,   // ₹59 -- charged once, for month 1 only
    amount_paise: 29900,       // ₹299/month -- regular price from month 2 onward
    max_sites: 1,
    max_products: 100,
    categories: true,
    videoBackgrounds: true,
    availableThemes: ['simple', 'bold'],
    watermark: false,
    blurb: 'Organize products into categories, remove branding, unlock the Bold theme.'
  },
  pro: {
    key: 'pro',
    name: 'Pro',
    first_month_paise: 9900,   // ₹99 -- charged once, for month 1 only
    amount_paise: 59900,       // ₹599/month -- regular price from month 2 onward
    max_sites: 3,
    max_products: 1000,
    categories: true,
    videoBackgrounds: true,
    availableThemes: ['simple', 'bold', 'aesthetic'],
    watermark: false,
    blurb: 'The full toolkit — unlimited categories, multiple stores, every theme.'
  }
};

// Attach the marketing "original price" (for the strikethrough) to each plan.
Object.values(PLANS).forEach(p => { p.original_amount_paise = originalPriceFor(p.amount_paise); });

// BuddySite's commission on every sale made through a seller's store.
const PLATFORM_FEE_PERCENT = 15;

module.exports = { PLANS, DISCOUNT_PERCENT, PLATFORM_FEE_PERCENT };
