require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const Razorpay = require('razorpay');
const multer = require('multer');

const db = require('./db');
const { requireAuth } = require('./middleware/auth');
const { PLANS, DISCOUNT_PERCENT } = require('./plans');

const app = express();
app.use(cors());

// IMPORTANT: the Razorpay webhook route must be registered BEFORE express.json(),
// because verifying its signature requires the raw, unparsed request body.
app.post('/api/webhooks/razorpay', express.raw({ type: 'application/json' }), (req, res) => {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) { console.warn('RAZORPAY_WEBHOOK_SECRET not set -- ignoring webhook.'); return res.status(200).send('ignored'); }

  const signature = req.headers['x-razorpay-signature'];
  const expected = crypto.createHmac('sha256', secret).update(req.body).digest('hex');
  if (signature !== expected) { console.warn('Webhook signature mismatch.'); return res.status(400).send('invalid signature'); }

  let event;
  try { event = JSON.parse(req.body.toString('utf8')); } catch { return res.status(400).send('bad payload'); }

  try {
    if (event.event === 'subscription.charged') {
      const rzpSubId = event.payload.subscription.entity.id;
      const sub = db.getSubscriptionByRzpId(rzpSubId);
      if (sub) {
        db.updateSubscriptionStatus(rzpSubId, 'active');
        const renewsAt = new Date(); renewsAt.setDate(renewsAt.getDate() + 30);
        db.updateUserPlan(sub.user_id, sub.plan, renewsAt.toISOString());
        db.createPayment({ user_id: sub.user_id, plan: sub.plan, amount_paise: PLANS[sub.plan].amount_paise, razorpay_order_id: 'autopay_' + rzpSubId + '_' + Date.now(), status: 'paid' });
      }
    } else if (event.event === 'subscription.activated' || event.event === 'subscription.authenticated') {
      db.updateSubscriptionStatus(event.payload.subscription.entity.id, 'active');
    } else if (event.event === 'subscription.cancelled' || event.event === 'subscription.halted' || event.event === 'subscription.completed') {
      db.updateSubscriptionStatus(event.payload.subscription.entity.id, event.event.replace('subscription.', ''));
    }
  } catch (err) {
    console.error('Webhook processing error:', err);
  }
  res.status(200).send('ok');
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);
app.use('/uploads', express.static(UPLOADS_DIR));

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
      cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
    }
  }),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB (covers short background videos)
  fileFilter: (req, file, cb) => {
    const ok = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.mp4', '.webm', '.mov'].includes(path.extname(file.originalname).toLowerCase());
    cb(ok ? null : new Error('Unsupported file type.'), ok);
  }
});

app.post('/api/upload', requireAuth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file received.' });
  const ext = path.extname(req.file.filename).toLowerCase();
  const type = ['.mp4', '.webm', '.mov'].includes(ext) ? 'video' : 'image';
  res.json({ url: `/uploads/${req.file.filename}`, type });
});

const razorpayEnabled = !!(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET && !process.env.RAZORPAY_KEY_ID.includes('xxxx'));
const razorpay = razorpayEnabled ? new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET }) : null;

function makeToken(userId) { return jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '30d' }); }
function slugify(str) { return str.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 40) || 'store'; }
function publicUser(u) { return { id: u.id, name: u.name, email: u.email, plan: u.plan, plan_renews_at: u.plan_renews_at }; }
function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// ---------- AUTH ----------
app.post('/api/auth/signup', (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ error: 'Name, email and password are all required.' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  const normalizedEmail = email.toLowerCase();
  if (db.getUserByEmail(normalizedEmail)) return res.status(400).json({ error: 'An account with that email already exists.' });
  const hash = bcrypt.hashSync(password, 10);
  const user = db.createUser({ name, email: normalizedEmail, password_hash: hash });
  res.json({ token: makeToken(user.id), user: publicUser(user) });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  const user = db.getUserByEmail((email || '').toLowerCase());
  if (!user || !bcrypt.compareSync(password || '', user.password_hash)) return res.status(401).json({ error: 'Incorrect email or password.' });
  res.json({ token: makeToken(user.id), user: publicUser(user) });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  const user = db.getUserById(req.userId);
  if (!user) return res.status(404).json({ error: 'Account not found.' });
  res.json({ user: publicUser(user) });
});

// ---------- SITES (stores) ----------
app.get('/api/sites', requireAuth, (req, res) => res.json({ sites: db.getSitesByUser(req.userId) }));

app.post('/api/sites', requireAuth, (req, res) => {
  const user = db.getUserById(req.userId);
  if (!user.plan || !PLANS[user.plan]) return res.status(403).json({ error: 'Please choose and pay for a plan before creating a store.' });
  const plan = PLANS[user.plan];
  if (db.countSitesByUser(req.userId) >= plan.max_sites) return res.status(403).json({ error: `Your ${plan.name} plan allows up to ${plan.max_sites} store(s). Upgrade to add more.` });
  const { store_name, theme } = req.body || {};
  const chosenTheme = theme || 'simple';
  if (!plan.availableThemes.includes(chosenTheme)) {
    return res.status(403).json({ error: `The "${chosenTheme}" theme isn't available on your ${plan.name} plan. Upgrade to unlock it.` });
  }
  const name = store_name || 'My Store';
  const slug = slugify(name) + '-' + Date.now().toString().slice(-5);
  const site = db.createSite({ user_id: req.userId, slug, store_name: name, theme: chosenTheme });
  res.json({ site });
});

function loadOwnedSite(req, res, next) {
  const site = db.getSiteByIdAndUser(req.params.id, req.userId);
  if (!site) return res.status(404).json({ error: 'Store not found.' });
  req.site = site;
  next();
}

app.get('/api/sites/:id', requireAuth, loadOwnedSite, (req, res) => res.json({ site: req.site }));

app.put('/api/sites/:id', requireAuth, loadOwnedSite, (req, res) => {
  if (req.body && req.body.theme !== undefined) {
    const user = db.getUserById(req.userId);
    const plan = PLANS[user.plan];
    if (!plan || !plan.availableThemes.includes(req.body.theme)) {
      return res.status(403).json({ error: `The "${req.body.theme}" theme isn't available on your plan. Upgrade to unlock it.` });
    }
  }
  const updated = db.updateSite(req.site.id, req.body || {});
  res.json({ site: updated });
});

app.delete('/api/sites/:id', requireAuth, loadOwnedSite, (req, res) => { db.deleteSite(req.site.id); res.json({ ok: true }); });

// ---------- ABOUT US / CONTACT US / BRAND STORY (all plans; video backgrounds Grow+/Pro only) ----------
app.put('/api/sites/:id/pages/:pageKey', requireAuth, loadOwnedSite, (req, res) => {
  const pageKey = req.params.pageKey === 'about' ? 'aboutPage' : req.params.pageKey === 'contact' ? 'contactPage' : req.params.pageKey === 'brand' ? 'brandStory' : null;
  if (!pageKey) return res.status(400).json({ error: 'Invalid page.' });

  const { content, background_url, background_type } = req.body || {};
  if (background_type === 'video') {
    const user = db.getUserById(req.userId);
    const plan = PLANS[user.plan];
    if (!plan || !plan.videoBackgrounds) {
      return res.status(403).json({ error: 'Video backgrounds are available on the Grow plan and above.' });
    }
  }
  const page = db.updatePage(req.site.id, pageKey, { content, background_url, background_type });
  res.json({ page });
});

// ---------- PRODUCTS ----------
app.post('/api/sites/:id/products', requireAuth, loadOwnedSite, (req, res) => {
  const user = db.getUserById(req.userId);
  const plan = PLANS[user.plan];
  if (db.countProducts(req.site.id) >= plan.max_products) return res.status(403).json({ error: `Your ${plan.name} plan allows up to ${plan.max_products} products. Upgrade for more.` });
  const product = db.addProduct(req.site.id, req.body || {});
  res.json({ product });
});
app.put('/api/sites/:id/products/:productId', requireAuth, loadOwnedSite, (req, res) => {
  const product = db.updateProduct(req.site.id, req.params.productId, req.body || {});
  if (!product) return res.status(404).json({ error: 'Product not found.' });
  res.json({ product });
});
app.delete('/api/sites/:id/products/:productId', requireAuth, loadOwnedSite, (req, res) => {
  db.deleteProduct(req.site.id, req.params.productId);
  res.json({ ok: true });
});

// ---------- CATEGORIES (name: all plans; image: Grow+/Pro only) ----------
app.post('/api/sites/:id/categories', requireAuth, loadOwnedSite, (req, res) => {
  const user = db.getUserById(req.userId);
  const plan = PLANS[user.plan];
  if (!plan.categories) return res.status(403).json({ error: 'Please choose and pay for a plan first.' });
  const { name, image } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Category name is required.' });
  if (image && !plan.categoryImages) return res.status(403).json({ error: 'Category photos are available on the Grow plan and above.' });
  const category = db.addCategory(req.site.id, name, plan.categoryImages ? image : '');
  res.json({ category });
});
app.put('/api/sites/:id/categories/:categoryId', requireAuth, loadOwnedSite, (req, res) => {
  const user = db.getUserById(req.userId);
  const plan = PLANS[user.plan];
  const { name, image } = req.body || {};
  if (image !== undefined && image && !plan.categoryImages) return res.status(403).json({ error: 'Category photos are available on the Grow plan and above.' });
  const category = db.updateCategory(req.site.id, req.params.categoryId, { name, image: plan.categoryImages ? image : undefined });
  if (!category) return res.status(404).json({ error: 'Category not found.' });
  res.json({ category });
});
app.delete('/api/sites/:id/categories/:categoryId', requireAuth, loadOwnedSite, (req, res) => {
  db.deleteCategory(req.site.id, req.params.categoryId);
  res.json({ ok: true });
});

// ---------- HOMEPAGE SLIDER (Pro plan only) ----------
app.post('/api/sites/:id/hero-slides', requireAuth, loadOwnedSite, (req, res) => {
  const user = db.getUserById(req.userId);
  const plan = PLANS[user.plan];
  if (!plan || plan.key !== 'pro') return res.status(403).json({ error: 'The homepage slider is available on the Pro plan.' });
  const { image, heading, subtext, link } = req.body || {};
  if (!image) return res.status(400).json({ error: 'Please upload an image for the slide.' });
  const slide = db.addHeroSlide(req.site.id, { image, heading, subtext, link });
  res.json({ slide });
});
app.delete('/api/sites/:id/hero-slides/:slideId', requireAuth, loadOwnedSite, (req, res) => {
  db.deleteHeroSlide(req.site.id, req.params.slideId);
  res.json({ ok: true });
});

// ---------- CATEGORY SECTIONS (Pro plan only): named homepage sections you
// add specific products to directly, e.g. "Top Deals", "Summer Sale". ----------
app.post('/api/sites/:id/category-groups', requireAuth, loadOwnedSite, (req, res) => {
  const user = db.getUserById(req.userId);
  const plan = PLANS[user.plan];
  if (!plan || plan.key !== 'pro') return res.status(403).json({ error: 'Custom homepage sections are available on the Pro plan.' });
  const { title, productIds } = req.body || {};
  if (!title) return res.status(400).json({ error: 'Please give this section a name.' });
  const group = db.addCategoryGroup(req.site.id, { title, productIds: productIds || [] });
  res.json({ group });
});
app.delete('/api/sites/:id/category-groups/:groupId', requireAuth, loadOwnedSite, (req, res) => {
  db.deleteCategoryGroup(req.site.id, req.params.groupId);
  res.json({ ok: true });
});
app.post('/api/sites/:id/category-groups/:groupId/products', requireAuth, loadOwnedSite, (req, res) => {
  const user = db.getUserById(req.userId);
  const plan = PLANS[user.plan];
  if (!plan || plan.key !== 'pro') return res.status(403).json({ error: 'Custom homepage sections are available on the Pro plan.' });
  const { productId } = req.body || {};
  if (!productId) return res.status(400).json({ error: 'Please choose a product.' });
  const group = db.addProductToGroup(req.site.id, req.params.groupId, productId);
  if (!group) return res.status(404).json({ error: 'Section not found.' });
  res.json({ group });
});
app.delete('/api/sites/:id/category-groups/:groupId/products/:productId', requireAuth, loadOwnedSite, (req, res) => {
  const group = db.removeProductFromGroup(req.site.id, req.params.groupId, req.params.productId);
  res.json({ group });
});

