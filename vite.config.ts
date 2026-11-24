import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  return {
    plugins: [
      react(),
      tailwindcss(),
      // Copies src/assets into dist/ so root-relative URLs like
      // "/src/assets/images/..." (e.g. generate_image output) still resolve
      // in production builds. Do not remove.
      {
        name: 'copy-unbundled-src-assets',
        apply: 'build',
        closeBundle(error?: Error): void {
          if (error) {
            return;
          }
          const distDir = path.resolve(__dirname, 'dist');
          const srcAssets = path.resolve(__dirname, 'src/assets');
          const distAssets = path.resolve(distDir, 'src/assets');
          if (fs.existsSync(distDir) && fs.existsSync(srcAssets)) {
            fs.cpSync(srcAssets, distAssets, {recursive: true, force: true});
          }

          // Cloudflare Pages should infer these types from extensions, but emit
          // exact-path overrides so static module/style requests cannot inherit
          // a generic application/octet-stream type from the hosting layer.
          if (fs.existsSync(distDir)) {
            const deployableAssets: string[] = [];
            const collectAssets = (directory: string): void => {
              for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
                const fullPath = path.join(directory, entry.name);
                if (entry.isDirectory()) {
                  collectAssets(fullPath);
                } else if (/\.(?:m?js|css)$/i.test(entry.name)) {
                  deployableAssets.push(path.relative(distDir, fullPath).split(path.sep).join('/'));
                }
              }
            };

            collectAssets(distDir);
            const headerRules = deployableAssets.map((asset) => {
              const contentType = /\.(?:m?js)$/i.test(asset)
                ? 'application/javascript; charset=utf-8'
                : 'text/css; charset=utf-8';
              return `/${asset}\n  Content-Type: ${contentType}`;
            });
            fs.writeFileSync(path.join(distDir, '_headers'), `${headerRules.join('\n\n')}\n`, 'utf8');
          }
        },
      },
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: false,
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
