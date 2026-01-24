import EmberApp from './ember-app.js';
import SsrPaths from './utils/ssr-paths.js';

/**
 * EmberSsr renders your Ember.js applications in Node.js. Start by
 * instantiating this class with the path to your compiled Ember app:
 *
 *
 * #### Sandboxing
 *
 * For security and correctness reasons, Ember applications running in EmberSsr
 * are run inside a sandbox that prohibits them from accessing the normal
 * Node.js environment.
 *
 * This sandbox is the built-in `VMSandbox` class, which uses
 * Node's `vm` module. You may add and/or override sandbox variables by
 * passing the `addOrOverrideSandboxGlobals` option.
 *
 * @example
 * import EmberSsr from 'vite-ember-ssr-server/ember-ssr';
 *
 * const app = new EmberSsr({
 *   distPath: 'path/to/dist',
 *   buildSandboxGlobals(globals) {
 *     return Object.assign({}, globals, {
 *       // custom globals
 *     });
 *   },
 * });
 *
 * app.visit('/photos')
 *   .then(result => result.html())
 *   .then(html => res.send(html));
 */
export default class EmberSsr {
  /**
   * Create a new EmberSsr instance.
   *
   * @param {Object} options
   * @param {string} options.distPath the path to the built Ember application
   * @param {Boolean} [options.resilient=false] if true, errors during rendering won't reject the `visit()` promise but instead resolve to a {@link Result}
   * @param {Function} [options.buildSandboxGlobals] a function used to build the final set of global properties setup within the sandbox
   * @param {Number} [options.maxSandboxQueueSize] - maximum sandbox queue size when using buildSandboxPerRequest flag.
   */
  constructor(options = {}) {
    let { buildSandboxGlobals, maxSandboxQueueSize } = options;

    this.resilient = 'resilient' in options ? Boolean(options.resilient) : false;

    this.ssrPaths = new SsrPaths(options.ssrPaths || options);
    this.buildSandboxGlobals = buildSandboxGlobals;
    this.maxSandboxQueueSize = maxSandboxQueueSize;

    this._buildEmberApp(this.ssrPaths, this.buildSandboxGlobals, maxSandboxQueueSize);
  }

  /**
   * Renders the Ember app at a specific URL, returning a promise that resolves
   * to a {@link Result}, giving you access to the rendered HTML as well as
   * metadata about the request such as the HTTP status code.
   *
   * @param {string} path the URL path to render, like `/photos/1`
   * @param {Object} options
   * @param {Boolean} [options.resilient] whether to reject the returned promise if there is an error during rendering. Overrides the instance's `resilient` setting
   * @param {string} [options.html] the HTML document to insert the rendered app into. Uses the built app's index.html by default.
   * @param {Object} [options.metadata] per request meta data that need to be exposed in the app.
   * @param {Boolean} [options.shouldRender] whether the app should do rendering or not. If set to false, it puts the app in routing-only.
   * @param {Boolean} [options.disableShoebox] whether we should send the API data in the shoebox. If set to false, it will not send the API data used for rendering the app on server side in the index.html.
   * @param {int} [options.destroyAppInstanceInMs] whether to destroy the instance in the given number of ms. This is a failure mechanism to not wedge the Node process (See: https://github.com/ember-fastboot/fastboot/issues/90)
   * @returns {Promise<Result>} result
   */
  async visit(path, options = {}) {
    let resilient = 'resilient' in options ? options.resilient : this.resilient;

    let result = await this._app.visit(path, options);

    if (!resilient && result?.error) {
      throw result.error;
    } else {
      return result;
    }
  }

  /**
   * Destroy the existing Ember application instance, and recreate it from the provided dist path.
   * This is commonly done when `dist` has been updated, and you need to prepare to serve requests
   * with the updated assets.
   *
   * @param {Object} options
   * @param {string} options.distPath the path to the built Ember application
   */
  reload({ ssrPaths, distPath }) {
    if (this._app) {
      this._app.destroy();
    }

    this._buildEmberApp(ssrPaths || distPath);
  }

  _buildEmberApp(
    ssrPaths = this.ssrPaths,
    buildSandboxGlobals = this.buildSandboxGlobals,
    maxSandboxQueueSize = this.maxSandboxQueueSize
  ) {
    this.ssrPaths = ssrPaths = SsrPaths.wrap(ssrPaths);
    if (!ssrPaths.hasPath) {
      throw new Error(
        'You must instantiate EmberSsr with a distPath ' +
        'option that contains a path to a dist directory ' +
        'produced by running ember build:ssr in your Ember app:' +
        '\n\n' +
        'new ViteEmberSsrServer({\n' +
        "  distPath: 'path/to/dist'\n" +
        '});'
      );
    }

    this._app = new EmberApp({
      ssrPaths,
      buildSandboxGlobals,
      maxSandboxQueueSize,
    });
  }
}
