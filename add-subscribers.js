if (!process.env.KV_REST_API_URL && process.env.UPSTASH_REDIS_REST_URL) {
  process.env.KV_REST_API_URL = process.env.UPSTASH_REDIS_REST_URL;
}
if (!process.env.KV_REST_API_TOKEN && process.env.UPSTASH_REDIS_REST_TOKEN) {
  process.env.KV_REST_API_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
}

const { kv } = require('@vercel/kv');

// Only attempt to seed if the KV credentials are configured. This script
// runs during the deployment build step via `npm postinstall` so we don't
// want it to fail the build if the environment variables are missing.
if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
  console.log('[add-subscribers] KV credentials not found; skipping seeding');
  process.exit(0);
}

const SUBSCRIBERS_KEY = 'allocationSubscribers';
const ids = [
  '169127116732891136',
  '178980194197962755',
  '297784270334722059',
  '373949108433584139',
  '452205802405756929',
  '534855346498437179',
  '538208941973438475',
  '936882956302159902',
  '961355883298828368',
  '1247981696951910496'
];

(async () => {
  try {
    await kv.sadd(SUBSCRIBERS_KEY, ...ids);
    console.log('Added subscriber IDs to KV');
  } catch (err) {
    console.error('Failed to add subscribers', err);
    process.exitCode = 1;
  }
})();
