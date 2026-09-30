You are building a small, production-quality tool for an e-commerce store owner. A technical hiring manager will judge it, so correctness and clean, explainable code matter more than features. Build ONLY what is listed. Do NOT add extra features, frameworks, files, or abstractions.

## Goal
A Google Sheet that pulls orders from a Shopify store and shows profit/loss by Day, Week, Month, and Year. The owner edits costs in the sheet and the P/L updates instantly without re-syncing.

## Stack (locked)
- Google Sheets + Google Apps Script (plain JavaScript, V8), deployed with clasp.
- Shopify GraphQL Admin API only (REST is legacy). Confirm the latest stable API version on shopify.dev and pin it in ONE constant.
- Tests: Node's built-in node:test. No npm dependencies other than @google/clasp (dev) without asking.
- All work MUST stay inside this repository. NEVER touch anything outside it.

## Auth: verify on shopify.dev BEFORE writing auth code
New admin-created custom apps can no longer be made (since Jan 1, 2026). New custom apps are created in the Dev Dashboard, which provides a client ID + secret exchanged for an Admin API access token (client credentials grant); these tokens expire. Confirm the current flow, then implement it:
- Store shop domain, client ID, and client secret in Script Properties only (set via a menu prompt). NEVER in sheet cells, code, or the repo.
- Cache the token until expiry; refresh automatically.
- Scopes: read_orders (read_products only if truly needed). Request NO customer PII fields (names, emails, addresses). Note in the README whether the Dev Dashboard requires a protected customer data declaration.
- By default Shopify returns only the last 60 days of orders, silently. Older orders require the read_all_orders scope, which needs Shopify approval. At sync time, query currentAppInstallation.accessScopes; if read_all_orders is missing, show a red banner on the P/L tab: "Only the last 60 days of orders are available — yearly/older figures are incomplete." NEVER show incomplete yearly totals without this warning.

## Sheet tabs
1. Settings: default COGS per unit = 1.00; shipping cost = 5.00 with a dropdown [per order | per unit], default per order; payment fee % and fixed per order (defaults 2.9% and 0.30, labeled "estimate, edit to match your plan").
2. COGS by SKU: optional per-SKU overrides; blank = default.
3. Other Expenses: manual rows (date, category e.g. ad spend, amount), counted in the period the date falls in.
4. Orders: raw synced data, one row per order. Header row says "Script-managed — do not edit".
5. P/L: timeframe dropdown [Daily | Weekly | Monthly | Yearly] + start/end date; one row per period + Totals row; negative profit in red. Put a short "How numbers are calculated" note at the top.

## P/L definitions (match Shopify Analytics so numbers reconcile)
- Bucket by the shop's timezone (shop.ianaTimezone), NOT UTC. Weeks start Monday.
- Exclude cancelled and test orders.
- Gross sales = line price × qty before discounts. Returns = refunded merchandise, attributed to the REFUND date. Net sales = gross − discounts − returns.
- Shipping charged to customers = separate revenue line. Taxes excluded entirely.
- COGS = units × SKU cost (fallback default). Refunded units reverse COGS on the refund date.
- Shipping cost per Settings mode; NOT reversed on refund.
- Payment fees = % × (net sales + shipping charged) + fixed × orders.
- Columns: Period, Orders, Units, Gross sales, Discounts, Returns, Net sales, Shipping charged, COGS, Shipping cost, Payment fees, Other expenses, Net profit, Margin % (net profit ÷ (net sales + shipping charged)), AOV.

## Architecture
- src/pl.js: pure functions only (normalize → bucket → compute rows). No Apps Script APIs. Must run in both Apps Script and Node (`if (typeof module !== 'undefined') module.exports = {...}`).
- src/main.js: onOpen menu "P/L" → Sync now / Recalculate / Load demo data / Set credentials / Enable hourly sync; entry-point functions only.
- src/sheet.js: read Settings/COGS/Expenses; write Orders and P/L; onEdit on Settings, COGS by SKU, Other Expenses → recalculate from the Orders tab with NO Shopify call.
- src/shopify.js: token handling; cursor-paginated orders query (250/page); respect GraphQL cost throttling (read extensions.cost, back off when throttled). Incremental sync: save last sync time, query `updated_at:>` it, upsert by order ID. Apps Script has a 6-minute limit: the first full sync MUST checkpoint and resume.
- Hourly trigger only when the user clicks the menu item. Never auto-install it.
- Load demo data: ~120 realistic orders over the past 14 months (several SKUs, discounts, a few partial refunds, 1 cancelled, 1 test order) so the sheet works before any store is connected.

