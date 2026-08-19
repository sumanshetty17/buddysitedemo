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
const { PLANS, DISCOUNT_PERCENT, PLATFORM_FEE_PERCENT } = require('./plans');

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

// ---------- ORDERS ----------
app.get('/api/sites/:id/orders', requireAuth, loadOwnedSite, (req, res) => res.json({ orders: db.getOrders(req.site.id) }));

app.put('/api/sites/:id/orders/:orderId', requireAuth, loadOwnedSite, (req, res) => {
  const { status } = req.body || {};
  if (!['new', 'paid', 'fulfilled'].includes(status)) return res.status(400).json({ error: 'Invalid status.' });
  const order = db.updateOrderStatus(req.site.id, req.params.orderId, status);
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  res.json({ order });
});

// Public: a customer places an order from the storefront (no login required)
app.post('/api/public/sites/:slug/order', (req, res) => {
  const site = db.getSiteBySlug(req.params.slug);
  if (!site || !site.published) return res.status(404).json({ error: 'Store not found.' });
  const { customerName, email, phone, address, paymentMethod, items } = req.body || {};
  if (!customerName || !phone || !address || !items || !items.length) return res.status(400).json({ error: 'Please fill in your name, phone, address, and add at least one item.' });
  const total = items.reduce((sum, i) => sum + (Number(i.price) || 0) * (Number(i.qty) || 1), 0);
  const order = db.addOrder(site.id, { customerName, email, phone, address, paymentMethod, items, total });
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
  return `<div class="sb-topbar" style="background:${t.topbarBg};border-bottom:1px solid ${t.border};position:sticky;top:0;z-index:5;">
    <div style="max-width:1100px;margin:0 auto;padding:14px 24px;display:flex;align-items:center;justify-content:space-between;">
      <span style="font-family:${t.headingFont};font-size:1rem;font-weight:700;color:${t.ink};">${escapeHtml(site.store_name)}</span>
      <div>${links.join('')}</div>
    </div>
  </div>`;
}

// Compact hero: background media shown at full brightness (no dimming), with
// any caption text placed in a small solid badge for legibility instead of
// darkening the whole image.
function renderCartAndCheckout(site) {
  return `
<div class="cart-fab" onclick="sbOpenCart()">🛒 Cart (<span id="sb-cart-count">0</span>)</div>

<div class="modal-overlay" id="sb-cart-modal">
  <div class="modal">
    <h2>Your Cart</h2>
    <div id="sb-cart-items"></div>
    <div class="total-row">Total: ₹<span id="sb-cart-total">0</span></div>
    <button class="btn" onclick="sbShowCheckout()">Checkout</button>
    <button class="btn" style="background:#eee;color:#333;margin-top:8px;" onclick="sbCloseCart()">Close</button>
  </div>
</div>

<div class="modal-overlay" id="sb-checkout-modal">
  <div class="modal">
    <h2>Checkout</h2>
    <label>Full name</label><input id="sb-name" required/>
    <label>Email</label><input id="sb-email" type="email"/>
    <label>Phone</label><input id="sb-phone" required/>
    <label>Delivery address</label><textarea id="sb-address" rows="3" required></textarea>
    <label>Payment method</label>
    <select id="sb-payment">
      <option value="COD">Cash on Delivery</option>
      <option value="UPI">UPI</option>
      <option value="Net Banking">Net Banking</option>
      <option value="Card">Card</option>
    </select>
    <button class="btn" style="margin-top:16px;" onclick="sbPlaceOrder()">Place Order</button>
    <button class="btn" style="background:#eee;color:#333;margin-top:8px;" onclick="sbCloseCheckout()">Back</button>
  </div>
</div>

<script>
var SB_SLUG = ${JSON.stringify(site.slug)};
var SB_KEY = 'sb_cart_' + SB_SLUG;
function sbGetCart(){ try { return JSON.parse(localStorage.getItem(SB_KEY) || '[]'); } catch(e){ return []; } }
function sbSaveCart(c){ localStorage.setItem(SB_KEY, JSON.stringify(c)); sbUpdateCount(); }
function sbUpdateCount(){ document.getElementById('sb-cart-count').textContent = sbGetCart().reduce(function(a,i){return a+i.qty;},0); }
window.sbAddToCart = function(id, name, price, image){
  var cart = sbGetCart();
  var ex = cart.find(function(i){ return i.id === id; });
  if (ex) ex.qty++; else cart.push({id:id, name:name, price:price, image:image, qty:1});
  sbSaveCart(cart);
  alert(name + ' added to cart!');
};
window.sbIncrementItem = function(id){
  var cart = sbGetCart();
  var item = cart.find(function(i){ return i.id === id; });
  if (item) item.qty++;
  sbSaveCart(cart);
  sbRenderCartItems();
};
window.sbDecrementItem = function(id){
  var cart = sbGetCart();
  var item = cart.find(function(i){ return i.id === id; });
  if (item) {
    item.qty--;
    if (item.qty <= 0) cart = cart.filter(function(i){ return i.id !== id; });
  }
  sbSaveCart(cart);
  sbRenderCartItems();
};
function sbRenderCartItems(){
  var cart = sbGetCart();
  var itemsEl = document.getElementById('sb-cart-items');
  if (cart.length === 0) { itemsEl.innerHTML = '<p style="color:#aaa;">Your cart is empty.</p>'; }
  else {
    itemsEl.innerHTML = cart.map(function(i){
      var thumb = i.image
        ? '<img src="'+i.image+'" style="width:48px;height:48px;object-fit:cover;border-radius:8px;flex-shrink:0;"/>'
        : '<div style="width:48px;height:48px;border-radius:8px;background:#eee;flex-shrink:0;"></div>';
      return '<div class="cart-row" style="align-items:center;gap:12px;">'
        + thumb
        + '<div style="flex:1;min-width:0;"><div style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">'+i.name+'</div><div style="color:#888;font-size:.85rem;">₹'+i.price+' each</div></div>'
        + '<span style="display:flex;align-items:center;gap:8px;">'
        + '<button onclick="sbDecrementItem('+i.id+')" style="width:26px;height:26px;border-radius:6px;border:1px solid #ccc;background:#fff;cursor:pointer;font-weight:700;">−</button>'
        + '<span>'+i.qty+'</span>'
        + '<button onclick="sbIncrementItem('+i.id+')" style="width:26px;height:26px;border-radius:6px;border:1px solid #ccc;background:#fff;cursor:pointer;font-weight:700;">+</button>'
        + '<span style="min-width:70px;text-align:right;font-weight:600;">₹'+(i.price*i.qty)+'</span>'
        + '</span></div>';
    }).join('');
  }
  document.getElementById('sb-cart-total').textContent = cart.reduce(function(a,i){return a+i.price*i.qty;},0);
}
window.sbOpenCart = function(){
  sbRenderCartItems();
  document.getElementById('sb-cart-modal').classList.add('open');
};
window.sbCloseCart = function(){ document.getElementById('sb-cart-modal').classList.remove('open'); };
window.sbShowCheckout = function(){
  if (sbGetCart().length === 0) { alert('Your cart is empty.'); return; }
  document.getElementById('sb-cart-modal').classList.remove('open');
  document.getElementById('sb-checkout-modal').classList.add('open');
};
window.sbCloseCheckout = function(){ document.getElementById('sb-checkout-modal').classList.remove('open'); };
window.sbPlaceOrder = function(){
  var name = document.getElementById('sb-name').value;
  var phone = document.getElementById('sb-phone').value;
  var address = document.getElementById('sb-address').value;
  if (!name || !phone || !address) { alert('Please fill in your name, phone, and address.'); return; }
  var paymentMethod = document.getElementById('sb-payment').value;
  var cart = sbGetCart();
  var total = cart.reduce(function(a,i){ return a + i.price * i.qty; }, 0);
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
    items: cart
  };
  fetch('/api/public/sites/' + SB_SLUG + '/order', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) })
    .then(function(r){ return r.json(); })
    .then(function(data){
      if (data.error) { alert(data.error); return; }
      localStorage.removeItem(SB_KEY);
      sbUpdateCount();
      document.getElementById('sb-checkout-modal').classList.remove('open');
      if (paymentMethod === 'COD') {
        alert('Order placed! Pay ₹' + total + ' in cash when it arrives.');
      } else {
        alert("Order placed! You'll now be sent to pay ₹" + total + ". Please enter that exact amount on the payment page.");
        window.open(paymentLink, '_blank');
      }
    })
    .catch(function(){ alert('Something went wrong placing your order.'); });
};
sbUpdateCount();
document.addEventListener('click', function(e){
  var btn = e.target.closest('.add-to-cart-btn');
  if (btn) sbAddToCart(Number(btn.dataset.id), btn.dataset.name, Number(btn.dataset.price), btn.dataset.image);
});
</script>
`;
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

function renderProductCard(p, t, site, extraAttrs) {
  const detailHref = site ? `/store/${site.slug}/product/${p.id}` : '#';
  return `
    <div class="product-card"${extraAttrs || ''}>
      <a class="product-card-link" href="${detailHref}">
        ${p.image ? `<img src="${escapeHtml(p.image)}" alt="${escapeHtml(p.name)}"/>` : '<div class="no-img">No image</div>'}
        <div class="product-body">
          <h3>${escapeHtml(p.name)}</h3>
          ${p.size || p.color ? `<p class="meta">${[p.size, p.color].filter(Boolean).map(escapeHtml).join(' · ')}</p>` : ''}
          <p class="price">₹${p.price}</p>
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

function renderPageBlocks(content, t) {
  const blocks = content || [];
  const paragraphs = blocks.filter(b => b.type === 'paragraph');
  const images = blocks.filter(b => b.type === 'image');
  const cardStyle = `background:${t.cardBg};border:1px solid ${t.border};border-radius:${t.radius};padding:32px;margin-bottom:24px;color:${t.ink};`;

  // Text-only: wide bordered card, left-aligned, spanning the container.
  if (images.length === 0) {
    return paragraphs.map(b => `
      <div style="${cardStyle}">
        <p style="line-height:1.9;font-size:1.05rem;margin:0;text-align:left;">${escapeHtml(b.text || '')}</p>
      </div>
    `).join('');
  }

  const justifyFor = align => align === 'left' ? 'flex-start' : align === 'right' ? 'flex-end' : 'center';

  // Pair paragraphs with images by order added. Each pair = one bordered card
  // with text on the left, photo on the right. Leftovers render as their own
  // standalone bordered cards (photo-only respects its chosen alignment).
  const pairCount = Math.max(paragraphs.length, images.length);
  let html = '';
  for (let i = 0; i < pairCount; i++) {
    const para = paragraphs[i];
    const img = images[i];
    if (para && img) {
      html += `
      <div style="${cardStyle}">
        <div style="display:flex;gap:32px;align-items:center;flex-wrap:wrap;">
          <div style="flex:1 1 280px;"><p style="line-height:1.8;font-size:1.02rem;margin:0;">${escapeHtml(para.text || '')}</p></div>
          <img src="${escapeHtml(img.url || '')}" style="flex:1 1 280px;max-width:100%;border-radius:${t.radius};"/>
        </div>
      </div>`;
    } else if (para) {
      html += `
      <div style="${cardStyle}">
        <p style="line-height:1.9;font-size:1.05rem;margin:0;text-align:left;">${escapeHtml(para.text || '')}</p>
      </div>`;
    } else if (img) {
      const breakout = img.align === 'left' ? 'margin-left:calc(50% - 50vw);border-top-left-radius:0;border-bottom-left-radius:0;'
        : img.align === 'right' ? 'margin-right:calc(50% - 50vw);border-top-right-radius:0;border-bottom-right-radius:0;'
        : '';
      html += `
      <div style="background:${t.cardBg};border:1px solid ${t.border};padding:32px;margin-bottom:24px;color:${t.ink};${breakout}">
        <div style="display:flex;justify-content:${justifyFor(img.align)};">
          <img src="${escapeHtml(img.url || '')}" style="max-width:60%;border-radius:${t.radius};"/>
        </div>
      </div>`;
    }
  }
  return html;
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
  .container{max-width:900px;margin:0 auto;padding:40px 24px;}
  footer{text-align:center;padding:24px;color:${t.muted};font-size:.85rem;}
</style></head>
<body>
${renderTopbar(site, pageKey === 'aboutPage' ? 'about' : 'contact', t)}
${hero}
<div class="container">${renderPageBlocks(page.content, t) || `<p style="color:${t.muted};text-align:center;">Nothing here yet.</p>`}</div>
<footer>Made with BuddySite</footer>
</body></html>`;
}

// Renders social icon "pills" for whichever links the seller has filled in.
function renderSocialLinks(social, t) {
  const items = [
    ['instagram', 'Instagram', '📸'], ['facebook', 'Facebook', '📘'], ['twitter', 'Twitter / X', '🐦'],
    ['youtube', 'YouTube', '▶️'], ['tiktok', 'TikTok', '🎵'], ['website', 'Website', '🌐']
  ];
  const links = items.filter(([k]) => social && social[k]);
  if (!links.length) return '';
  return `<div class="social-row">${links.map(([k, label, icon]) => `<a href="${escapeHtml(social[k])}" target="_blank" rel="noopener" class="social-pill">${icon} ${escapeHtml(label)}</a>`).join('')}</div>`;
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
  const socialHtml = renderSocialLinks(site.socialLinks, t);
  const brandStoryHtml = (hasBrandStory || socialHtml) ? `
    <div class="section-wrap brand-story-wrap">
      <h2 class="section-title">About ${escapeHtml(site.store_name)}</h2>
      ${renderPageBlocks(site.brandStory.content, t)}
      ${socialHtml}
    </div>` : '';

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${escapeHtml(site.store_name)}</title>
<link href="${t.fontsUrl}" rel="stylesheet">
<style>
  *{box-sizing:border-box;}
  body{margin:0;font-family:${t.bodyFont};background:${t.bg};color:${t.ink};}
  h1,h2,h3{font-family:${t.headingFont};}
  .section-wrap{max-width:1100px;margin:0 auto;padding:36px 24px;}
  .section-title{text-align:center;margin-bottom:20px;letter-spacing:.02em;}

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
  .price{font-size:1.2rem;font-weight:700;color:${t.accent};margin:4px 0 8px;}
  .product-card-actions{padding:0 16px 16px;}
  .btn{display:inline-block;background:${t.btnBg};color:${t.btnText};padding:10px 20px;border-radius:${t.btnRadius};text-decoration:none;font-weight:600;border:none;cursor:pointer;font-size:.95rem;width:100%;}

  .brand-story-wrap{background:${t.catSectionBg};border-radius:${t.radius};}
  .social-row{display:flex;gap:10px;flex-wrap:wrap;margin-top:18px;justify-content:center;}
  .social-pill{display:inline-flex;align-items:center;gap:6px;padding:9px 18px;border-radius:100px;border:1px solid ${t.border};text-decoration:none;color:${t.ink};font-size:.85rem;font-weight:600;background:${t.cardBg};}

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
${slidingSectionsHtml}
${categoryGroupsHtml}
${shopByCategoryHtml}
${shopAllHtml}
${brandStoryHtml}
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
  .container{max-width:1100px;margin:0 auto;padding:32px 24px;}
  .back-link{display:inline-block;margin-bottom:20px;color:${t.muted};text-decoration:none;font-size:.9rem;}
  .product-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:20px;}
  .product-card{background:${t.cardBg};border:1px solid ${t.border};border-radius:${t.radius};overflow:hidden;}
  .product-card-link{display:block;text-decoration:none;color:inherit;}
  .product-card img{width:100%;height:180px;object-fit:cover;}
  .no-img{width:100%;height:180px;background:${t.border};display:flex;align-items:center;justify-content:center;color:${t.muted};}
  .product-body{padding:16px 16px 4px;}
  .meta{color:${t.muted};font-size:.85rem;margin:2px 0 6px;}
  .price{font-size:1.2rem;font-weight:700;color:${t.accent};margin:4px 0 8px;}
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
  const category = product.categoryId ? site.categories.find(c => c.id === product.categoryId) : null;
  const similar = product.categoryId ? site.products.filter(p => p.categoryId === product.categoryId && p.id !== product.id).slice(0, 8) : [];

  const galleryHtml = images.length ? `
    <div class="prod-gallery">
      <div class="prod-gallery-track" id="prodTrack" style="width:${images.length * 100}%;">
        ${images.map(img => `<div class="prod-gallery-slide" style="width:${100 / images.length}%;"><img src="${escapeHtml(img)}" alt="${escapeHtml(product.name)}"/></div>`).join('')}
      </div>
      ${images.length > 1 ? `
        <button class="hero-arrow hero-arrow-left" onclick="pgPrev()" aria-label="Previous image">‹</button>
        <button class="hero-arrow hero-arrow-right" onclick="pgNext()" aria-label="Next image">›</button>
        <div class="hero-dots">${images.map((_, i) => `<span class="hero-dot${i === 0 ? ' active' : ''}" data-i="${i}"></span>`).join('')}</div>
      ` : ''}
    </div>
    <script>
    (function(){
      var track = document.getElementById('prodTrack');
      if (!track) return;
      var n = track.children.length;
      var idx = 0;
      var dots = document.querySelectorAll('.hero-dot');
      function go(i){
        idx = (i + n) % n;
        track.style.transform = 'translateX(-' + (idx * (100 / n)) + '%)';
        dots.forEach(function(d, j){ d.classList.toggle('active', j === idx); });
      }
      window.pgNext = function(){ go(idx + 1); };
      window.pgPrev = function(){ go(idx - 1); };
      dots.forEach(function(d){ d.addEventListener('click', function(){ go(Number(d.dataset.i)); }); });
    })();
    </script>` : `<div class="prod-gallery"><div class="no-img" style="height:100%;">No image</div></div>`;

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
  .container{max-width:1100px;margin:0 auto;padding:32px 24px;}
  .section-wrap{max-width:1100px;margin:0 auto;padding:36px 24px;}
  .section-title{text-align:center;margin-bottom:20px;letter-spacing:.02em;}
  .back-link{display:inline-block;margin-bottom:20px;color:${t.muted};text-decoration:none;font-size:.9rem;}

  .prod-layout{display:grid;grid-template-columns:1.1fr 1fr;gap:44px;align-items:start;}
  @media (max-width:800px){ .prod-layout{grid-template-columns:1fr;} }

  .prod-gallery{position:relative;overflow:hidden;border-radius:${t.radius};background:${t.cardBg};border:1px solid ${t.border};}
  .prod-gallery-track{display:flex;transition:transform .5s cubic-bezier(.4,0,.2,1);}
  .prod-gallery-slide{flex-shrink:0;}
  .prod-gallery-slide img{width:100%;height:480px;object-fit:cover;display:block;}
  .hero-arrow{position:absolute;top:50%;transform:translateY(-50%);background:rgba(255,255,255,.9);border:none;width:40px;height:40px;border-radius:50%;font-size:1.4rem;cursor:pointer;z-index:2;line-height:1;}
  .hero-arrow-left{left:16px;} .hero-arrow-right{right:16px;}
  .hero-dots{position:absolute;bottom:16px;left:50%;transform:translateX(-50%);display:flex;gap:6px;z-index:2;}
  .hero-dot{width:7px;height:7px;border-radius:50%;background:rgba(0,0,0,.3);cursor:pointer;}
  .hero-dot.active{background:${t.accent};}

  .prod-info{padding-top:4px;}
  .prod-info h1{font-size:2.1rem;margin:0 0 12px;}
  .prod-meta{color:${t.muted};font-size:1rem;margin:0 0 14px;}
  .prod-price{font-size:2rem;font-weight:700;color:${t.accent};margin:0 0 22px;}
  .prod-desc{font-size:1.05rem;line-height:1.6;color:${t.ink};margin:0 0 28px;white-space:pre-wrap;}
  .prod-add-btn{font-size:1.1rem;padding:16px 24px;}

  .product-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:20px;}
  .product-card{background:${t.cardBg};border:1px solid ${t.border};border-radius:${t.radius};overflow:hidden;}
  .product-card-link{display:block;text-decoration:none;color:inherit;}
  .product-card img{width:100%;height:180px;object-fit:cover;}
  .no-img{width:100%;height:180px;background:${t.border};display:flex;align-items:center;justify-content:center;color:${t.muted};}
  .product-body{padding:16px 16px 4px;}
  .meta{color:${t.muted};font-size:.85rem;margin:2px 0 6px;}
  .price{font-size:1.2rem;font-weight:700;color:${t.accent};margin:4px 0 8px;}
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
  <a class="back-link" href="${category ? `/store/${site.slug}/category/${category.id}` : `/store/${site.slug}`}">← Back to ${category ? escapeHtml(category.name) : 'Home'}</a>
  <div class="prod-layout">
    ${galleryHtml}
    <div class="prod-info">
      <h1>${escapeHtml(product.name)}</h1>
      ${product.size || product.color ? `<p class="prod-meta">${[product.size, product.color].filter(Boolean).map(escapeHtml).join(' · ')}</p>` : ''}
      <p class="prod-price">₹${product.price}</p>
      ${product.description ? `<p class="prod-desc">${escapeHtml(product.description)}</p>` : ''}
      <button class="btn prod-add-btn add-to-cart-btn" data-id="${product.id}" data-name="${escapeHtml(product.name)}" data-price="${product.price}" data-image="${escapeHtml(product.image || '')}">Add to Cart</button>
    </div>
  </div>
</div>
${similarHtml}
<footer>Made with BuddySite</footer>

${renderCartAndCheckout(site)}
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
  .container{max-width:1100px;margin:0 auto;padding:32px 24px;}
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
  .price{font-size:1.2rem;font-weight:700;color:${t.accent};margin:4px 0 8px;}
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
