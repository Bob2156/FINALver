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

This project can keep allocation state using [Vercel Edge Config](https://vercel.com/docs/storage/edge-config) and [Vercel Blob](https://vercel.com/docs/vercel-blob).

- **Edge Config** stores the most recent allocation value for quick reads.
- **Blob** keeps JSON snapshots of each change under an `allocations/` folder.

Set the following environment variables when deploying:

```
EDGE_CONFIG=<connection string>
BLOB_READ_WRITE_TOKEN=<token for Blob uploads>
EDGE_CONFIG_ID=<optional id if not in connection>
EDGE_CONFIG_TOKEN=<optional write token if not in connection>
```

If `EDGE_CONFIG` is omitted, the ID and token will be combined to form a connection string automatically.
