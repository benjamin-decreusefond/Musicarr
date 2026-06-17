import * as esbuild from 'esbuild';
import fs from 'node:fs';

fs.mkdirSync('dist', { recursive: true });
fs.copyFileSync('src/index.html', 'dist/index.html');
fs.copyFileSync('src/favicon.svg', 'dist/favicon.svg');
fs.copyFileSync('src/manifest.webmanifest', 'dist/manifest.webmanifest');
// The service worker must be served from the site root to control the whole
// scope, and is shipped as-is (no bundling needed).
fs.copyFileSync('src/sw.js', 'dist/sw.js');

await esbuild.build({
  entryPoints: ['src/main.jsx'],
  bundle: true,
  minify: true,
  sourcemap: false,
  format: 'esm',
  target: ['es2020'],
  loader: { '.jsx': 'jsx', '.css': 'css' },
  jsx: 'automatic',
  outfile: 'dist/app.js',
  define: { 'process.env.NODE_ENV': '"production"' },
});

console.log('web build done');