Verify EVERY GraphQL field and argument name against the docs for the pinned version. NEVER guess a field name. If a planned field doesn't exist, stop and tell me.

## Tests (required)
test/pl.test.js with hand-computed expected values for: single order; discount; partial refund in a later month; cancelled + test orders excluded; an 11:30pm shop-time order landing on the correct local date, including across a DST change; per-unit vs per-order shipping; SKU COGS override; week bucketing across a year boundary.

## Deliverables
- The code above.
- README.md: numbered setup for a non-developer store owner (create Dev Dashboard app → scopes → install on store → Set credentials → first sync); how to request read_all_orders; the P/L definitions and assumptions.

## Process and stop conditions
1. Plan: file list, the exact GraphQL query, every assumption you're unsure of. STOP for approval.
2. src/pl.js + tests. Green before moving on. If a test still fails after 3 fix attempts, STOP and explain.
3. src/sheet.js + main.js menu + demo data (no Shopify calls yet).
4. src/shopify.js.
5. README.md.
- After each step output: ✅ [what was completed]. Commit after each step.
- STOP and ask before: adding any dependency, touching files outside this repo, or running `clasp push`.

## Done when
All tests pass; demo mode shows a correct P/L for all four timeframes; changing default COGS from 1 to 2 updates the P/L without a sync; a synced dev store's net sales match Shopify's Sales report for the same date range; a non-developer can follow the README setup.

## Decisions

Approved after step-1 planning, verified against shopify.dev for the pinned API version below. These override anything in the body of this spec that conflicts.

### API version
Pinned to **2026-07** (latest stable as of planning: released 2026-07-01, supported until 2027-07-16 15:00 UTC). One constant, `API_VERSION`, in `src/shopify.js`.

### Money representation
All amounts held as integer cents throughout `pl.js` (`MoneyV2.amount` arrives as a Decimal-as-string; convert with `Math.round(parseFloat(amount) * 100)`). Divide only at display time.

### Original vs. current amounts (no double-counting refunds)
Gross sales, discounts, and shipping charged are built ONLY from original/order-level fields. Returns and all refund effects come ONLY from `Order.refunds`, dated by the refund. `current*` fields (`currentTotalPriceSet`, `currentSubtotalPriceSet`, `currentTotalDiscountsSet`, `currentShippingPriceSet`, `LineItem.currentQuantity`, `LineItem.refundableQuantity`) are never read — they already have refunds subtracted, so combining them with a separate refund subtraction would double-count.

- Gross sales = Σ (`LineItem.originalUnitPriceSet.shopMoney.amount` × `LineItem.quantity`). `quantity` includes refunded/removed units (per docs), which is what we want for "units sold."
- Units = Σ `LineItem.quantity`.

### Discounts — deterministic, not deferred (supersedes original plan's `totalDiscountsSet` + fallback)
`Order.totalDiscountsSet` is **never used** — its interaction with shipping discounts is unverified and the dev store has no shipping discount to test it against. Instead:
- Merchandise discounts = Σ `LineItem.discountAllocations[].allocatedAmountSet.shopMoney.amount` (verified: `[DiscountAllocation!]!`, a plain list, includes line-level, order-level, and code-based allocations, at +3 query-cost points per line item).
- `discountAllocations` added to the `lineItems` selection in the sync query.
- Test required: an order with a shipping discount proving it is counted exactly once (in Shipping charged, not in Discounts, and not double-counted).

### Shipping charged — exact field (supersedes `Order.totalShippingPriceSet`)
Shipping charged = Σ over `Order.shippingLines.nodes[].discountedPriceSet.shopMoney.amount` (verified field: "The shipping price after applying discounts," `MoneyBag!`, not deprecated; `ShippingLineConnection` confirmed to expose `.nodes`). `Order.totalShippingPriceSet` and `ShippingLine.originalPriceSet`/`price` are not used.

