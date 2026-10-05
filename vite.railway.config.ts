import {fileURLToPath} from 'node:url';
import {defineConfig} from 'vite';
import vinext from 'vinext';

// Preparation only: no Sites packaging, Cloudflare bindings or deployment calls.
// The shim cannot connect a database or enable commerce, even with inherited vars.
export default defineConfig({
  plugins: [vinext()],
  resolve: {alias: [{
    find: /^cloudflare:workers$/,
    replacement: fileURLToPath(new URL('./infra/railway/preparation-env.mjs', import.meta.url)),
  }]},
});
