import Module from 'node:module';
import { dirname } from 'node:path';
import vm from 'node:vm';

import chalk from 'chalk';
import fs from 'fs-extra';
import { HTMLElement } from 'linkedom/worker';

import debug from './debug.js';
import createDocument from './document.js';
import Result from './result.js';
import FastBootInfo from './ssr-info.js';
import { loadConfig } from './ssr-schema.js';
import SsrPaths from './utils/ssr-paths.js';

const { readFileSync } = fs;
const require = Module.createRequire(import.meta.url);

const noop = function() {};

/**
 * SSR using vm.Script with per-request vm.createContext.
 *
 * Key design: NOTHING is set on the real global object per request.
 * Each request gets its own vm.Context with its own document, window, etc.
 * The vm.Script is compiled once and reused across all contexts.
 * The real global (and its timer infrastructure) never references per-request
 * objects, so V8 can GC the contexts fully.
 */
export default class EmberApp {
  constructor(options) {
    this.buildSandboxGlobals = options.buildSandboxGlobals || defaultBuildSandboxGlobals;

    this.ssrPaths = SsrPaths.wrap(options.ssrPaths || options);
    let config = loadConfig(this.ssrPaths);

    this.hostWhitelist = config.hostWhitelist;
    this.config = config.config;
    this.appName = config.appName;
    this.html = config.html;
    this.sandboxRequire = config.sandboxRequire;

    if (process.env.APP_CONFIG) {
      let appConfig = JSON.parse(process.env.APP_CONFIG);
      let appConfigKey = this.appName;
      if (!(appConfigKey in appConfig)) {
        this.config[appConfigKey] = appConfig;
      }
    }

    if (process.env.ALL_CONFIG) {
      let allConfig = JSON.parse(process.env.ALL_CONFIG);
      this.config = allConfig;
    }

    this.scripts = config.scripts.filter(Boolean);

    // Compile scripts once. vm.Script can be run in multiple contexts.
    // CJS wrapper provides exports/require/module as local variables.
    this._compiledScripts = this.scripts.map(scriptPath => {
      const source = readFileSync(scriptPath, { encoding: 'utf8' });
      debug('compiling script %s', scriptPath);
      const wrapped = `(function(exports, require, module, __filename, __dirname) {\n${source}\n})`;
      return { script: new vm.Script(wrapped, { filename: scriptPath }), filename: scriptPath };
    });
  }

  /**
   * Build a fresh vm.Context for one request. All per-request state
   * (document, window, etc.) lives here, NOT on the real global.
   */
  buildContext() {
    const { ssrPaths, buildSandboxGlobals, config, appName, sandboxRequire } = this;

    let console = this.buildWrappedConsole();

    function ssrConfig(key) {
      if (!key) key = appName;
      return config ? { default: config[key] } : { default: undefined };
    }

    const Ssr = {
      appConfig: config[appName],
      require: sandboxRequire,
      config: ssrConfig,
      get distPath() { return ssrPaths.clientPath; },
    };

    const sandboxCjsRequire = (specifier) => {
      try { return require(specifier); }
      catch { return sandboxRequire(specifier); }
    };

    const doc = this.buildSandboxDocument();

    // Immediate-execution timers: setTimeout(fn, 0) calls fn() synchronously.
    // This lets Ember's run loop flush and app.destroy() complete immediately
    // without creating real timer entries in Node.js's timerListMap (which
    // retain closures and prevent GC of the vm.Context).
    let nextTimerId = 1;
    const sandboxSetTimeout = (fn, delay, ...args) => {
      const id = nextTimerId++;
      if (!delay) {
        try { fn(...args); } catch(e) { /* swallow errors from scheduled cleanup */ }
      }
      return id;
    };
    const sandboxClearTimeout = noop;
    const sandboxSetInterval = noop;
    const sandboxClearInterval = noop;

    // CRITICAL: All functions passed into the sandbox must be wrapped.
    // Direct references to globalThis functions (fetch, AbortController, etc.)
    // create a retention chain: vm.Context → function → function's execution
    // context → real globalThis → timerListMap. This prevents GC of the
    // vm.Context after the request completes. Thin wrappers break the chain.
    const globals = buildSandboxGlobals({
      console,
      setTimeout: sandboxSetTimeout,
      clearTimeout: sandboxClearTimeout,
      setInterval: sandboxSetInterval,
      clearInterval: sandboxClearInterval,
      structuredClone: (...args) => structuredClone(...args),
      AbortController,
      URL: globalThis.URL,
      fetch: (...args) => globalThis.fetch(...args),
      Headers: globalThis.Headers,
      Request: globalThis.Request,
      Response: globalThis.Response,
      ReadableStream: globalThis.ReadableStream,
      WritableStream: globalThis.WritableStream,
      TransformStream: globalThis.TransformStream,
      addEventListener: noop,
      removeEventListener: noop,
      document: doc,
      HTMLElement,
      navigator: { userAgent: '' },

      require: sandboxCjsRequire,
      module: { exports: {} },

      process: { env: process.env },
      Ssr,
      FastBoot: Ssr,
    });

    // Re-wrap fetch after buildSandboxGlobals in case the user passed
    // the raw globalThis.fetch which would create a retention chain.
    if (globals.fetch === globalThis.fetch) {
      globals.fetch = (...args) => globalThis.fetch(...args);
    }

    globals.exports = globals.module.exports;
    globals.window = globals;
    globals.self = globals;

    return vm.createContext(globals);
  }

