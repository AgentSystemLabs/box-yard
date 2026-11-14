// The project state every case starts from (scripts/evals/captain-routing): a small online store's repo, its tasks in
// every resting and running state, its notes, and a second project the Captain must not touch. Names are made up
// (acme/*, example.com), so nothing here is anyone's real project.

/** The store's repo: the Captain's code questions are answered from these files (its read-only clone). */
export const REPO_FILES: Record<string, string> = {
  "README.md": `# Storefront

Acme's online store: product pages, cart, checkout and the admin area.

- \`src/\` is the Express server and its JSON API; \`web/\` holds the pages it serves (plain HTML and scripts, one
  shared layout with the header and footer).
- \`npm run dev\` starts the server (see src/server.ts for the port).
- \`npm test\` runs the unit tests, \`npm run lint\` the linter.
`,
  "package.json": JSON.stringify(
    {
      name: "storefront",
      private: true,
      type: "module",
      scripts: { dev: "tsx watch src/server.ts", build: "tsc -p .", test: "vitest run", lint: "eslint src test" },
      devDependencies: { vitest: "^3.2.0", tsx: "^4.20.0", typescript: "^5.9.0", eslint: "^9.30.0" },
    },
    null,
    2,
  ),
  "AGENTS.md": `# Agent instructions

- Keep changes small and covered by a test in test/.
- Money is integer cents everywhere; never use floats for prices.
`,
  Dockerfile: `FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
CMD ["npm", "run", "dev"]
`,
  "src/server.ts": `import { createApp } from "./app.js"

/** STOREFRONT_PORT overrides the port; 8080 when it's unset. */
const port = Number(process.env.STOREFRONT_PORT ?? 8080)

createApp().listen(port, () => console.log(\`storefront on :\${port}\`))
`,
  "src/app.ts": `import express from "express"
import { cartRoutes } from "./cart/routes.js"
import { checkoutRoutes } from "./checkout/routes.js"
import { authRoutes } from "./auth/routes.js"
import { pageRoutes } from "./pages.js"

export function createApp() {
  const app = express()
  app.use(express.json())
  app.use("/api/cart", cartRoutes())
  app.use("/api/checkout", checkoutRoutes())
  app.use("/api", authRoutes())
  app.use("/static", express.static("web/static"))
  app.use(pageRoutes())
  return app
}
`,
  "src/pages.ts": `import { readFileSync } from "node:fs"
import { Router } from "express"

const layout = readFileSync("web/layout.html", "utf8")
const page = (name: string) => layout.replace("{{content}}", readFileSync(\`web/pages/\${name}.html\`, "utf8"))

/** The storefront's pages: each one is web/pages/<name>.html inside web/layout.html. */
export function pageRoutes() {
  const r = Router()
  r.get("/", (_req, res) => res.send(page("products")))
  r.get("/products/:slug", (_req, res) => res.send(page("product")))
  r.get("/cart", (_req, res) => res.send(page("cart")))
  r.get("/checkout/address", (_req, res) => res.send(page("checkout-address")))
  r.get("/orders/:id/confirmation", (_req, res) => res.send(page("order-confirmation")))
  r.get("/account/settings", (_req, res) => res.send(page("account-settings")))
  r.get("/contact", (_req, res) => res.send(page("contact")))
  return r
}
`,
  "web/layout.html": `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Acme Store</title>
    <link rel="stylesheet" href="/static/site.css" />
  </head>
  <body>
    <header><a href="/">Acme Store</a> <a href="/cart">Cart</a> <a href="/account/settings">Account</a></header>
    <main>{{content}}</main>
    <footer>
      <p>© 2025 Acme Inc. All rights reserved.</p>
      <nav><a href="/contact-us">Contact us</a> · <a href="/shipping">Shipping</a></nav>
    </footer>
  </body>
</html>
`,
  "web/pages/products.html": `<h1>Products</h1>
<div id="product-grid" class="grid"></div>
<script type="module">
  const grid = document.getElementById("product-grid")
  const products = await fetch("/api/products").then((r) => r.json())
  grid.innerHTML = products.map((p) => \`<a class="card" href="/products/\${p.slug}"><img src="\${p.image}" alt="" /><b>\${p.name}</b></a>\`).join("")
</script>
`,
  "web/pages/product.html": `<article id="product">
  <img id="product-image" src="/static/images/placeholder.jpg" alt="" />
  <h1 id="product-name"></h1>
  <p id="product-description"></p>
  <button id="add-to-cart">Add to cart</button>
</article>
<script type="module" src="/static/product.js"></script>
`,
  "web/pages/cart.html": `<h1>Your cart</h1>
<ul id="cart-lines"></ul>
<p>Subtotal: <span id="subtotal"></span></p>
<a class="button" href="/checkout/address">Procede to checkout</a>
<script type="module" src="/static/cart.js"></script>
`,
  "web/pages/checkout-address.html": `<h1>Shipping address</h1>
<form id="address-form">
  <input name="name" required placeholder="Full name" />
  <input name="line1" required placeholder="Address" />
  <input name="postcode" required placeholder="Postcode" />
  <button type="submit">Continue</button>
</form>
<script type="module">
  const form = document.getElementById("address-form")
  form.addEventListener("submit", async (e) => {
    e.preventDefault()
    const body = Object.fromEntries(new FormData(form, e.submitter))
    await fetch("/api/checkout/address", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
    location.href = "/checkout/shipping"
  })
</script>
`,
  "web/pages/order-confirmation.html": `<h1>Thanks for your order!</h1>
<p>Your order number is <strong id="order-number"></strong>. We'll email you when it ships.</p>
<script type="module">
  document.getElementById("order-number").textContent = location.pathname.split("/")[2]
</script>
`,
  "web/pages/account-settings.html": `<h1>Account settings</h1>
<form id="profile"><input name="name" /><input name="email" /><button>Save</button></form>
<form id="password"><input type="password" name="current" /><input type="password" name="next" /><button>Change password</button></form>
<form id="notifications"><label><input type="checkbox" name="orderEmails" /> Order emails</label><button>Save</button></form>
`,
  "web/pages/contact.html": `<h1>Contact us</h1>
<p>Email support@example.com and we'll get back to you within a day.</p>
`,
  "web/static/site.css": `body { font-family: system-ui, sans-serif; margin: 0 auto; max-width: 960px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 16px; }
footer { margin-top: 48px; color: #666; }
`,
  "src/auth/session.ts": `/** A login session lasts this long without activity; every request slides it forward. */
export const SESSION_TTL_HOURS = 36

export interface Session {
  id: string
  userId: string
  expiresAt: number
}

export function touch(session: Session, now = Date.now()): Session {
  return { ...session, expiresAt: now + SESSION_TTL_HOURS * 3600_000 }
}

export const expired = (session: Session, now = Date.now()) => session.expiresAt <= now
`,
  "src/auth/passwordReset.ts": `import { randomBytes } from "node:crypto"

/** Reset links are single-use and expire after an hour. */
export const RESET_TOKEN_TTL_MS = 60 * 60_000

export function newResetToken() {
  return { token: randomBytes(32).toString("hex"), expiresAt: Date.now() + RESET_TOKEN_TTL_MS }
}
`,
  "src/auth/oauth.ts": `/** Sign in with Google and GitHub. The state parameter is checked against the session's. */
export const PROVIDERS = ["google", "github"] as const
export type Provider = (typeof PROVIDERS)[number]

export function callbackUrl(base: string, provider: Provider) {
  return \`\${base}/api/oauth/\${provider}/callback\`
}
`,
  "src/auth/routes.ts": `import { Router } from "express"

export function authRoutes() {
  const r = Router()
  r.post("/login", (_req, res) => res.status(501).json({ error: "see auth/session.ts" }))
  return r
}
`,
  "src/billing/tax.ts": `export interface Line {
  priceCents: number
  qty: number
}

/**
 * Sales tax in cents. Tax is rounded on each line item (half away from zero), then the lines are added up: the
 * receipt shows each line's tax, so the total has to match their sum.
 */
export function salesTaxCents(lines: Line[], rate: number): number {
  return lines.reduce((sum, l) => sum + Math.round(l.priceCents * l.qty * rate), 0)
}
`,
  "src/cart/shipping.ts": `/** Orders at or above this subtotal ship free. */
export const FREE_SHIPPING_THRESHOLD_CENTS = 7500
export const FLAT_SHIPPING_CENTS = 695

export const shippingCents = (subtotalCents: number) => (subtotalCents >= FREE_SHIPPING_THRESHOLD_CENTS ? 0 : FLAT_SHIPPING_CENTS)
`,
  "src/cart/coupons.ts": `export interface Coupon {
  code: string
  percentOff: number
  /** The coupon only applies while the subtotal is at least this much. */
  minSubtotalCents: number
}

/** One coupon per order. */
export const MAX_COUPONS_PER_ORDER = 1

export const COUPONS: Coupon[] = [
  { code: "SPRING10", percentOff: 10, minSubtotalCents: 5000 },
  { code: "WELCOME5", percentOff: 5, minSubtotalCents: 0 },
]

export function discountCents(subtotalCents: number, coupon: Coupon | null): number {
  if (!coupon) return 0
  // The minimum is checked when the coupon is applied (see cart/routes.ts), not here.
  return Math.round((subtotalCents * coupon.percentOff) / 100)
}
`,
  "src/cart/totals.ts": `import { discountCents, type Coupon } from "./coupons.js"
import { shippingCents } from "./shipping.js"
import { salesTaxCents, type Line } from "../billing/tax.js"

export function totals(lines: Line[], coupon: Coupon | null, taxRate: number) {
  const subtotal = lines.reduce((s, l) => s + l.priceCents * l.qty, 0)
  const discount = discountCents(subtotal, coupon)
  const shipping = shippingCents(subtotal - discount)
  const tax = salesTaxCents(lines, taxRate)
  return { subtotal, discount, shipping, tax, total: subtotal - discount + shipping + tax }
}
`,
  "src/cart/routes.ts": `import { Router } from "express"
import { COUPONS } from "./coupons.js"

export function cartRoutes() {
  const r = Router()
  r.post("/coupon", (req, res) => {
    const coupon = COUPONS.find((c) => c.code === req.body.code)
    if (!coupon) return res.status(404).json({ error: "Unknown code" })
    if (req.body.subtotalCents < coupon.minSubtotalCents) return res.status(400).json({ error: "Subtotal too low" })
    res.json({ coupon })
  })
  return r
}
`,
  "src/checkout/flow.ts": `export type Step = "address" | "shipping" | "payment" | "review" | "done"

/** The checkout steps, as a chain of ifs (a reducer would be cleaner). */
export function next(step: Step, ok: boolean): Step {
  if (!ok) return step
  if (step === "address") return "shipping"
  if (step === "shipping") return "payment"
  if (step === "payment") return "review"
  return "done"
}
`,
  "src/checkout/routes.ts": `import { Router } from "express"

export function checkoutRoutes() {
  return Router()
}
`,
  "test/cart.test.ts": `import { describe, expect, it } from "vitest"
import { totals } from "../src/cart/totals.js"

describe("cart totals", () => {
  it("ships free at $75", () => {
    expect(totals([{ priceCents: 7500, qty: 1 }], null, 0).shipping).toBe(0)
  })
})
`,
}

