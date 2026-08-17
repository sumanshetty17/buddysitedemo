// A tiny pure-JavaScript database stored as a single JSON file.
// No native code to compile -- works identically on any host.

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'data.json');

function empty() {
  return {
    users: [], sites: [], payments: [], subscriptions: [], razorpayPlans: {},
    nextUserId: 1, nextSiteId: 1, nextProductId: 1, nextCategoryId: 1, nextOrderId: 1, nextPaymentId: 1, nextSubscriptionId: 1,
    nextHeroSlideId: 1, nextCategoryGroupId: 1
  };
}

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
    categoryGroups: [],   // Pro plan: titled homepage sections -- [{id, title, categoryIds:[]}]
    brandStory: emptyPage(), // all plans: "about the brand" footer section
    socialLinks: { instagram: '', facebook: '', twitter: '', youtube: '', tiktok: '', website: '' },
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
  if (!site.socialLinks) site.socialLinks = { instagram: '', facebook: '', twitter: '', youtube: '', tiktok: '', website: '' };
  if (!site.theme) site.theme = 'simple';
  if (!site.description_align) site.description_align = 'center';
  if (!site.description_size) site.description_size = 'medium';
  if (!site.description_font) site.description_font = 'inter';
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
  ['store_name', 'description', 'description_align', 'description_size', 'description_font', 'background_url', 'background_type', 'payment_link', 'published', 'theme'].forEach(f => {
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
function addProduct(siteId, { name, price, image, size, color, description, categoryId }) {
  const data = load();
  const site = data.sites.find(s => s.id === Number(siteId));
  if (!site) return null;
  const product = { id: data.nextProductId++, name, price: Number(price) || 0, image: image || '', size: size || '', color: color || '', description: description || '', categoryId: categoryId || null };
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
  ['name', 'price', 'image', 'size', 'color', 'description', 'categoryId'].forEach(f => {
    if (fields[f] !== undefined) p[f] = f === 'price' ? Number(fields[f]) || 0 : fields[f];
  });
  save(data);
  return p;
}
function deleteProduct(siteId, productId) {
  const data = load();
  const site = data.sites.find(s => s.id === Number(siteId));
  if (!site) return false;
  site.products = site.products.filter(p => p.id !== Number(productId));
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
function addOrder(siteId, { customerName, email, phone, address, paymentMethod, items, total }) {
  const data = load();
  const site = data.sites.find(s => s.id === Number(siteId));
  if (!site) return null;
  const status = paymentMethod === 'COD' ? 'new' : 'awaiting_payment';
  const order = { id: data.nextOrderId++, customerName, email, phone, address, paymentMethod, items, total, status, created_at: new Date().toISOString() };
  site.orders.push(order);
  save(data);
  return order;
}
function getOrders(siteId) {
  const site = load().sites.find(s => s.id === Number(siteId));
  return site ? site.orders.slice().reverse() : [];
}
function updateOrderStatus(siteId, orderId, status) {
  const data = load();
  const site = data.sites.find(s => s.id === Number(siteId));
  if (!site) return null;
  const order = site.orders.find(o => o.id === Number(orderId));
  if (!order) return null;
  order.status = status;
  save(data);
  return order;
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

// ---------- CATEGORY GROUPS (Pro plan titled homepage sections) ----------
function addCategoryGroup(siteId, { title, categoryIds }) {
  const data = load();
  const site = data.sites.find(s => s.id === Number(siteId));
  if (!site) return null;
  if (!site.categoryGroups) site.categoryGroups = [];
  const group = { id: data.nextCategoryGroupId++, title: title || 'Categories', categoryIds: Array.isArray(categoryIds) ? categoryIds.map(Number) : [] };
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
  createPayment, getPaymentByOrderId, updatePaymentStatus, countPaidCyclesForUser,
  getRazorpayPlanId, setRazorpayPlanId,
  createSubscription, getSubscriptionByRzpId, getActiveSubscriptionForUser, updateSubscriptionStatus,
  addHeroSlide, deleteHeroSlide,
  addCategoryGroup, deleteCategoryGroup,
  updateSocialLinks
};