// ---------- SLIDING PRODUCT SECTIONS (Pro plan only): named, curated
// horizontally-scrolling carousels of products. ----------
app.post('/api/sites/:id/sliding-sections', requireAuth, loadOwnedSite, (req, res) => {
  const user = db.getUserById(req.userId);
  const plan = PLANS[user.plan];
  if (!plan || plan.key !== 'pro') return res.status(403).json({ error: 'Sliding Products sections are available on the Pro plan.' });
  const { title, productIds } = req.body || {};
  if (!title) return res.status(400).json({ error: 'Please give this sliding section a name.' });
  const section = db.addSlidingSection(req.site.id, { title, productIds: productIds || [] });
  res.json({ section });
});
app.delete('/api/sites/:id/sliding-sections/:sectionId', requireAuth, loadOwnedSite, (req, res) => {
  db.deleteSlidingSection(req.site.id, req.params.sectionId);
  res.json({ ok: true });
});
app.post('/api/sites/:id/sliding-sections/:sectionId/products', requireAuth, loadOwnedSite, (req, res) => {
  const user = db.getUserById(req.userId);
  const plan = PLANS[user.plan];
  if (!plan || plan.key !== 'pro') return res.status(403).json({ error: 'Sliding Products sections are available on the Pro plan.' });
  const { productId } = req.body || {};
  if (!productId) return res.status(400).json({ error: 'Please choose a product.' });
  const section = db.addProductToSlidingSection(req.site.id, req.params.sectionId, productId);
  if (!section) return res.status(404).json({ error: 'Sliding section not found.' });
  res.json({ section });
});
app.delete('/api/sites/:id/sliding-sections/:sectionId/products/:productId', requireAuth, loadOwnedSite, (req, res) => {
  const section = db.removeProductFromSlidingSection(req.site.id, req.params.sectionId, req.params.productId);
  res.json({ section });
});

// ---------- SOCIAL LINKS (all plans) ----------
app.put('/api/sites/:id/social-links', requireAuth, loadOwnedSite, (req, res) => {
  const socialLinks = db.updateSocialLinks(req.site.id, req.body || {});
  res.json({ socialLinks });
});

// ---------- COUPONS (Starter plan and above) ----------
app.post('/api/sites/:id/coupons', requireAuth, loadOwnedSite, (req, res) => {
  const user = db.getUserById(req.userId);
  const plan = PLANS[user.plan];
  if (!plan || !plan.coupons) return res.status(403).json({ error: 'Coupons are available on the Starter plan and above.' });
  const { code, type, value, minCartValue, expiryDate, usageLimit } = req.body || {};
  if (!code || !String(code).trim()) return res.status(400).json({ error: 'Please enter a coupon code.' });
  if (!value || Number(value) <= 0) return res.status(400).json({ error: 'Please enter a discount value.' });
  const coupon = db.addCoupon(req.site.id, { code, type, value, minCartValue, expiryDate, usageLimit });
  if (!coupon) return res.status(400).json({ error: 'Could not create that coupon.' });
  if (coupon.error === 'duplicate') return res.status(400).json({ error: 'A coupon with that code already exists.' });
  res.json({ coupon });
});
app.delete('/api/sites/:id/coupons/:couponId', requireAuth, loadOwnedSite, (req, res) => {
  db.deleteCoupon(req.site.id, req.params.couponId);
  res.json({ ok: true });
});

// Public: live-validate a coupon code against the customer's current cart total.
app.post('/api/public/sites/:slug/coupons/validate', (req, res) => {
  const site = db.getSiteBySlug(req.params.slug);
  if (!site || !site.published) return res.status(404).json({ error: 'Store not found.' });
  const { code, cartTotal } = req.body || {};
  const result = db.validateCoupon(site.id, code, Number(cartTotal) || 0);
  if (result.error) return res.status(400).json({ error: result.error });
  res.json({ code: result.coupon.code, type: result.coupon.type, discount: result.discount });
});

// ---------- ORDERS ----------
app.get('/api/sites/:id/orders', requireAuth, loadOwnedSite, (req, res) => res.json({ orders: db.getOrders(req.site.id) }));

app.put('/api/sites/:id/orders/:orderId', requireAuth, loadOwnedSite, (req, res) => {
  const { status } = req.body || {};
  if (!['new', 'paid', 'fulfilled', 'cancelled', 'refunded'].includes(status)) return res.status(400).json({ error: 'Invalid status.' });
  const order = db.updateOrderStatus(req.site.id, req.params.orderId, status);
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  res.json({ order });
});

// Partial refund -- proportionally adjusts the BuddySite commission owed for
// this order instead of reversing it entirely. Validated server-side BEFORE
// any ledger/order mutation happens (see db.refundOrderPartial) -- the
// frontend cannot manipulate the commission figure, and a rejected refund
// never leaves partially-applied data behind.
app.post('/api/sites/:id/orders/:orderId/refund', requireAuth, loadOwnedSite, (req, res) => {
  const amount = Number((req.body || {}).amount);
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Enter a valid refund amount.' });
  const result = db.refundOrderPartial(req.site.id, req.params.orderId, amount);
  if (!result) return res.status(404).json({ error: 'Order not found.' });
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(result);
});

// Seller Finance / Payouts dashboard (spec section 6): gross sales,
// discounts, commissionable sales, BuddySite commission, refunds, and net
// payout, backed by the immutable commission ledger. Never labelled as GST.
app.get('/api/sites/:id/finance', requireAuth, loadOwnedSite, (req, res) => {
  res.json(db.getFinanceSummary(req.site.id));
});

// Public: a customer places an order from the storefront (no login required)
app.post('/api/public/sites/:slug/order', (req, res) => {
  const site = db.getSiteBySlug(req.params.slug);
  if (!site || !site.published) return res.status(404).json({ error: 'Store not found.' });
  const { customerName, email, phone, address, paymentMethod, items, couponCode } = req.body || {};
  if (!customerName || !phone || !address || !items || !items.length) return res.status(400).json({ error: 'Please fill in your name, phone, address, and add at least one item.' });

  // SECURITY / COMMISSION INTEGRITY: never trust prices sent by the client --
  // the BuddySite commission is a percentage of this subtotal, so a
  // manipulated client-side price would both underpay the seller and
  // under-report the commission owed. Re-price every line item from the
  // store's actual product catalog, server-side, before any total or
  // commission is calculated.
  const priceable = [];
  for (const i of items) {
    const product = site.products.find(p => p.id === Number(i.id));
    if (!product) return res.status(400).json({ error: `One of the items in your cart is no longer available.` });
    const qty = Math.max(1, Number(i.qty) || 1);
    priceable.push({ id: product.id, name: product.name, price: product.price, size: i.size || null, qty });
  }
  const subtotal = priceable.reduce((sum, i) => sum + i.price * i.qty, 0);

  // Never trust a discount amount sent by the client -- re-validate the
  // coupon server-side and recompute it from scratch.
  let discount = 0;
  let appliedCoupon = null;
  if (couponCode) {
    const result = db.validateCoupon(site.id, couponCode, subtotal);
    if (!result.error) { discount = result.discount; appliedCoupon = result.coupon; }
  }
  const total = Math.max(0, subtotal - discount);
  const order = db.addOrder(site.id, { customerName, email, phone, address, paymentMethod, items: priceable, total, couponCode: appliedCoupon ? appliedCoupon.code : '', discount, subtotal });
  if (appliedCoupon) db.incrementCouponUsage(site.id, appliedCoupon.id);
  res.json({ ok: true, order });
});

// ---------- BILLING (Razorpay) ----------
app.get('/api/billing/plans', (req, res) => res.json({ plans: Object.values(PLANS), razorpayEnabled, discountPercent: DISCOUNT_PERCENT }));

// ============================================================
// ⚠️ DEMO-ONLY ROUTE — instantly activates a plan, no payment,
// no auto-pay setup. This exists ONLY so you can preview the
// post-payment experience yourself. NEVER deploy this build
// anywhere a real customer could reach it.
// ============================================================
app.post('/api/billing/demo-activate', requireAuth, (req, res) => {
  const { plan } = req.body || {};
  if (!PLANS[plan]) return res.status(400).json({ error: 'Invalid plan.' });
  const renewsAt = new Date(); renewsAt.setDate(renewsAt.getDate() + 30);
  const user = db.updateUserPlan(req.userId, plan, renewsAt.toISOString());
  db.createPayment({ user_id: req.userId, plan, amount_paise: 0, razorpay_order_id: 'demo_' + Date.now(), status: 'paid' });
  res.json({ ok: true, user: { id: user.id, name: user.name, email: user.email, plan: user.plan, plan_renews_at: user.plan_renews_at } });
});

app.post('/api/billing/order', requireAuth, async (req, res) => {
  if (!razorpayEnabled) return res.status(500).json({ error: 'Payments are not configured yet.' });
  const { plan } = req.body || {};
  const planConfig = PLANS[plan];
  if (!planConfig) return res.status(400).json({ error: 'Invalid plan selected.' });

  // First-month discounted price only -- from month 2 onward, billing happens via auto-pay at the regular price.
  const amount = planConfig.first_month_paise;

  try {
    const order = await razorpay.orders.create({ amount, currency: 'INR', receipt: `user_${req.userId}_${Date.now()}`, notes: { userId: String(req.userId), plan } });
    db.createPayment({ user_id: req.userId, plan, amount_paise: amount, razorpay_order_id: order.id, status: 'created' });
    res.json({ order, keyId: process.env.RAZORPAY_KEY_ID });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not create payment order. Check your Razorpay keys.' });
  }
});

app.post('/api/billing/verify', requireAuth, (req, res) => {
  if (!razorpayEnabled) return res.status(500).json({ error: 'Payments are not configured yet.' });
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) return res.status(400).json({ error: 'Missing payment details.' });
  const expected = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(`${razorpay_order_id}|${razorpay_payment_id}`).digest('hex');
  if (expected !== razorpay_signature) {
    db.updatePaymentStatus(razorpay_order_id, 'failed', razorpay_payment_id);
    return res.status(400).json({ error: 'Payment verification failed.' });
  }
  const payment = db.getPaymentByOrderId(razorpay_order_id);
  if (!payment) return res.status(404).json({ error: 'Order not found.' });
  db.updatePaymentStatus(razorpay_order_id, 'paid', razorpay_payment_id);
  const renewsAt = new Date(); renewsAt.setDate(renewsAt.getDate() + 30);
  const user = db.updateUserPlan(req.userId, payment.plan, renewsAt.toISOString());
  res.json({ ok: true, user: publicUser(user) });
});

// ---------- AUTO-PAY (Razorpay Subscriptions) ----------
// Ensures a Razorpay "Plan" object exists for this tier at the REGULAR (post-intro) price,
// creating it once and caching the id so we never create duplicates.
async function ensureRazorpayPlan(planKey) {
  const cached = db.getRazorpayPlanId(planKey);
  if (cached) return cached;
  const planConfig = PLANS[planKey];
  const rzpPlan = await razorpay.plans.create({
    period: 'monthly',
    interval: 1,
    item: { name: `BuddySite ${planConfig.name}`, amount: planConfig.amount_paise, currency: 'INR' }
  });
  db.setRazorpayPlanId(planKey, rzpPlan.id);
  return rzpPlan.id;
}

app.get('/api/billing/autopay-status', requireAuth, (req, res) => {
  const sub = db.getActiveSubscriptionForUser(req.userId);
  res.json({ autopayOn: !!sub, subscription: sub || null });
});

app.post('/api/billing/enable-autopay', requireAuth, async (req, res) => {
  if (!razorpayEnabled) return res.status(500).json({ error: 'Payments are not configured yet.' });
  const user = db.getUserById(req.userId);
  if (!user.plan || !PLANS[user.plan]) return res.status(400).json({ error: 'You need an active plan before enabling auto-pay.' });
  if (db.getActiveSubscriptionForUser(req.userId)) return res.status(400).json({ error: 'Auto-pay is already on.' });

  try {
    const planId = await ensureRazorpayPlan(user.plan);
    // total_count is required by Razorpay; 120 monthly cycles (~10 years) approximates "ongoing."
    const subscription = await razorpay.subscriptions.create({
      plan_id: planId,
      customer_notify: 1,
      total_count: 120,
      notes: { userId: String(req.userId), plan: user.plan }
    });
    db.createSubscription({ user_id: req.userId, plan: user.plan, razorpay_subscription_id: subscription.id });
    res.json({ subscriptionId: subscription.id, keyId: process.env.RAZORPAY_KEY_ID });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not set up auto-pay. Please try again.' });
  }
});

app.post('/api/billing/verify-autopay', requireAuth, (req, res) => {
  const { razorpay_payment_id, razorpay_subscription_id, razorpay_signature } = req.body || {};
  if (!razorpay_payment_id || !razorpay_subscription_id || !razorpay_signature) return res.status(400).json({ error: 'Missing details.' });
  const expected = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(`${razorpay_payment_id}|${razorpay_subscription_id}`).digest('hex');
  if (expected !== razorpay_signature) return res.status(400).json({ error: 'Verification failed.' });
  db.updateSubscriptionStatus(razorpay_subscription_id, 'active');
  res.json({ ok: true });
});

// ---------- PUBLIC STOREFRONT (fixed template) ----------