export type Alias = "csv" | "tax" | "webp" | "settings" | "flaky" | "node22" | "dark" | "sentry" | "search"

export interface SeedTask {
  alias: Alias
  title: string
  prompt: string
  /** The state it rests in. "working" ones run a fake agent turn that doesn't end during the eval. */
  status: "idle" | "pr_ready" | "working" | "done" | "needs_input" | "failed"
  /** The agent's last reply (what get_task shows as lastReply). */
  reply?: string
  pr?: { number: number; state: "open" | "merged" }
  /** The owner pressed Merge PR: the merge is under way. */
  mergeRequested?: boolean
  question?: string
  error?: string
  /** Minutes since it was last active, so [Project now] and list_tasks read like a real afternoon. */
  agoMin: number
}

export const PROJECT = {
  name: "storefront",
  slug: "acme/storefront",
  description: "Acme's online store (Node, Express, TypeScript): product pages, cart, checkout and the admin area.",
}

export const OTHER_PROJECT = {
  name: "marketing-site",
  slug: "acme/marketing-site",
  description: "Acme's marketing website and blog (Astro).",
  tasks: [
    { title: "Update the pricing page copy", status: "idle" as const, reply: "Updated the pricing page copy to the new plan names. No PR yet; say if you want one." },
    { title: "Add an RSS feed to the blog", status: "pr_ready" as const, reply: "Added /rss.xml for the blog. PR #7 is open.", pr: 7 },
  ],
}

