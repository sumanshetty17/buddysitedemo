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
  const { store_name } = req.body || {};
  const name = store_name || 'My Store';
  const slug = slugify(name) + '-' + Date.now().toString().slice(-5);
  const site = db.createSite({ user_id: req.userId, slug, store_name: name });
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
  const updated = db.updateSite(req.site.id, req.body || {});
  res.json({ site: updated });
});

app.delete('/api/sites/:id', requireAuth, loadOwnedSite, (req, res) => { db.deleteSite(req.site.id); res.json({ ok: true }); });

// ---------- ABOUT US / CONTACT US PAGES (all plans; video backgrounds Grow+/Pro only) ----------
app.put('/api/sites/:id/pages/:pageKey', requireAuth, loadOwnedSite, (req, res) => {
  const pageKey = req.params.pageKey === 'about' ? 'aboutPage' : req.params.pageKey === 'contact' ? 'contactPage' : null;
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

// ---------- CATEGORIES (Grow+ only) ----------
app.post('/api/sites/:id/categories', requireAuth, loadOwnedSite, (req, res) => {
  const user = db.getUserById(req.userId);
  const plan = PLANS[user.plan];
  if (!plan.categories) return res.status(403).json({ error: 'Categories are available on the Grow plan and above.' });
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Category name is required.' });
  const category = db.addCategory(req.site.id, name);
  res.json({ category });
});
app.delete('/api/sites/:id/categories/:categoryId', requireAuth, loadOwnedSite, (req, res) => {
  db.deleteCategory(req.site.id, req.params.categoryId);
  res.json({ ok: true });
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
function renderStoreNav(site, current) {
  const hasAbout = site.aboutPage && site.aboutPage.content && site.aboutPage.content.length > 0;
  const hasContact = site.contactPage && site.contactPage.content && site.contactPage.content.length > 0;
  if (!hasAbout && !hasContact) return '';
  const link = (href, label, key) => `<a href="${href}" style="${current === key ? 'font-weight:700;' : ''}">${label}</a>`;
  const links = [link(`/store/${site.slug}`, 'Home', 'home')];
  if (hasAbout) links.push(link(`/store/${site.slug}/about`, 'About Us', 'about'));
  if (hasContact) links.push(link(`/store/${site.slug}/contact`, 'Contact Us', 'contact'));
  return `<nav style="max-width:1000px;margin:0 auto;padding:16px 24px 0;font-size:.9rem;">${links.join(' &nbsp; ')}</nav>
  <style>nav a{color:#8a7a8c;text-decoration:none;margin-right:6px;}</style>`;
}

function renderPageBlocks(content) {
  const blocks = content || [];
  const paragraphs = blocks.filter(b => b.type === 'paragraph');
  const images = blocks.filter(b => b.type === 'image');
  const cardStyle = 'background:#fff;border:1px solid #F3E3DC;border-radius:16px;padding:32px;margin-bottom:24px;box-shadow:0 2px 10px rgba(0,0,0,.04);';

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
          <img src="${escapeHtml(img.url || '')}" style="flex:1 1 280px;max-width:100%;border-radius:12px;"/>
        </div>
      </div>`;
    } else if (para) {
      html += `
      <div style="${cardStyle}">
        <p style="line-height:1.9;font-size:1.05rem;margin:0;text-align:left;">${escapeHtml(para.text || '')}</p>
      </div>`;
    } else if (img) {
      html += `
      <div style="${cardStyle}">
        <div style="display:flex;justify-content:${justifyFor(img.align)};">
          <img src="${escapeHtml(img.url || '')}" style="max-width:60%;border-radius:12px;"/>
        </div>
      </div>`;
    }
  }
  return html;
}

function renderInfoPage(site, plan, pageKey, title) {
  const page = site[pageKey] || { content: [], background_url: '', background_type: 'image' };
  const bg = page.background_url
    ? (page.background_type === 'video'
      ? `<video autoplay muted loop playsinline class="bg-media"><source src="${escapeHtml(page.background_url)}"></video>`
      : `<img src="${escapeHtml(page.background_url)}" class="bg-media"/>`)
    : '';
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${escapeHtml(title)} — ${escapeHtml(site.store_name)}</title>
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@600;700&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  *{box-sizing:border-box;}
  body{margin:0;font-family:'Inter',system-ui,sans-serif;background:#FFF9F5;color:#3D2C3E;}
  h1,h2{font-family:'Poppins',sans-serif;}
  .hero{position:relative;min-height:200px;display:flex;align-items:center;justify-content:center;text-align:center;padding:32px 24px;overflow:hidden;background:linear-gradient(135deg,#FF9A8B,#FF6A88);}
  .bg-media{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:.55;}
  .hero h1{position:relative;z-index:1;color:#fff;text-shadow:0 2px 12px rgba(0,0,0,.25);margin:0;}
  .container{max-width:900px;margin:0 auto;padding:48px 24px;}
  footer{text-align:center;padding:24px;color:#c9b8bb;font-size:.85rem;}
</style></head>
<body>
<div class="hero">${bg}<h1>${escapeHtml(title)}</h1></div>
${renderStoreNav(site, pageKey === 'aboutPage' ? 'about' : 'contact')}
<div class="container">${renderPageBlocks(page.content) || '<p style="color:#a8a29e;text-align:center;">Nothing here yet.</p>'}</div>
${plan.watermark ? `<footer>Made with BuddySite</footer>` : ''}
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

app.get('/store/:slug', (req, res) => {
  const site = db.getSiteBySlug(req.params.slug);
  if (!site || !site.published) return res.status(404).send('<h1>Store not found or not published yet.</h1>');
  const user = db.getUserById(site.user_id);
  const plan = PLANS[user.plan] || { watermark: true };

  const categoryMap = {};
  site.categories.forEach(c => categoryMap[c.id] = c.name);
  const grouped = {};
  site.products.forEach(p => {
    const key = p.categoryId && categoryMap[p.categoryId] ? categoryMap[p.categoryId] : 'Products';
    (grouped[key] = grouped[key] || []).push(p);
  });

  const productsHtml = Object.keys(grouped).map(catName => `
    <div class="cat-section">
      ${Object.keys(grouped).length > 1 ? `<h2 class="cat-title">${escapeHtml(catName)}</h2>` : ''}
      <div class="product-grid">
        ${grouped[catName].map(p => `
          <div class="product-card">
            ${p.image ? `<img src="${escapeHtml(p.image)}" alt="${escapeHtml(p.name)}"/>` : '<div class="no-img">No image</div>'}
            <div class="product-body">
              <h3>${escapeHtml(p.name)}</h3>
              ${p.size || p.color ? `<p class="meta">${[p.size, p.color].filter(Boolean).map(escapeHtml).join(' · ')}</p>` : ''}
              <p class="price">₹${p.price}</p>
              <button class="btn add-to-cart-btn" data-id="${p.id}" data-name="${escapeHtml(p.name)}" data-price="${p.price}" data-image="${escapeHtml(p.image || '')}">Add to Cart</button>
            </div>
          </div>
        `).join('')}
      </div>
    </div>
  `).join('');

  const bg = site.background_url
    ? (site.background_type === 'video'
      ? `<video autoplay muted loop playsinline class="bg-media"><source src="${escapeHtml(site.background_url)}"></video>`
      : `<img src="${escapeHtml(site.background_url)}" class="bg-media"/>`)
    : '';

  res.send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${escapeHtml(site.store_name)}</title>
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@600;700&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  *{box-sizing:border-box;}
  body{margin:0;font-family:'Inter',system-ui,sans-serif;background:#FFF9F5;color:#3D2C3E;}
  h1,h2,h3{font-family:'Poppins',sans-serif;}
  .hero{position:relative;min-height:340px;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:40px 24px;overflow:hidden;background:linear-gradient(135deg,#FF9A8B,#FF6A88);}
  .bg-media{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:.55;}
  .hero-content{position:relative;z-index:1;color:#fff;text-shadow:0 2px 12px rgba(0,0,0,.25);}
  .hero h1{font-size:2.4rem;margin:0 0 10px;}
  .hero p{font-size:1.05rem;max-width:520px;margin:0 auto;opacity:.95;}
  .container{max-width:1000px;margin:0 auto;padding:32px 24px;}
  .cat-title{margin-bottom:16px;}
  .cat-section{margin-bottom:36px;}
  .product-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:20px;}
  .product-card{background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 2px 10px rgba(0,0,0,.06);}
  .product-card img{width:100%;height:180px;object-fit:cover;}
  .no-img{width:100%;height:180px;background:#FFE8DE;display:flex;align-items:center;justify-content:center;color:#c98;}
  .product-body{padding:16px;}
  .meta{color:#8a7a8c;font-size:.85rem;margin:2px 0 6px;}
  .price{font-size:1.2rem;font-weight:700;color:#FF6A88;margin:4px 0 12px;}
  .btn{display:inline-block;background:#FF6A88;color:#fff;padding:10px 20px;border-radius:100px;text-decoration:none;font-weight:600;border:none;cursor:pointer;font-size:.95rem;width:100%;}
  .cart-fab{position:fixed;bottom:20px;right:20px;background:#3D2C3E;color:#fff;padding:14px 22px;border-radius:100px;cursor:pointer;font-weight:600;box-shadow:0 4px 16px rgba(0,0,0,.2);z-index:10;}
  .modal-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:20;align-items:center;justify-content:center;}
  .modal-overlay.open{display:flex;}
  .modal{background:#fff;border-radius:16px;padding:28px;max-width:440px;width:90%;max-height:85vh;overflow-y:auto;}
  .modal h2{margin-top:0;}
  .cart-row{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #f0e5e0;}
  label{display:block;font-size:.85rem;font-weight:600;margin:12px 0 4px;}
  input,select,textarea{width:100%;padding:10px;border:1px solid #eee0da;border-radius:8px;font-size:.95rem;font-family:inherit;}
  .total-row{font-weight:700;font-size:1.1rem;margin:14px 0;text-align:right;}
  footer{text-align:center;padding:24px;color:#c9b8bb;font-size:.85rem;}
</style></head>
<body>
<div class="hero">
  ${bg}
  <div class="hero-content">
    <h1>${escapeHtml(site.store_name)}</h1>
    ${site.description ? `<p>${escapeHtml(site.description)}</p>` : ''}
  </div>
</div>
${renderStoreNav(site, 'home')}
<div class="container">${productsHtml || '<p style="text-align:center;color:#a8a29e;">No products yet — check back soon!</p>'}</div>
${plan.watermark ? `<footer>Made with BuddySite</footer>` : ''}

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
window.sbOpenCart = function(){
  var cart = sbGetCart();
  var itemsEl = document.getElementById('sb-cart-items');
  if (cart.length === 0) { itemsEl.innerHTML = '<p style="color:#aaa;">Your cart is empty.</p>'; }
  else {
    itemsEl.innerHTML = cart.map(function(i){
      return '<div class="cart-row"><span>'+i.name+' × '+i.qty+'</span><span>₹'+(i.price*i.qty)+'</span></div>';
    }).join('');
  }
  document.getElementById('sb-cart-total').textContent = cart.reduce(function(a,i){return a+i.price*i.qty;},0);
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
</body></html>`);
});

app.listen(process.env.PORT || 3000, () => {
  console.log(`Server running on http://localhost:${process.env.PORT || 3000}`);
  if (!razorpayEnabled) console.log('Razorpay keys not set -- payments are disabled until you add them to .env');
});
