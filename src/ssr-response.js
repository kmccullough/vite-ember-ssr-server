import FastBootHeaders from './ssr-headers.js';

export default class SsrResponse {
  constructor(response) {
    this.headers = new FastBootHeaders(
      typeof response.getHeaders === 'function' ? response.getHeaders() : response._headers
    );
    this.statusCode = 200;
  }
}
