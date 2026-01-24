import assert from 'node:assert';
import cluster from 'node:cluster';
import os from 'node:os';
import {  dirname, isAbsolute, join } from 'node:path';

import Ui from './src/ui.js';
import Worker from './src/worker.js';
import SsrPaths from './src/utils/ssr-paths.js';

const { env } = process;

export const envs = {
  mode:       'NODE_ENV',
  distPath:   'SSR_DIST_PATH',
  clientPath: 'CLIENT_PATH',
  ssrPath:    'SSR_PATH',
  host:       'SERVER_HOST',
  port:       'SERVER_PORT',
};

export function defaults(mode = 'production') {
  return {
    dev: false,
    mode,
    distPath:   null,
    clientPath: null,
    ssrPath:    null,
    downloader: null,
    host:       'localhost',
    port:       4200,
    noGzip:     false,
    baseIndex:  'index.html',
    username:   null,
    password:   null,
    ui:         null,
    log:        null,
    notifier:   null,
    cache:      null,
    httpServer: null,
    chunkedResponse:     true,
    beforeMiddleware:    null,
    afterMiddleware:     null,
    buildSandboxGlobals: null,
  };
}

const rootPath = dirname(process.argv[1]);

export default class ViteEmberSsrServer {
  dev;
  mode;
  distPath;
  clientPath;
  ssrPath;
  ssrPaths;
  downloader;
  host;
  port;
  noGzip;
  baseIndex;
  username;
  password;
  ui;
  log;
  notifier;
  cache;
  httpServer;
  chunkedResponse;
  beforeMiddleware;
  afterMiddleware;
  buildSandboxGlobals;

  vite;

  nextRequestId = 1;

  constructor(options) {
    options ||= {};
    const defaultOptions = defaults(options.mode);
    const combinedDefaultOptions = {
      ...defaultOptions,
      ...(options.defaults || {}),
    };
    for (const o of Object.keys(defaultOptions)) {
      this[o] = (options[o] ?? env[envs[o]]) || combinedDefaultOptions[o];
    }

    this.ssrPaths = new SsrPaths({
      distPath: this._absolutePath(this.distPath),
      clientPath: this._absolutePath(this.clientPath),
      ssrPath: this._absolutePath(this.ssrPath),
    });
    this.ui ||= new Ui();

    this.propagateUI();

    if (cluster.isWorker) {
      this.worker = new Worker({
        ui: this.ui,
        ssrPaths: this.ssrPaths,
        cache: this.cache,
        gzip: !this.noGzip,
        host: this.host,
        port: this.port,
        username: this.username,
        password: this.password,
        httpServer: this.httpServer,
        beforeMiddleware: this.beforeMiddleware,
        afterMiddleware: this.afterMiddleware,
        buildSandboxGlobals: this.buildSandboxGlobals,
        chunkedResponse: this.chunkedResponse,
        log: this.log,
      });

      this.worker.start();
    } else {
      this.workerCount = options.workerCount ||
        (process.env.NODE_ENV === 'test' ? 1 : null) ||
        os.cpus().length;

      assert(
        (this.ssrPaths.clientPath && this.ssrPaths.ssrPath) || this.downloader,
        'ViteEmberSsrServer must be provided with either a distPath (or clientPath & ssrPath) or a downloader option.'
      );
      assert(
        !((this.ssrPaths.clientPath || this.ssrPaths.ssrPath) && this.downloader),
        'ViteEmberSsrServer must be provided with either a distPath (or clientPath & ssrPath) or a downloader option, but not both.'
      );
    }
  }

  start() {
    if (cluster.isWorker) {
      return;
    }

    return this.initializeApp()
      .then(() => this.subscribeToNotifier())
      .then(() => this.forkWorkers())
      .then(() => {
        if (this.initializationError) {
          this.broadcast({ event: 'error', error: this.initializationError.stack });
        }
      })
      .catch(err => {
        this.ui.writeLine(err.stack);
      });
  }

  stop() {
    this.broadcast({ event: 'shutdown' });
  }

  propagateUI() {
    if (this.downloader) {
      this.downloader.ui = this.ui;
    }
    if (this.notifier) {
      this.notifier.ui = this.ui;
    }
    if (this.cache) {
      this.cache.ui = this.ui;
    }
    if (this.httpServer) {
      this.httpServer.ui = this.ui;
    }
  }

  initializeApp() {
    // If there's a downloader, it returns a promise for downloading the app
    if (this.downloader) {
      return this.downloadApp()
        .catch(err => {
          this.ui.writeLine('Error downloading app');
          this.ui.writeLine(err.stack);
          this.initializationError = err;
        });
    }

    if (this.ssrPaths.clientPath === this.ssrPaths.ssrPath) {
      this.ui.writeLine(`using distPath; path=${this.ssrPaths.ssrPath}`);
    } else {
      this.ui.writeLine(`using clientPath; path=${this.ssrPaths.clientPath}`);
      this.ui.writeLine(`using ssrPath; path=${this.ssrPaths.ssrPath}`);
    }

    return Promise.resolve();
  }

  downloadApp() {
    this.ui.writeLine('downloading app');

    return this.downloader.download()
      .then(({ distPath, clientPath, ssrPath }) => {
        this.ssrPaths.setPaths({
          distPath: this._absolutePath(distPath),
          clientPath: this._absolutePath(clientPath),
          ssrPath: this._absolutePath(ssrPath),
        });
      })
      .catch(err => {
        if (err.name.match(/AppNotFound/)) {
          this.ui.writeError('app not downloaded');
        } else {
          throw err;
        }
      });
  }

  subscribeToNotifier() {
    if (this.notifier) {
      this.ui.writeLine('subscribing to update notifications');

      return this.notifier.subscribe(() => {
        this.ui.writeLine('reloading server');
        this.initializeApp()
          .then(() => this.reload());
      })
        .catch(err => {
          this.ui.writeLine('Error subscribing');
          this.ui.writeLine(err.stack);
          this.initializationError = err;
        });
    }
  }

  broadcast(message) {
    let workers = cluster.workers;

    for (let id in workers) {
      workers[id].send(message);
    }
  }

  reload() {
    this.broadcast({ event: 'reload', distPath: this.distPath });
  }

  forkWorkers() {
    let promises = [];

    for (let i = 0; i < this.workerCount; i++) {
      promises.push(this.forkWorker());
    }

    return Promise.all(promises);
  }

  forkWorker() {
    let env = this.buildWorkerEnv();
    let worker = cluster.fork(env);

    this.ui.writeLine(`forked worker ${worker.process.pid}`);

    worker.on('exit', (code, signal) => {
      if (signal) {
        this.ui.writeLine(`worker was killed by signal: ${signal}`);
      } else if (code !== 0) {
        this.ui.writeLine(`worker exited with error code: ${code}`);
      } else {
        this.ui.writeLine(`worker exited`);
      }

      this.forkWorker();
    });

    return new Promise(resolve => {
      this.ui.writeLine('worker online');
      worker.on('message', message => {
        if (message.event === 'http-online') {
          resolve();
        }
      });
    });
  }

  buildWorkerEnv() {
    let env = {};

    if (this.ssrPaths.clientPath && this.ssrPaths.ssrPath) {
      env[envs.clientPath] = this.ssrPaths.clientPath;
      env[envs.ssrPath] = this.ssrPaths.ssrPath;
    }

    return env;
  }

  _absolutePath(path) {
    return path && !isAbsolute(path) ? join(rootPath, path) : path;
  }
}

process.on('uncaughtException', err => {
  console.log('uncaughtException', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.log('unhandledRejection', reason);
});
