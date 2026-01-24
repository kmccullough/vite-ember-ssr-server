import Module from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import * as glob from 'glob';
import resolve from 'resolve';
import debug from './debug.js';

import htmlEntrypoint from './html-entrypoint.js';
import getPackageName from './utils/get-package-name.js';

const require = Module.createRequire(import.meta.url);

/**
 * Given the path to a built Ember app, loads our complete configuration
 */
export function loadConfig(ssrPaths) {
  const { clientPath, ssrPath } = ssrPaths;
  let pkgPath = path.join(ssrPath, 'package.json');
  let file;

  try {
    file = fs.readFileSync(pkgPath);
  } catch (e) {
    throw new Error(
      `Couldn't find ${pkgPath}. You may need to update your version of vite-ember-ssr-server.`
    );
  }

  let pkg;
  try {
    pkg = JSON.parse(file);
  } catch (e) {
    throw new Error(
      `${pkgPath} was malformed or did not contain a ssrServer config. Ensure that you have a compatible version of vite-ember-ssr-server.`
    );
  }

  let config, html;
  const appName = pkg.name;
  ({ config, html } = htmlEntrypoint(
    appName,
    clientPath,
    pkg.ssrServer.htmlEntrypoint || 'index.html'
  ));

  let sandboxRequire = buildWhitelistedRequire(
    pkg.ssrServer.moduleWhitelist || [],
    ssrPath
  );

  const scripts = [].concat(pkg.ssrServer.scripts || 'app.{mjs,js}')
    .flatMap(script => glob.sync(
      path.isAbsolute(script) ? script : path.join(ssrPath, script)
    ));

  return {
    scripts,
    html,
    hostWhitelist: pkg.ssrServer.hostWhitelist,
    config,
    appName,
    sandboxRequire,
  };
}

/**
 * The Ember app runs inside a sandbox that doesn't have access to the normal
 * Node.js environment, including the `require` function. Instead, we provide
 * our own `require` method that only allows whitelisted packages to be
 * requested.
 *
 * This method takes an array of whitelisted package names and the path to the
 * built Ember app and constructs this "fake" `require` function that gets made
 * available globally inside the sandbox.
 *
 * @param {string[]} whitelist array of whitelisted package names
 * @param {string} ssrPath path to the built Ember app
 */
function buildWhitelistedRequire(whitelist, ssrPath) {
  whitelist.forEach(function(whitelistedModule) {
    debug('module whitelisted; module=%s', whitelistedModule);
  });

  return function(moduleName) {
    let packageName = getPackageName(moduleName);
    let isWhitelisted = whitelist.indexOf(packageName) > -1;

    if (isWhitelisted) {
      try {
        let resolvedModulePath = resolve.sync(moduleName, { basedir: ssrPath });
        return require(resolvedModulePath);
      } catch (error) {
        if (error.code === 'MODULE_NOT_FOUND') {
          return require(moduleName);
        } else {
          throw error;
        }
      }
    }

    throw new Error(
      "Unable to require module '" +
      moduleName +
      "' in EmberSsr because its package '" +
      packageName +
      "' was not explicitly allowed in 'ssrDependencies' in your package.json."
    );
  };
}
