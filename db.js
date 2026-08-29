// A tiny pure-JavaScript database stored as a single JSON file.
// No native code to compile -- works identically on any host.

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'data.json');

function empty() {
  return {
    users: [], sites: [], payments: [], subscriptions: [], razorpayPlans: {}, commissions: [],
    nextUserId: 1, nextSiteId: 1, nextProductId: 1, nextCategoryId: 1, nextOrderId: 1, nextPaymentId: 1, nextSubscriptionId: 1,
    nextHeroSlideId: 1, nextCategoryGroupId: 1, nextSlidingSectionId: 1, nextCommissionId: 1
  };
}

// Money is stored using plain rupee numbers rounded to 2 decimal places
// (never floating-point-only arithmetic left unrounded) so ledger totals
// stay exact instead of drifting from repeated cents-level rounding.
function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

function load() {
  if (!fs.existsSync(FILE)) return empty();
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    const e = empty();
    Object.keys(e).forEach(k => { if (data[k] === undefined) data[k] = e[k]; }); // safety for older data files
    return data;
  } catch {
    return empty();
  }
}

function save(data) { fs.writeFileSync(FILE, JSON.stringify(data, null, 2)); }

// ---------- USERS ----------
function createUser({ name, email, password_hash }) {
  const data = load();
  const user = { id: data.nextUserId++, name, email, password_hash, plan: null, plan_renews_at: null, paid_cycles: 0, created_at: new Date().toISOString() };
  data.users.push(user);
  save(data);
  return user;
}
function getUserByEmail(email) { return load().users.find(u => u.email === email); }
function getUserById(id) { return load().users.find(u => u.id === Number(id)); }

function updateUserPlan(userId, plan, renewsAt) {
  const data = load();
  const user = data.users.find(u => u.id === Number(userId));
  if (!user) return null;
  user.plan = plan;
  user.plan_renews_at = renewsAt;
  user.paid_cycles = (user.paid_cycles || 0) + 1;
  save(data);
  return user;
}

// ---------- SITES (stores) ----------
function emptyPage() {
  return { content: [], background_url: '', background_type: 'image' };
}

function createSite({ user_id, slug, store_name, theme }) {
  const data = load();
  const site = {
    id: data.nextSiteId++,
    user_id: Number(user_id),
    slug,
    store_name,
    theme: theme || 'simple', // 'simple' | 'bold' | 'aesthetic'
    description: '',
    description_align: 'center', // 'left' | 'center' | 'right'
    description_size: 'medium', // 'small' | 'medium' | 'large'
    description_font: 'inter', // 'inter' | 'poppins' | 'playfair'
    background_url: '',
    background_type: 'image', // 'image' | 'video'
    payment_link: '',
    products: [],
    categories: [],
    orders: [],
    aboutPage: emptyPage(),
    contactPage: emptyPage(),
    heroSlides: [],       // Pro plan: multi-slide homepage banner -- [{id, image, heading, subtext, link}]
    categoryGroups: [],   // Pro plan: titled homepage sections -- [{id, title, productIds:[]}]
    slidingSections: [],  // Pro plan: named sliding/carousel product rows -- [{id, title, productIds:[]}]
    brandStory: emptyPage(), // all plans: "about the brand" footer section
    socialLinks: { instagram: '', facebook: '', twitter: '', youtube: '', tiktok: '', website: '' },
    cartPosition: 'bottom', // 'bottom' (floating button) | 'top' (topbar icon) -- both link to a dedicated cart page
    storeNamePosition: 'left', // 'left' | 'center'
    logoVideoUrl: '', logoVideoPosition: 'left', // 'left' | 'right' -- optional looping logo video
    published: 0,
    created_at: new Date().toISOString()
  };
  data.sites.push(site);
  save(data);
  return site;
}

function updatePage(siteId, pageKey, fields) {
  // pageKey is 'aboutPage' or 'contactPage'
  const data = load();
  const site = data.sites.find(s => s.id === Number(siteId));
  if (!site) return null;
  if (!site[pageKey]) site[pageKey] = emptyPage();
  if (fields.content !== undefined) site[pageKey].content = fields.content;
  if (fields.background_url !== undefined) site[pageKey].background_url = fields.background_url;
  if (fields.background_type !== undefined) site[pageKey].background_type = fields.background_type;
  save(data);
  return site[pageKey];
}

