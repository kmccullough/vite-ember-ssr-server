import Module from 'node:module';
import { dirname, resolve, normalize } from 'node:path';
import URL from 'node:url';
import vm from 'node:vm';
import chalk from 'chalk';
import fs from 'fs-extra';
import { HTMLElement } from 'linkedom/worker';
import sourceMapSupport from 'source-map-support';

import debug from './debug.js';
import createDocument from './document.js';
import Result from './result.js';
import FastBootInfo from './ssr-info.js';
import { loadConfig } from './ssr-schema.js';
import Queue from './utils/queue.js';
import SsrPaths from './utils/ssr-paths.js';

const { statSync, readFile } = fs;
const require = Module.createRequire(import.meta.url);

const noop = function() {};

/**
 * @private
 *
 * The `EmberApp` class serves as a non-sandboxed wrapper around a sandboxed
 * `Ember.Application`. This bridge allows the FastBoot to quickly spin up new
 * `ApplicationInstances` initialized at a particular route, then destroy them
 * once the route has finished rendering.
 */
export default class EmberApp {
  /**
   * Create a new EmberApp.
   * @param {Object} options
   * @param {string} options.distPath - path to the built Ember application
   * @param {Function} [options.buildSandboxGlobals] - the function used to build the final set of global properties accesible within the sandbox
   * @param {Number} [options.maxSandboxQueueSize] - maximum sandbox queue size when using buildSandboxPerRequest flag.
   */
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

    this.scripts = config.scripts;