// Three theme tiers, gated by plan (see plans.js availableThemes).
function getTheme(themeKey) {
  const ALL_FONTS_URL = 'https://fonts.googleapis.com/css2?family=Poppins:wght@600;700;800&family=Inter:wght@400;500;600&family=Playfair+Display:wght@600;700&display=swap';
  const themes = {
    simple: {
      bg: '#FFF9F5', ink: '#3D2C3E', muted: '#8a7a8c', cardBg: '#fff', border: '#F3E3DC',
      accent: '#FF6A88', accentDark: '#E8496A', btnBg: '#FF6A88', btnText: '#fff',
      heroFallback: 'linear-gradient(135deg,#FF9A8B,#FF6A88)',
      headingFont: "'Poppins',sans-serif", bodyFont: "'Inter',system-ui,sans-serif",
      fontsUrl: ALL_FONTS_URL,
      topbarBg: '#fff', radius: '16px', btnRadius: '100px',
      catSectionBg: '#FFF3EC', catDiscBg: '#FFE0D5', catDiscBorder: '#FFD1C0'
    },
    bold: {
      bg: '#0B0B0B', ink: '#FFFFFF', muted: '#A3A3A3', cardBg: '#161616', border: '#2A2A2A',
      accent: '#FFFFFF', accentDark: '#E5E5E5', btnBg: '#FFFFFF', btnText: '#0B0B0B',
      heroFallback: 'linear-gradient(135deg,#1A1A1A,#000000)',
      headingFont: "'Poppins',sans-serif", bodyFont: "'Inter',system-ui,sans-serif",
      fontsUrl: ALL_FONTS_URL,
      topbarBg: '#000000', radius: '4px', btnRadius: '4px',
      catSectionBg: '#161616', catDiscBg: '#2A2A2A', catDiscBorder: '#3A3A3A'
    },
    aesthetic: {
      bg: '#FAF8F5', ink: '#2B2B2B', muted: '#8A8378', cardBg: '#FFFFFF', border: '#E5E0D8',
      accent: '#4A5D4A', accentDark: '#3A4A3A', btnBg: '#2B2B2B', btnText: '#FAF8F5',
      heroFallback: 'linear-gradient(135deg,#E8E2D6,#D9D0BF)',
      headingFont: "'Playfair Display',serif", bodyFont: "'Inter',system-ui,sans-serif",
      fontsUrl: ALL_FONTS_URL,
      topbarBg: '#FAF8F5', radius: '2px', btnRadius: '2px',
      catSectionBg: '#F1ECE2', catDiscBg: '#E8E2D6', catDiscBorder: '#D9D0BF'
    }
  };
  return themes[themeKey] || themes.simple;
}

const DESCRIPTION_FONTS = { inter: "'Inter',system-ui,sans-serif", poppins: "'Poppins',sans-serif", playfair: "'Playfair Display',serif" };
const DESCRIPTION_SIZES = { small: '.85rem', medium: '1.05rem', large: '1.35rem' };

// Small, compact top bar (logo/store-name small, left; nav links right) --
// used on every page (home, about, contact) regardless of theme.
function renderTopbar(site, current, t) {
  const hasAbout = site.aboutPage && site.aboutPage.content && site.aboutPage.content.length > 0;
  const hasContact = site.contactPage && site.contactPage.content && site.contactPage.content.length > 0;
  const link = (href, label, key) => `<a href="${href}" style="color:${t.ink};text-decoration:none;margin-left:20px;font-size:.88rem;font-weight:${current === key ? '700' : '500'};opacity:${current === key ? '1' : '.75'};">${label}</a>`;
  const links = [link(`/store/${site.slug}`, 'Home', 'home')];
  if (hasAbout) links.push(link(`/store/${site.slug}/about`, 'About Us', 'about'));
  if (hasContact) links.push(link(`/store/${site.slug}/contact`, 'Contact Us', 'contact'));
  if (site.cartPosition === 'top') {
    links.push(`<a href="/store/${site.slug}/cart" style="color:${t.ink};text-decoration:none;margin-left:20px;font-size:.88rem;font-weight:${current === 'cart' ? '700' : '600'};">🛒 Cart (<span id="sb-topbar-cart-count">0</span>)</a>`);
  }

  const hasLogoVideo = !!site.logoVideoUrl;
  const namePosition = site.storeNamePosition === 'center' ? 'center' : 'left';
  const videoPosition = site.logoVideoPosition === 'right' ? 'right' : site.logoVideoPosition === 'center' ? 'center' : 'left';
  const storeNameHtml = `<span style="font-family:${t.headingFont};font-size:1rem;font-weight:700;color:${t.ink};white-space:nowrap;">${escapeHtml(site.store_name)}</span>`;
  const logoVideoHtml = hasLogoVideo ? `<video src="${escapeHtml(site.logoVideoUrl)}" autoplay muted loop playsinline style="height:52px;width:auto;border-radius:6px;display:block;"></video>` : '';

  const leftParts = [];
  if (hasLogoVideo && videoPosition === 'left') leftParts.push(logoVideoHtml);
  if (namePosition === 'left') leftParts.push(storeNameHtml);

  const centerParts = [];
  if (hasLogoVideo && videoPosition === 'center') centerParts.push(logoVideoHtml);
  if (namePosition === 'center') centerParts.push(storeNameHtml);

  const rightParts = [];
  if (hasLogoVideo && videoPosition === 'right') rightParts.push(logoVideoHtml);
  rightParts.push(`<div>${links.join('')}</div>`);

  const barPadding = hasLogoVideo ? '20px 24px' : '14px 24px';

  return `<div class="sb-topbar" style="background:${t.topbarBg};border-bottom:1px solid ${t.border};position:sticky;top:0;z-index:5;">
    <div style="width:100%;padding:${barPadding};display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:16px;box-sizing:border-box;">
      <div style="display:flex;align-items:center;gap:14px;">${leftParts.join('')}</div>
      <div style="display:flex;align-items:center;gap:14px;justify-content:center;">${centerParts.join('')}</div>
      <div style="display:flex;align-items:center;gap:20px;justify-self:end;">${rightParts.join('')}</div>
    </div>
  </div>`;
}

// Compact hero: background media shown at full brightness (no dimming), with
// any caption text placed in a small solid badge for legibility instead of
// darkening the whole image.
// Shared cart utilities included on every storefront page: cart state (in
// localStorage, so it survives navigating to the dedicated cart page),
// a toast for "added to cart", and -- unless this IS the cart page itself,
// or the seller put the cart icon in the topbar instead -- the floating
// cart button.
function renderCartAndCheckout(site, opts) {
  opts = opts || {};
  const showFab = !opts.hideFab && site.cartPosition !== 'top';
  return `
${showFab ? `<a class="cart-fab" href="/store/${site.slug}/cart" style="text-decoration:none;">🛒 Cart (<span id="sb-cart-count">0</span>)</a>` : ''}
<script>
var SB_SLUG = ${JSON.stringify(site.slug)};
var SB_KEY = 'sb_cart_' + SB_SLUG;
function sbGetCart(){ try { return JSON.parse(localStorage.getItem(SB_KEY) || '[]'); } catch(e){ return []; } }
function sbSaveCart(c){ localStorage.setItem(SB_KEY, JSON.stringify(c)); sbUpdateCount(); }
function sbUpdateCount(){
  var n = sbGetCart().reduce(function(a,i){return a+i.qty;},0);
  var el1 = document.getElementById('sb-cart-count');
  if (el1) el1.textContent = n;
  var el2 = document.getElementById('sb-topbar-cart-count');
  if (el2) el2.textContent = n;
}
function sbShowToast(msg){
  var el = document.getElementById('sb-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'sb-toast';
    el.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#1A1A1A;color:#fff;padding:12px 22px;border-radius:100px;font-size:.9rem;font-weight:600;z-index:50;box-shadow:0 4px 16px rgba(0,0,0,.25);opacity:0;transition:opacity .25s ease;pointer-events:none;';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.style.opacity = '1';
  clearTimeout(window._sbToastTimer);
  window._sbToastTimer = setTimeout(function(){ el.style.opacity = '0'; }, 2200);
}
window.sbShowToast = sbShowToast;
window.sbAddToCart = function(id, name, price, image, size, originalPrice){
  var cart = sbGetCart();
  size = size || '';
  var ex = cart.find(function(i){ return i.id === id && (i.size || '') === size; });
  if (ex) ex.qty++; else cart.push({ id: id, name: name, price: price, originalPrice: originalPrice || 0, image: image, size: size, qty: 1 });
  sbSaveCart(cart);
};
sbUpdateCount();
document.addEventListener('click', function(e){
  var btn = e.target.closest('.add-to-cart-btn');
  if (!btn) return;
  sbAddToCart(Number(btn.dataset.id), btn.dataset.name, Number(btn.dataset.price), btn.dataset.image, btn.dataset.size || '', Number(btn.dataset.originalPrice) || 0);
  sbShowToast(btn.dataset.name + ' added to cart');
});

// Remembers the scroll position of whichever page the customer is leaving
// (e.g. scrolled halfway down the homepage to find a product) and restores
// it when they land back on that same page/URL -- via "Back to Home", a
// category link, or the browser's own back button -- instead of dumping
// them back at the top.
(function(){
  function scrollKey(){ return 'sb_scroll_' + window.location.pathname + window.location.search; }
  document.addEventListener('click', function(e){
    var link = e.target.closest('a[href]');
    if (!link) return;
    var href = link.getAttribute('href') || '';
    if (href.indexOf('/store/') !== 0) return;
    try { sessionStorage.setItem(scrollKey(), String(window.scrollY)); } catch(err){}
  });
  window.addEventListener('load', function(){
    try {
      var saved = sessionStorage.getItem(scrollKey());
      if (saved !== null) {
        sessionStorage.removeItem(scrollKey());
        window.scrollTo(0, parseInt(saved, 10) || 0);
      }
    } catch(err){}
  });
})();
</script>
`;
}

