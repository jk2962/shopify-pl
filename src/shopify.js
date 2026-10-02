/*
 * Shopify GraphQL Admin API: token handling, paginated/incremental order
 * sync with checkpoint/resume, cost-based throttling, and the
 * read_all_orders banner. Calls pl.js's normalizeOrder() and sheet.js's
 * upsertOrders()/setPlBanner()/recalculate() as bare globals
 * (Apps Script shares one global scope across files in a project).
 *
 * Verified against shopify.dev on 2026-09-30 for API version 2026-07
 * (still the latest stable release; 2026-10 is release-candidate only).
 */

// eslint-disable-next-line no-var
var pl = typeof require !== 'undefined' ? require('./pl.js') : null;

function centsFromAmountCompat(amountStr) {
  return pl ? pl.centsFromAmount(amountStr) : centsFromAmount(amountStr);
}

// pl.normalizeOrder in Node; the bare global from pl.js (shared Apps Script scope) otherwise.
function normalizeOrderCompat(node, timeZone) {
  return pl ? pl.normalizeOrder(node, timeZone) : normalizeOrder(node, timeZone);
}

const API_VERSION = '2026-07';
const MAX_QUERY_COST = 1000; // single-query cost cap, confirmed store-plan-independent
const MAX_PAGE_SIZE = 250;
const INITIAL_PAGE_SIZE = 50;
const SYNC_BUDGET_MS = 5 * 60 * 1000; // Apps Script's execution limit is 6 minutes
const INCREMENTAL_OVERLAP_MS = 10 * 60 * 1000;

const PROPS = {
  SHOP: 'shopify_shop',
  CLIENT_ID: 'shopify_client_id',
  CLIENT_SECRET: 'shopify_client_secret',
  TOKEN: 'shopify_access_token',
  TOKEN_EXPIRES_AT: 'shopify_token_expires_at',
  LAST_SYNCED_AT: 'shopify_last_synced_at',
  SHOP_TIMEZONE: 'shopify_shop_timezone',
  SYNC_STATE: 'shopify_sync_state',
  SYNC_TRIGGER_ID: 'shopify_sync_trigger_id',
  TAXES_INCLUDED_SEEN: 'shopify_taxes_included_seen',
};

// ---- Pure helpers (Node + Apps Script) ----

function normalizeShopDomain(input) {
  let domain = String(input || '').trim();
  domain = domain.replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  if (domain && !domain.includes('.')) domain += '.myshopify.com';
  return domain;
}

function incrementalSinceIso(lastSyncedIso) {
  return new Date(new Date(lastSyncedIso).getTime() - INCREMENTAL_OVERLAP_MS).toISOString();
}

function ordersQueryFilter(sinceIso) {
  return sinceIso ? `status:any updated_at:>'${sinceIso}'` : 'status:any';
}

function hasReadAllOrdersScope(accessScopeNodes) {
  return (accessScopeNodes || []).some((s) => s.handle === 'read_all_orders');
}

function computeBackoffMs(throttleStatus, nextCost) {
  if (!throttleStatus) return 0;
  const deficit = nextCost - throttleStatus.currentlyAvailable;
  if (deficit <= 0) return 0;
  return Math.ceil((deficit / throttleStatus.restoreRate) * 1000);
}

// ponytail: cost-per-order is a rough average from the last page, not a true model.
// Upgrade to per-field cost accounting if a store's line-item count varies wildly.
function nextPageSize(prevPageSize, cost) {
  if (!cost || !cost.actualQueryCost || !cost.throttleStatus) return prevPageSize;
  const perOrderCost = cost.actualQueryCost / Math.max(prevPageSize, 1);
  if (perOrderCost <= 0) return prevPageSize;
  const budget = Math.min(cost.throttleStatus.currentlyAvailable, MAX_QUERY_COST);
  const size = Math.floor(budget / perOrderCost);
  return Math.max(1, Math.min(MAX_PAGE_SIZE, size));
}