    // default to 1 if maxSandboxQueueSize is not defined so the sandbox is pre-warmed when process comes up
    const maxSandboxQueueSize = options.maxSandboxQueueSize || 1;
    // Ensure that the dist files can be evaluated and the `Ember.Application`
    // instance created.
    this.buildSandboxQueue(maxSandboxQueueSize);
  }

  /**
   * @private
   *
   * Function to build queue of sandboxes which is later leveraged if application is using `buildSandboxPerRequest`
   * flag. This is an optimization to help with performance.
   *
   * @param {Number} maxSandboxQueueSize - maximum size of queue (this is should be a derivative of your QPS)
   */
  buildSandboxQueue(maxSandboxQueueSize) {
    this._sandboxApplicationInstanceQueue = new Queue(
      () => this.buildNewApplicationInstance(),
      maxSandboxQueueSize
    );

    for (let i = 0; i < maxSandboxQueueSize; i++) {
      this._sandboxApplicationInstanceQueue.enqueue();
    }
  }

  /**
   * @private
   *
   * Builds and initializes a new sandbox to run the Ember application in.
   */
  buildContext() {
    const { ssrPaths, buildSandboxGlobals, config, appName, sandboxRequire } = this;

    let console = this.buildWrappedConsole();

    function ssrConfig(key) {
      if (!key) {
        // default to app key
        key = appName;
      }

      if (config) {
        return { default: config[key] };
      } else {
        return { default: undefined };
      }
    }

    const Ssr = {
      appConfig: config[appName],
      require: sandboxRequire,
      config: ssrConfig,

      get distPath() {
        return ssrPaths.clientPath;
      },
    };

    const globals = buildSandboxGlobals({
      console,
      setTimeout,
      clearTimeout,
      structuredClone,
      AbortController,
      URL,
      addEventListener: noop,
      removeEventListener: noop,
      document: createDocument(),
      HTMLElement,
      navigator: { userAgent: '' },

      // Convince jQuery not to assume it's in a browser
      module: { exports: {} },

      sourceMapSupport,
      process,
      Ssr,
      FastBoot: Ssr,
    });

    // Set the global as `window`.
    globals.window = globals;
    globals.window.self = globals;

    return vm.createContext(globals);
  }

  buildWrappedConsole() {
    let wrappedConsole = Object.create(console);

    wrappedConsole.error = function(...args) {
      console.error.apply(
        console,
        args.map(function(a) {
          return typeof a === 'string' ? chalk.red(a) : a;
        })
      );
    };

    return wrappedConsole;
  }

  /**
   * Perform any cleanup that is needed
   */
  destroy() {
  }

  /**
   * Builds a new application instance context as a micro-task.
   */
  buildNewApplicationInstance() {
    return Promise.resolve().then(() => this.buildApp())
  }

  /**
   * @typedef AppContext
   * @property {Ember.Application} app
   * @property {{}} context vm context globals
   */
  /**
   * @private
   *
   * Creates a new `Application`
   *
   * @returns {Promise.<AppContext>} instance
   */
  async buildApp() {
    const context = this.buildContext();
    let createSsrApp;

    debug('adding files to sandbox');

    for (let script of this.scripts) {
      if (!script) {
        continue;
      }
      debug('evaluating file %s', script);
      const { link, importModuleDynamically } = this.buildLink(context, script);
      const module = await this.buildScript(
        script, context, link, importModuleDynamically,
      );
      try {
        await module.evaluate();
        createSsrApp ??= module.namespace?.createSsrApp;
        await Promise.resolve(); // Run microtasks?
      } catch (e) {
        console.log('ssr exception', e);
        return null;
      }
    }

    debug('files evaluated');

    // If the application factory couldn't be found, throw an error
    if (!createSsrApp || typeof createSsrApp !== 'function') {
      console.log(
        'Failed to load Ember app from app.js, make sure it was built for FastBoot with the `ember fastboot:build` command.'
      );
      return null;
    }

    debug('creating application');

    // Otherwise, return a new `Ember.Application` instance
    return { app: createSsrApp(), context };
  }

  async buildScript(filePath, context, link, importModuleDynamically, source = null) {
    source ??= await readFile(filePath, { encoding: 'utf8' });
    const module = new vm.SourceTextModule(source, {
      context,
      identifier: filePath,
      importModuleDynamically,
    });
    await module.link(link);
    return module;
  }

  buildLink(context, defaultBase) {
    const importModuleDynamically = async specifier => {
      return (await link(specifier)).namespace;
    };
    const link = async (specifier, referencingModule) => {
      const base = referencingModule?.identifier || defaultBase;
      const identifier = await this.resolveImport(specifier, base);
      const module = await this.buildScript(
        identifier, context, link, importModuleDynamically,
      );
      await module.evaluate();
      return module;
    };
    return { link, importModuleDynamically };
  }

  async resolveImport(specifier, importerPath) {
    if (!specifier.startsWith('.')) {
      return require.resolve(specifier);
    }
    const resolvedPath = normalize(resolve(dirname(importerPath), specifier));
    let foundPath;
    const attempts = [
      { },
      { file: 'index.js' },
      { ext: '.mjs' },
      { ext: '.js' }
    ];
    for (const attempt of attempts) {
      let attemptPath = resolvedPath;
      if (attempt.file) {
        attemptPath = resolve(attemptPath, attempt.file);
      }
      if (attempt.ext) {
        attemptPath += attempt.ext;
      }
      const stats = statSync(attemptPath, { throwIfNoEntry: false });
      if (stats?.isFile()) {
        foundPath = attemptPath;
        break;
      }
    }
    return foundPath || require.resolve(specifier);
  }

  /**
   * @private
   *
   * @param {AppContext} appContext - the instance that is pre-warmed or built on demand
   * @param {Boolean} isAppInstancePreBuilt - boolean representing how the instance was built
   *
   * @returns {Object}
   */
  getAppInstanceInfo(appContext, isAppInstancePreBuilt = true) {
    return { appContext, isSandboxPreBuilt: isAppInstancePreBuilt };
  }

  /**
   * @private
   *
   * Get the new sandbox off if it is being created, otherwise create a new one on demand.
   * The latter is needed when the current request hasn't finished or wasn't build with sandbox
   * per request turned on and a new request comes in.
   */
  async getNewApplicationInstance() {
    const queueObject = this._sandboxApplicationInstanceQueue.dequeue();
    const app = await queueObject.item;

    return this.getAppInstanceInfo(app, queueObject.isItemPreBuilt);
  }

  /**
   * @private
   *
   * Main function that creates the app instance for every `visit` request, boots
   * the app instance and then visits the given route and destroys the app instance
   * when the route is finished its render cycle.
   *
   * Ember apps can manually defer rendering in FastBoot mode if they're waiting
   * on something async the router doesn't know about. This function fetches
   * that promise for deferred rendering from the app.
   *
   * @param {string} path the URL path to render, like `/photos/1`
   * @param {Object} fastbootInfo An object holding per request info
   * @param {Object} bootOptions An object containing the boot options that are used
   *                             by ember to decide whether it needs to do rendering or not.
   * @param {Object} result
   * @return {Promise<instance>} instance
   */
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

  /**
   * Creates a new application instance and renders the instance at a specific
   * URL, returning a promise that resolves to a {@link Result}. The `Result`
   * gives you access to the rendered HTML as well as metadata about the
   * request such as the HTTP status code.
   *
   * If this call to `visit()` is to service an incoming HTTP request, you may
   * provide Node's `ClientRequest` and `ServerResponse` objects as options
   * (e.g., the `res` and `req` arguments passed to Express middleware).  These
   * are provided to the Ember application via the FastBoot service.
   *
   * @param {string} path the URL path to render, like `/photos/1`
   * @param {Object} options
   * @param {string} [options.html] the HTML document to insert the rendered app into
   * @param {Object} [options.metadata] Per request specific data used in the app.
   * @param {Boolean} [options.shouldRender] whether the app should do rendering or not. If set to false, it puts the app in routing-only.
   * @param {Boolean} [options.disableShoebox] whether we should send the API data in the shoebox. If set to false, it will not send the API data used for rendering the app on server side in the index.html.
   * @param {Integer} [options.destroyAppInstanceInMs] whether to destroy the instance in the given number of ms. This is a failure mechanism to not wedge the Node process (See: https://github.com/ember-fastboot/fastboot/issues/90)
   * @param {ClientRequest}
   * @param {ClientResponse}
   * @returns {Promise<Result>} result
   */
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

    const { appContext, isSandboxPreBuilt }
      = await this.getNewApplicationInstance();

    const { app, context } = appContext;

    const doc = context.document;
    const result = new Result(doc, html, fastbootInfo);

    // entangle the specific application instance to the result, so it can be
    // destroyed when result._destroy() is called (after the visit is
    // completed)
    result.applicationInstance = app;

    // we add analytics information about the current request to know
    // whether it used sandbox from the pre-built queue or built on demand.
    result.analytics.usedPrebuiltSandbox = isSandboxPreBuilt;

    const shouldRender = options.shouldRender !== undefined ? options.shouldRender : true;
    const bootOptions = buildBootOptions(shouldRender, doc);

    // TODO: Use Promise.race here
    let destroyAppInstanceTimer;
    if (destroyAppInstanceInMs > 0) {
      // start a timer to destroy the appInstance forcefully in the given ms.
      // This is a failure mechanism so that node process doesn't get wedged if the `visit` never completes.
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
        // if shoebox is not disabled, then create the shoebox and send API data
        createShoebox(doc, fastbootInfo);
      }
    } catch (error) {
      // eslint-disable-next-line require-atomic-updates
      result.error = error;
    } finally {
      result._finalize();
      // ensure we invoke `Ember.Application.destroy()` and
      // `Ember.ApplicationInstance.destroy()`, but use `result._destroy()` so
      // that the `result` object's internal `this.isDestroyed` flag is correct
      result._destroy();

      clearTimeout(destroyAppInstanceTimer);

      // build a new sandbox for the next incoming request
      this._sandboxApplicationInstanceQueue.enqueue();
    }

    return result;
  }
}

