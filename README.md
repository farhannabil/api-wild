# API WILD

Source for the API WILD model marketplace and customer account application at https://apiwild.com.

## Development

Requires Node.js 22.

```sh
node scripts/prepare-ci.mjs
npm run install:ci
npm test
npm run dev
```

The exported repository uses a generic build-only hosting configuration when the private deployment identity is absent. Production publication is managed separately through Sites; a successful GitHub check is not a deployment.

## Operations

See [OPERATIONS.md](OPERATIONS.md) for support email, daily health checks and release verification. Sensitive credentials belong in the appropriate provider secret store and must never be committed.

The workflow builds and tests commits and pull requests, supports manual runs, and checks production daily. Support acknowledgement automation uses signed Resend events and a service-only Supabase delivery ledger. Additional commerce email templates require their verified business-event integrations before activation.
