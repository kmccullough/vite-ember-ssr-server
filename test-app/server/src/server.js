import ViteEmberSsrServer from 'vite-ember-ssr-server';

const server = new ViteEmberSsrServer({
  ssrPath: process.env.SSR_PATH || '../../dist/ssr',
  clientPath: process.env.CLIENT_PATH || '../../dist/public',
  host: '0.0.0.0',
  port: process.env.PORT || 4000,
  workerCount: 1,

  buildSandboxGlobals(defaultGlobals) {
    return {
      ...defaultGlobals,
      fetch,
      AbortController,
      Headers,
      Request,
      Response,
      ReadableStream,
    };
  },

  beforeMiddleware(app) {
    app.use((req, res, next) => {
      if (req.url === '/health') {
        return res.status(200).send('ok');
      }
      next();
    });
  },
});

server.start();