function parseOrdersResponse(json) {
  if (json.errors && json.errors.length) {
    const throttled = json.errors.some((e) => e.extensions && e.extensions.code === 'THROTTLED');
    const err = new Error(json.errors.map((e) => e.message).join('; '));
    err.throttled = throttled;
    // A THROTTLED response still carries extensions.cost; carry it onto the
    // error so the retry can wait exactly the cost deficit (computeBackoffMs)
    // instead of guessing at a fixed sleep.
    err.cost = (json.extensions && json.extensions.cost) || null;
    throw err;
  }
  const conn = json.data.orders;
  return {
    nodes: conn.nodes,
    hasNextPage: conn.pageInfo.hasNextPage,
    endCursor: conn.pageInfo.endCursor,
    cost: json.extensions && json.extensions.cost,
  };
}

// Order.refunds/RefundLineItem-style plain lists take a `first` arg but expose
// no cursor or pageInfo (shopify.dev confirms no documented way to page past
// truncation for list-typed fields), so completeness is checked by comparing
// sums against Order.totalRefundedSet instead of a pageInfo flag.
function isRefundListTruncated(node) {
  if (!node.totalRefundedSet) return false;
  const orderTotal = centsFromAmountCompat(node.totalRefundedSet.shopMoney.amount);
  const refundSum = (node.refunds || []).reduce((sum, r) => {
    if (!r.totalRefundedSet) return sum;
    return sum + centsFromAmountCompat(r.totalRefundedSet.shopMoney.amount);
  }, 0);
  return refundSum !== orderTotal;
}

function nestedTruncationWarnings(node) {
  const warnings = [];
  if (node.lineItems && node.lineItems.pageInfo && node.lineItems.pageInfo.hasNextPage) {
    warnings.push('lineItems');
  }
  if (node.shippingLines && node.shippingLines.pageInfo && node.shippingLines.pageInfo.hasNextPage) {
    warnings.push('shippingLines');
  }
  for (const r of node.refunds || []) {
    if (r.refundLineItems && r.refundLineItems.pageInfo && r.refundLineItems.pageInfo.hasNextPage) {
      warnings.push('refundLineItems');
    }
    if (r.refundShippingLines && r.refundShippingLines.pageInfo && r.refundShippingLines.pageInfo.hasNextPage) {
      warnings.push('refundShippingLines');
    }
    if (r.orderAdjustments && r.orderAdjustments.pageInfo && r.orderAdjustments.pageInfo.hasNextPage) {
      warnings.push('orderAdjustments');
    }
  }
  return warnings;
}

// ---- GraphQL documents (pinned to API_VERSION) ----

const ORDERS_QUERY = `
  query SyncOrders($first: Int!, $after: String, $query: String!, $sortKey: OrderSortKeys!) {
    orders(first: $first, after: $after, query: $query, sortKey: $sortKey, reverse: false) {
      nodes {
        id
        name
        test
        cancelledAt
        processedAt
        taxesIncluded
        totalRefundedSet { shopMoney { amount } }
        lineItems(first: 100) {
          pageInfo { hasNextPage }
          nodes {
            sku
            quantity
            originalUnitPriceSet { shopMoney { amount } }
            discountAllocations {
              allocatedAmountSet { shopMoney { amount } }
            }
          }
        }
        shippingLines(first: 50) {
          pageInfo { hasNextPage }
          nodes {
            discountedPriceSet { shopMoney { amount } }
          }
        }
        refunds(first: 20) {
          processedAt
          updatedAt
          totalRefundedSet { shopMoney { amount } }
          refundLineItems(first: 100) {
            pageInfo { hasNextPage }
            nodes {
              quantity
              subtotalSet { shopMoney { amount } }
              lineItem { sku }
            }
          }
          refundShippingLines(first: 20) {
            pageInfo { hasNextPage }
            nodes {
              subtotalAmountSet { shopMoney { amount } }
            }
          }
          orderAdjustments(first: 20) {
            pageInfo { hasNextPage }
            nodes {
              amountSet { shopMoney { amount } }
            }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const ORDER_REFUNDS_QUERY = `
  query OrderRefunds($id: ID!, $first: Int!) {
    order(id: $id) {
      refunds(first: $first) {
        processedAt
        updatedAt
        totalRefundedSet { shopMoney { amount } }
        refundLineItems(first: 250) {
          nodes {
            quantity
            subtotalSet { shopMoney { amount } }
            lineItem { sku }
          }
        }
        refundShippingLines(first: 50) {
          nodes {
            subtotalAmountSet { shopMoney { amount } }
          }
        }
        orderAdjustments(first: 50) {
          nodes {
            amountSet { shopMoney { amount } }
          }
        }
      }
    }
  }
