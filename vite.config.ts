import { defineConfig } from 'vite';

export default defineConfig({
  // Relative, so the same build works both at a domain root
  // (birds.protonumerique.net/) and under a subpath
  // (protonumerique.github.io/birds-within/). With base: '/' the built index.html
  // asks for /assets/... which 404s on a project page - a blank screen that works
  // perfectly in dev. `import.meta.env.BASE_URL` becomes './', so the catalogue
  // fetch resolves relative to the page too. Do not "fix" this back to '/'.
  base: './',

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