### Cancelled and test orders
Counted order = `Order.test === false` AND `Order.cancelledAt === null`. Both are reliable, documented booleans/nullable-dates on `Order` in 2026-07 — no fallback heuristic needed. `Order.test`: *"Whether the order is a test. Test orders are made using the Shopify Bogus Gateway or a payment provider with test mode enabled."* `Order.cancelledAt`: *"Returns `null` if the order hasn't been canceled."* Excluded orders are still written to the Orders tab (visible, with Test/Cancelled flags) but contribute $0 to every P/L column, including their refunds.

### AOV
AOV = Net sales ÷ Orders (Orders = counted orders only, cancelled/test excluded). Zero counted orders in a period → blank, not a division error. Documented in the P/L tab's "How numbers are calculated" note.

### No refunded dollar disappears silently (supersedes "Returns = refunded merchandise" wording)
Every refund is fully accounted for across three buckets, by exact field, all dated to the refund:
- **Merchandise returns** → Returns: Σ `RefundLineItem.subtotalSet.shopMoney.amount` (ex-tax; tax lives separately in `RefundLineItem.totalTaxSet` and is not read).
- **Shipping refunds** → reduce Shipping charged (not Returns): Σ `RefundShippingLine.subtotalAmountSet.shopMoney.amount` (ex-tax; `taxAmountSet` not read).
- **Discretionary/manual refunds not tied to any line item or shipping line** (e.g. goodwill) → Returns: Σ `Refund.orderAdjustments.nodes[].amountSet.shopMoney.amount` (ex-tax; `taxAmountSet` not read; verified `OrderAdjustmentConnection` exposes `.nodes`).
- All three bucket on **`Refund.processedAt`** (`DateTime!`, non-null — preferred over the originally-planned `createdAt`, which is nullable). `Refund.updatedAt` is the fallback only if `processedAt` is ever absent in practice.
- Taxes stay excluded throughout by construction (only `*Set`/`amountSet`, never `taxAmountSet` or `totalTaxSet`, are summed).

Required tests: one order with a shipping refund (proves it reduces Shipping charged, not Returns); one order with a $10 no-line-item discretionary refund (proves it lands in Returns via `orderAdjustments`, not silently dropped).

### Truncation detection (supersedes line-item-based check)
Refund-list truncation is detected by comparing the sum of fetched `Refund.totalRefundedSet` against `Order.totalRefundedSet`, NOT by checking `refundLineItems`/`pageInfo` — a refund with no line items (shipping-only or discretionary) is valid and must not trigger a false refetch. Mismatch ⇒ refetch that order alone with a higher `refunds(first: …)`.

### Incremental sync overlap
Incremental sync queries `updated_at:>` (last sync time − 10 minutes), not the raw last-sync timestamp. Upsert by `Order.id` makes the resulting re-fetches harmless. Guards against any order whose `updatedAt` advance and the previous sync's read landing in the same narrow window.

### Query shape and cost (confirmed 2026-07)
- `orders(first, after, query, sortKey: UPDATED_AT, reverse)` on `OrderConnection` — `.nodes`/`.pageInfo` confirmed; `UPDATED_AT` confirmed in `OrderSortKeys`.
- Per-order cost with the full selection (line items + discountAllocations + shipping lines + refunds incl. shipping lines and order adjustments) runs materially higher than the original ~114-point estimate; page size is tuned from the live `extensions.cost.requestedQueryCost`/`throttleStatus`, not hardcoded to 250. 1,000-point hard cap per query confirmed store-plan-independent.
- Nested-connection truncation (line items, discountAllocations, shippingLines, refundLineItems, refund orderAdjustments) is checked via each connection's own `pageInfo.hasNextPage`; refunds-list truncation via the `totalRefundedSet` comparison above.

### Other approved-as-written assumptions (from step-1 plan §10)
- `Refund.createdAt` being nullable is moot now that `processedAt` (non-null) is the primary refund-dating field.
- `Order.taxesIncluded` is read; any counted order with it `true` shows the "taxes excluded" caveat is unverified for that order (banner), since all summed fields are documented as tax-exclusive but a tax-inclusive shop was never tested against this plan.
- Single shop currency: only `shopMoney` read everywhere; `presentmentMoney` unused.
- Shipping cost (the owner's cost, from Settings) uses units/orders **sold**, never reversed on refund, per spec.
- Auth flow (Dev Dashboard client-credentials grant) remains unverified until step 4 — not guessed at, not started.
