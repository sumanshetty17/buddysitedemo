# 🆕 UPGRADE NOTES (read this first, then the rest of the file below)

This build now follows the **"Final Pricing & Transaction Commission Specification
v2.0"**: four plans (Free, Starter, Grow, Pro) and a per-plan BuddySite
**transaction commission** on every sale, replacing the old flat 15% fee. GST
was explicitly out of scope for this release and nothing GST-related was built.

## What changed

- **New plans** (`plans.js`): Free ₹0, Starter ₹99/mo, Grow ₹299/mo, Pro ₹599/mo —
  a single flat monthly price each, no more "discounted first month, then
  auto-pay at a different regular price." Product limits: Free 10, Starter 50,
  Grow 500, Pro unlimited. Stores: 1 / 1 / 1 / 3.
- **Commission engine** (`db.js`): every order now calculates and stores a
  BuddySite commission at the **seller's plan rate at the moment the order was
  placed** — Free/Starter 2%, Grow 3.5%, Pro 5% — on the server, never the
  browser. This rate is frozen onto that order permanently: changing plans
  later never rewrites old orders. Every commission event (order placed, full
  refund, partial refund) is appended to an immutable ledger
  (`data.commissions`) alongside a live summary on each order.
- **Refunds & cancellations**: cancelling an order, or refunding it (fully or
  for a specific ₹ amount), automatically reverses the BuddySite commission —
  in full for a cancellation, proportionally for a partial refund — and logs
  the adjustment as its own ledger entry.
- **Finance / Payouts tab** (new, in the store admin sidebar): gross sales,
  commission charged, commission reversed by refunds, and net payout, plus a
  per-order ledger. The commission is always labelled as a **BuddySite
  platform fee**, never GST or any tax.
- **Free plan**: `POST /api/billing/activate-free` turns a plan on instantly
  with no payment step at all (this is real, not part of the demo-skip below).

## What this upgrade deliberately does NOT include

The pricing spec's roadmap (WhatsApp commerce, coupons, inventory, wishlists,
abandoned-cart recovery, CRM, SEO automation, a Buddy AI assistant, a
drag-and-drop builder, a theme marketplace, POS, real Razorpay
Route-based automatic payment splitting, etc.) is a large, multi-phase build.
This pass focused on Phase 1's core: the plan/commission engine and its
ledger, which is the prerequisite everything else in the roadmap builds on.
Sellers still connect their own payment link and are asked to account for
BuddySite's commission themselves — see the Finance tab for the exact
numbers — until real marketplace settlement (Razorpay Route or equivalent)
is approved and wired in.

---

# ⚠️ THIS IS A DEMO BUILD — READ THIS FIRST

This copy has **payment and auto-pay setup skipped entirely** — clicking any plan
instantly activates it for free. It's meant only for you, personally, to preview what
the dashboard and store admin panel look like right after "subscribing" to a plan.

**Never deploy this build anywhere a real customer could reach it** — anyone could get
a free subscription. Keep this running locally on your own computer only
(`npm install` -> `npm start` -> `http://localhost:3000`), or use it on a private/throwaway
Render service that you don't share the link to.

Your real, live BuddySite (the one customers actually use) is the other zip I gave you —
this is a separate copy just for your own preview.

---

# BuddySite — your own "mini Shopify"

This is a complete rebuild around your spec: sellers sign up, pick a plan, and get a
real store with product management, categories (Grow+), an orders inbox, and a live
customer-facing shop page with a cart and checkout. Read this whole file once before
doing anything — it's written for someone with zero coding background.

You already know the GitHub upload + Render deploy flow from before, so this README
focuses on what's new and what you need to configure.

---

## What's built

- **Landing page** branded as BuddySite, with an About section and live plan pricing
- **New pricing — flat monthly, four tiers, no intro-price gimmick**:
  - **Free**: ₹0/mo — 2% commission, up to 10 products, 1 store
  - **Starter**: ₹99/mo — 2% commission, up to 50 products, 1 store
  - **Grow**: ₹299/mo — 3.5% commission, up to 500 products, 1 store
  - **Pro**: ₹599/mo — 5% commission, unlimited products, up to 3 stores
- **Auto-pay is optional**, not part of signing up: a seller can pay manually each month,
  or click "Enable Auto-Pay" once to authorize recurring billing at their plan's price
  (same flat price every cycle — see the Auto-pay section below).
- **About Us & Contact Us pages** — included on every plan. Sellers add paragraphs and
  photos via the store admin panel; these become live pages linked in the storefront nav.
- **Background images** on the store, About page, and Contact page — every plan.
  **Background videos** are Grow and Pro only (Free/Starter are blocked with a clear message).
- **Store admin panel** with a sidebar: Store Settings, About Us Page, Contact Us Page,
  Add Product, Manage Products, Categories (Grow+), Payment Method, Orders, **Finance**
- **Real file uploads** — "Choose File" everywhere (store/page backgrounds, product
  photos), no URL pasting anywhere
- **Live storefront** (`/store/your-store-slug`) with a hero banner, products grouped
  by category, a cart, and a checkout form (name, email, phone, address, payment method:
  COD / UPI / Net Banking / Card)