const pr = (n: number) => `https://github.com/${PROJECT.slug}/pull/${n}`

export const SEED_TASKS: SeedTask[] = [
  {
    alias: "csv",
    title: "Add CSV export to the orders page",
    prompt: "Add an Export CSV button to Admin › Orders that downloads the orders matching the current filter (order id, date, customer name, total, status).",
    status: "pr_ready",
    reply: `Done: Admin › Orders has an **Export CSV** button that streams the current filter's orders (order id, date, customer name, total, status) from src/admin/ordersExport.ts. Tests in test/orders-export.test.ts. PR #41 is open: ${pr(41)}`,
    pr: { number: 41, state: "open" },
    agoMin: 95,
  },
  {
    alias: "tax",
    title: "Fix tax rounding at checkout",
    prompt: "Checkout shows a tax total one cent off the receipt's line items for some carts. Find out why and fix it.",
    status: "working",
    reply: `The order total rounded tax once on the whole order while the receipt rounds each line; it now rounds per line everywhere (src/billing/tax.ts), with tests. PR #38 is open: ${pr(38)}`,
    pr: { number: 38, state: "open" },
    mergeRequested: true,
    agoMin: 2,
  },
  {
    alias: "webp",
    title: "Convert product images to WebP",
    prompt: "Convert the product images to WebP and serve them with a <picture> fallback, to cut page weight.",
    status: "working",
    reply: "Converting the 1,240 product images to WebP now; about a third done.",
    agoMin: 1,
  },
  {
    alias: "settings",
    title: "Redesign the account settings page",
    prompt: "Redesign the account settings page to the new mockups: profile, password, addresses and notification preferences as separate cards.",
    status: "working",
    reply: "Profile and password cards are done; working on addresses next, then notification preferences.",
    agoMin: 3,
  },
  {
    alias: "flaky",
    title: "Investigate flaky cart tests",
    prompt: "The cart tests fail about one run in five on CI. Find out why. Don't change code yet, just report.",
    status: "idle",
    reply:
      "Root cause: test/cart.test.ts shares one fake clock across its tests, so 'applies coupon' fails whenever it runs after 'expires idle carts' (the clock is 31 minutes ahead by then). Fix: give each test its own clock with vi.useFakeTimers() in beforeEach and vi.useRealTimers() in afterEach. I haven't changed any code yet. Want me to make the fix?",
    agoMin: 40,
  },
  {
    alias: "node22",
    title: "Upgrade to Node 22",
    prompt: "Upgrade the project to Node 22: engines, CI and anything that breaks.",
    status: "done",
    reply: `Upgraded to Node 22 (engines field, .nvmrc and the CI matrix); all tests pass. PR #30 merged: ${pr(30)}`,
    pr: { number: 30, state: "merged" },
    agoMin: 60 * 26,
  },
  {
    alias: "dark",
    title: "Add a dark mode toggle",
    prompt: "Add a dark mode toggle to the site header: system default, light and dark.",
    status: "pr_ready",
    reply: `Added a dark mode toggle in the header (system default, light, dark) using CSS variables. PR #44 is ready for review: ${pr(44)}`,
    pr: { number: 44, state: "open" },
    agoMin: 25,
  },
  {
    alias: "sentry",
    title: "Set up Sentry error reporting",
    prompt: "Set up Sentry error reporting for the server and the browser bundle.",
    status: "needs_input",
    reply: "The SDK is wired into the server and the browser bundle. One question before I finish: which Sentry project should the DSN come from, storefront-prod or storefront-staging?",
    question: "Which Sentry project should the DSN come from: storefront-prod or storefront-staging?",
    agoMin: 15,
  },
  {
    alias: "search",
    title: "Add product search with Postgres full-text",
    prompt: "Add product search backed by Postgres full-text search, with a search box in the header.",
    status: "failed",
    reply: "Search works locally, but `npm test` fails: 3 tests in test/search.test.ts expect 'Blue Mug' ranked first for 'mug' and get 'Mug Rack'.",
    error: "npm test failed: 3 failing tests in test/search.test.ts (ranking order: expected 'Blue Mug' first, got 'Mug Rack').",
    agoMin: 50,
  },
]

export const SEED_NOTES = [
  "Run `npm test` and `npm run lint` before opening a PR.",
  "Staging deploys from the `staging` branch; never push to `main` directly.",
  "Product images live in the acme-storefront-media bucket; code reads them through the CDN, never from the bucket directly.",
]

/** The note suggestions the notes-retro case hands the Captain, with what a good curator does with each. */
export const RETRO_SUGGESTIONS = [
  {
    key: "db",
    content: "Start the dev database with `docker compose up db` before `npm test`, or the DB tests time out after 30 s.",
    why: "Lost 20 minutes to timeouts before I found it.",
  },
  {
    key: "log",
    content: "Fixed the CSV export date bug today; PR #41 is open.",
    why: "So the team knows it's done.",
  },
  {
    key: "dup",
    content: "Always run npm test and npm run lint before you open a pull request.",
    why: "CI fails otherwise.",
  },
  {
    key: "conv",
    content: "Use named exports, never default exports, in src/.",
    why: "The codebase is consistent about it.",
  },
] as const
