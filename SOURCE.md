# Where the code comes from

`src/` is the CLI itself. It imports the connection code of the paironce.com web app (`apps/app/src/session.ts`,
`returning-device.ts`, `identity.ts`, `realtime/disk-receive.ts` and the files they import) and the PairOnce packages
([@paironce/core](https://github.com/paironce/core), protocol, crypto, transfer). `build.mjs` bundles all of it with
esbuild into `dist/paironce.mjs`, which is exactly the file published on npm: it is not minified, and every bundled file
is marked with its path, so the whole client side of a PairOnce connection can be read there.

The signaling and relay service is not part of this repository.
