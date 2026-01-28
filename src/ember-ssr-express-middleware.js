import chalk from 'chalk';
import mime from 'mime';

import EmberSsr from './ember-ssr.js';

export default function emberSsrExpressMiddleware(options = {}) {
  let log = options.log !== false ? _log : function() {};

  let emberSsr = options.emberSsr;

  if (!emberSsr) {
    emberSsr = new EmberSsr({
      clientPath: options.clientPath,
      ssrPath: options.ssrPath,
      resilient: options.resilient,
    });
  }

  return async function(req, res, next) {
    const path = req.url;

    try {
      const visitOptions = Object.assign({}, options.visitOptions, {
        request: req, response: res,
      });
      const result = await emberSsr.visit(path, visitOptions);
      if (!result) {
        const html = emberSsr._app.html || emberSsr.html || options.visitOptions?.html;
        return html ? res.type('text/html').send(html) : res.status(500);
      }
      let body = options.chunkedResponse
        ? await result.chunks() : await result.html();

      if (result.error) {
        log('RESILIENT MODE CAUGHT:', result.error.stack);
        next(result.error);
      }

      let headers = result.headers;
      let statusMessage = result.error ? 'NOT OK ' : 'OK ';

      for (const pair of headers.entries()) {
        res.append(pair[0], pair[1]);
      }

      log(result.statusCode, statusMessage + path);
      res.status(result.statusCode);

      if (typeof body === 'string') {
        res.type('text/html').send(body);
      } else if (result.error) {
        res.type('text/html').send(body[0]);
      } else {
        res.type('text/html');
        body.forEach(chunk => res.write(chunk));
        res.end();
      }
    } catch (error) {
      if (error.name === 'UnrecognizedURLError') {
        next();
      } else {
        res.status(500);
        next(error);
      }
    }
  };
}

function _log(statusCode, message, startTime) {
  let color = statusCode === 200 ? 'green' : 'red';
  let now = new Date();

  if (startTime) {
    let diff = Date.now() - startTime;
    message = message + chalk.blue(' ' + diff + 'ms');
  }

  console.log(chalk.blue(now.toISOString()) + ' ' + chalk[color](statusCode) + ' ' + message);
}
