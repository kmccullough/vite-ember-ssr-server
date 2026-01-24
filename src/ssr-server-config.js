import path, { join } from 'node:path';
import fs from 'node:fs';

import stringify from 'json-stable-stringify';
import { deserializeRegExp, serializeRegExp } from './regexp.js';

export function getEnvironmentFilePath(appRoot) {
  return path.join(appRoot, 'config', 'environment.js');
}

export const ssrServerConfigKeys = {
  hostWhitelist: {
    load: whitelist => whitelist?.map(deserializeRegExp),
    save: whitelist => whitelist?.map(serializeRegExp),
  },
  moduleWhitelist: true,
};

function normalizeSsrConfig(config, serialize = false) {
  if (!config) {
    return config;
  }
  config = {
    name: config.modulePrefix || config.name,
    ssrServer: normalizeSsrServerConfig(config.ssrServer || config.fastboot, serialize),
  };
  const result = {};
  for (const [ key, value ] of Object.entries(config)) {
    if (value) {
      result[key] = value;
    }
  }
  return Object.keys(result).length ? result : null;
}

function normalizeSsrServerConfig(config, serialize = false) {
  if (!config) {
    return config;
  }
  const result = {};
  for (const [ key, x ] of Object.entries(ssrServerConfigKeys)) {
    if (key in config) {
      const transform = x && typeof x === 'object' && serialize ? x.save : x.load;
      const value = typeof transform === 'function' ? transform(config[key]) : config[key];
      if ((value ?? null) !== null) {
        result[key] = value;
      }
    }
  }
  return Object.keys(result).length ? result : null;
}

export async function getSsrServerConfigFromApp(appRoot, mode = 'development') {
  const envPath = getEnvironmentFilePath(appRoot);
  const configFn = (await import(envPath)).default;
  const appConfig = configFn(mode);
  return normalizeSsrConfig(appConfig);
}

export function getSsrServerConfigFromServer(serverRoot) {
  let ssrConfig = {};
  try {
    ssrConfig = JSON.parse(fs.readFileSync(join(serverRoot, 'package.json'), 'utf-8')).ssrServer;
  } catch (e) {}
  return normalizeSsrConfig(ssrConfig);
}

export function writeSsrServerConfigForServer(distPath, ssrConfig) {
  const configPath = path.resolve(distPath, 'package.json');
  let configPkg = {};
  try {
    configPkg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch(e) {}
  const config = normalizeSsrConfig(ssrConfig, true);
  if (config) {
    configPkg = { ...configPkg, ...config };
  }
  const output = stringify(configPkg, { space: 2 });
  fs.mkdirSync(distPath, { recursive: true });
  fs.writeFileSync(configPath, output);
}
