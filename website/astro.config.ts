import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'astro/config';

// Compiler fragments are injected with set:html and carry white-space:pre columns whose U+3000
// are content, so the HTML compressor must never touch the page.
export default defineConfig({
  site: 'https://jpnov.com',
  base: '/',
  output: 'static',
  compressHTML: false,
  vite: {
    plugins: [tailwindcss()],
    // Browser code imports the product's 傍点 probe from the repository root.
    server: { fs: { allow: [fileURLToPath(new URL('..', import.meta.url))] } },
  },
});
