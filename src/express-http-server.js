import { join } from 'node:path';
import compression from 'compression';
import express from 'express';

import basicAuth from './basic-auth.js';
import SsrPaths from './utils/ssr-paths.js';

function noop() {}

export default class ExpressHTTPServer {
  constructor(options) {
    options = options || {};

    this.ui = options.ui;
    this.ssrPaths = SsrPaths.wrap(options.ssrPaths || options);
    this.username = options.username;
    this.password = options.password;
    this.cache = options.cache;
    this.gzip = options.gzip || true;
    this.base = options.base;
    this.host = options.host;
    this.port = options.port;
    this.beforeMiddleware = options.beforeMiddleware || noop;
    this.afterMiddleware = options.afterMiddleware || noop;

    this.app = express();
  }

  serve(fastbootMiddleware) {
    let app = this.app;
    const router = express.Router();
    let username = this.username;
    let password = this.password;

    this.beforeMiddleware(app);

    if (this.gzip) {
      router.use(compression());
    }

    if ((username ?? null) !== null || (password ?? null) !== null) {
      this.ui.writeLine(`adding basic auth; username=${username}; password=${password}`);
      router.use(basicAuth(username, password));
    }

    if (this.cache) {
      router.get('/*all', this.buildCacheMiddleware());
    }

    if (this.ssrPaths.hasPath) {
      router.get('/', fastbootMiddleware);
      router.use(express.static(this.ssrPaths.clientPath));
      router.get('/assets/*asset', function(req, res) {
        res.sendStatus(404);
      });
    }

    router.get('/*all', fastbootMiddleware);

    this.afterMiddleware(router);

    const base = join('/', this.base || '/', '/');
    app.use(base, router);

    return new Promise(resolve => {
      let listener = app.listen(this.port || process.env.PORT || 3000, this.host || process.env.HOST, () => {
        let host = listener.address().address;
        let port = listener.address().port;

        this.ui.writeLine('HTTP server started; url=http://%s:%s%s', host, port, base);

        resolve();
      });
    });
  }

  buildCacheMiddleware() {
    return (req, res, next) => {
      let path = req.path;

      Promise.resolve(this.cache.fetch(path, req))
        .then(response => {
          if (response) {
            this.ui.writeLine(`cache hit; path=${path}`);
            res.send(response);
          } else {
            this.ui.writeLine(`cache miss; path=${path}`);
            this.interceptResponseCompletion(path, res);
            next();
          }
        })
        .catch(() => next());
    };
  }

  interceptResponseCompletion(path, res) {
    let send = res.send.bind(res);

    res.send = (body) => {
      let ret = send(body);

      this.cache.put(path, body, res)
        .then(() => {
          this.ui.writeLine(`stored in cache; path=${path}`);
        })
        .catch(() => {
          let truncatedBody = body.replace(/\n/g).substr(0, 200);
          this.ui.writeLine(`error storing cache; path=${path}; body=${truncatedBody}...`);
        });

      res.send = send;

      return ret;
    };
  }
}
