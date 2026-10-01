# Shopify P/L

A Google Sheet that syncs orders from a Shopify store via the GraphQL Admin API and shows profit/loss by day, week, month, and year. Store owners edit costs (COGS, shipping, fees, other expenses) directly in the sheet, and the P/L recalculates instantly without a re-sync.

## Setup (for the store owner)

These steps assume the Google Sheet has already been shared with you and has the **P/L** menu at the top (next to File/Edit/View). If you just want to see how it works before connecting a real store, open the menu and click **P/L → Load demo data** first — it fills the sheet with ~120 sample orders and a working P/L.

1. **Create the app in the Shopify Dev Dashboard.**
   - Go to your Shopify Partner organization's **Dev Dashboard** (`partners.shopify.com` → your organization → **Dev Dashboard**).
   - Click **Create app**, choose **Custom app**, and give it a name (e.g. "P/L Sync").

2. **Set the app's scopes.**
   - In the app's **Configuration**, under **Access scopes**, request:
     - `read_orders` (required)
     - `read_products` (only if you later need it — not required for P/L)
   - Do not request any customer-data scopes. This app never reads customer names, emails, or addresses.
   - Save the configuration.

3. **Install the app on your store.**
   - Still in the Dev Dashboard, click **Install app** and choose your store. The app and the store must be in the same Shopify organization (this is always true for a store you own).
   - Approve the requested scopes when prompted.
   - Open the app's **Settings** page and copy the **Client ID** and **Client secret** — you'll need both in the next step.

4. **Set credentials in the Sheet.**
   - In the Sheet, open **P/L → Set credentials**.
   - You'll be asked for three things, in order:
     1. **Shopify shop domain** — e.g. `my-store.myshopify.com`.
     2. **Client ID** — from the app's Settings page.
     3. **Client secret** — from the app's Settings page.
   - These are stored only in the script's private settings (Script Properties) — never in a sheet cell, and never in this repository.

5. **Run the first sync.**
   - Open **P/L → Sync now**.
   - A status message at the bottom of the screen shows progress. A first sync pulls your full order history; if your store has enough orders that it can't finish in one pass, it automatically picks up where it left off within a few seconds — just leave the sheet open.
   - Check the **Orders** tab for the raw synced rows and the **P/L** tab for the computed numbers.
   - Optional: **P/L → Enable hourly sync** turns on automatic syncing every hour. This is off by default and only turns on if you click it.

## Requesting `read_all_orders` (full order history)

By default, Shopify only returns orders from the **last 60 days** to any app — this is a platform-wide limit, not a bug in this tool. If that's missing, the P/L tab shows a red banner:

> Only the last 60 days of orders are available — yearly/older figures are incomplete.

To get full history, request the `read_all_orders` scope, which needs Shopify's approval:

1. In the Dev Dashboard, open your app → **Versions** → the **Access** tab.
2. Find **Request access** / **All access requests**, and look for **Read all orders**.
3. Submit the request with a short reason (e.g. "P/L reporting needs historical order data for yearly totals").
4. Shopify reviews these manually — approval isn't instant. Once approved, re-run **P/L → Sync now**; the banner disappears automatically once the app's granted scopes include `read_all_orders`.

## Protected customer data

This app only requests `read_orders` (and optionally `read_products`) and never reads any customer PII fields (name, email, address, phone). Separately: a custom app installed on a store in your **own** Shopify organization — which is the case here — gets Protected Customer Data access automatically; there's no separate declaration form to fill out for that case (that requirement applies to public apps distributed to other merchants' stores, which this isn't).

## P/L definitions and assumptions

The P/L tab is built to reconcile with Shopify's own Analytics/Sales reports for the same date range. The exact rules:

- **Timezone:** every order and refund is bucketed by the connected store's own timezone (`shop.ianaTimezone`), not UTC and not your browser's timezone. Weeks start on **Monday**.
- **Cancelled and test orders** are excluded from every P/L number. They're still visible on the Orders tab (flagged), but contribute $0 everywhere, including their refunds.
- **Gross sales** = line price × quantity, before any discount, summed across all line items (including units that were later refunded — "units sold" includes returns, matching Shopify's own definition).
- **Discounts** = merchandise-level discount allocations (line, order, and discount-code level). Shipping discounts are *not* counted here — they reduce Shipping charged instead, so nothing is double-counted.
- **Returns** = every refunded dollar, dated to the **refund date** (not the original order date), split three ways: refunded merchandise, refunded shipping (which reduces Shipping charged, not Returns), and discretionary/goodwill refunds not tied to a line item.
- **Net sales** = Gross sales − Discounts − Returns.
- **Shipping charged** = what the customer actually paid for shipping (after any shipping discount), reduced by any shipping refunds on the refund date.
- **Taxes are excluded** from every column, throughout.
- **COGS** = units sold × per-SKU cost (falling back to the Settings default when a SKU has no override). Refunded units reverse their COGS on the refund date.
- **Shipping cost** (what *you* pay a carrier, from Settings — per-order or per-unit) is based on units/orders sold and is **not** reversed on a refund, since you already paid to ship it.
- **Payment fees** = fee % × (Net sales + Shipping charged) + fixed fee × number of orders. The defaults (2.9% + $0.30) are an estimate — edit them in Settings to match your actual payment processor plan.
- **Net profit** = Net sales + Shipping charged − COGS − Shipping cost − Payment fees − Other expenses.
- **Margin %** = Net profit ÷ (Net sales + Shipping charged). Shown in red when negative.
- **AOV** (average order value) = Net sales ÷ number of counted orders. Blank (not an error) for a period with zero orders.
- **Other Expenses** (e.g. ad spend) are counted in whichever period their date falls into, exactly as entered on the Other Expenses tab.
- Editing **Settings**, **COGS by SKU**, or **Other Expenses** recalculates the P/L tab instantly — no sync needed, no Shopify call made.
