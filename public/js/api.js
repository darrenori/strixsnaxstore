import { initData } from './tg.js';

/**
 * Every request carries the Telegram signature. There is no token to store and
 * nothing to refresh — if Telegram trusts the session, so does the server.
 */
async function request(path, { method = 'GET', body, formData, signal } = {}) {
  const headers = { 'X-Telegram-Init-Data': initData() };
  let payload;

  if (formData) {
    payload = formData;                       // let the browser set the boundary
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  const res = await fetch(`/api${path}`, { method, headers, body: payload, signal });

  let data = null;
  const text = await res.text();
  if (text) {
    try { data = JSON.parse(text); } catch { data = { error: text }; }
  }

  if (!res.ok) {
    const err = new Error(data?.error ?? `Request failed (${res.status})`);
    err.status = res.status;
    err.code = data?.code;
    throw err;
  }
  return data;
}

/** Fetch a binary response (the payment screenshot) as an object URL. */
async function requestBlob(path) {
  const res = await fetch(`/api${path}`, {
    headers: { 'X-Telegram-Init-Data': initData() },
  });
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try { message = (await res.json()).error ?? message; } catch { /* not JSON */ }
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }
  return URL.createObjectURL(await res.blob());
}

export const api = {
  me:            () => request('/me'),
  catalog:       () => request('/catalog'),

  placeOrder:    (payload) => request('/orders', { method: 'POST', body: payload }),
  myOrders:      () => request('/orders'),
  order:         (id) => request(`/orders/${id}`),
  cancelOrder:   (id) => request(`/orders/${id}/cancel`, { method: 'POST' }),
  uploadProof:   (id, formData) => request(`/orders/${id}/proof`, { method: 'POST', formData }),

  // --- admin ---------------------------------------------------------------
  adminSummary:  () => request('/admin/summary'),
  adminOrders:   (status) => request(`/admin/orders${status ? `?status=${encodeURIComponent(status)}` : ''}`),
  // The screenshot comes back as raw bytes behind the admin gate, so it needs
  // its own fetch: turn it into an object URL the <img> can point at.
  adminProof:    (id) => requestBlob(`/admin/orders/${id}/proof`),
  approve:       (id, note) => request(`/admin/orders/${id}/approve`, { method: 'POST', body: { note } }),
  reject:        (id, note) => request(`/admin/orders/${id}/reject`, { method: 'POST', body: { note } }),

  adminCatalog:  () => request('/admin/catalog'),
  setStock:      (id, count, note) => request(`/admin/items/${id}/stock`, { method: 'POST', body: { count, note } }),
  adjustStock:   (id, delta, reason, note) =>
                   request(`/admin/items/${id}/adjust`, { method: 'POST', body: { delta, reason, note } }),
  stockTake:     (entries, note) => request('/admin/stock-take', { method: 'POST', body: { entries, note } }),
  movements:     (itemId) => request(`/admin/stock-movements${itemId ? `?itemId=${itemId}` : ''}`),

  createItem:    (payload) => request('/admin/items', { method: 'POST', body: payload }),
  updateItem:    (id, patch) => request(`/admin/items/${id}`, { method: 'PATCH', body: patch }),
  archiveItem:   (id) => request(`/admin/items/${id}`, { method: 'DELETE' }),
  createCategory:(payload) => request('/admin/categories', { method: 'POST', body: payload }),

  users:         (adminsOnly) => request(`/admin/users${adminsOnly ? '?admins=1' : ''}`),
  setRole:       (telegramId, isAdmin) => request('/admin/users/role', { method: 'POST', body: { telegramId, isAdmin } }),
  setBlocked:    (telegramId, isBlocked) => request('/admin/users/block', { method: 'POST', body: { telegramId, isBlocked } }),
  settings:      (payload) => request('/admin/settings', { method: 'POST', body: payload }),
  syncSheets:    () => request('/admin/sheets/sync', { method: 'POST' }),
};

export default api;
