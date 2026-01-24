import EmberSsr from './ember-ssr.js';
import emberSsrMiddleware from './ember-ssr-express-middleware.js';
import ExpressHTTPServer from './express-http-server.js';
import SsrPaths from './utils/ssr-paths.js';

export default class Worker {
  constructor(options) {
    this.clientPath = options.clientPath;
    this.ssrPaths = SsrPaths.wrap(options.ssrPaths || options);
    this.httpServer = options.httpServer;
    this.ui = options.ui;
    this.cache = options.cache;
    this.gzip = options.gzip;
    this.base = options.base;
    this.host = options.host;
    this.port = options.port;
    this.username = options.username;
    this.password = options.password;
    this.beforeMiddleware = options.beforeMiddleware;
    this.afterMiddleware = options.afterMiddleware;
    this.buildSandboxGlobals = options.buildSandboxGlobals;
    this.chunkedResponse = options.chunkedResponse;
    this.log = options.log;

    if (!this.httpServer) {
      this.httpServer = new ExpressHTTPServer({
        ui: this.ui,
        ssrPaths: this.ssrPaths,
        cache: this.cache,
        gzip: this.gzip,
        base: this.base,
        host: this.host,
        port: this.port,
        username: this.username,
        password: this.password,
        beforeMiddleware: this.beforeMiddleware,
        afterMiddleware: this.afterMiddleware,
        buildSandboxGlobals: options.buildSandboxGlobals,
      });
    }

    if (!this.httpServer.cache) {
      this.httpServer.cache = this.cache;
    }
    if (!this.httpServer.ssrPaths) {
      this.httpServer.ssrPaths = SsrPaths.wrap(this.ssrPaths);
    }
    if (!this.httpServer.ui) {
      this.httpServer.ui = this.ui;
    }
  }

  start() {
    if (!this.ssrPaths.hasPath) {
      this.middleware = this.noAppMiddleware();
    } else {
      this.middleware = this.buildMiddleware();
    }

    this.bindEvents();
    this.serveHTTP();
  }

  bindEvents() {
    process.on('message', message => this.handleMessage(message));
  }

  handleMessage(message) {
    switch (message.event) {
      case 'reload':
        this.ssrPaths.setPaths({
          clientPath: message.clientPath || this.ssrPaths.clientPath,
          ssrPath: message.ssrPath || this.ssrPaths.ssrPath,
        });
        if (this.ssrPaths.clientPath === this.ssrPaths.ssrPath) {
          this.ui.writeLine('Reloading the application from distPath:', this.ssrPaths.ssrPath);
        } else {
          this.ui.writeLine('Reloading the application from clientPath:', this.ssrPaths.clientPath);
          this.ui.writeLine('Reloading the application from ssrPath:', this.ssrPaths.ssrPath);
        }
        this.emberSsr.reload({
          ssrPaths: this.ssrPaths,
        });
        break;
      case 'error':
        this.error = message.error;
        break;
      case 'shutdown':
        process.exit(0); // eslint-disable-line no-process-exit
    }
  }

  buildMiddleware() {
    this.emberSsr = new EmberSsr({
      ssrPaths: this.ssrPaths,
      buildSandboxGlobals: this.buildSandboxGlobals,
    });

    return emberSsrMiddleware({
      emberSsr: this.emberSsr,
      chunkedResponse: this.chunkedResponse,
      log: this.log,
    });
  }

  serveHTTP() {
    this.ui.writeLine('starting HTTP server');
    const app = this.emberSsr._app;
    this.httpServer.base = app.config[app.appName].rootURL;
    return this.httpServer.serve(this.middleware)
      .then(() => {
        process.send({ event: 'http-online' });
      });
  }

  noAppMiddleware() {
    return (req, res) => {
      let html = '<h1>No Application Found</h1>';

      if (this.error) {
        html += '<pre style="color: red">' + this.error + '</pre>';
      }

      res.status(500).send(html);
    };
  }
}
