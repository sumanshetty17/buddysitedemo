# ⚠️ THIS IS A DEMO BUILD — READ THIS FIRST

This copy has **payment skipped entirely** — clicking any plan instantly activates it
for free, no Razorpay checkout happens. It's meant only for you, personally, to preview
what the dashboard and store admin panel look like right after "buying" a plan.

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
- **3 plans, all starting at ₹99 for the first 2 months**, then:
  - **Basic ₹699/mo** — 1 store, up to 20 products
  - **Grow ₹1,699/mo** — 1 store, up to 100 products, **categories**
  - **Pro ₹2,999/mo** — up to 3 stores, up to 1,000 products, categories
- **Store admin panel** with a sidebar: Store Settings, Add Product, Manage Products,
  Categories (Grow+), Payment Method, Orders
- **Real file uploads** — "Choose File" for store background (image or video) and
  product photos, no URL pasting anywhere
- **Live storefront** (`/store/your-store-slug`) with a hero banner, products grouped
  by category, a cart, and a checkout form (name, email, phone, address, payment method:
  COD / UPI / Net Banking / Card)
- **Orders inbox** — every order a customer places shows up for the seller with full
  contact + delivery details
- **15% platform fee disclosure** shown to sellers when they add a product price

## About the 15% platform fee — important

Right now, the 15% fee is **shown to sellers as a disclosure**, not automatically
deducted. Automatically splitting every payment (85% to the seller, 15% to you,
instantly) requires **Razorpay Route**, which needs a separate business approval from
Razorpay — this is the application you should have started earlier. Once that's
approved, tell me and I'll wire in the real automatic split. Until then, sellers pay
themselves directly via the payment link they add in "Payment Method," and are asked to
account for your 15% manually.

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

- Automatic 15% payment splitting (waiting on Razorpay Route approval)
- Recurring auto-billing for your subscription plans (sellers currently pay for 30 days
  at a time, manually)
- Order status updates (e.g. marking an order "shipped") — currently orders are just
  a read-only list
- Store themes/colors customization by the seller (currently one fixed BuddySite look)
- Multiple images per product

Happy to build any of these next — just ask.
