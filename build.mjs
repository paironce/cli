// Bundles the CLI into one file, dist/paironce.mjs: the web app's own connection code (apps/app/src/session.ts and what
// it imports) with the production settings of paironce.com; node-datachannel and zod stay dependencies.
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const pkg = JSON.parse(readFileSync(new URL('package.json', import.meta.url), 'utf8'));
const version = /CLI_VERSION = "([^"]+)"/.exec(readFileSync(new URL('src/version.ts', import.meta.url), 'utf8'))?.[1];
if (version !== pkg.version) throw new Error(`src/version.ts says ${version}, package.json ${pkg.version}`);
const origin = process.env.PAIRONCE_ORIGIN ?? 'https://paironce.com';

await build({
  entryPoints: [`${here}src/cli.ts`],
  outfile: `${here}dist/paironce.mjs`,
  bundle: true, platform: 'node', format: 'esm', target: 'node22',
  // Installed next to it rather than copied in, each with its own license: WebRTC (native) and zod.
  external: ['node-datachannel', 'node-datachannel/*', 'zod', 'zod/*'],
  // The same values as the paironce.com build (apps/app/.env.realtime-beta.example), with the site as the signaling origin.
  define: {
    'import.meta.env.VITE_SIGNALING_URL': JSON.stringify(origin),
    'import.meta.env.VITE_STUN_URL': JSON.stringify('stun:stun.cloudflare.com:3478'),
    'import.meta.env.VITE_ICE_TRANSPORT_POLICY': JSON.stringify('all'),
    'import.meta.env.VITE_REALTIME_ONLY': JSON.stringify('true'),
    'import.meta.env.VITE_RELAY_FALLBACK': JSON.stringify('true'),
    'import.meta.env.VITE_PUBLIC_BETA': JSON.stringify('true'),
    'import.meta.env': '{}',
  },
  alias: { '@paironce/core': `${here}../core/src/index.ts` },
  banner: { js: '#!/usr/bin/env node\n// paironce CLI (Apache-2.0). Source: https://github.com/paironce/cli' },
  legalComments: 'eof',
  logLevel: 'warning',
});
console.log(`dist/paironce.mjs for ${origin}`);