function withPageDefaults(site) {
  if (!site) return site;
  if (!site.aboutPage) site.aboutPage = emptyPage();
  if (!site.contactPage) site.contactPage = emptyPage();
  if (!site.brandStory) site.brandStory = emptyPage();
  if (!site.heroSlides) site.heroSlides = [];
  if (!site.categoryGroups) site.categoryGroups = [];
  if (!site.slidingSections) site.slidingSections = [];
  if (!site.socialLinks) site.socialLinks = { instagram: '', facebook: '', twitter: '', youtube: '', tiktok: '', website: '' };
  if (!site.cartPosition) site.cartPosition = 'bottom';
  if (!site.storeNamePosition) site.storeNamePosition = 'left';
  if (site.logoVideoUrl === undefined) site.logoVideoUrl = '';
  if (!site.logoVideoPosition) site.logoVideoPosition = 'left';
  if (!site.theme) site.theme = 'simple';
  if (!site.description_align) site.description_align = 'center';
  if (!site.description_size) site.description_size = 'medium';
  if (!site.description_font) site.description_font = 'inter';
  if (Array.isArray(site.products)) {
    site.products.forEach(p => {
      if (!Array.isArray(p.images)) p.images = p.image ? [p.image] : [];
      if (!Array.isArray(p.sizes)) p.sizes = p.size ? [p.size] : [];
      if (p.originalPrice === undefined) p.originalPrice = 0;
      if (!p.sizeGuide || !Array.isArray(p.sizeGuide.content)) p.sizeGuide = { title: '', content: [] };
    });
  }
  if (Array.isArray(site.categoryGroups)) {
    site.categoryGroups.forEach(g => { if (!Array.isArray(g.productIds)) g.productIds = []; });
  }
  if (Array.isArray(site.slidingSections)) {
    site.slidingSections.forEach(g => { if (!Array.isArray(g.productIds)) g.productIds = []; });
  }
  return site;
}

function getSitesByUser(userId) { return load().sites.filter(s => s.user_id === Number(userId)).sort((a, b) => a.id - b.id).map(withPageDefaults); }
function countSitesByUser(userId) { return getSitesByUser(userId).length; }
function getSiteByIdAndUser(id, userId) { return withPageDefaults(load().sites.find(s => s.id === Number(id) && s.user_id === Number(userId))); }
function getSiteById(id) { return withPageDefaults(load().sites.find(s => s.id === Number(id))); }
function getSiteBySlug(slug) { return withPageDefaults(load().sites.find(s => s.slug === slug)); }

function updateSite(id, fields) {
  const data = load();
  const site = data.sites.find(s => s.id === Number(id));
  if (!site) return null;
  ['store_name', 'description', 'description_align', 'description_size', 'description_font', 'background_url', 'background_type', 'payment_link', 'published', 'theme', 'cartPosition', 'storeNamePosition', 'logoVideoUrl', 'logoVideoPosition'].forEach(f => {
    if (fields[f] !== undefined) site[f] = f === 'published' ? (fields[f] ? 1 : 0) : fields[f];
  });
  save(data);
  return site;
}

function deleteSite(id) {
  const data = load();
  data.sites = data.sites.filter(s => s.id !== Number(id));
  save(data);
}