`;

const SCOPES_QUERY = `
  query CurrentScopes {
    currentAppInstallation {
      accessScopes { handle }
    }
  }
`;

const SHOP_TZ_QUERY = `
  query ShopTimezone {
    shop { ianaTimezone }
  }
`;

// ---- Token handling (Apps Script only: PropertiesService, UrlFetchApp) ----

function getAccessToken(props) {
  const cached = props.getProperty(PROPS.TOKEN);
  const expiresAt = Number(props.getProperty(PROPS.TOKEN_EXPIRES_AT) || 0);
  if (cached && Date.now() < expiresAt - 60000) return cached;
  return fetchNewAccessToken(props);
}

function fetchNewAccessToken(props) {
  const shop = props.getProperty(PROPS.SHOP);
  const clientId = props.getProperty(PROPS.CLIENT_ID);
  const clientSecret = props.getProperty(PROPS.CLIENT_SECRET);
  if (!shop || !clientId || !clientSecret) {
    throw new Error('Shopify credentials are not set. Use the "Set credentials" menu item first.');
  }
  const resp = UrlFetchApp.fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'post',
    contentType: 'application/x-www-form-urlencoded',
    payload: { grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret },
    muteHttpExceptions: true,
  });
  const body = JSON.parse(resp.getContentText());
  if (resp.getResponseCode() !== 200 || !body.access_token) {
    throw new Error('Failed to get a Shopify access token: ' + resp.getContentText());
  }
  props.setProperty(PROPS.TOKEN, body.access_token);
  props.setProperty(PROPS.TOKEN_EXPIRES_AT, String(Date.now() + body.expires_in * 1000));
  return body.access_token;
}

// ---- GraphQL requests (Apps Script only: UrlFetchApp) ----

function graphqlRequest(shop, token, query, variables) {
  const url = `https://${shop}/admin/api/${API_VERSION}/graphql.json`;
  const resp = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'X-Shopify-Access-Token': token },
    payload: JSON.stringify({ query, variables }),
    muteHttpExceptions: true,
  });
  // muteHttpExceptions means a 429/5xx arrives as a normal response, usually
  // with a non-JSON body — parsing it blind surfaced as an opaque
  // "SyntaxError: Unexpected token <" and abandoned the sync mid-page.
  const code = resp.getResponseCode();
  const body = resp.getContentText();
  if (code !== 200) {
    const err = new Error(`Shopify GraphQL HTTP ${code}: ${body.slice(0, 300)}`);
    err.retryable = code === 429 || code === 430 || code >= 500;
    throw err;
  }
  return JSON.parse(body);
}

function throwOnErrors(json) {
  if (json.errors && json.errors.length) {
    throw new Error(json.errors.map((e) => e.message).join('; '));
  }
}

// Wait the cost deficit reported by extensions.cost when we have it; otherwise
// a plain linear backoff for transient HTTP failures.
function retrySleepMs(err, attempt) {
  const cost = err.cost;
  const deficitWait = cost ? computeBackoffMs(cost.throttleStatus, cost.requestedQueryCost) : 0;
  return deficitWait > 0 ? deficitWait : 1000 * attempt;
}

