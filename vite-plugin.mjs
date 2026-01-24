import path from 'node:path';

import { getEnvironmentFilePath, getSsrServerConfigFromApp, writeSsrServerConfigForServer } from './src/ssr-server-config.js';

export function viteEmberSsrServerPlugin() {
  if (!process.env.VITE_SSR) {
    return;
  }

  let config;
  let bundle;
  let server;

  const updateConfig = async log => {
    if (!(server || bundle)) {
      console.log('Writing fastboot config failed on ' + log);
      return;
    }
    const appRoot = config.root;
    const distPath = path.join(appRoot, config.build.outDir);
    console.log('Writing fastboot config on ' + log);
    const fastbootConfig = await getSsrServerConfigFromApp(appRoot, config.mode);
    writeSsrServerConfigForServer(distPath, fastbootConfig);
  };

  return {
    name: 'fastboot-plugin',

    configResolved(resolvedConfig) {
      config = resolvedConfig;
    },

    generateBundle(options, resolvedBundle) {
      bundle = resolvedBundle;
    },

    async configureServer(server) {
      const appRoot = config.root;
      const envPath = getEnvironmentFilePath(appRoot);

      await updateConfig('initial dev serve');

      server.watcher.on('change', async changedFile => {
        if (changedFile === envPath) {
          await updateConfig('environment.js change');
        }
      });
    },

    async closeBundle() {
      await updateConfig('build');
    },
  };
}
