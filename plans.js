// Central place to configure your subscription tiers.
//
// UPDATED PRICING MODEL (per "Final Pricing & Transaction Commission
// Specification", v2.0): flat monthly price per plan (no discounted
// "first month then auto-pay at regular price" split anymore), plus a
// per-plan BuddySite transaction commission charged on every sale made
// through a seller's store. There is now a Free plan, so a seller can
// start building without paying anything.
//
// Prices are in paise (100 paise = ₹1). Commission is a percent of the
// order's merchandise subtotal, applied and stored on every order --
// see db.js (commission ledger) and server.js (/api/public/sites/:slug/order).

const PLANS = {
  free: {
    key: 'free',
    name: 'Free',
    amount_paise: 0,           // ₹0/month
    commission_percent: 2,     // BuddySite transaction commission
    max_sites: 1,
    max_products: 10,
    categories: true,
    categoryImages: false,
    videoBackgrounds: false,
    availableThemes: ['simple'],
    watermark: true,
    blurb: 'Start for free -- add products, connect a payment link, and test your store idea with no monthly cost.'
  },
  starter: {
    key: 'starter',
    name: 'Starter',
    amount_paise: 9900,        // ₹99/month
    commission_percent: 2,
    max_sites: 1,
    max_products: 50,
    categories: true,
    categoryImages: false,
    videoBackgrounds: false,
    availableThemes: ['simple'],
    watermark: true,
    blurb: 'For small active sellers -- more products and the same low 2% commission as Free.'
  },
  growth: {
    key: 'growth',
    name: 'Grow',
    amount_paise: 29900,       // ₹299/month
    commission_percent: 3.5,
    max_sites: 1,
    max_products: 500,
    categories: true,
    categoryImages: true,
    videoBackgrounds: true,
    availableThemes: ['simple', 'bold'],
    watermark: false,
    blurb: 'For growing businesses -- category photos, video backgrounds, the Bold theme, and branding removed.'
  },
  pro: {
    key: 'pro',
    name: 'Pro',
    amount_paise: 59900,       // ₹599/month
    commission_percent: 5,
    max_sites: 3,
    max_products: 100000,      // effectively unlimited
    categories: true,
    categoryImages: true,
    videoBackgrounds: true,
    availableThemes: ['simple', 'bold', 'aesthetic'],
    watermark: false,
    blurb: 'The full toolkit -- unlimited products, up to 3 stores, every theme, and the full merchandised homepage.'
  }
};

// Order in which plans unlock features/themes, lowest to highest.
const PLAN_ORDER = ['free', 'starter', 'growth', 'pro'];

module.exports = { PLANS, PLAN_ORDER };
