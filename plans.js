// Central place to configure your subscription tiers.
// No free tier -- a customer must pay before they can build a store.
// Prices are in paise (100 paise = ₹1).
// Every plan starts with an introductory price for the first INTRO_MONTHS
// billing cycles, then switches to the regular price.

const INTRO_MONTHS = 2;
const INTRO_AMOUNT_PAISE = 9900; // ₹99 for the first 2 months, any plan

const PLANS = {
  basic: {
    key: 'basic',
    name: 'Basic',
    amount_paise: 69900, // ₹699 / month (after intro period)
    max_sites: 1,
    max_products: 20,
    categories: false,
    watermark: true,
    blurb: 'Add products, set up payments, and start selling.'
  },
  growth: {
    key: 'growth',
    name: 'Grow',
    amount_paise: 169900, // ₹1,699 / month
    max_sites: 1,
    max_products: 100,
    categories: true,
    watermark: false,
    blurb: 'Organize products into categories, remove branding.'
  },
  pro: {
    key: 'pro',
    name: 'Pro',
    amount_paise: 299900, // ₹2,999 / month
    max_sites: 3,
    max_products: 1000,
    categories: true,
    watermark: false,
    blurb: 'The full toolkit — unlimited categories, multiple stores.'
  }
};

// BuddySite's commission on every sale made through a seller's store.
const PLATFORM_FEE_PERCENT = 15;

module.exports = { PLANS, INTRO_MONTHS, INTRO_AMOUNT_PAISE, PLATFORM_FEE_PERCENT };
