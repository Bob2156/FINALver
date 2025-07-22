# Discord Bot

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```
2. Copy the example environment file and edit it with your values:
   ```bash
   cp .env.example .env
   # then open .env and fill in each variable
   ```

The `.env` file is excluded from version control so your secrets remain private.

## Vercel Storage

This project now stores allocation data using [Vercel KV](https://vercel.com/docs/storage/vercel-kv).

- The most recent allocation value is kept under the `lastAllocation` key.
- Each change is recorded by pushing a JSON entry onto the `allocationHistory` list.

Set the following environment variables when deploying:

```
KV_REST_API_URL=<connection url>
KV_REST_API_TOKEN=<access token>
```

If either `KV_REST_API_URL` or `KV_REST_API_TOKEN` is not provided, the bot will
also look for `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` and use
those values instead. This makes it easier to reuse existing Upstash
environment variables when migrating.