// ---------- PRODUCTS ----------
function addProduct(siteId, { name, price, originalPrice, image, images, sizes, size, color, description, categoryId, sizeGuide }) {
  const data = load();
  const site = data.sites.find(s => s.id === Number(siteId));
  if (!site) return null;
  const imgList = (Array.isArray(images) && images.length) ? images.filter(Boolean) : (image ? [image] : []);
  const sizeList = Array.isArray(sizes) ? sizes.filter(Boolean) : (size ? [size] : []);
  const product = {
    id: data.nextProductId++, name, price: Number(price) || 0,
    originalPrice: originalPrice ? Number(originalPrice) || 0 : 0,
    image: imgList[0] || '', images: imgList,
    sizes: sizeList, size: sizeList[0] || '', color: color || '', description: description || '', categoryId: categoryId || null,
    sizeGuide: sizeGuide && sizeGuide.content && sizeGuide.content.length ? { title: sizeGuide.title || 'Size Guide', content: sizeGuide.content } : { title: '', content: [] }
  };
  site.products.push(product);
  save(data);
  return product;
}
function updateProduct(siteId, productId, fields) {
  const data = load();
  const site = data.sites.find(s => s.id === Number(siteId));
  if (!site) return null;
  const p = site.products.find(p => p.id === Number(productId));
  if (!p) return null;
  if (fields.images !== undefined) {
    const imgList = Array.isArray(fields.images) ? fields.images.filter(Boolean) : [];
    p.images = imgList;
    p.image = imgList[0] || '';
  } else if (fields.image !== undefined) {
    p.image = fields.image;
    p.images = fields.image ? [fields.image] : [];
  }
  if (fields.sizes !== undefined) {
    const sizeList = Array.isArray(fields.sizes) ? fields.sizes.filter(Boolean) : [];
    p.sizes = sizeList;
    p.size = sizeList[0] || '';
  }
  if (fields.sizeGuide !== undefined) {
    p.sizeGuide = fields.sizeGuide && fields.sizeGuide.content && fields.sizeGuide.content.length
      ? { title: fields.sizeGuide.title || 'Size Guide', content: fields.sizeGuide.content }
      : { title: '', content: [] };
  }
  ['name', 'price', 'originalPrice', 'color', 'description', 'categoryId'].forEach(f => {
    if (fields[f] !== undefined) p[f] = (f === 'price' || f === 'originalPrice') ? (Number(fields[f]) || 0) : fields[f];
  });
  save(data);
  return p;
}
function deleteProduct(siteId, productId) {
  const data = load();
  const site = data.sites.find(s => s.id === Number(siteId));
  if (!site) return false;
  site.products = site.products.filter(p => p.id !== Number(productId));
  (site.categoryGroups || []).forEach(g => { g.productIds = (g.productIds || []).filter(id => id !== Number(productId)); });
  (site.slidingSections || []).forEach(g => { g.productIds = (g.productIds || []).filter(id => id !== Number(productId)); });
  save(data);
  return true;
}
function countProducts(siteId) {
  const site = load().sites.find(s => s.id === Number(siteId));
  return site ? site.products.length : 0;
}

// ---------- CATEGORIES ----------
function addCategory(siteId, name, image) {
  const data = load();
  const site = data.sites.find(s => s.id === Number(siteId));
  if (!site) return null;
  const category = { id: data.nextCategoryId++, name, image: image || '' };
  site.categories.push(category);
  save(data);
  return category;
}
function updateCategory(siteId, categoryId, { name, image }) {
  const data = load();
  const site = data.sites.find(s => s.id === Number(siteId));
  if (!site) return null;
  const cat = site.categories.find(c => c.id === Number(categoryId));
  if (!cat) return null;
  if (name !== undefined) cat.name = name;
  if (image !== undefined) cat.image = image;
  save(data);
  return cat;
}
function deleteCategory(siteId, categoryId) {
  const data = load();
  const site = data.sites.find(s => s.id === Number(siteId));
  if (!site) return false;
  site.categories = site.categories.filter(c => c.id !== Number(categoryId));
  site.products.forEach(p => { if (p.categoryId === Number(categoryId)) p.categoryId = null; });
  save(data);
  return true;
}

// ---------- ORDERS ----------
// `commission` (optional) is a ready-made object computed by the caller
// (server.js, which knows the seller's plan) recording the BuddySite
// transaction commission that applied at the moment this order was placed:
// { plan_at_transaction, rate, base_amount, amount, currency, seller_payout_amount, refund_adjustment_amount, status }
function addOrder(siteId, { customerName, email, phone, address, paymentMethod, items, total, commission }) {
  const data = load();
  const site = data.sites.find(s => s.id === Number(siteId));
  if (!site) return null;
  const status = paymentMethod === 'COD' ? 'new' : 'awaiting_payment';
  const order = {
    id: data.nextOrderId++, customerName, email, phone, address, paymentMethod, items, total, status,
    commission: commission || null, refunded_amount: 0,
    created_at: new Date().toISOString()
  };
  site.orders.push(order);
  save(data);
  return order;
}
function getOrders(siteId) {
  const site = load().sites.find(s => s.id === Number(siteId));
  return site ? site.orders.slice().reverse() : [];
}