  buildSandboxDocument() {
    const doc = createDocument();
    const { config, appName } = this;
    if (config && config[appName]) {
      const meta = doc.createElement('meta');
      meta.setAttribute('name', `${appName}/config/environment`);
      meta.setAttribute('content', encodeURIComponent(JSON.stringify(config[appName])));
      doc.head.appendChild(meta);
    }
    return doc;
  }

  buildWrappedConsole() {
    let wrappedConsole = Object.create(console);
    wrappedConsole.error = function(...args) {
      console.error.apply(console, args.map(a => typeof a === 'string' ? chalk.red(a) : a));
    };
    return wrappedConsole;
  }

  destroy() {
    this._compiledScripts = null;
  }

  /**
   * Run the pre-compiled CJS scripts in a fresh context.
   * Returns the Ember app + context (for cleanup).
   */
  async buildApp() {
    const context = this.buildContext();

    debug('running scripts in sandbox');

    for (const { script, filename } of this._compiledScripts) {
      try {
        const factory = script.runInContext(context);
        factory(
          context.module.exports,
          context.require,
          context.module,
          filename,
          dirname(filename),
        );
      } catch (e) {
        console.log('ssr exception', e);
        return null;
      }
    }

    debug('scripts evaluated');

    const configMeta = context.document.querySelector(`meta[name="${this.appName}/config/environment"]`);
    if (configMeta) configMeta.remove();

    const createSsrApp = context.module.exports.createSsrApp;

    if (!createSsrApp || typeof createSsrApp !== 'function') {
      console.log('Failed to load Ember app — createSsrApp not found on module.exports.');
      return null;
    }

    debug('creating application');

    return { app: createSsrApp(), context };
  }

  async _visit(path, fastbootInfo, bootOptions, result) {
    const app = result.applicationInstance;
    await app.boot();

    let instance = await app.buildInstance();
    result.applicationInstanceInstance = instance;

    registerFastBootInfo(fastbootInfo, instance);

    await instance.boot(bootOptions);
    await instance.visit(path, bootOptions);
    await fastbootInfo.deferredPromise;
  }

  async visit(path, options) {
    const req = options.request;
    const res = options.response;
    const html = options.html || this.html;
    const disableShoebox = options.disableShoebox || false;
    const destroyAppInstanceInMs = parseInt(options.destroyAppInstanceInMs, 10);

    const fastbootInfo = new FastBootInfo(req, res, {
      hostWhitelist: this.hostWhitelist,
      metadata: options.metadata || {},
    });

    const appContext = await this.buildApp();

    if (!appContext) {
      return null;
    }

    const { app, context } = appContext;
    const doc = context.document;
    const result = new Result(doc, html, fastbootInfo);

    result.applicationInstance = app;

    const shouldRender = options.shouldRender !== undefined ? options.shouldRender : true;
    const bootOptions = buildBootOptions(shouldRender, doc);

    let destroyAppInstanceTimer;
    if (destroyAppInstanceInMs > 0) {
      destroyAppInstanceTimer = setTimeout(function() {
        if (result._destroy()) {
          result.error = new Error(
            'App instance was forcefully destroyed in ' + destroyAppInstanceInMs + 'ms'
          );
        }
      }, destroyAppInstanceInMs);
    }

    try {
      await this._visit(path, fastbootInfo, bootOptions, result);

      if (!disableShoebox) {
        createShoebox(doc, fastbootInfo);
      }
    } catch (error) {
      result.error = error;
    } finally {
      result._finalize();
      result._destroy();
      clearTimeout(destroyAppInstanceTimer);
    }

    return result;
  }
}

function buildBootOptions(shouldRender, document) {
  let rootElement = document.body;
  let _renderMode = process.env.EXPERIMENTAL_RENDER_MODE_SERIALIZE ? 'serialize' : undefined;

  return {
    isBrowser: false,
    document,
    rootElement,
    shouldRender,
    _renderMode,
  };
}

const hasOwnProperty = Object.prototype.hasOwnProperty;

function createShoebox(doc, fastbootInfo) {
  let shoebox = fastbootInfo.shoebox;
  if (!shoebox) return;

  for (let key in shoebox) {
    if (!hasOwnProperty.call(shoebox, key)) continue;
    let value = shoebox[key];
    let textValue = escapeJSONString(JSON.stringify(value));
    let scriptText = doc.createRawHTMLSection(textValue);
    let scriptEl = doc.createElement('script');
    scriptEl.setAttribute('type', 'fastboot/shoebox');
    scriptEl.setAttribute('id', `shoebox-${key}`);
    scriptEl.appendChild(scriptText);
    doc.body.appendChild(scriptEl);
  }
}

const JSON_ESCAPE = {
  '&': '\\u0026',
  '>': '\\u003e',
  '<': '\\u003c',
  '\u2028': '\\u2028',
  '\u2029': '\\u2029',
};

const JSON_ESCAPE_REGEXP = /[\u2028\u2029&><]/g;

function escapeJSONString(string) {
  return string.replace(JSON_ESCAPE_REGEXP, match => JSON_ESCAPE[match]);
}

function registerFastBootInfo(info, instance) {
  info.register(instance);
}

function defaultBuildSandboxGlobals(defaultGlobals) {
  return defaultGlobals;
}
