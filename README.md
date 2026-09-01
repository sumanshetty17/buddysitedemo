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
- **4 plans** (per the Final Pricing & Transaction Commission Specification, v2.0):
  - **Free ₹0/mo** — 1 store, up to 10 products, 2% BuddySite commission
  - **Starter ₹99/mo** — 1 store, up to 50 products, 2% BuddySite commission
  - **Grow ₹299/mo** — 1 store, up to 500 products, 3.5% BuddySite commission
  - **Pro ₹599/mo** — up to 3 stores, unlimited products, 5% BuddySite commission
- **Store admin panel** with a sidebar: Store Settings, Add Product, Manage Products,
  Categories (Grow+), Payment Method, Orders, **Finance / Payouts**, Analytics
- **Real file uploads** — "Choose File" for store background (image or video) and
  product photos, no URL pasting anywhere
- **Live storefront** (`/store/your-store-slug`) with a hero banner, products grouped
  by category, a cart, and a checkout form (name, email, phone, address, payment method:
  COD / UPI / Net Banking / Card)
- **Orders inbox** — every order a customer places shows up for the seller with full
  contact + delivery details, with Mark as Paid / Cancel / Refund actions
- **Commission engine** (`commission-engine.js`) — a fixed, server-side, per-order
  BuddySite platform commission, with an immutable ledger. See below.

## The BuddySite commission — how it actually works now

BuddySite charges a **fixed transaction/platform commission**: Free 2%, Starter 2%,
Grow 3.5%, Pro 5%. These rates are final (per the product owner's spec) and are
centralized in `plans.js` / `commission-engine.js` — nowhere else in the app should
hard-code a percentage.

- Every order automatically gets a **commission ledger record** (`commissionLedger` in
  `data.json`), calculated **server-side only**, on the merchandise subtotal after
  discounts (shipping and taxes are excluded from the commission base).
- The record freezes the **plan and rate that applied at the moment of the order** — if
  a seller later upgrades or downgrades, past orders keep their original rate.
- Cancelling an order or issuing a full refund reverses the commission; a partial refund
  creates a proportional adjustment. Nothing rewrites the original calculation — every
  change is recorded as an adjustment, so there's a full audit trail.
- Sellers can see the exact breakdown — gross sales, discounts, commissionable sales,
  commission, refunds, net payout, per-order detail — on the new **Finance / Payouts**
  tab (`GET /api/sites/:id/finance`).
- This is a **BuddySite platform commission**, never GST or any government tax, and the
  app never implies it replaces whatever tax a seller owes. GST invoicing is explicitly
  out of scope for this release (see the spec, section 4) — the data model is kept
  extensible so a tax/invoicing module can be added later without touching orders or
  the commission ledger.

### What's *not* yet built: automatic money splitting

Sellers still collect payment themselves via their own payment link — money does not
yet flow through BuddySite and get split automatically. The commission ledger tells
sellers exactly what they owe BuddySite, but doesn't move money yet. Real automatic
settlement (BuddySite instantly keeping its commission and paying the seller the rest)
requires a **marketplace/platform-payments product with commission-and-payout support**
(e.g. Razorpay Route), which needs a separate business approval from the payment
provider. Once that's approved, the ledger built here (`payment_provider_fee`,
`seller_payout_amount`, `status`, `settled_at` fields already exist on every record) is
ready to be wired up to real payouts — ask me and I'll connect it.

## Auto-pay (recurring subscriptions) -- NEW

Sellers can now click **"Enable Auto-Pay"** on their dashboard to stop manually renewing
every month. Here's exactly how it works, and what you need to set up once:

**How it works for the seller:**
- Their first ₹99 x 2 intro payments stay as manual one-time payments (already working)
- Once they're ready, they click "Enable Auto-Pay" and authorize a mandate (UPI Autopay
  or card) at their plan's **regular** price
- From then on, Razorpay automatically charges them every month -- no action needed on
  their end, or yours

**Why the price is fixed at "regular," not ₹99:** UPI and card auto-pay mandates lock in
a maximum amount the moment the customer authorizes them, and that amount can't be
silently raised later without asking them to re-authorize. So auto-pay always starts at
the plan's regular price, which is the technically correct and honest way to do this.

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

Per the Final Pricing & Transaction Commission Specification's phased roadmap (section 9):

- **Automatic commission settlement** — real money splitting via a marketplace payment
  provider (waiting on Razorpay Route or equivalent business approval); today the
  commission is calculated and shown to sellers, but not auto-deducted
  - Recurring auto-billing for your subscription plans (sellers currently pay for 30 days
  at a time, manually)
- Order "shipped" / "delivered" status tracking beyond new/paid/fulfilled/cancelled/refunded
- Store themes/colors customization by the seller (currently one fixed BuddySite look)
- Multiple images per product
- Product variants, inventory management, custom domains, UPI/COD as first-class
  checkout options, WhatsApp commerce, shipping integrations, customer CRM, reviews,
  wishlist, abandoned-cart recovery, deeper analytics, SEO automation, Buddy AI,
  drag-and-drop page builder, theme marketplace, marketing integrations, loyalty/referrals
- **GST invoicing is intentionally out of scope** for this release (spec section 4) —
  do not add it without a fresh product decision, and never label the BuddySite
  commission as GST when you do

Happy to build any of these next — just ask.