// Changing an order's status to 'cancelled' or 'refunded' reverses the
// BuddySite commission that was charged on it -- fully for a cancellation
// or a refund with no amount specified, or proportionally for a partial
// refund (refundAmount). Every adjustment is also appended as its own
// immutable ledger entry in data.commissions, in addition to updating the
// order's own commission summary. Historical orders keep the commission
// rate that applied when they were placed -- changing a seller's plan
// later never rewrites past orders.
function updateOrderStatus(siteId, orderId, status, refundAmount) {
  const data = load();
  const site = data.sites.find(s => s.id === Number(siteId));
  if (!site) return null;
  const order = site.orders.find(o => o.id === Number(orderId));
  if (!order) return null;

  const wasAlreadyReversed = order.status === 'cancelled' || order.status === 'refunded';
  order.status = status;

  const isReversal = status === 'cancelled' || status === 'refunded';
  if (order.commission && !wasAlreadyReversed && isReversal) {
    const remainingBase = round2(order.total - (order.refunded_amount || 0));
    const noAmountGiven = refundAmount === undefined || refundAmount === null || refundAmount === '';
    const isFull = status === 'cancelled' || noAmountGiven || Number(refundAmount) >= remainingBase;
    const refundBase = isFull ? remainingBase : Math.max(0, round2(Number(refundAmount) || 0));
    const rate = order.commission.rate;
    const adjustment = round2(refundBase * rate / 100);

    order.refunded_amount = round2((order.refunded_amount || 0) + refundBase);
    order.commission.refund_adjustment_amount = round2((order.commission.refund_adjustment_amount || 0) + adjustment);
    const netCommission = round2(order.commission.amount - order.commission.refund_adjustment_amount);
    order.commission.seller_payout_amount = round2(order.total - order.refunded_amount - netCommission);
    order.commission.status = isFull ? 'reversed' : 'partially_reversed';

    data.commissions.push({
      id: data.nextCommissionId++,
      order_id: order.id, store_id: site.id, seller_id: site.user_id,
      plan_at_transaction: order.commission.plan_at_transaction,
      commission_rate_at_transaction: rate,
      commission_base_amount: -refundBase,
      commission_amount: -adjustment,
      currency: order.commission.currency || 'INR',
      seller_payout_amount: order.commission.seller_payout_amount,
      status: isFull ? 'reversed' : 'partially_reversed',
      refund_adjustment_amount: adjustment,
      event: isFull ? 'full_refund_adjustment' : 'partial_refund_adjustment',
      created_at: new Date().toISOString(),
      settled_at: null
    });
  }

  save(data);
  return order;
}

// ---------- COMMISSION LEDGER (immutable financial record) ----------
// One record per financial event (order created, refund adjustment, ...).
// Never recalculated from a seller's current plan -- always stores the
// rate that actually applied at that moment.
function createCommissionRecord(fields) {
  const data = load();
  const record = {
    id: data.nextCommissionId++,
    order_id: fields.order_id,
    store_id: fields.store_id,
    seller_id: fields.seller_id,
    plan_at_transaction: fields.plan_at_transaction,
    commission_rate_at_transaction: fields.commission_rate_at_transaction,
    commission_base_amount: fields.commission_base_amount,
    commission_amount: fields.commission_amount,
    currency: fields.currency || 'INR',
    seller_payout_amount: fields.seller_payout_amount,
    status: fields.status || 'pending',
    refund_adjustment_amount: fields.refund_adjustment_amount || 0,
    event: fields.event || 'order_created',
    created_at: new Date().toISOString(),
    settled_at: null
  };
  data.commissions.push(record);
  save(data);
  return record;
}
function getCommissionsForSite(siteId) {
  return load().commissions.filter(c => c.store_id === Number(siteId)).sort((a, b) => b.id - a.id);
}
// Rolled-up Finance/Payouts numbers for a seller's store: gross sales,
// commission charged, commission reversed by refunds/cancellations, and
// net payout -- everything a seller needs to see how much BuddySite
// charged them and what they should actually receive.
function getFinanceSummaryForSite(siteId) {
  const site = load().sites.find(s => s.id === Number(siteId));
  if (!site) return null;
  const orders = site.orders || [];
  let gross = 0, commission = 0, refundedCommission = 0, refundedGross = 0, netPayout = 0;
  orders.forEach(o => {
    if (o.status === 'awaiting_payment') return; // not a confirmed sale yet
    gross += o.total || 0;
    refundedGross += o.refunded_amount || 0;
    if (o.commission) {
      commission += o.commission.amount || 0;
      refundedCommission += o.commission.refund_adjustment_amount || 0;
      netPayout += o.commission.seller_payout_amount || 0;
    }
  });
  return {
    gross_sales: round2(gross),
    refunded_amount: round2(refundedGross),
    total_commission: round2(commission),
    refunded_commission: round2(refundedCommission),
    net_commission: round2(commission - refundedCommission),
    net_payout: round2(netPayout),
    order_count: orders.filter(o => o.status !== 'awaiting_payment').length
  };
}

