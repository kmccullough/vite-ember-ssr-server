export default class SsrPaths {
  static from(ssrPaths) {
    let options = null;
    if (ssrPaths) {
      if (typeof ssrPaths === 'string') {
        options = { distPath: ssrPaths };
      } else if (typeof ssrPaths === 'object') {
        options = ssrPaths;
      }
    }
    return new SsrPaths(options);
  }

  static wrap(ssrPaths) {
    return ssrPaths instanceof SsrPaths ? ssrPaths : SsrPaths.from(ssrPaths);
  }

  constructor(options) {
    this.setPaths(options);
  }

  setPaths({ distPath, clientPath, ssrPath } = {}) {
    this.distPath = distPath;
    this.clientPath = clientPath || distPath || ssrPath;
    this.ssrPath = ssrPath || distPath || clientPath;
    this.hasPath = !!(distPath || clientPath || ssrPath);
  }
}
