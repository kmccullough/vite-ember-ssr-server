import { defineConfig } from 'vite';
import { extensions, classicEmberSupport, ember } from '@embroider/vite';
import { babel } from '@rollup/plugin-babel';
import { viteEmberSsrServerPlugin } from 'vite-ember-ssr-server/vite-plugin.mjs';

const isSsr = !!process.env.VITE_SSR;

export default defineConfig({
  build: {
    outDir: isSsr ? 'dist/ssr' : 'dist/public',
    ...(isSsr ? { ssr: 'app/app.ts' } : {}),
    rollupOptions: {
      output: {
        ...(isSsr
          ? {
              format: 'cjs',
              exports: 'named',
              inlineDynamicImports: true,
            }
          : {}),
      },
    },
  },
  ssr: {
    noExternal: true,
  },
  plugins: [
    classicEmberSupport(),
    ember(),
    babel({
      babelHelpers: 'runtime',
      extensions,
    }),
    viteEmberSsrServerPlugin(),
  ],
});
