import cookie from 'cookie';
import FastBootHeaders from './ssr-headers.js';
import { deserializeRegExp, matchesSerializedRegExp } from './regexp.js';

export default class SsrRequest {
  constructor(request, hostWhitelist) {
    this.hostWhitelist = hostWhitelist;

    this.protocol = `${request.protocol}:`;
    this.headers = new FastBootHeaders(request.headers);
    this.queryParams = request.query;
    this.path = request.url;
    this.method = request.method;
    this.body = request.body;

    this.cookies = this.extractCookies(request);
  }

  host() {
    if (!this.hostWhitelist) {
      throw new Error('You must provide a hostWhitelist to retrieve the host');
    }

    const host = this.headers.get('host');
    const matchFound = this.hostWhitelist.some(entry => {
      if (matchesSerializedRegExp(entry)) {
        return deserializeRegExp(entry).test(host);
      } else {
        return entry === host;
      }
    });

    if (!matchFound) {
      throw new Error(`The host header did not match a hostWhitelist entry. Host header: ${host}`);
    }

    return host;
  }

  extractCookies(request) {
    // If cookie-parser middleware has already parsed the cookies,
    // just use that.
    if (request.cookies) {
      return request.cookies;
    }

    // Otherwise, try to parse the cookies ourselves, if they exist.
    const cookies = request.headers.cookie;
    if (cookies) {
      return cookie.parse(cookies);
    }

    // Return an empty object instead of undefined if no cookies are present.
    return {};
  }
}