// ---------- PAYMENTS (platform subscription billing) ----------
function createPayment({ user_id, plan, amount_paise, razorpay_order_id, status }) {
  const data = load();
  const payment = { id: data.nextPaymentId++, user_id: Number(user_id), plan, amount_paise, razorpay_order_id, razorpay_payment_id: null, status, created_at: new Date().toISOString() };
  data.payments.push(payment);
  save(data);
  return payment;
}
function getPaymentByOrderId(orderId) { return load().payments.find(p => p.razorpay_order_id === orderId); }
function updatePaymentStatus(orderId, status, paymentId) {
  const data = load();
  const payment = data.payments.find(p => p.razorpay_order_id === orderId);
  if (!payment) return null;
  payment.status = status;
  if (paymentId) payment.razorpay_payment_id = paymentId;
  save(data);
  return payment;
}
function countPaidCyclesForUser(userId) {
  return load().payments.filter(p => p.user_id === Number(userId) && p.status === 'paid').length;
}

// ---------- RAZORPAY PLAN CACHE (so we only create each Razorpay Plan once) ----------
function getRazorpayPlanId(planKey) { return load().razorpayPlans[planKey] || null; }
function setRazorpayPlanId(planKey, razorpayPlanId) {
  const data = load();
  data.razorpayPlans[planKey] = razorpayPlanId;
  save(data);
}

// ---------- SUBSCRIPTIONS (auto-pay) ----------
function createSubscription({ user_id, plan, razorpay_subscription_id }) {
  const data = load();
  const sub = { id: data.nextSubscriptionId++, user_id: Number(user_id), plan, razorpay_subscription_id, status: 'created', created_at: new Date().toISOString() };
  data.subscriptions.push(sub);
  save(data);
  return sub;
}
function getSubscriptionByRzpId(rzpId) { return load().subscriptions.find(s => s.razorpay_subscription_id === rzpId); }
function getActiveSubscriptionForUser(userId) {
  return load().subscriptions.find(s => s.user_id === Number(userId) && (s.status === 'active' || s.status === 'authenticated'));
}
function updateSubscriptionStatus(rzpId, status) {
  const data = load();
  const sub = data.subscriptions.find(s => s.razorpay_subscription_id === rzpId);
  if (!sub) return null;
  sub.status = status;
  save(data);
  return sub;
}

// ---------- HERO SLIDES (Pro plan homepage slider) ----------
function addHeroSlide(siteId, { image, heading, subtext, link }) {
  const data = load();
  const site = data.sites.find(s => s.id === Number(siteId));
  if (!site) return null;
  if (!site.heroSlides) site.heroSlides = [];
  const slide = { id: data.nextHeroSlideId++, image: image || '', heading: heading || '', subtext: subtext || '', link: link || '' };
  site.heroSlides.push(slide);
  save(data);
  return slide;
}
function deleteHeroSlide(siteId, slideId) {
  const data = load();
  const site = data.sites.find(s => s.id === Number(siteId));
  if (!site) return false;
  site.heroSlides = (site.heroSlides || []).filter(s => s.id !== Number(slideId));
  save(data);
  return true;
}

