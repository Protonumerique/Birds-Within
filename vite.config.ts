import { defineConfig } from 'vite';

export default defineConfig({
  // Deploying to a subdomain root, so '/' is correct. If this ever ends up served
  // from a subpath (e.g. GitHub Pages project sites), change this to '/<repo>/'
  // or asset URLs will 404 in production while working fine in dev.
  base: '/',

  server: {
    host: true,
    // Uncomment when step 2 moves to the multi-threaded WASM runtime: pthreads
    // needs SharedArrayBuffer, which needs cross-origin isolation. The production
    // host must send the same two headers - GitHub Pages cannot, Netlify and
    // Cloudflare Pages can.
    // headers: {
    //   'Cross-Origin-Opener-Policy': 'same-origin',
    //   'Cross-Origin-Embedder-Policy': 'require-corp',
    // },
  },

  // satellite.js v7 ships emscripten WASM builds, and the pthreads one contains
  // top-level await. Vite's default worker output format is 'iife', which cannot
  // express that, so a production build fails with UNSUPPORTED_FEATURE the moment
  // anything is imported from the package root. ES-format workers fix it, and are
  // what step 2's own propagation worker wants anyway.
  worker: {
    format: 'es',
  },

  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
