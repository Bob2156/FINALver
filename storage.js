const { get } = require('@vercel/edge-config');
const { put } = require('@vercel/blob');
const axios = require('axios');

const EDGE_KEY = 'lastAllocation';

async function readEdgeAllocation() {
  try {
    const value = await get(EDGE_KEY);
    return typeof value === 'string' ? value : null;
  } catch (err) {
    console.error('[storage] read edge', err);
    return null;
  }
}

function parseEdgeConnection(str) {
  try {
    const url = new URL(str);
    const id = url.pathname.split('/').pop();
    const token = url.searchParams.get('token');
    return { id, token };
  } catch {
    return {};
  }
}

async function updateEdgeAllocation(value) {
  let id = process.env.EDGE_CONFIG_ID;
  let token = process.env.EDGE_CONFIG_TOKEN;
  if ((!id || !token) && process.env.EDGE_CONFIG) {
    const parsed = parseEdgeConnection(process.env.EDGE_CONFIG);
    if (!id) id = parsed.id;
    if (!token) token = parsed.token;
  }
  if (!id || !token) {
    console.warn('[storage] EDGE_CONFIG_ID or EDGE_CONFIG_TOKEN not set');
    return;
  }
  try {
    await axios.patch(
      `https://api.vercel.com/v1/edge-config/${id}/items`,
      { items: [{ operation: 'upsert', key: EDGE_KEY, value }] },
      { headers: { Authorization: `Bearer ${token}` } }
    );
  } catch (err) {
    console.error('[storage] update edge', err.response?.data || err);
  }
}

async function storeBlobSnapshot(allocation) {
  try {
    const path = `allocations/${Date.now()}.json`;
    await put(
      path,
      JSON.stringify({ allocation, timestamp: new Date().toISOString() }),
      { access: 'public' }
    );
  } catch (err) {
    console.error('[storage] blob put', err);
  }
}

module.exports = {
  readEdgeAllocation,
  updateEdgeAllocation,
  storeBlobSnapshot,
};