// ---------- CATEGORY SECTIONS (Pro plan): titled homepage sections you add
// specific products to directly, e.g. "Top Deals", "Summer Sale". ----------
function addCategoryGroup(siteId, { title, productIds }) {
  const data = load();
  const site = data.sites.find(s => s.id === Number(siteId));
  if (!site) return null;
  if (!site.categoryGroups) site.categoryGroups = [];
  const group = { id: data.nextCategoryGroupId++, title: title || 'Section', productIds: Array.isArray(productIds) ? productIds.map(Number) : [] };
  site.categoryGroups.push(group);
  save(data);
  return group;
}
function deleteCategoryGroup(siteId, groupId) {
  const data = load();
  const site = data.sites.find(s => s.id === Number(siteId));
  if (!site) return false;
  site.categoryGroups = (site.categoryGroups || []).filter(g => g.id !== Number(groupId));
  save(data);
  return true;
}
function addProductToGroup(siteId, groupId, productId) {
  const data = load();
  const site = data.sites.find(s => s.id === Number(siteId));
  if (!site) return null;
  const group = (site.categoryGroups || []).find(g => g.id === Number(groupId));
  if (!group) return null;
  const pid = Number(productId);
  if (!group.productIds.includes(pid)) group.productIds.push(pid);
  save(data);
  return group;
}
function removeProductFromGroup(siteId, groupId, productId) {
  const data = load();
  const site = data.sites.find(s => s.id === Number(siteId));
  if (!site) return null;
  const group = (site.categoryGroups || []).find(g => g.id === Number(groupId));
  if (!group) return null;
  group.productIds = group.productIds.filter(id => id !== Number(productId));
  save(data);
  return group;
}

// ---------- SLIDING PRODUCT SECTIONS (Pro plan): named, admin-curated
// horizontally-scrolling carousels, e.g. "Trending Now", "New Arrivals". ----------
function addSlidingSection(siteId, { title, productIds }) {
  const data = load();
  const site = data.sites.find(s => s.id === Number(siteId));
  if (!site) return null;
  if (!site.slidingSections) site.slidingSections = [];
  const section = { id: data.nextSlidingSectionId++, title: title || 'Sliding Products', productIds: Array.isArray(productIds) ? productIds.map(Number) : [] };
  site.slidingSections.push(section);
  save(data);
  return section;
}
function deleteSlidingSection(siteId, sectionId) {
  const data = load();
  const site = data.sites.find(s => s.id === Number(siteId));
  if (!site) return false;
  site.slidingSections = (site.slidingSections || []).filter(g => g.id !== Number(sectionId));
  save(data);
  return true;
}
function addProductToSlidingSection(siteId, sectionId, productId) {
  const data = load();
  const site = data.sites.find(s => s.id === Number(siteId));
  if (!site) return null;
  const section = (site.slidingSections || []).find(g => g.id === Number(sectionId));
  if (!section) return null;
  const pid = Number(productId);
  if (!section.productIds.includes(pid)) section.productIds.push(pid);
  save(data);
  return section;
}
function removeProductFromSlidingSection(siteId, sectionId, productId) {
  const data = load();
  const site = data.sites.find(s => s.id === Number(siteId));
  if (!site) return null;
  const section = (site.slidingSections || []).find(g => g.id === Number(sectionId));
  if (!section) return null;
  section.productIds = section.productIds.filter(id => id !== Number(productId));
  save(data);
  return section;
}

// ---------- SOCIAL LINKS ----------
function updateSocialLinks(siteId, fields) {
  const data = load();
  const site = data.sites.find(s => s.id === Number(siteId));
  if (!site) return null;
  if (!site.socialLinks) site.socialLinks = { instagram: '', facebook: '', twitter: '', youtube: '', tiktok: '', website: '' };
  ['instagram', 'facebook', 'twitter', 'youtube', 'tiktok', 'website'].forEach(k => {
    if (fields[k] !== undefined) site.socialLinks[k] = fields[k];
  });
  save(data);
  return site.socialLinks;
}

module.exports = {
  createUser, getUserByEmail, getUserById, updateUserPlan,
  createSite, getSitesByUser, countSitesByUser, getSiteByIdAndUser, getSiteById, getSiteBySlug, updateSite, deleteSite, updatePage,
  addProduct, updateProduct, deleteProduct, countProducts,
  addCategory, updateCategory, deleteCategory,
  addOrder, getOrders, updateOrderStatus,
  createCommissionRecord, getCommissionsForSite, getFinanceSummaryForSite,
  createPayment, getPaymentByOrderId, updatePaymentStatus, countPaidCyclesForUser,
  getRazorpayPlanId, setRazorpayPlanId,
  createSubscription, getSubscriptionByRzpId, getActiveSubscriptionForUser, updateSubscriptionStatus,
  addHeroSlide, deleteHeroSlide,
  addCategoryGroup, deleteCategoryGroup, addProductToGroup, removeProductFromGroup,
  addSlidingSection, deleteSlidingSection, addProductToSlidingSection, removeProductFromSlidingSection,
  updateSocialLinks
};
