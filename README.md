# vite-ember-ssr-server

SSR (server-side rendering) for Ember apps built with [Embroider](https://github.com/embroider-build/embroider) + [Vite](https://vite.dev). A production-ready replacement for [fastboot-app-server](https://www.npmjs.com/package/fastboot-app-server).

Built on Express with Node.js cluster mode for multi-worker serving. Each SSR request runs your Ember app in an isolated `vm.Context` sandbox, renders the route, and returns the HTML.

## Why This Fork?

The [original project](https://github.com/kmccullough/vite-ember-ssr-server) used `vm.SourceTextModule` (ESM) to evaluate the SSR bundle. This causes a memory leak in Node.js — `SourceTextModule` creates retention chains through Node.js's timer infrastructure (`timerListMap`) that prevent V8 from ever GCing per-request contexts. Memory grows with every request until the process is killed.

This fork replaces `vm.SourceTextModule` with `vm.Script` (CJS), which allows full GC of per-request contexts. The tradeoff is that your SSR bundle must be built as CJS (see [Vite Configuration](#vite-configuration)).

## Quick Start

### 1. Install

Not published to npm. Install from GitHub:

```bash
# In your Ember app's package.json (build-time dependency)
"vite-ember-ssr-server": "github:st-h/vite-ember-ssr-server#stable"

# In your server's package.json (runtime dependency)
"vite-ember-ssr-server": "https://github.com/st-h/vite-ember-ssr-server/archive/stable.tar.gz"
```

### 2. Configure Vite

Add the plugin to your `vite.config.mjs` and configure the SSR build output:

```js
import { viteEmberSsrServerPlugin } from 'vite-ember-ssr-server/vite-plugin.mjs';

export default defineConfig(() => {
  const isSsr = !!process.env.VITE_SSR;

  return {
    build: {
      outDir: isSsr ? 'dist/ssr' : 'dist/public',
      ...(isSsr ? { ssr: 'app/app.ts' } : {}),
      rollupOptions: {
        output: {
          ...(isSsr ? {
            format: 'cjs',
            inlineDynamicImports: true,
          } : {}),
        },
      },
    },
    ssr: {
      noExternal: true,
    },
    plugins: [
      // ... your other plugins
      viteEmberSsrServerPlugin(),
    ],
  };
});
```

### 3. Export `createSsrApp`

Your Ember app entry point (`app/app.ts` or `app/app.js`) must export a `createSsrApp` function:

```ts
import Application from '@ember/application';
import config from 'my-app/config/environment';

export function createSsrApp() {
  return Application.create({
    ...config.APP,
    modulePrefix: config.modulePrefix,
  });
}
```

### 4. Build

```bash
# Client build
vite build

# SSR build
VITE_SSR=true vite build
```

This produces:
- `dist/public/` — client assets (JS, CSS, images)
- `dist/ssr/` — SSR bundle (`app.js`) + FastBoot config

### 5. Write a Server

Create a `server/src/server.js`:

```js
import ViteEmberSsrServer from 'vite-ember-ssr-server';

const server = new ViteEmberSsrServer({
  ssrPath: process.env.SSR_PATH || './dist/ssr',
  clientPath: process.env.CLIENT_PATH || './dist/public',
  host: '0.0.0.0',
  port: process.env.PORT || 4000,
  workerCount: 2,

  buildSandboxGlobals(defaultGlobals) {
    return {
      ...defaultGlobals,
      // Add any globals your Ember app needs at runtime
      fetch,
      AbortController,
      Headers,
      Request,
      Response,
      ReadableStream,
      BACKEND_URI: process.env.BACKEND_URI,
    };
  },

  beforeMiddleware(app) {
    // Health check endpoint (useful for load balancers)
    app.use((req, res, next) => {
      if (req.url === '/health') {
        return res.status(200).send('ok');
      }
      next();
    });
  },
});

server.start();
```

With a `server/package.json`:

```json
{
  "type": "module",
  "main": "./src/server.js",
  "dependencies": {
    "vite-ember-ssr-server": "https://github.com/st-h/vite-ember-ssr-server/archive/stable.tar.gz"
  }
}
```

### 6. Run

```bash
cd server && npm install && node src/server.js
```

## Docker Deployment

```dockerfile
FROM node:22-alpine

WORKDIR /app

# Copy built Ember app (client + SSR bundles)
COPY dist/public ./dist/public
COPY dist/ssr ./dist/ssr

# Copy server code and install dependencies
COPY server/package.json ./server/
WORKDIR /app/server
RUN npm install --omit=dev

COPY server/src ./src

USER node
EXPOSE 4000

CMD ["node", "--expose-gc", "--max-old-space-size=768", "src/server.js"]
```

Key flags:
- `--expose-gc` — enables `global.gc()` for explicit memory management (see [Memory Management](#memory-management))
- `--max-old-space-size=768` — set the V8 heap limit appropriate for your container

## Memory Management

Each SSR request creates a fresh `vm.Context`, evaluates the CJS bundle, renders the route, and destroys the context. To ensure prompt cleanup:

**Trigger GC after each request** in your server's `beforeMiddleware`:

```js
beforeMiddleware(app) {
  app.use((req, res, next) => {
    res.on('finish', () => {
      if (global.gc) global.gc();
    });
    next();
  });
},
```

Without explicit GC, V8 defers collection and heap grows until the next natural GC cycle. With it, memory stays flat at ~20-25% of a 768MB heap under load.

**Run with `--expose-gc`** to make `global.gc()` available.

**Use 2 workers** (`workerCount: 2`) as a starting point. The cluster primary automatically restarts workers that crash.

## Server Options

| Option | Env Var | Default | Description |
|---|---|---|---|
| `ssrPath` | `SSR_PATH` | — | Path to the SSR build output (`dist/ssr`) |
| `clientPath` | `CLIENT_PATH` | — | Path to the client build output (`dist/public`) |
| `distPath` | `SSR_DIST_PATH` | — | Combined dist path (if client + SSR are in the same directory) |
| `host` | `SERVER_HOST` | `localhost` | Server bind address |
| `port` | `SERVER_PORT` | `4200` | Server port |
| `workerCount` | — | `os.cpus().length` | Number of cluster workers |
| `buildSandboxGlobals` | — | identity | Function to customize sandbox globals |
| `beforeMiddleware` | — | — | Express middleware added before SSR handler |
| `afterMiddleware` | — | — | Express middleware added after SSR handler |
| `resilient` | — | `false` | If true, render errors resolve instead of rejecting |
| `chunkedResponse` | — | `true` | Use chunked transfer encoding |
| `username` / `password` | — | — | Basic auth credentials |

## Vite Plugin

The `viteEmberSsrServerPlugin()` writes FastBoot configuration (app name, scripts, config) into your SSR build output. It runs automatically during `vite build` when `VITE_SSR=true`.

During dev (`vite serve`), it watches `config/environment.js` and regenerates the config on changes.

## Sandbox Globals

The SSR sandbox is an isolated `vm.Context`. Your Ember app can only access globals that are explicitly provided. The server provides sensible defaults:

- `console`, `setTimeout`, `clearTimeout`, `setInterval`, `clearInterval`
- `URL`, `HTMLElement`, `AbortController`, `structuredClone`
- `document`, `window`, `self`, `navigator`
- `process` (limited to `{ env }`)
- `module`, `exports`, `require`
- `Ssr` / `FastBoot` (config and `distPath` accessor)

Use `buildSandboxGlobals` to add more:

```js
buildSandboxGlobals(defaultGlobals) {
  return {
    ...defaultGlobals,
    fetch,                    // network access
    Headers, Request, Response, // Fetch API types
    MY_CONFIG: process.env.MY_CONFIG,
  };
}
```

## How It Works

1. **Boot**: Scripts are read from disk and compiled into `vm.Script` objects (once, at startup)
2. **Per request**: A fresh `vm.Context` is created with isolated globals (document, window, etc.)
3. **Evaluate**: The pre-compiled scripts run in the context via `script.runInContext(context)`
4. **Render**: The Ember `Application` is created, booted, and visits the requested route
5. **Respond**: The rendered HTML is extracted from the sandbox document and sent to the client
6. **Cleanup**: The `Application` is destroyed, the context becomes eligible for GC

The `vm.Script` approach compiles once and evaluates per request. This is slightly slower than a shared-Application model (~100ms overhead for a ~3MB bundle) but ensures complete isolation between requests.

### Why CJS instead of ESM?

Node.js's `vm.SourceTextModule` (the ESM equivalent of `vm.Script`) creates retention chains through internal timer infrastructure that prevent garbage collection of per-request contexts. This causes memory to grow unboundedly — confirmed in production where `vm.SourceTextModule` held at 60%+ memory (rising to OOM), while `vm.Script` stays flat at 20-25%.

This is a Node.js-level issue, not an Ember issue. Until Node.js resolves the `vm.SourceTextModule` memory characteristics, CJS is the only viable approach for per-request sandboxed SSR.

## Requirements

- Node.js 20+
- Ember with Embroider + Vite build pipeline
- `ember-cli-fastboot` for the FastBoot service (shoebox, request/response access)
- SSR bundle built as CJS (`format: 'cjs'` in Vite config)

## Credits

Based on [vite-ember-ssr-server](https://github.com/kmccullough/vite-ember-ssr-server) by Kerry McCullough.

## License

MIT