function fetchOrdersPage(shop, token, first, after, queryFilter) {
  const MAX_ATTEMPTS = 5;
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const json = graphqlRequest(shop, token, ORDERS_QUERY, {
        first,
        after,
        query: queryFilter,
        sortKey: 'UPDATED_AT',
      });
      return parseOrdersResponse(json);
    } catch (err) {
      lastErr = err;
      if ((err.throttled || err.retryable) && attempt < MAX_ATTEMPTS) {
        Utilities.sleep(retrySleepMs(err, attempt));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

function fetchAccessScopes(shop, token) {
  const json = graphqlRequest(shop, token, SCOPES_QUERY, {});
  throwOnErrors(json);
  return json.data.currentAppInstallation.accessScopes;
}

function fetchShopTimezone(shop, token) {
  const json = graphqlRequest(shop, token, SHOP_TZ_QUERY, {});
  throwOnErrors(json);
  return json.data.shop.ianaTimezone;
}

function refetchOrderRefunds(shop, token, orderId) {
  const json = graphqlRequest(shop, token, ORDER_REFUNDS_QUERY, { id: orderId, first: 250 });
  throwOnErrors(json);
  return (json.data.order && json.data.order.refunds) || [];
}

// ---- Checkpoint/resume state (Apps Script only: PropertiesService) ----

function loadSyncState(props) {
  const raw = props.getProperty(PROPS.SYNC_STATE);
  return raw ? JSON.parse(raw) : null;
}

function saveSyncState(props, state) {
  props.setProperty(PROPS.SYNC_STATE, JSON.stringify(state));
}

function clearSyncState(props) {
  props.deleteProperty(PROPS.SYNC_STATE);
}

// ---- One-off continuation trigger (Apps Script only: ScriptApp) ----
// Not the hourly trigger — a single follow-up run, installed only to finish
// a sync that outran one execution, and deleted once the sync completes.

function scheduleContinuation(props) {
  deleteContinuationTrigger(props);
  const trigger = ScriptApp.newTrigger('continueSyncTrigger').timeBased().after(10 * 1000).create();
  props.setProperty(PROPS.SYNC_TRIGGER_ID, trigger.getUniqueId());
}

function deleteContinuationTrigger(props) {
  const id = props.getProperty(PROPS.SYNC_TRIGGER_ID);
  if (!id) return;
  for (const t of ScriptApp.getProjectTriggers()) {
    if (t.getUniqueId() === id) ScriptApp.deleteTrigger(t);
  }
  props.deleteProperty(PROPS.SYNC_TRIGGER_ID);
}

// ---- Sync orchestration (Apps Script only) ----

function runSyncPass(ss) {
  const props = PropertiesService.getScriptProperties();
  const startedAt = Date.now();

  const token = getAccessToken(props);
  const shop = props.getProperty(PROPS.SHOP);

  const shopTz = fetchShopTimezone(shop, token);
  ss.setSpreadsheetTimeZone(shopTz);
  props.setProperty(PROPS.SHOP_TIMEZONE, shopTz);

  const accessScopes = fetchAccessScopes(shop, token);
  const hasReadAllOrders = hasReadAllOrdersScope(accessScopes);

  let state = loadSyncState(props);
  if (!state) {
    const lastSyncedAt = props.getProperty(PROPS.LAST_SYNCED_AT);
    const since = lastSyncedAt ? incrementalSinceIso(lastSyncedAt) : null;
    // startedAt is pinned into the state so a sync that spans several
    // executions still records its OWN start as the next incremental
    // watermark. Using the final pass's start would mark orders changed during
    // the earlier passes as already-synced and skip them next time.
    if (!lastSyncedAt) props.deleteProperty(PROPS.TAXES_INCLUDED_SEEN);
    state = {
      filter: ordersQueryFilter(since),
      cursor: null,
      pageSize: INITIAL_PAGE_SIZE,
      startedAt: new Date(startedAt).toISOString(),
    };
  }

  let taxesIncludedSeen = props.getProperty(PROPS.TAXES_INCLUDED_SEEN) === 'true';
  setPlBanner(ss, hasReadAllOrders, taxesIncludedSeen);

  let ordersSynced = 0;
  let done = false;

  while (Date.now() - startedAt < SYNC_BUDGET_MS) {
    const page = fetchOrdersPage(shop, token, state.pageSize, state.cursor, state.filter);

    const normalized = page.nodes.map((rawOrder) => {
      if (isRefundListTruncated(rawOrder)) {
        rawOrder.refunds = refetchOrderRefunds(shop, token, rawOrder.id);
      }
      const warnings = nestedTruncationWarnings(rawOrder);
      if (warnings.length) {
        Logger.log('Order ' + rawOrder.id + ' may have truncated: ' + warnings.join(', '));
      }
      // Every summed field is documented as tax-exclusive, but that was never
      // verified against a tax-inclusive shop — so a counted order with
      // taxesIncluded earns the caveat banner (SPEC.md "Other approved-as-
      // written assumptions").
      if (rawOrder.taxesIncluded === true && rawOrder.test === false && rawOrder.cancelledAt === null) {
        taxesIncludedSeen = true;
      }
      return normalizeOrderCompat(rawOrder, shopTz);
    });

    upsertOrders(ss, normalized);
    recalculate(ss);
    ordersSynced += normalized.length;

    state.cursor = page.endCursor;
    state.pageSize = nextPageSize(state.pageSize, page.cost);
    saveSyncState(props, state);
    // Saved per page, alongside the checkpoint: if a later page throws, the
    // resumed pass never re-reads this one, so the flag must already be stored.
    if (taxesIncludedSeen && props.getProperty(PROPS.TAXES_INCLUDED_SEEN) !== 'true') {
      props.setProperty(PROPS.TAXES_INCLUDED_SEEN, 'true');
      setPlBanner(ss, hasReadAllOrders, true);
    }

    if (!page.hasNextPage) {
      done = true;
      break;
    }
  }

  if (done) {
    clearSyncState(props);
    props.setProperty(PROPS.LAST_SYNCED_AT, state.startedAt || new Date(startedAt).toISOString());
    deleteContinuationTrigger(props);
  } else {
    scheduleContinuation(props);
  }

  return { done, ordersSynced };
}

// ---- Entry points called from main.js's menu / triggers ----

function runSync(ss) {
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty(PROPS.SHOP) || !props.getProperty(PROPS.CLIENT_ID) || !props.getProperty(PROPS.CLIENT_SECRET)) {
    throw new Error('Shopify credentials are not set. Use the "Set credentials" menu item first.');
  }
  return runSyncPass(ss);
}

function saveShopifyCredentials() {
  const ui = SpreadsheetApp.getUi();
  const shopResp = ui.prompt('Shopify shop domain', 'e.g. my-dev-store.myshopify.com', ui.ButtonSet.OK_CANCEL);
  if (shopResp.getSelectedButton() !== ui.Button.OK) return;

  const clientIdResp = ui.prompt("Client ID", "From the Dev Dashboard app's Settings page", ui.ButtonSet.OK_CANCEL);
  if (clientIdResp.getSelectedButton() !== ui.Button.OK) return;

  const clientSecretResp = ui.prompt(
    'Client secret',
    "From the Dev Dashboard app's Settings page. Kept only in Script Properties.",
    ui.ButtonSet.OK_CANCEL
  );
  if (clientSecretResp.getSelectedButton() !== ui.Button.OK) return;

  const props = PropertiesService.getScriptProperties();
  props.setProperty(PROPS.SHOP, normalizeShopDomain(shopResp.getResponseText()));
  props.setProperty(PROPS.CLIENT_ID, clientIdResp.getResponseText().trim());
  props.setProperty(PROPS.CLIENT_SECRET, clientSecretResp.getResponseText().trim());
  props.deleteProperty(PROPS.TOKEN);
  props.deleteProperty(PROPS.TOKEN_EXPIRES_AT);

  ui.alert('Shopify credentials saved ✅', 'Use "Sync now" to pull orders.', ui.ButtonSet.OK);
}

function enableHourlySync() {
  const ui = SpreadsheetApp.getUi();
  const alreadyEnabled = ScriptApp.getProjectTriggers().some((t) => t.getHandlerFunction() === 'hourlySync');
  if (alreadyEnabled) {
    ui.alert('Hourly sync is already enabled.');
    return;
  }
  ScriptApp.newTrigger('hourlySync').timeBased().everyHours(1).create();
  ui.alert('Hourly sync enabled ✅', 'Orders will sync automatically every hour.', ui.ButtonSet.OK);
}

function hourlySync() {
  try {
    runSyncPass(SpreadsheetApp.getActive());
  } catch (err) {
    Logger.log('Hourly sync failed: ' + ((err && err.message) || err));
  }
}

function continueSyncTrigger() {
  try {
    runSyncPass(SpreadsheetApp.getActive());
  } catch (err) {
    Logger.log('Sync continuation failed: ' + ((err && err.message) || err));
  }
}

if (typeof module !== 'undefined') {
  module.exports = {
    API_VERSION,
    normalizeShopDomain,
    incrementalSinceIso,
    ordersQueryFilter,
    hasReadAllOrdersScope,
    computeBackoffMs,
    nextPageSize,
    parseOrdersResponse,
    isRefundListTruncated,
    nestedTruncationWarnings,
  };
}
