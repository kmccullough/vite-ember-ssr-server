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
"vite-ember-ssr-server": "github:st-h/vite-ember-ssr-server#stable"
```

Add this to both your Ember app's `package.json` (build-time, for the Vite plugin) and your `server/package.json` (runtime). Some package managers (e.g. npm in Docker) require the tarball URL format instead:

```bash
"vite-ember-ssr-server": "https://github.com/st-h/vite-ember-ssr-server/archive/stable.tar.gz"
```

### 2. Configure Embroider Compat

`ember-cli-fastboot` provides `content-for` hooks that are incompatible with Embroider. Disable them in `ember-cli-build.js`:

```js
return compatBuild(app, buildOnce, {
  useAddonConfigModule: false,
  useAddonAppBoot: false,
});
```

Also create an empty `_fastboot_` directory in your app root. Embroider's entrypoint builder expects this directory when `ember-cli-fastboot` is installed:

```bash
mkdir _fastboot_
```

### 3. Configure Vite

Add the plugin to your `vite.config.mjs` and configure the SSR build output (note: the `isSsr` flag is read at the top level, not inside the callback):

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
            exports: 'named',
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

### 4. Export `createSsrApp`

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

### 5. Add SSR Placeholders to `index.html`

The SSR server replaces placeholder comments in your `index.html` with the rendered output. Add these where you want the SSR content injected:

```html
<head>
  <!-- VITE_EMBER_SSR_HEAD -->
  <!-- your existing head content -->
</head>
<body>
  <!-- VITE_EMBER_SSR_BODY -->
  <!-- your scripts -->
</body>
```

`<!-- VITE_EMBER_SSR_HEAD -->` is replaced with any `<head>` content set during SSR (meta tags, title, etc.). `<!-- VITE_EMBER_SSR_BODY -->` is replaced with the rendered route HTML, wrapped in boundary markers (`fastboot-body-start` / `fastboot-body-end`).

### 6. Configure Module Whitelist

If your SSR bundle requires Node.js built-in modules (e.g. `crypto` from `@warp-drive`), add them to the `fastboot.moduleWhitelist` in `config/environment.js`:

```js
module.exports = function (environment) {
  const ENV = {
    // ...
    fastboot: {
      moduleWhitelist: ['crypto'],
    },
  };
  // ...
};
```

### 7. Build

```bash
# Client build
vite build

# SSR build
VITE_SSR=true vite build
```

This produces:
- `dist/public/` — client assets (JS, CSS, images)
- `dist/ssr/` — SSR bundle (`app.js`) + FastBoot config

### 8. Write a Server

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

### 9. Run

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

ENV EXPERIMENTAL_RENDER_MODE_SERIALIZE=true
CMD ["node", "--expose-gc", "--max-old-space-size=768", "src/server.js"]
```

Key flags:
- `--expose-gc` — enables `global.gc()` for explicit memory management (see [Memory Management](#memory-management))
- `--max-old-space-size=768` — set the V8 heap limit appropriate for your container
- `EXPERIMENTAL_RENDER_MODE_SERIALIZE=true` — enables Glimmer serialization markers for client-side rehydration (see [Rehydration](#rehydration))

## Memory Management

Each SSR request creates a fresh `vm.Context`, evaluates the CJS bundle, renders the route, and destroys the context. V8 will garbage-collect these contexts naturally. In most cases, you don't need to do anything special.

If you're running in a memory-constrained container and want tighter control, you can optionally trigger explicit GC after each request:

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

This requires running Node with `--expose-gc`. It trades a small amount of per-request latency for more predictable memory usage. Whether this is worthwhile depends on your container size and traffic pattern. Start without it and add it if you see memory pressure.

**Use 2 workers** (`workerCount: 2`) as a starting point. The cluster primary automatically restarts workers that crash.

## Rehydration

By default, the client app re-renders from scratch after the SSR HTML is displayed. With rehydration enabled, the client takes over the existing SSR DOM instead of replacing it, eliminating the flash between SSR content and client render.

Rehydration requires three pieces working together:

### 1. Server: Enable Serialize Mode

Set `EXPERIMENTAL_RENDER_MODE_SERIALIZE=true` on your server process. This tells Ember to render with Glimmer's serialization mode, which inserts marker comments (`%+b:0%`) into the HTML that the client uses to identify rehydratable DOM nodes.

In Docker:
```dockerfile
ENV EXPERIMENTAL_RENDER_MODE_SERIALIZE=true
```

Or when running directly:
```bash
EXPERIMENTAL_RENDER_MODE_SERIALIZE=true node server/src/server.js
```

### 2. Client: Detection Script + ApplicationInstance.reopen

Add two scripts to your `index.html`, after the `<!-- VITE_EMBER_SSR_BODY -->` placeholder and before the main app module:

```html
<!-- VITE_EMBER_SSR_BODY -->

<script>
  // Detect SSR serialization markers before Ember boots.
  // Must be a regular script (not module) to run synchronously.
  (function() {
    var boundary = document.getElementById('fastboot-body-start');
    if (boundary) {
      var next = boundary.nextSibling;
      if (next && next.nodeType === 8 && next.nodeValue === '%+b:0%') {
        window.__REHYDRATE__ = true;
        boundary.remove();
        var end = document.getElementById('fastboot-body-end');
        if (end) end.remove();
      }
    }
  })();
</script>
<script type="module">
  import ApplicationInstance from '@ember/application/instance';
  import Application from './app/app';
  import environment from './app/config/environment';

  // Reopen ApplicationInstance BEFORE Application.create() so that _bootSync
  // uses rehydrate mode from the very first call. Instance initializers can't
  // do this because they run INSIDE _bootSync (too late to patch it).
  if (window.__REHYDRATE__) {
    ApplicationInstance.reopen({
      _bootSync(options) {
        if (options === undefined) {
          options = { _renderMode: 'rehydrate' };
        }
        return this._super(options);
      }
    });
  }

  Application.create(environment.APP);
</script>
```

**Why two scripts?** The detection must be a regular `<script>` (runs synchronously during HTML parsing) to set `window.__REHYDRATE__` before the module script runs. Module scripts are deferred.

**Why `.reopen()` instead of an instance-initializer?** Instance initializers run inside `ApplicationInstance._bootSync()`. By the time they execute, `_bootSync` is already on the call stack, so patching it from an initializer has no effect. The `.reopen()` modifies the class prototype before any instance is created.

### 3. Patch ember-cli-fastboot's Broken Rehydration Script

`ember-cli-fastboot` ships with `vendor/experimental-render-mode-rehydrate.js` which tries to enable rehydration via AMD `require('ember')`. This doesn't work with Embroider/Vite (no AMD modules) and logs a console error. Disable it with a patch.

With pnpm:
```bash
pnpm patch ember-cli-fastboot
# Replace vendor/experimental-render-mode-rehydrate.js with:
# // Disabled: rehydration is handled via ESM imports in index.html.
# // See https://github.com/ember-fastboot/ember-cli-fastboot/issues/938
pnpm patch-commit <path-shown-by-pnpm-patch>
```

`ember-cli-fastboot` also includes a `clear-double-boot` instance-initializer that strips SSR content from the DOM. When rehydration is active, the boundary markers are already removed by the detection script, so `clear-double-boot` becomes a no-op (it guards on `getElementById('fastboot-body-start')` returning null).

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