/*
 * Builds an object with the options required to boot an ApplicationInstance in
 * FastBoot mode.
 */
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

/*
 * Writes the shoebox into the DOM for the browser rendered app to consume.
 * Uses a script tag with custom type so that the browser will treat as plain
 * text, and not expend effort trying to parse contents of the script tag.
 * Each key is written separately so that the browser rendered app can
 * parse the specific item at the time it is needed instead of everything
 * all at once.
 */
const hasOwnProperty = Object.prototype.hasOwnProperty; // jshint ignore:line

function createShoebox(doc, fastbootInfo) {
  let shoebox = fastbootInfo.shoebox;
  if (!shoebox) {
    return;
  }

  for (let key in shoebox) {
    if (!hasOwnProperty.call(shoebox, key)) {
      continue;
    } // TODO: remove this later #144, ember-fastboot/ember-cli-fastboot/pull/417
    let value = shoebox[key];
    let textValue = JSON.stringify(value);
    textValue = escapeJSONString(textValue);

    let scriptText = doc.createRawHTMLSection(textValue);
    let scriptEl = doc.createElement('script');

    scriptEl.setAttribute('type', 'ssr/shoebox');
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
  return string.replace(JSON_ESCAPE_REGEXP, function(match) {
    return JSON_ESCAPE[match];
  });
}

/*
 * Builds a new FastBootInfo instance with the request and response and injects
 * it into the application instance.
 */
function registerFastBootInfo(info, instance) {
  info.register(instance);
}

function defaultBuildSandboxGlobals(defaultGlobals) {
  return defaultGlobals;
}
