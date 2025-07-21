const { get } = require('@vercel/edge-config');
const { put } = require('@vercel/blob');
const axios = require('axios');

const EDGE_KEY = 'lastAllocation';

function parseEdgeConnection() {
  const str = process.env.EDGE_CONFIG;
  if (!str) return {};
  try {
    const u = new URL(str);
    return {
      id: u.pathname.replace(/^\//, ''),
      token: u.searchParams.get('token'),
    };
  } catch {
    return {};
  }
}

async function readEdgeAllocation() {
  try {
    const value = await get(EDGE_KEY);
    return typeof value === 'string' ? value : null;
  } catch (err) {
    console.error('[storage] read edge', err);
    return null;
  }
}

async function updateEdgeAllocation(value) {
  const parsed = parseEdgeConnection();
  const id = process.env.EDGE_CONFIG_ID || parsed.id;
  const token = process.env.EDGE_CONFIG_TOKEN || parsed.token;
  if (!id || !token) {
    console.warn('[storage] Edge Config credentials not set');
    return;
  }
  try {
    await axios.patch(
      `https://api.vercel.com/v1/edge-config/${id}/items`,
      { items: [{ operation: 'upsert', key: EDGE_KEY, value }] },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    console.error('[storage] update edge', err.response?.data || err);
  }
}

async function storeBlobSnapshot(allocation) {
  try {
    const path = `allocations/${Date.now()}.json`;
    const { url } = await put(
      path,
      JSON.stringify({ allocation, timestamp: new Date().toISOString() }),
      { access: 'public' }
    );
    console.log('[storage] blob snapshot', url);
  } catch (err) {
    console.error('[storage] blob put', err);
  }
}

module.exports = {
  readEdgeAllocation,
  updateEdgeAllocation,
  storeBlobSnapshot,
};