// The dedicated cart page (linked from the floating button or topbar icon,
// same as About Us / Contact Us): itemised cart on the left, an order
// summary with savings + checkout form on the right.
function renderCartPage(site, t) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Your Cart — ${escapeHtml(site.store_name)}</title>
<link href="${t.fontsUrl}" rel="stylesheet">
<style>
  *{box-sizing:border-box;}
  body{margin:0;font-family:${t.bodyFont};background:${t.bg};color:${t.ink};}
  h1,h2{font-family:${t.headingFont};}
  .container{width:100%;padding:32px 24px;max-width:1200px;margin:0 auto;}
  label{display:block;font-size:.85rem;font-weight:600;margin:12px 0 4px;}
  input,select,textarea{width:100%;padding:10px;border:1px solid ${t.border};border-radius:6px;font-size:.95rem;font-family:inherit;background:${t.cardBg};color:${t.ink};}
  .btn{display:inline-block;background:${t.btnBg};color:${t.btnText};padding:12px 20px;border-radius:${t.btnRadius};text-decoration:none;font-weight:600;border:none;cursor:pointer;font-size:.95rem;width:100%;}
  .price{color:${t.accent};}
  .price-scratch{font-size:.85rem;color:${t.muted};text-decoration:line-through;margin-left:6px;}

  .cart-page-layout{display:grid;grid-template-columns:1fr 360px;gap:32px;align-items:start;margin-top:8px;}
  @media (max-width:800px){ .cart-page-layout{grid-template-columns:1fr;} }
  .cart-item-row{display:flex;gap:16px;align-items:center;padding:18px 0;border-bottom:1px solid ${t.border};}
  .cart-item-thumb{width:72px;height:72px;object-fit:cover;border-radius:${t.radius};flex-shrink:0;}
  .cart-item-info{flex:1;min-width:0;}
  .cart-item-name{font-weight:600;margin-bottom:4px;}
  .cart-item-meta{color:${t.muted};font-size:.85rem;margin-bottom:8px;}
  .cart-item-qty{display:flex;align-items:center;gap:10px;}
  .cart-item-qty button{width:26px;height:26px;border-radius:6px;border:1px solid ${t.border};background:${t.cardBg};cursor:pointer;font-weight:700;color:${t.ink};}
  .cart-item-right{text-align:right;flex-shrink:0;}
  .cart-item-remove{background:none;border:none;color:${t.muted};cursor:pointer;font-size:.9rem;margin-bottom:8px;padding:0;}
  .cart-item-price{font-weight:700;}
  .cart-item-saved{color:#1a8a5f;font-size:.8rem;margin-top:4px;}

  .cart-summary-card{background:${t.cardBg};border:1px solid ${t.border};border-radius:${t.radius};padding:24px;}
  .cart-summary-row{display:flex;justify-content:space-between;padding:8px 0;color:${t.muted};}
  .cart-savings-row{color:#1a8a5f;font-weight:600;}
  .cart-summary-total{display:flex;justify-content:space-between;font-weight:700;font-size:1.15rem;padding-top:12px;margin-top:8px;border-top:1px solid ${t.border};}
  .coupon-row{display:flex;gap:8px;margin-bottom:6px;}
  .coupon-row input{flex:1;}
  .secondary-btn{width:auto;flex-shrink:0;background:${t.cardBg};color:${t.ink};border:1px solid ${t.border};padding:10px 16px;}
  .coupon-message{font-size:.82rem;margin-bottom:10px;min-height:1em;}
  .coupon-message.ok{color:#1a8a5f;}
  .coupon-message.error{color:#d94f5c;}
  footer{text-align:center;padding:24px;color:${t.muted};font-size:.85rem;}
</style></head>
<body>
${renderTopbar(site, 'cart', t)}
<div class="container">
  <h1 style="margin-bottom:8px;">Your Cart</h1>
  <div class="cart-page-layout">
    <div id="sb-cart-page-items"></div>
    <div>
      <div id="sb-cart-page-empty" style="display:none;color:${t.muted};">Your cart is empty. <a href="/store/${site.slug}" style="color:${t.accent};">Continue shopping</a>.</div>
      <div class="cart-summary-card" id="sb-cart-page-summary">
        <div class="coupon-row">
          <input type="text" id="sb-coupon-input" placeholder="Coupon code" style="text-transform:uppercase;"/>
          <button class="btn secondary-btn" id="sb-coupon-apply-btn" type="button">Apply</button>
        </div>
        <div id="sb-coupon-message" class="coupon-message"></div>
        <div class="cart-summary-row"><span>Subtotal</span><span id="sb-cart-subtotal">₹0</span></div>
        <div class="cart-summary-row cart-savings-row" id="sb-cart-savings-row" style="display:none;"><span>You're saving</span><span id="sb-cart-savings">₹0</span></div>
        <div class="cart-summary-row cart-savings-row" id="sb-coupon-savings-row" style="display:none;"><span>Coupon applied</span><span id="sb-coupon-savings">₹0</span></div>
        <div class="cart-summary-total"><span>Total</span><span id="sb-cart-page-total">₹0</span></div>
        <button class="btn" id="sb-proceed-btn" style="margin-top:16px;" type="button">Proceed to Checkout</button>
        <div id="sb-checkout-form" style="display:none;margin-top:8px;">
          <label>Full name</label><input id="sb-name" required/>
          <label>Email</label><input id="sb-email" type="email"/>
          <label>Phone</label><input id="sb-phone" required/>
          <label>Delivery address</label><textarea id="sb-address" rows="3" required></textarea>
          <label>Payment method</label>
          <select id="sb-payment">
            <option value="UPI">UPI</option>
            <option value="COD">Cash on Delivery</option>
            <option value="Net Banking">Net Banking</option>
            <option value="Card">Card</option>
          </select>
          <button class="btn" id="sb-place-order-btn" style="margin-top:16px;" type="button">Place Order</button>
        </div>
      </div>
    </div>
  </div>
</div>
<footer>Made with BuddySite</footer>

${renderCartAndCheckout(site, { hideFab: true })}
<script>
(function(){
  function money(n){ return '₹' + n; }
  function keyOf(i){ return i.id + '|' + (i.size || ''); }
  function findByKey(cart, key){
    var parts = key.split('|'); var id = Number(parts[0]); var size = parts.slice(1).join('|');
    return cart.find(function(i){ return i.id === id && (i.size || '') === size; });
  }
  function removeByKey(cart, key){
    var parts = key.split('|'); var id = Number(parts[0]); var size = parts.slice(1).join('|');
    return cart.filter(function(i){ return !(i.id === id && (i.size || '') === size); });
  }
  var appliedCoupon = null; // { code, discount }
  function render(){
    var cart = sbGetCart();
    var itemsEl = document.getElementById('sb-cart-page-items');
    var emptyEl = document.getElementById('sb-cart-page-empty');
    var summaryEl = document.getElementById('sb-cart-page-summary');
    if (cart.length === 0) {
      itemsEl.innerHTML = '';
      emptyEl.style.display = 'block';
      summaryEl.style.display = 'none';
      return;
    }
    emptyEl.style.display = 'none';
    summaryEl.style.display = 'block';
    itemsEl.innerHTML = cart.map(function(i){
      var thumb = i.image ? '<img src="' + i.image + '" class="cart-item-thumb"/>' : '<div class="cart-item-thumb" style="background:${t.border};"></div>';
      var saved = (i.originalPrice && i.originalPrice > i.price) ? (i.originalPrice - i.price) * i.qty : 0;
      var priceHtml = '<span class="cart-item-price price">₹' + (i.price * i.qty) + '</span>' + (saved > 0 ? '<span class="price-scratch">₹' + (i.originalPrice * i.qty) + '</span>' : '');
      var savedHtml = saved > 0 ? '<div class="cart-item-saved">You saved ₹' + saved + '</div>' : '';
      var key = keyOf(i);
      return '<div class="cart-item-row">' +
        thumb +
        '<div class="cart-item-info">' +
          '<div class="cart-item-name">' + i.name + '</div>' +
          (i.size ? '<div class="cart-item-meta">Size: ' + i.size + '</div>' : '') +
          '<div class="cart-item-qty">' +
            '<button type="button" data-act="dec" data-key="' + key + '">−</button>' +
            '<span>' + i.qty + '</span>' +
            '<button type="button" data-act="inc" data-key="' + key + '">+</button>' +
          '</div>' +
        '</div>' +
        '<div class="cart-item-right">' +
          '<button type="button" class="cart-item-remove" data-act="rm" data-key="' + key + '">✕ Remove</button>' +
          '<div>' + priceHtml + '</div>' +
          savedHtml +
        '</div>' +
      '</div>';
    }).join('');
    var subtotal = cart.reduce(function(a, i){ return a + i.price * i.qty; }, 0);
    var savings = cart.reduce(function(a, i){ return a + ((i.originalPrice && i.originalPrice > i.price) ? (i.originalPrice - i.price) * i.qty : 0); }, 0);
    document.getElementById('sb-cart-subtotal').textContent = money(subtotal);
    var savingsRow = document.getElementById('sb-cart-savings-row');
    if (savings > 0) { savingsRow.style.display = 'flex'; document.getElementById('sb-cart-savings').textContent = money(savings); }
    else savingsRow.style.display = 'none';
    var couponRow = document.getElementById('sb-coupon-savings-row');
    var couponDiscount = appliedCoupon ? Math.min(appliedCoupon.discount, subtotal) : 0;
    if (couponDiscount > 0) { couponRow.style.display = 'flex'; document.getElementById('sb-coupon-savings').textContent = '−' + money(couponDiscount); }
    else couponRow.style.display = 'none';
    document.getElementById('sb-cart-page-total').textContent = money(Math.max(0, subtotal - couponDiscount));
  }
  document.getElementById('sb-cart-page-items').addEventListener('click', function(e){
    var btn = e.target.closest('button[data-act]');
    if (!btn) return;
    var cart = sbGetCart();
    var key = btn.dataset.key;
    if (btn.dataset.act === 'inc') { var it = findByKey(cart, key); if (it) it.qty++; }
    else if (btn.dataset.act === 'dec') { var it2 = findByKey(cart, key); if (it2) { it2.qty--; if (it2.qty <= 0) cart = removeByKey(cart, key); } }
    else if (btn.dataset.act === 'rm') { cart = removeByKey(cart, key); }
    sbSaveCart(cart);
    render();
  });
  document.getElementById('sb-coupon-apply-btn').addEventListener('click', function(){
    var codeEl = document.getElementById('sb-coupon-input');
    var msgEl = document.getElementById('sb-coupon-message');
    var code = codeEl.value.trim();
    if (!code) return;
    var cart = sbGetCart();
    var subtotal = cart.reduce(function(a, i){ return a + i.price * i.qty; }, 0);
    msgEl.textContent = 'Checking...';
    msgEl.className = 'coupon-message';
    fetch('/api/public/sites/' + SB_SLUG + '/coupons/validate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: code, cartTotal: subtotal })
    })
      .then(function(r){ return r.json().then(function(data){ return { ok: r.ok, data: data }; }); })
      .then(function(res){
        if (!res.ok) { appliedCoupon = null; msgEl.textContent = res.data.error || 'That coupon isn\u2019t valid.'; msgEl.className = 'coupon-message error'; render(); return; }
        appliedCoupon = { code: res.data.code, discount: res.data.discount };
        msgEl.textContent = 'Coupon "' + res.data.code + '" applied!';
        msgEl.className = 'coupon-message ok';
        render();
      })
      .catch(function(){ msgEl.textContent = 'Something went wrong checking that coupon.'; msgEl.className = 'coupon-message error'; });
  });
  document.getElementById('sb-proceed-btn').addEventListener('click', function(){
    var form = document.getElementById('sb-checkout-form');
    form.style.display = 'block';
    this.style.display = 'none';
    form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
  document.getElementById('sb-place-order-btn').addEventListener('click', function(){
    var name = document.getElementById('sb-name').value;
    var phone = document.getElementById('sb-phone').value;
    var address = document.getElementById('sb-address').value;
    if (!name || !phone || !address) { alert('Please fill in your name, phone, and address.'); return; }
    var paymentMethod = document.getElementById('sb-payment').value;
    var cart = sbGetCart();
    if (cart.length === 0) { alert('Your cart is empty.'); return; }
    var subtotal = cart.reduce(function(a, i){ return a + i.price * i.qty; }, 0);
    var total = Math.max(0, subtotal - (appliedCoupon ? Math.min(appliedCoupon.discount, subtotal) : 0));
    var paymentLink = ${JSON.stringify(site.payment_link || '')};
    if (paymentMethod !== 'COD' && !paymentLink) {
      alert("This seller hasn't set up online payments yet. Please choose Cash on Delivery, or contact them directly.");
      return;
    }
    var payload = {
      customerName: name,
      email: document.getElementById('sb-email').value,
      phone: phone,
      address: address,
      paymentMethod: paymentMethod,
      items: cart,
      couponCode: appliedCoupon ? appliedCoupon.code : ''
    };
    fetch('/api/public/sites/' + SB_SLUG + '/order', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      .then(function(r){ return r.json(); })
      .then(function(data){
        if (data.error) { alert(data.error); return; }
        localStorage.removeItem(SB_KEY);
        sbUpdateCount();
        if (paymentMethod === 'COD') {
          alert('Order placed! Pay ₹' + total + ' in cash when it arrives.');
        } else {
          alert("Order placed! You'll now be sent to pay ₹" + total + ". Please enter that exact amount on the payment page.");
          window.open(paymentLink, '_blank');
        }
        window.location.href = '/store/' + SB_SLUG;
      })
      .catch(function(){ alert('Something went wrong placing your order.'); });
  });
  render();
})();
</script>
</body></html>`;
}

// Splits an array into fixed-size chunks -- used to lay categories out
// 4-per-row, wrapping to a new row after every 4.
function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Round "popping out" category tile: a flat colour disc sits behind the
// category photo, and the photo itself is scaled up and anchored to the
// bottom of the disc so it visually spills out over the top edge (works
// best with a background-removed / transparent PNG, but degrades fine for
// a normal photo too since it's still clipped to a circle either way).
function renderCategoryTile(c, site, plan, t) {
  const hasImg = plan.categoryImages && c.image;
  return `
    <a class="category-tile" href="/store/${site.slug}/category/${c.id}">
      <div class="cat-circle">
        ${hasImg
          ? `<img class="cat-pop-img" src="${escapeHtml(c.image)}" alt="${escapeHtml(c.name)}"/>`
          : '<div class="category-tile-noimg">🛍️</div>'}
      </div>
      <span>${escapeHtml(c.name)}</span>
    </a>`;
}

// Whole-number discount %, only when a scratch (original) price is actually
// higher than the selling price.
function priceDiscountPercent(p) {
  if (p && p.originalPrice && p.originalPrice > p.price) {
    return Math.round((1 - p.price / p.originalPrice) * 100);
  }
  return 0;
}

// "₹price" alone, or "₹price  ₹~~original~~  X% OFF" when a scratch price is set.
function renderPriceRow(p) {
  const off = priceDiscountPercent(p);
  if (off > 0) {
    return `<span class="price">₹${p.price}</span><span class="price-scratch">₹${p.originalPrice}</span><span class="price-off">${off}% OFF</span>`;
  }
  return `<span class="price">₹${p.price}</span>`;
}

function renderProductCard(p, t, site, extraAttrs) {
  const detailHref = site ? `/store/${site.slug}/product/${p.id}` : '#';
  return `
    <div class="product-card"${extraAttrs || ''}>
      <a class="product-card-link" href="${detailHref}">
        ${p.image ? `<img src="${escapeHtml(p.image)}" alt="${escapeHtml(p.name)}"/>` : '<div class="no-img">No image</div>'}
        <div class="product-body">
          <h3>${escapeHtml(p.name)}</h3>
          ${p.color ? `<p class="meta">${escapeHtml(p.color)}</p>` : ''}
          <p class="price-row">${renderPriceRow(p)}</p>
        </div>
      </a>
      <div class="product-card-actions">
        <button class="btn add-to-cart-btn" data-id="${p.id}" data-name="${escapeHtml(p.name)}" data-price="${p.price}" data-image="${escapeHtml(p.image || '')}">Add to Cart</button>
      </div>
    </div>`;
}

function renderHero(bgUrl, bgType, t, captionHtml, descStyle) {
  const bg = bgUrl
    ? (bgType === 'video'
      ? `<video autoplay muted loop playsinline style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;"><source src="${escapeHtml(bgUrl)}"></video>`
      : `<img src="${escapeHtml(bgUrl)}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;"/>`)
    : '';
  const align = (descStyle && descStyle.align) || 'center';
  const justify = align === 'left' ? 'flex-start' : align === 'right' ? 'flex-end' : 'center';
  const fontFamily = DESCRIPTION_FONTS[(descStyle && descStyle.font)] || DESCRIPTION_FONTS.inter;
  const fontSize = DESCRIPTION_SIZES[(descStyle && descStyle.size)] || DESCRIPTION_SIZES.medium;
  return `<div style="position:relative;min-height:${bgUrl ? '320px' : '160px'};display:flex;align-items:flex-end;justify-content:${justify};padding:28px 24px;overflow:hidden;${bgUrl ? '' : 'background:' + t.heroFallback + ';'}">
    ${bg}
    ${captionHtml ? `<div style="position:relative;z-index:1;background:${t.cardBg};color:${t.ink};padding:10px 20px;border-radius:${t.btnRadius === '100px' ? '100px' : '6px'};font-size:${fontSize};font-family:${fontFamily};text-align:${align};max-width:560px;box-shadow:0 2px 12px rgba(0,0,0,.15);">${captionHtml}</div>` : ''}
  </div>`;
}

// Renders the optional per-product Size Guide (shown in a modal, not a full
// page) -- supports paragraphs, images, and bullet points (heading optional).
function renderSizeGuideBlocks(content, t) {
  return (content || []).map(b => {
    if (b.type === 'paragraph' && b.text) {
      return `<p style="line-height:1.7;margin:0 0 16px;">${escapeHtml(b.text)}</p>`;
    }
    if (b.type === 'image' && b.url) {
      return `<img src="${escapeHtml(b.url)}" style="max-width:100%;border-radius:${t.radius};display:block;margin:0 0 16px;"/>`;
    }
    if (b.type === 'bullet' && b.text) {
      return `<div style="margin:0 0 14px;">${b.heading ? `<strong style="display:block;margin-bottom:2px;">${escapeHtml(b.heading)}</strong>` : ''}<p style="margin:0;line-height:1.6;color:${t.muted};">${escapeHtml(b.text)}</p></div>`;
    }
    return '';
  }).join('');
}

function renderPageBlocks(content, t) {
  const blocks = content || [];
  const cardStyle = `background:${t.cardBg};border:1px solid ${t.border};border-radius:${t.radius};padding:32px;margin-bottom:24px;color:${t.ink};`;

  return blocks.map(b => {
    if (b.type === 'paragraph') {
      return `
      <div style="${cardStyle}">
        <p style="line-height:1.9;font-size:1.05rem;margin:0;text-align:left;">${escapeHtml(b.text || '')}</p>
      </div>`;
    }
    if (b.type === 'image' && b.url) {
      const url = escapeHtml(b.url);
      // Breaks out of the container's own side padding so the photo truly
      // touches that edge, instead of floating in the middle of a padded card.
      if (b.align === 'left') {
        return `
      <div style="margin:0 0 24px -24px;width:calc(50% + 24px);max-width:660px;">
        <img src="${url}" style="display:block;width:100%;height:auto;border-radius:0 ${t.radius} ${t.radius} 0;"/>
      </div>`;
      }
      if (b.align === 'right') {
        return `
      <div style="margin:0 -24px 24px auto;width:calc(50% + 24px);max-width:660px;">
        <img src="${url}" style="display:block;width:100%;height:auto;border-radius:${t.radius} 0 0 ${t.radius};"/>
      </div>`;
      }
      return `
      <div style="text-align:center;margin-bottom:24px;">
        <img src="${url}" style="max-width:70%;border-radius:${t.radius};"/>
      </div>`;
    }
    return '';
  }).join('');
}

function renderInfoPage(site, plan, pageKey, title) {
  const t = getTheme(site.theme);
  const page = site[pageKey] || { content: [], background_url: '', background_type: 'image' };
  const hero = renderHero(page.background_url, page.background_type, t, `<strong style="font-family:${t.headingFont};">${escapeHtml(title)}</strong>`);
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${escapeHtml(title)} — ${escapeHtml(site.store_name)}</title>
<link href="${t.fontsUrl}" rel="stylesheet">
<style>
  *{box-sizing:border-box;}
  body{margin:0;font-family:${t.bodyFont};background:${t.bg};color:${t.ink};}
  h1,h2{font-family:${t.headingFont};}
  .container{width:100%;padding:40px 24px;}
  footer{text-align:center;padding:24px;color:${t.muted};font-size:.85rem;}
</style></head>
<body>
${renderTopbar(site, pageKey === 'aboutPage' ? 'about' : 'contact', t)}
${hero}
<div class="container">${renderPageBlocks(page.content, t) || `<p style="color:${t.muted};text-align:center;">Nothing here yet.</p>`}</div>
<footer>Made with BuddySite</footer>
</body></html>`;
}

// Renders a full-width "Connect with us" bar with a contrasting background
// and real, clickable icon links to whichever socials the seller has set.
function renderSocialLinks(social, t) {
  const items = [
    ['instagram', 'Instagram', '📸'], ['facebook', 'Facebook', '📘'], ['twitter', 'Twitter / X', '🐦'],
    ['youtube', 'YouTube', '▶️'], ['tiktok', 'TikTok', '🎵'], ['website', 'Website', '🌐']
  ];
  const links = items.filter(([k]) => social && social[k]);
  if (!links.length) return '';
  return `
  <div class="social-bar">
    <div class="social-bar-inner">
      <span class="social-bar-label">Connect with us</span>
      <div class="social-bar-links">
        ${links.map(([k, label, icon]) => `<a href="${escapeHtml(social[k])}" target="_blank" rel="noopener" class="social-icon-link"><span>${icon}</span> ${escapeHtml(label)}</a>`).join('')}
      </div>
    </div>
  </div>`;
}

// Multi-slide homepage banner: auto-advances, has left/right arrows and dot
// indicators, and slides with a smooth CSS transform transition.
function renderHeroSlider(slides) {
  if (!slides.length) return '';
  const n = slides.length;
  return `
  <div class="hero-slider">
    <div class="hero-track" id="heroTrack" style="width:${n * 100}%;">
      ${slides.map(s => `
        <div class="hero-slide" style="width:${100 / n}%;">
          ${s.image ? `<img src="${escapeHtml(s.image)}" alt=""/>` : ''}
          ${(s.heading || s.subtext) ? `<div class="hero-slide-caption">
            ${s.heading ? `<h1>${escapeHtml(s.heading)}</h1>` : ''}
            ${s.subtext ? `<p>${escapeHtml(s.subtext)}${s.link ? ` &middot; <a href="${escapeHtml(s.link)}">Tap to explore</a>` : ''}</p>` : ''}
          </div>` : ''}
        </div>`).join('')}
    </div>
    ${n > 1 ? `
      <button class="hero-arrow hero-arrow-left" onclick="sbHeroPrev()" aria-label="Previous slide">‹</button>
      <button class="hero-arrow hero-arrow-right" onclick="sbHeroNext()" aria-label="Next slide">›</button>
      <div class="hero-dots">${slides.map((_, i) => `<span class="hero-dot${i === 0 ? ' active' : ''}" data-i="${i}"></span>`).join('')}</div>
    ` : ''}
  </div>
  <script>
  (function(){
    var track = document.getElementById('heroTrack');
    if (!track) return;
    var n = track.children.length;
    var idx = 0;
    var dots = document.querySelectorAll('.hero-dot');
    function go(i){
      idx = (i + n) % n;
      track.style.transform = 'translateX(-' + (idx * (100 / n)) + '%)';
      dots.forEach(function(d, j){ d.classList.toggle('active', j === idx); });
    }
    window.sbHeroNext = function(){ go(idx + 1); resetTimer(); };
    window.sbHeroPrev = function(){ go(idx - 1); resetTimer(); };
    dots.forEach(function(d){ d.addEventListener('click', function(){ go(Number(d.dataset.i)); resetTimer(); }); });
    var timer;
    function resetTimer(){ clearInterval(timer); if (n > 1) timer = setInterval(function(){ go(idx + 1); }, 1000); }
    resetTimer();
  })();
  </script>`;
}

// The full Pro-plan homepage, in order: multi-slide hero, named "Sliding
// Products" carousels, titled Category Sections (e.g. "Top Deals"), the
// flat "Shop by Category" tile grid, a "Shop All" grid with a sticky filter
// bar, and a brand-story + socials footer.
function renderProStorefront(site, plan, t) {
  const allProducts = site.products;

  const heroHtml = (site.heroSlides && site.heroSlides.length)
    ? renderHeroSlider(site.heroSlides)
    : renderHero(site.background_url, site.background_type, t, site.description ? escapeHtml(site.description) : '', { align: site.description_align, size: site.description_size, font: site.description_font });

  // Product search: a live, client-side search box sitting right under the
  // hero -- typing filters straight from the seller's product list, with a
  // "Similar Products" row (same category as the matches) underneath.
  const searchProductsJson = JSON.stringify(site.products.map(p => ({
    id: p.id, name: p.name, price: p.price, originalPrice: p.originalPrice || 0, image: p.image || '', categoryId: p.categoryId || null
  })));
  const searchBarHtml = site.products.length ? `
    <div class="section-wrap">
      <h2 class="section-title">Search Products</h2>
      <div class="search-bar-wrap">
        <input type="text" id="storeSearchInput" class="search-bar-input" placeholder="Search for products…"/>
      </div>
      <div id="storeSearchResults" style="display:none;margin-top:24px;">
        <h3 class="search-results-title">Results</h3>
        <div class="product-grid" id="storeSearchResultsGrid"></div>
        <div id="storeSearchSimilarWrap" style="display:none;">
          <h3 class="search-results-title" style="margin-top:32px;">Similar Products</h3>
          <div class="product-grid" id="storeSearchSimilarGrid"></div>
        </div>
      </div>
    </div>
    <script>
    (function(){
      var SB_ALL_PRODUCTS = ${searchProductsJson};
      var SB_SITE_SLUG = ${JSON.stringify(site.slug)};
      function sbEscapeHtml(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){ return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]; }); }
      function sbPriceRowHtml(p){
        var off = (p.originalPrice && p.originalPrice > p.price) ? Math.round((1 - p.price / p.originalPrice) * 100) : 0;
        if (off > 0) return '<span class="price">₹' + p.price + '</span><span class="price-scratch">₹' + p.originalPrice + '</span><span class="price-off">' + off + '% OFF</span>';
        return '<span class="price">₹' + p.price + '</span>';
      }
      function sbProductCardHtml(p){
        var name = sbEscapeHtml(p.name);
        var img = p.image ? '<img src="' + sbEscapeHtml(p.image) + '" alt="' + name + '"/>' : '<div class="no-img">No image</div>';
        return '<div class="product-card">' +
          '<a class="product-card-link" href="/store/' + SB_SITE_SLUG + '/product/' + p.id + '">' + img +
          '<div class="product-body"><h3>' + name + '</h3><p class="price-row">' + sbPriceRowHtml(p) + '</p></div></a>' +
          '<div class="product-card-actions"><button class="btn add-to-cart-btn" data-id="' + p.id + '" data-name="' + name + '" data-price="' + p.price + '" data-image="' + sbEscapeHtml(p.image || '') + '">Add to Cart</button></div>' +
        '</div>';
      }
      var input = document.getElementById('storeSearchInput');
      if (!input) return;
      input.addEventListener('input', function(){
        var q = this.value.trim().toLowerCase();
        var resultsWrap = document.getElementById('storeSearchResults');
        if (!q) { resultsWrap.style.display = 'none'; return; }
        resultsWrap.style.display = 'block';
        var matches = SB_ALL_PRODUCTS.filter(function(p){ return p.name.toLowerCase().indexOf(q) !== -1; });
        document.getElementById('storeSearchResultsGrid').innerHTML = matches.length
          ? matches.map(sbProductCardHtml).join('')
          : '<p class="muted">No products found.</p>';
        var matchIds = matches.map(function(p){ return p.id; });
        var matchCats = matches.map(function(p){ return p.categoryId; }).filter(Boolean);
        var similar = SB_ALL_PRODUCTS.filter(function(p){ return matchIds.indexOf(p.id) === -1 && matchCats.indexOf(p.categoryId) !== -1; }).slice(0, 8);
        var simWrap = document.getElementById('storeSearchSimilarWrap');
        if (similar.length) {
          simWrap.style.display = 'block';
          document.getElementById('storeSearchSimilarGrid').innerHTML = similar.map(sbProductCardHtml).join('');
        } else {
          simWrap.style.display = 'none';
        }
      });
    })();
    </script>` : '';

  // Sliding Products: named, admin-curated horizontally-scrolling carousels
  // (e.g. "New Arrivals", "Trending Now") -- unlike the old auto-generated
  // "New Arrivals" section, the seller names each one and picks exactly
  // which products appear in it.
  const productById = {};
  site.products.forEach(p => productById[p.id] = p);
  const slidingSectionsHtml = (site.slidingSections || []).map(g => {
    const prods = (g.productIds || []).map(id => productById[id]).filter(Boolean);
    if (!prods.length) return '';
    const trackId = `slidingTrack-${g.id}`;
    return `
    <div class="section-wrap">
      <h2 class="section-title">${escapeHtml(g.title)}</h2>
      <div class="carousel-wrap">
        <button class="carousel-arrow carousel-arrow-left" onclick="sbScrollCarousel('${trackId}',-1)" aria-label="Previous">‹</button>
        <div class="carousel-track" id="${trackId}">
          ${prods.map(p => renderProductCard(p, t, site)).join('')}
        </div>
        <button class="carousel-arrow carousel-arrow-right" onclick="sbScrollCarousel('${trackId}',1)" aria-label="Next">›</button>
      </div>
    </div>`;
  }).join('');

  // "Shop by Category" is always built from the seller's flat category list
  // (Categories tab) -- independent of Category Sections, so categories never
  // disappear no matter how sections are used.
  const shopByCategoryHtml = site.categories.length ? `
    <div class="section-wrap">
      <h2 class="section-title">Shop by Category</h2>
      <div class="cat-tile-grid">
        ${site.categories.map(c => `
          <a class="cat-sq-tile" href="/store/${site.slug}/category/${c.id}">
            ${(plan.categoryImages && c.image) ? `<img src="${escapeHtml(c.image)}" alt="${escapeHtml(c.name)}"/>` : `<div class="cat-sq-noimg"></div>`}
            <span>${escapeHtml(c.name)}</span>
          </a>`).join('')}
      </div>
    </div>` : '';

  // Category Sections are custom-titled homepage blocks (e.g. "Top Deals",
  // "Summer Sale") that the seller fills with specific products directly.
  const categoryGroupsHtml = (site.categoryGroups || []).map(g => {
    const prods = (g.productIds || []).map(id => productById[id]).filter(Boolean);
    if (!prods.length) return '';
    return `
    <div class="section-wrap">
      <h2 class="section-title">${escapeHtml(g.title)}</h2>
      <div class="product-grid">
        ${prods.map(p => renderProductCard(p, t, site)).join('')}
      </div>
    </div>`;
  }).join('');

  const shopAllHtml = allProducts.length ? `
    <div class="section-wrap">
      <h2 class="section-title">Shop All</h2>
      <div class="filter-bar" id="filterBar">
        <button class="filter-pill active" data-filter="all">Trending</button>
        ${site.categories.map(c => `<button class="filter-pill" data-filter="${c.id}">${escapeHtml(c.name)}</button>`).join('')}
      </div>
      <div class="product-grid" id="shopAllGrid">
        ${allProducts.map(p => renderProductCard(p, t, site, ` data-category="${p.categoryId || ''}"`)).join('')}
      </div>
    </div>` : '';

  const hasBrandStory = site.brandStory && site.brandStory.content && site.brandStory.content.length;
  const brandStoryHtml = hasBrandStory ? `
    <div class="section-wrap">
      <h2 class="section-title">About ${escapeHtml(site.store_name)}</h2>
      ${renderPageBlocks(site.brandStory.content, t)}
    </div>` : '';
  const socialBarHtml = renderSocialLinks(site.socialLinks, t);

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${escapeHtml(site.store_name)}</title>
<link href="${t.fontsUrl}" rel="stylesheet">
<style>
  *{box-sizing:border-box;}
  body{margin:0;font-family:${t.bodyFont};background:${t.bg};color:${t.ink};}
  h1,h2,h3{font-family:${t.headingFont};}
  .section-wrap{width:100%;padding:36px 24px;}
  .section-title{text-align:center;margin-bottom:20px;letter-spacing:.02em;}

  .search-bar-wrap{max-width:560px;margin:0 auto;}
  .search-bar-input{width:100%;padding:14px 20px;border:1.5px solid ${t.border};border-radius:${t.btnRadius};font-size:1rem;font-family:inherit;background:${t.cardBg};color:${t.ink};}
  .search-bar-input:focus{outline:none;border-color:${t.accent};}
  .search-results-title{text-align:center;margin-bottom:16px;font-size:1.1rem;}

  .hero-slider{position:relative;overflow:hidden;}
  .hero-track{display:flex;transition:transform .6s cubic-bezier(.4,0,.2,1);}
  .hero-slide{position:relative;flex-shrink:0;}
  .hero-slide img{width:100%;height:380px;object-fit:cover;display:block;}
  .hero-slide-caption{position:absolute;left:28px;bottom:28px;color:#fff;text-shadow:0 2px 10px rgba(0,0,0,.45);max-width:70%;}
  .hero-slide-caption h1{font-size:2.1rem;margin:0 0 8px;}
  .hero-slide-caption p{margin:0;font-size:1rem;}
  .hero-slide-caption a{color:#fff;text-decoration:underline;}
  .hero-arrow{position:absolute;top:50%;transform:translateY(-50%);background:rgba(255,255,255,.9);border:none;width:40px;height:40px;border-radius:50%;font-size:1.4rem;cursor:pointer;z-index:2;line-height:1;}
  .hero-arrow-left{left:16px;} .hero-arrow-right{right:16px;}
  .hero-dots{position:absolute;bottom:16px;left:50%;transform:translateX(-50%);display:flex;gap:6px;z-index:2;}
  .hero-dot{width:7px;height:7px;border-radius:50%;background:rgba(255,255,255,.55);cursor:pointer;}
  .hero-dot.active{background:#fff;}

  .carousel-wrap{position:relative;}
  .carousel-track{display:flex;gap:18px;overflow-x:auto;scroll-behavior:smooth;scroll-snap-type:x mandatory;padding-bottom:4px;-ms-overflow-style:none;scrollbar-width:none;}
  .carousel-track::-webkit-scrollbar{display:none;}
  .carousel-track .product-card{flex:0 0 230px;scroll-snap-align:start;}
  .carousel-arrow{position:absolute;top:38%;background:${t.cardBg};border:1px solid ${t.border};width:36px;height:36px;border-radius:50%;cursor:pointer;z-index:2;font-size:1.2rem;line-height:1;}
  .carousel-arrow-left{left:-14px;} .carousel-arrow-right{right:-14px;}

  .cat-tile-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:22px;}
  .cat-sq-tile{display:block;text-decoration:none;color:${t.ink};}
  .cat-sq-tile img,.cat-sq-noimg{width:100%;aspect-ratio:4/5;object-fit:cover;border-radius:${t.radius};background:${t.catDiscBg};display:block;}
  .cat-sq-tile span{display:block;margin-top:12px;font-weight:700;letter-spacing:.03em;text-transform:uppercase;font-size:.95rem;text-align:center;}

  .filter-bar{position:sticky;top:0;background:${t.bg};z-index:6;display:flex;gap:10px;overflow-x:auto;padding:14px 0;margin-bottom:22px;border-bottom:1px solid ${t.border};-ms-overflow-style:none;scrollbar-width:none;}
  .filter-bar::-webkit-scrollbar{display:none;}
  .filter-pill{flex:0 0 auto;padding:9px 20px;border-radius:100px;border:1px solid ${t.border};background:${t.cardBg};color:${t.ink};font-weight:600;font-size:.85rem;cursor:pointer;white-space:nowrap;}
  .filter-pill.active{background:${t.btnBg};color:${t.btnText};border-color:${t.btnBg};}

  .product-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:20px;}
  .product-card{background:${t.cardBg};border:1px solid ${t.border};border-radius:${t.radius};overflow:hidden;}
  .product-card-link{display:block;text-decoration:none;color:inherit;}
  .product-card img{width:100%;height:180px;object-fit:cover;}
  .no-img{width:100%;height:180px;background:${t.border};display:flex;align-items:center;justify-content:center;color:${t.muted};}
  .product-body{padding:16px 16px 4px;}
  .meta{color:${t.muted};font-size:.85rem;margin:2px 0 6px;}
  .price-row{margin:4px 0 8px;}
  .price{font-size:1.2rem;font-weight:700;color:${t.accent};}
  .price-scratch{font-size:.85rem;color:${t.muted};text-decoration:line-through;margin-left:6px;}
  .price-off{font-size:.7rem;font-weight:700;color:#fff;background:#1a8a5f;padding:2px 8px;border-radius:100px;margin-left:6px;vertical-align:middle;}
  .product-card-actions{padding:0 16px 16px;}
  .btn{display:inline-block;background:${t.btnBg};color:${t.btnText};padding:10px 20px;border-radius:${t.btnRadius};text-decoration:none;font-weight:600;border:none;cursor:pointer;font-size:.95rem;width:100%;}

  .social-bar{width:100%;background:${t.ink};padding:26px 24px;}
  .social-bar-inner{display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:16px;}
  .social-bar-label{color:${t.bg};font-weight:700;letter-spacing:.03em;text-transform:uppercase;font-size:.8rem;opacity:.7;margin-right:6px;}
  .social-bar-links{display:flex;flex-wrap:wrap;gap:10px;justify-content:center;}
  .social-icon-link{display:inline-flex;align-items:center;gap:8px;color:${t.bg};text-decoration:none;font-weight:600;font-size:.88rem;padding:9px 18px;border-radius:100px;background:rgba(255,255,255,.1);}
  .social-icon-link:hover{background:rgba(255,255,255,.18);}

  .cart-fab{position:fixed;bottom:20px;right:20px;background:${t.ink};color:${t.bg};padding:14px 22px;border-radius:${t.btnRadius};cursor:pointer;font-weight:600;box-shadow:0 4px 16px rgba(0,0,0,.25);z-index:10;}
  .modal-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:20;align-items:center;justify-content:center;}
  .modal-overlay.open{display:flex;}
  .modal{background:${t.cardBg};color:${t.ink};border-radius:${t.radius};padding:28px;max-width:440px;width:90%;max-height:85vh;overflow-y:auto;}
  .modal h2{margin-top:0;}
  .cart-row{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid ${t.border};}
  label{display:block;font-size:.85rem;font-weight:600;margin:12px 0 4px;}
  input,select,textarea{width:100%;padding:10px;border:1px solid ${t.border};border-radius:6px;font-size:.95rem;font-family:inherit;background:${t.bg};color:${t.ink};}
  .total-row{font-weight:700;font-size:1.1rem;margin:14px 0;text-align:right;}
  footer{text-align:center;padding:28px 24px;color:${t.muted};font-size:.85rem;}
  .footer-tagline{margin:0 0 6px;font-weight:600;color:${t.ink};}
</style></head>
<body>
${renderTopbar(site, 'home', t)}
${heroHtml}
${searchBarHtml}
${slidingSectionsHtml}
${categoryGroupsHtml}
${shopByCategoryHtml}
${shopAllHtml}
${brandStoryHtml}
${socialBarHtml}
<footer>
  <p class="footer-tagline">This store was built with BuddySite — build your own free online store at BuddySite.</p>
  <p>Made with BuddySite</p>
</footer>

${renderCartAndCheckout(site)}
<script>
(function(){
  var bar = document.getElementById('filterBar');
  if (bar) {
    var topbarEl = document.querySelector('.sb-topbar');
    if (topbarEl) bar.style.top = topbarEl.offsetHeight + 'px';
    bar.addEventListener('click', function(e){
      var btn = e.target.closest('.filter-pill');
      if (!btn) return;
      bar.querySelectorAll('.filter-pill').forEach(function(b){ b.classList.remove('active'); });
      btn.classList.add('active');
      var filter = btn.dataset.filter;
      document.querySelectorAll('#shopAllGrid .product-card').forEach(function(card){
        card.style.display = (filter === 'all' || card.dataset.category === filter) ? '' : 'none';
      });
    });
  }
  window.sbScrollCarousel = function(id, dir){
    var el = document.getElementById(id);
    if (el) el.scrollBy({ left: dir * 520, behavior: 'smooth' });
  };
})();
</script>
</body></html>`;
}

app.get('/store/:slug/cart', (req, res) => {
  const site = db.getSiteBySlug(req.params.slug);
  if (!site || !site.published) return res.status(404).send('<h1>Store not found or not published yet.</h1>');
  const t = getTheme(site.theme);
  res.send(renderCartPage(site, t));
});

app.get('/store/:slug/about', (req, res) => {
  const site = db.getSiteBySlug(req.params.slug);
  if (!site || !site.published) return res.status(404).send('<h1>Store not found or not published yet.</h1>');
  const user = db.getUserById(site.user_id);
  const plan = PLANS[user.plan] || { watermark: true };
  res.send(renderInfoPage(site, plan, 'aboutPage', 'About Us'));
});

app.get('/store/:slug/contact', (req, res) => {
  const site = db.getSiteBySlug(req.params.slug);
  if (!site || !site.published) return res.status(404).send('<h1>Store not found or not published yet.</h1>');
  const user = db.getUserById(site.user_id);
  const plan = PLANS[user.plan] || { watermark: true };
  res.send(renderInfoPage(site, plan, 'contactPage', 'Contact Us'));
});

app.get('/store/:slug/category/:categoryId', (req, res) => {
  const site = db.getSiteBySlug(req.params.slug);
  if (!site || !site.published) return res.status(404).send('<h1>Store not found or not published yet.</h1>');
  const user = db.getUserById(site.user_id);
  const plan = PLANS[user.plan] || { watermark: true };
  const t = getTheme(site.theme);

  const category = site.categories.find(c => c.id === Number(req.params.categoryId));
  if (!category) return res.status(404).send('<h1>Category not found.</h1>');
  const products = site.products.filter(p => p.categoryId === category.id);

  res.send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${escapeHtml(category.name)} — ${escapeHtml(site.store_name)}</title>
<link href="${t.fontsUrl}" rel="stylesheet">
<style>
  *{box-sizing:border-box;}
  body{margin:0;font-family:${t.bodyFont};background:${t.bg};color:${t.ink};}
  h1,h2,h3{font-family:${t.headingFont};}
  .container{width:100%;padding:32px 24px;}
  .back-link{display:inline-block;margin-bottom:20px;color:${t.muted};text-decoration:none;font-size:.9rem;}
  .product-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:20px;}
  .product-card{background:${t.cardBg};border:1px solid ${t.border};border-radius:${t.radius};overflow:hidden;}
  .product-card-link{display:block;text-decoration:none;color:inherit;}
  .product-card img{width:100%;height:180px;object-fit:cover;}
  .no-img{width:100%;height:180px;background:${t.border};display:flex;align-items:center;justify-content:center;color:${t.muted};}
  .product-body{padding:16px 16px 4px;}
  .meta{color:${t.muted};font-size:.85rem;margin:2px 0 6px;}
  .price-row{margin:4px 0 8px;}
  .price{font-size:1.2rem;font-weight:700;color:${t.accent};}
  .price-scratch{font-size:.85rem;color:${t.muted};text-decoration:line-through;margin-left:6px;}
  .price-off{font-size:.7rem;font-weight:700;color:#fff;background:#1a8a5f;padding:2px 8px;border-radius:100px;margin-left:6px;vertical-align:middle;}
  .product-card-actions{padding:0 16px 16px;}
  .btn{display:inline-block;background:${t.btnBg};color:${t.btnText};padding:10px 20px;border-radius:${t.btnRadius};text-decoration:none;font-weight:600;border:none;cursor:pointer;font-size:.95rem;width:100%;}
  .cart-fab{position:fixed;bottom:20px;right:20px;background:${t.ink};color:${t.bg};padding:14px 22px;border-radius:${t.btnRadius};cursor:pointer;font-weight:600;box-shadow:0 4px 16px rgba(0,0,0,.25);z-index:10;}
  .modal-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:20;align-items:center;justify-content:center;}
  .modal-overlay.open{display:flex;}
  .modal{background:${t.cardBg};color:${t.ink};border-radius:${t.radius};padding:28px;max-width:440px;width:90%;max-height:85vh;overflow-y:auto;}
  .modal h2{margin-top:0;}
  .cart-row{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid ${t.border};}
  label{display:block;font-size:.85rem;font-weight:600;margin:12px 0 4px;}
  input,select,textarea{width:100%;padding:10px;border:1px solid ${t.border};border-radius:6px;font-size:.95rem;font-family:inherit;background:${t.bg};color:${t.ink};}
  .total-row{font-weight:700;font-size:1.1rem;margin:14px 0;text-align:right;}
  footer{text-align:center;padding:24px;color:${t.muted};font-size:.85rem;}
</style></head>
<body>
${renderTopbar(site, 'home', t)}
<div class="container">
  <a class="back-link" href="/store/${site.slug}">← Back to Home</a>
  <h1 style="margin-bottom:24px;">${escapeHtml(category.name)}</h1>
  <div class="product-grid">
    ${products.length ? products.map(p => renderProductCard(p, t, site)).join('') : `<p style="color:${t.muted};">No products in this category yet.</p>`}
  </div>
</div>
<footer>Made with BuddySite</footer>

${renderCartAndCheckout(site)}
</body></html>`);
});

// Product detail page: sliding image gallery on the left, name/price/
// description/Add to Cart in large text on the right, and a "Similar
// Products" grid below (same category), regardless of whether the customer
// arrived via a category page, a homepage category section, or the general
// product grid -- it's always driven by the product's own category.
app.get('/store/:slug/product/:productId', (req, res) => {
  const site = db.getSiteBySlug(req.params.slug);
  if (!site || !site.published) return res.status(404).send('<h1>Store not found or not published yet.</h1>');
  const user = db.getUserById(site.user_id);
  const plan = PLANS[user.plan] || { watermark: true };
  const t = getTheme(site.theme);

  const product = site.products.find(p => p.id === Number(req.params.productId));
  if (!product) return res.status(404).send('<h1>Product not found.</h1>');

  const images = (product.images && product.images.length) ? product.images : (product.image ? [product.image] : []);
  const sizes = product.sizes && product.sizes.length ? product.sizes : (product.size ? [product.size] : []);
  const hasSizeGuide = product.sizeGuide && product.sizeGuide.content && product.sizeGuide.content.length;
  const category = product.categoryId ? site.categories.find(c => c.id === product.categoryId) : null;
  const similar = product.categoryId ? site.products.filter(p => p.categoryId === product.categoryId && p.id !== product.id).slice(0, 8) : [];

  const whatsappEnabled = plan.whatsapp;
  const productUrl = `https://${req.get('host')}/store/${site.slug}/product/${product.id}`;
  const waMessage = encodeURIComponent(`Check this out: ${product.name} - ₹${product.price}\n${productUrl}`);
  const whatsappShareHtml = whatsappEnabled ? `
    <a class="whatsapp-share-btn" href="https://wa.me/?text=${waMessage}" target="_blank" rel="noopener">Share on WhatsApp</a>` : '';

  const galleryHtml = images.length ? `
    <div class="prod-gallery-wrap">
      ${images.length > 1 ? `
      <div class="prod-thumbs" id="prodThumbs">
        ${images.map((img, i) => `<button type="button" class="prod-thumb${i === 0 ? ' active' : ''}" data-i="${i}" onclick="pgGoTo(${i})"><img src="${escapeHtml(img)}" alt=""/></button>`).join('')}
      </div>` : ''}
      <div class="prod-gallery">
        <div class="prod-gallery-track" id="prodTrack" style="width:${images.length * 100}%;">
          ${images.map(img => `<div class="prod-gallery-slide" style="width:${100 / images.length}%;"><img src="${escapeHtml(img)}" alt="${escapeHtml(product.name)}"/></div>`).join('')}
        </div>
        ${images.length > 1 ? `
          <button class="hero-arrow hero-arrow-left" onclick="pgPrev()" aria-label="Previous image">‹</button>
          <button class="hero-arrow hero-arrow-right" onclick="pgNext()" aria-label="Next image">›</button>
        ` : ''}
      </div>
    </div>
    <script>
    (function(){
      var track = document.getElementById('prodTrack');
      if (!track) return;
      var n = track.children.length;
      var idx = 0;
      var thumbs = document.querySelectorAll('.prod-thumb');
      var thumbsWrap = document.getElementById('prodThumbs');
      function go(i){
        idx = (i + n) % n;
        track.style.transform = 'translateX(-' + (idx * (100 / n)) + '%)';
        thumbs.forEach(function(th, j){ th.classList.toggle('active', j === idx); });
        var activeThumb = thumbs[idx];
        if (activeThumb && thumbsWrap) {
          activeThumb.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
      }
      window.pgNext = function(){ go(idx + 1); };
      window.pgPrev = function(){ go(idx - 1); };
      window.pgGoTo = function(i){ go(i); };
    })();
    </script>` : `<div class="prod-gallery"><div class="no-img" style="height:100%;">No image</div></div>`;

  const sizeHtml = sizes.length ? `
    <div class="prod-size-wrap">
      <div class="prod-size-label-row">
        <span class="prod-size-label">Select Size</span>
        ${hasSizeGuide ? `<button type="button" class="prod-size-guide-link" onclick="pgOpenSizeGuide()">Size Guide ›</button>` : ''}
      </div>
      <div class="prod-size-options">
        ${sizes.map(s => `<button type="button" class="prod-size-chip" data-size="${escapeHtml(s)}" onclick="pgSelectSize(this)">${escapeHtml(s)}</button>`).join('')}
      </div>
    </div>` : '';

  const sizeGuideModalHtml = hasSizeGuide ? `
    <div class="modal-overlay" id="pgSizeGuideModal">
      <div class="modal">
        <div class="row-between" style="margin-bottom:12px;"><h2 style="margin:0;">${escapeHtml(product.sizeGuide.title || 'Size Guide')}</h2><button type="button" onclick="pgCloseSizeGuide()" style="background:none;border:none;font-size:1.3rem;cursor:pointer;color:${t.muted};">✕</button></div>
        ${renderSizeGuideBlocks(product.sizeGuide.content, t)}
      </div>
    </div>` : '';

  const similarHtml = similar.length ? `
    <div class="section-wrap">
      <h2 class="section-title">Similar Products${category ? ` in ${escapeHtml(category.name)}` : ''}</h2>
      <div class="product-grid">
        ${similar.map(p => renderProductCard(p, t, site)).join('')}
      </div>
    </div>` : '';

  res.send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${escapeHtml(product.name)} — ${escapeHtml(site.store_name)}</title>
<link href="${t.fontsUrl}" rel="stylesheet">
<style>
  *{box-sizing:border-box;}
  body{margin:0;font-family:${t.bodyFont};background:${t.bg};color:${t.ink};}
  h1,h2,h3{font-family:${t.headingFont};}
  .container{width:100%;padding:32px 24px;}
  .section-wrap{width:100%;padding:36px 24px;}
  .section-title{text-align:center;margin-bottom:20px;letter-spacing:.02em;}
  .back-link{display:inline-block;margin-bottom:20px;color:${t.muted};text-decoration:none;font-size:.9rem;}
  .row-between{display:flex;justify-content:space-between;align-items:center;}

  .prod-layout{display:grid;grid-template-columns:1.1fr 1fr;gap:44px;align-items:start;}
  @media (max-width:800px){ .prod-layout{grid-template-columns:1fr;} }

  .prod-gallery-wrap{display:flex;gap:14px;}
  .prod-thumbs{display:flex;flex-direction:column;gap:10px;width:72px;flex-shrink:0;max-height:480px;overflow-y:auto;}
  .prod-thumb{border:2px solid transparent;border-radius:8px;padding:0;overflow:hidden;cursor:pointer;background:none;width:100%;height:72px;flex-shrink:0;}
  .prod-thumb img{width:100%;height:100%;object-fit:cover;display:block;}
  .prod-thumb.active{border-color:${t.accent};}
  .prod-gallery{flex:1;position:relative;overflow:hidden;border-radius:${t.radius};background:${t.cardBg};border:1px solid ${t.border};min-width:0;}
  .prod-gallery-track{display:flex;transition:transform .5s cubic-bezier(.4,0,.2,1);}
  .prod-gallery-slide{flex-shrink:0;}
  .prod-gallery-slide img{width:100%;height:480px;object-fit:cover;display:block;}
  .hero-arrow{position:absolute;top:50%;transform:translateY(-50%);background:rgba(255,255,255,.9);border:none;width:40px;height:40px;border-radius:50%;font-size:1.4rem;cursor:pointer;z-index:2;line-height:1;}
  .hero-arrow-left{left:16px;} .hero-arrow-right{right:16px;}

  .prod-info{padding-top:4px;}
  .prod-info h1{font-size:2.1rem;margin:0 0 12px;}
  .prod-meta{color:${t.muted};font-size:1rem;margin:0 0 14px;}
  .prod-price-row{margin:0 0 22px;}
  .prod-price-row .price{font-size:2rem;}
  .prod-price-row .price-scratch{font-size:1.1rem;}
  .prod-price-row .price-off{font-size:.8rem;padding:4px 10px;}
  .prod-desc{font-size:1.05rem;line-height:1.6;color:${t.ink};margin:0 0 28px;white-space:pre-wrap;}
  .prod-add-btn{font-size:1.1rem;padding:16px 24px;}
  .whatsapp-share-btn{display:block;text-align:center;margin-top:10px;padding:12px;border-radius:${t.btnRadius};background:#25D366;color:#fff;text-decoration:none;font-weight:600;font-size:.92rem;}

  .prod-size-wrap{margin:0 0 28px;}
  .prod-size-label-row{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;}
  .prod-size-label{font-weight:600;font-size:.95rem;}
  .prod-size-guide-link{background:none;border:none;color:${t.accent};font-size:.85rem;font-weight:600;cursor:pointer;text-decoration:underline;padding:0;}
  .prod-size-options{display:flex;flex-wrap:wrap;gap:10px;}
  .prod-size-chip{min-width:44px;height:44px;padding:0 14px;border:1.5px solid ${t.border};border-radius:8px;background:${t.cardBg};color:${t.ink};font-weight:600;cursor:pointer;font-size:.9rem;}
  .prod-size-chip.selected{border-color:${t.accent};background:${t.accent};color:#fff;}

  .product-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:20px;}
  .product-card{background:${t.cardBg};border:1px solid ${t.border};border-radius:${t.radius};overflow:hidden;}
  .product-card-link{display:block;text-decoration:none;color:inherit;}
  .product-card img{width:100%;height:180px;object-fit:cover;}
  .no-img{width:100%;height:180px;background:${t.border};display:flex;align-items:center;justify-content:center;color:${t.muted};}
  .product-body{padding:16px 16px 4px;}
  .meta{color:${t.muted};font-size:.85rem;margin:2px 0 6px;}
  .price-row{margin:4px 0 8px;}
  .price{font-size:1.2rem;font-weight:700;color:${t.accent};}
  .price-scratch{font-size:.85rem;color:${t.muted};text-decoration:line-through;margin-left:6px;}
  .price-off{font-size:.7rem;font-weight:700;color:#fff;background:#1a8a5f;padding:2px 8px;border-radius:100px;margin-left:6px;vertical-align:middle;}
  .product-card-actions{padding:0 16px 16px;}
  .btn{display:inline-block;background:${t.btnBg};color:${t.btnText};padding:10px 20px;border-radius:${t.btnRadius};text-decoration:none;font-weight:600;border:none;cursor:pointer;font-size:.95rem;width:100%;}
  .cart-fab{position:fixed;bottom:20px;right:20px;background:${t.ink};color:${t.bg};padding:14px 22px;border-radius:${t.btnRadius};cursor:pointer;font-weight:600;box-shadow:0 4px 16px rgba(0,0,0,.25);z-index:10;}
  .modal-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:20;align-items:center;justify-content:center;}
  .modal-overlay.open{display:flex;}
  .modal{background:${t.cardBg};color:${t.ink};border-radius:${t.radius};padding:28px;max-width:440px;width:90%;max-height:85vh;overflow-y:auto;}
  .modal h2{margin-top:0;}
  label{display:block;font-size:.85rem;font-weight:600;margin:12px 0 4px;}
  input,select,textarea{width:100%;padding:10px;border:1px solid ${t.border};border-radius:6px;font-size:.95rem;font-family:inherit;background:${t.bg};color:${t.ink};}
  footer{text-align:center;padding:24px;color:${t.muted};font-size:.85rem;}

  .pg-finalize-row{display:flex;gap:14px;align-items:center;margin-bottom:16px;}
  .pg-finalize-thumb{width:64px;height:64px;object-fit:cover;border-radius:8px;flex-shrink:0;}
  .pg-finalize-name{font-weight:600;margin-bottom:4px;}
  .pg-finalize-size{font-size:.9rem;color:${t.muted};margin:8px 0;}
  .pg-qty-stepper{display:flex;align-items:center;gap:14px;margin-top:6px;}
  .pg-qty-stepper button{width:32px;height:32px;border-radius:8px;border:1px solid ${t.border};background:${t.bg};cursor:pointer;font-weight:700;font-size:1.1rem;color:${t.ink};}
</style></head>
<body>
${renderTopbar(site, 'home', t)}
<div class="container">
  <a class="back-link" href="${category ? `/store/${site.slug}/category/${category.id}` : `/store/${site.slug}`}">← Back to ${category ? escapeHtml(category.name) : 'Home'}</a>
  <div class="prod-layout">
    ${galleryHtml}
    <div class="prod-info">
      <h1>${escapeHtml(product.name)}</h1>
      ${product.color ? `<p class="prod-meta">${escapeHtml(product.color)}</p>` : ''}
      <p class="prod-price-row">${renderPriceRow(product)}</p>
      ${sizeHtml}
      ${product.description ? `<p class="prod-desc">${escapeHtml(product.description)}</p>` : ''}
      <button class="btn prod-add-btn" type="button" id="pgAddToCartBtn">Add to Cart</button>
      ${whatsappShareHtml}
    </div>
  </div>
</div>
${similarHtml}
<footer>Made with BuddySite</footer>

${sizeGuideModalHtml}
<div class="modal-overlay" id="pgFinalizeModal">
  <div class="modal">
    <h2>Confirm your item</h2>
    <div class="pg-finalize-row">
      ${images[0] ? `<img src="${escapeHtml(images[0])}" class="pg-finalize-thumb"/>` : ''}
      <div>
        <div class="pg-finalize-name">${escapeHtml(product.name)}</div>
        <div>${renderPriceRow(product)}</div>
      </div>
    </div>
    ${sizes.length ? `<p class="pg-finalize-size">Size: <strong id="pgFinalizeSize"></strong></p>` : ''}
    <label>Quantity</label>
    <div class="pg-qty-stepper">
      <button type="button" onclick="pgQtyChange(-1)">−</button>
      <span id="pgQty">1</span>
      <button type="button" onclick="pgQtyChange(1)">+</button>
    </div>
    <button class="btn" style="margin-top:20px;" type="button" onclick="pgConfirmAddToCart()">Add to Bag</button>
    <button class="btn" style="background:${t.border};color:${t.ink};margin-top:8px;" type="button" onclick="pgCloseFinalize()">Cancel</button>
  </div>
</div>

${renderCartAndCheckout(site)}
<script>
(function(){
  var PRODUCT_ID = ${product.id};
  var PRODUCT_NAME = ${JSON.stringify(product.name)};
  var PRODUCT_PRICE = ${product.price};
  var PRODUCT_ORIGINAL_PRICE = ${product.originalPrice || 0};
  var PRODUCT_IMAGE = ${JSON.stringify(product.image || '')};
  var SIZES = ${JSON.stringify(sizes)};
  var pgQty = 1;
  var pgSelectedSize = '';

  window.pgSelectSize = function(btn){
    document.querySelectorAll('.prod-size-chip').forEach(function(b){ b.classList.remove('selected'); });
    btn.classList.add('selected');
    pgSelectedSize = btn.dataset.size;
  };
  window.pgOpenSizeGuide = function(){ document.getElementById('pgSizeGuideModal').classList.add('open'); };
  window.pgCloseSizeGuide = function(){ document.getElementById('pgSizeGuideModal').classList.remove('open'); };
  window.pgQtyChange = function(d){ pgQty = Math.max(1, pgQty + d); document.getElementById('pgQty').textContent = pgQty; };
  window.pgCloseFinalize = function(){ document.getElementById('pgFinalizeModal').classList.remove('open'); };
  window.pgConfirmAddToCart = function(){
    for (var i = 0; i < pgQty; i++) {
      sbAddToCart(PRODUCT_ID, PRODUCT_NAME, PRODUCT_PRICE, PRODUCT_IMAGE, pgSelectedSize, PRODUCT_ORIGINAL_PRICE);
    }
    document.getElementById('pgFinalizeModal').classList.remove('open');
    sbShowToast(PRODUCT_NAME + ' added to cart');
    pgQty = 1;
    document.getElementById('pgQty').textContent = '1';
  };
  document.getElementById('pgAddToCartBtn').addEventListener('click', function(){
    if (SIZES.length > 0 && !pgSelectedSize) { alert('Please select a size.'); return; }
    var sizeEl = document.getElementById('pgFinalizeSize');
    if (sizeEl) sizeEl.textContent = pgSelectedSize;
    document.getElementById('pgFinalizeModal').classList.add('open');
  });
})();
</script>
</body></html>`);
});

app.get('/store/:slug', (req, res) => {
  const site = db.getSiteBySlug(req.params.slug);
  if (!site || !site.published) return res.status(404).send('<h1>Store not found or not published yet.</h1>');
  const user = db.getUserById(site.user_id);
  const plan = PLANS[user.plan] || { watermark: true };
  const t = getTheme(site.theme);

  if (plan.key === 'pro') {
    return res.send(renderProStorefront(site, plan, t));
  }

  const categoryMap = {};
  site.categories.forEach(c => categoryMap[c.id] = c);
  const uncategorized = site.products.filter(p => !p.categoryId || !categoryMap[p.categoryId]);

  const uncategorizedHtml = uncategorized.length ? `
    <div class="cat-section">
      <div class="product-grid">
        ${uncategorized.map(p => renderProductCard(p, t, site)).join('')}
      </div>
    </div>` : '';

  const categoryRows = chunkArray(site.categories, 4);
  const categoryTilesHtml = site.categories.length ? `
    <div class="cat-section">
      ${uncategorized.length ? '<h2 class="cat-title">Shop by Category</h2>' : ''}
      <div class="category-grid-wrap">
        ${categoryRows.map((row, i) => `
          <div class="category-row ${i % 2 === 1 ? 'category-row-shift' : ''}">
            ${row.map(c => renderCategoryTile(c, site, plan, t)).join('')}
          </div>
        `).join('')}
      </div>
    </div>` : '';

  const productsHtml = uncategorizedHtml + categoryTilesHtml;

  const hero = renderHero(site.background_url, site.background_type, t, site.description ? escapeHtml(site.description) : '', { align: site.description_align, size: site.description_size, font: site.description_font });

  res.send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${escapeHtml(site.store_name)}</title>
<link href="${t.fontsUrl}" rel="stylesheet">
<style>
  *{box-sizing:border-box;}
  body{margin:0;font-family:${t.bodyFont};background:${t.bg};color:${t.ink};}
  h1,h2,h3{font-family:${t.headingFont};}
  .container{width:100%;padding:32px 24px;}
  .cat-title{margin-bottom:16px;}
  .cat-section{margin-bottom:36px;}
  .product-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:20px;}
  .category-grid-wrap{background:${t.catSectionBg};border-radius:${t.radius};padding:28px 20px 20px;}
  .category-row{display:flex;justify-content:center;gap:22px;flex-wrap:wrap;}
  .category-row + .category-row{margin-top:26px;}
  .category-row-shift{transform:translateX(46px);}
  .category-tile{flex:0 0 auto;display:flex;flex-direction:column;align-items:center;justify-content:flex-start;gap:10px;width:112px;text-decoration:none;color:${t.ink};font-weight:600;font-size:.85rem;text-align:center;transition:transform .15s ease;}
  .category-tile:hover{transform:translateY(-3px);}
  .cat-circle{position:relative;width:104px;height:104px;border-radius:50%;background:${t.catDiscBg};border:1px solid ${t.catDiscBorder};box-shadow:0 3px 10px rgba(0,0,0,.08);overflow:visible;}
  .cat-pop-img{position:absolute;left:50%;bottom:2px;width:82%;height:112%;max-width:none;object-fit:contain;object-position:center bottom;transform:translateX(-50%);filter:drop-shadow(0 8px 8px rgba(0,0,0,.18));}
  .category-tile-noimg{width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:2.1rem;border-radius:50%;}
  @media (max-width:640px){
    .category-row-shift{transform:translateX(24px);}
    .cat-circle{width:88px;height:88px;}
    .category-tile{width:96px;}
  }
  .product-card{background:${t.cardBg};border:1px solid ${t.border};border-radius:${t.radius};overflow:hidden;}
  .product-card-link{display:block;text-decoration:none;color:inherit;}
  .product-card img{width:100%;height:180px;object-fit:cover;}
  .no-img{width:100%;height:180px;background:${t.border};display:flex;align-items:center;justify-content:center;color:${t.muted};}
  .product-body{padding:16px 16px 4px;}
  .meta{color:${t.muted};font-size:.85rem;margin:2px 0 6px;}
  .price-row{margin:4px 0 8px;}
  .price{font-size:1.2rem;font-weight:700;color:${t.accent};}
  .price-scratch{font-size:.85rem;color:${t.muted};text-decoration:line-through;margin-left:6px;}
  .price-off{font-size:.7rem;font-weight:700;color:#fff;background:#1a8a5f;padding:2px 8px;border-radius:100px;margin-left:6px;vertical-align:middle;}
  .product-card-actions{padding:0 16px 16px;}
  .btn{display:inline-block;background:${t.btnBg};color:${t.btnText};padding:10px 20px;border-radius:${t.btnRadius};text-decoration:none;font-weight:600;border:none;cursor:pointer;font-size:.95rem;width:100%;}
  .cart-fab{position:fixed;bottom:20px;right:20px;background:${t.ink};color:${t.bg};padding:14px 22px;border-radius:${t.btnRadius};cursor:pointer;font-weight:600;box-shadow:0 4px 16px rgba(0,0,0,.25);z-index:10;}
  .modal-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:20;align-items:center;justify-content:center;}
  .modal-overlay.open{display:flex;}
  .modal{background:${t.cardBg};color:${t.ink};border-radius:${t.radius};padding:28px;max-width:440px;width:90%;max-height:85vh;overflow-y:auto;}
  .modal h2{margin-top:0;}
  .cart-row{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid ${t.border};}
  label{display:block;font-size:.85rem;font-weight:600;margin:12px 0 4px;}
  input,select,textarea{width:100%;padding:10px;border:1px solid ${t.border};border-radius:6px;font-size:.95rem;font-family:inherit;background:${t.bg};color:${t.ink};}
  .total-row{font-weight:700;font-size:1.1rem;margin:14px 0;text-align:right;}
  footer{text-align:center;padding:24px;color:${t.muted};font-size:.85rem;}
</style></head>
<body>
${renderTopbar(site, 'home', t)}
${hero}
<div class="container">${productsHtml || `<p style="text-align:center;color:${t.muted};">No products yet — check back soon!</p>`}</div>
<footer>Made with BuddySite</footer>

${renderCartAndCheckout(site)}
</body></html>`);
});

app.listen(process.env.PORT || 3000, () => {
  console.log(`Server running on http://localhost:${process.env.PORT || 3000}`);
  if (!razorpayEnabled) console.log('Razorpay keys not set -- payments are disabled until you add them to .env');
});