- **Real payment-before-order for online methods**: choosing UPI/Card/Net Banking sends
  the customer to the seller's payment link before the order is confirmed; COD stays
  instant. Sellers manually mark online orders "Paid" once they've received the money.
- **Orders inbox** — every order a customer places shows up for the seller with full
  contact + delivery details, plus payment status, and can be cancelled or refunded
- **Commission engine + Finance tab (new)** — every order calculates and records the
  BuddySite transaction commission at the seller's plan rate, shown transparently per
  order and as running totals; cancelling/refunding an order reverses the commission

## About BuddySite's transaction commission — important

Each plan now carries a fixed **transaction commission** instead of the old flat 15%:
Free/Starter 2%, Grow 3.5%, Pro 5%. It's calculated server-side on every order's
merchandise subtotal, stored permanently at the rate that applied when the order was
placed (changing plans later never changes past orders), and shown to sellers in full
on the **Finance** tab — gross sales, commission charged, commission reversed by
refunds, and net payout. It is a BuddySite platform fee only, never GST or any tax, and
that wording is enforced everywhere it's shown to a seller.

This is still **shown as a disclosure**, not automatically deducted from the seller's
bank account. Automatically splitting every payment at the moment of payment (seller's
share direct to them, BuddySite's commission direct to you) requires a proper
marketplace/platform-payment integration such as **Razorpay Route**, which needs a
separate business approval from Razorpay. Until that's approved and wired in, sellers
still pay themselves directly via the payment link they add in "Payment Method," and are
asked to account for BuddySite's commission themselves using the Finance tab's numbers.

## Auto-pay (recurring subscriptions)

Sellers can click **"Enable Auto-Pay"** on their dashboard to stop manually renewing
every month. Here's exactly how it works, and what you need to set up once:

**How it works for the seller:**
- They pay for their first month manually (already working)
- Whenever they're ready, they click "Enable Auto-Pay" and authorize a mandate (UPI
  Autopay or card) at their plan's price — the same flat price every month, since there's
  no more separate intro-vs-regular price to reconcile
- From then on, Razorpay automatically charges them every month -- no action needed on
  their end, or yours
- Auto-pay isn't offered on the Free plan, since there's nothing to charge

**One-time setup you need to do (5 minutes):**
1. Go to Razorpay Dashboard -> Account & Settings -> **Webhooks**
2. Click **Add New Webhook**
3. Webhook URL: `https://yourdomain.com/api/webhooks/razorpay` (use your real Render URL)
4. Enable these events: `subscription.charged`, `subscription.activated`,
   `subscription.authenticated`, `subscription.cancelled`, `subscription.halted`,
   `subscription.completed`
5. Razorpay will show you a **Webhook Secret** -- copy it
6. Add it to your `.env` (locally) and Render's Environment tab as `RAZORPAY_WEBHOOK_SECRET`
7. Redeploy

Without this webhook set up, sellers can still turn auto-pay on, but your server won't
know when a renewal payment succeeds, so their plan won't automatically extend each month.

## Website styles (themes) — NEW

Every store now has a **website style**, chosen when the store is created (or changed
later in Store Settings):

- **Simple** — warm coral/peach colors, friendly and approachable. Available on **every plan**.
- **Bold** — pure black & white, high-contrast, uppercase headings. Unlocked on **Grow and Pro**.
- **Aesthetic** — ivory background, elegant serif headings (Playfair Display), minimal
  borders — a fully polished, editorial look. Unlocked on **Pro only**.

Every page (home, About Us, Contact Us) uses a **small, compact top bar** — store name
on the left, nav links on the right — instead of a large banner. Background images/videos
are shown at their real, undimmed brightness (no dark overlay tint).

## Environment setup (same as before)

Copy `.env.example` to `.env` and fill in:
- `JWT_SECRET` — any random words
- `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` — from your Razorpay dashboard (this is for
  your **subscription billing** from sellers, separate from the seller's own payment link)

## Updating your live site

Same process as before:
1. `npm install` locally to test (`npm start`, visit `http://localhost:3000`)
2. Upload changed files to GitHub (drag into the `sitebuilder` folder in your repo,
   matching the same file paths, commit)
3. Render auto-redeploys within a minute or two

**Files changed in this rebuild:** almost everything. Easiest is to re-upload the whole
`sitebuilder` folder contents again (same process as your very first upload), replacing
everything. Don't upload `node_modules`, `package-lock.json`, `.env`, `data.json`, or
`uploads/` — those are excluded on purpose.

## What this still doesn't include (roadmap ideas)

- Automatic commission splitting at the moment of payment (waiting on Razorpay Route or equivalent marketplace-payment approval)
- The rest of the pricing spec's phase 2+ roadmap: WhatsApp commerce, coupons, inventory, wishlists, abandoned-cart recovery, CRM, SEO automation, Buddy AI, custom domains, a drag-and-drop page builder, a theme marketplace, POS
- Recurring auto-billing for your subscription plans (sellers currently pay for 30 days
  at a time, manually)
- Order status updates (e.g. marking an order "shipped") — currently orders are just
  a read-only list
- Store themes/colors customization by the seller (currently one fixed BuddySite look)
- Multiple images per product

Happy to build any of these next — just ask.
