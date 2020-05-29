/*
 * Copyright 2020 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

/* eslint-env mocha */

'use strict';

const assert = require('assert');
const stream = require('stream');
const util = require('util');

const isStream = require('is-stream');
const nock = require('nock');
const parseCacheControl = require('parse-cache-control');
const { WritableStreamBuffer } = require('stream-buffers');

const {
  fetch, onPush, offPush, disconnectAll, clearCache, cacheStats, context, TimeoutError, createUrl,
} = require('../src/index.js');

const WOKEUP = 'woke up!';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms, WOKEUP));

describe('Fetch Tests', () => {
  afterEach(async () => {
    // clear client cache
    clearCache();
    // disconnect all sessions
    await disconnectAll();
  });

  it('fetch supports HTTP/1(.1)', async () => {
    const resp = await fetch('http://httpbin.org/status/200');
    assert.equal(resp.status, 200);
    assert.equal(resp.httpVersion, 1);
  });

  it('fetch supports HTTP/2', async () => {
    const resp = await fetch('https://www.nghttp2.org/httpbin/status/200');
    assert.equal(resp.status, 200);
    assert.equal(resp.httpVersion, 2);
  });

  it('fetch supports json response body', async () => {
    const resp = await fetch('https://httpbin.org/json');
    assert.equal(resp.status, 200);
    assert.equal(resp.headers.get('content-type'), 'application/json');
    const json = await resp.json();
    assert(json !== null && typeof json === 'object');
  });

  it('fetch supports binary response body (ArrayBuffer)', async () => {
    const dataLen = 64 * 1024; // httpbin.org/stream-bytes/{n} has a limit of 100kb ...
    const contentType = 'application/octet-stream';
    const resp = await fetch(`https://httpbin.org/stream-bytes/${dataLen}`, {
      headers: { accept: contentType },
    });
    assert.equal(resp.status, 200);
    assert.equal(resp.headers.get('content-type'), contentType);
    const buffer = await resp.arrayBuffer();
    assert(buffer !== null && buffer instanceof ArrayBuffer);
    assert.equal(buffer.byteLength, dataLen);
  });

  it('fetch supports binary response body (Stream)', async () => {
    const dataLen = 64 * 1024; // httpbin.org/stream-bytes/{n} has a limit of 100kb ...
    const contentType = 'application/octet-stream';
    const resp = await fetch(`https://httpbin.org/stream-bytes/${dataLen}`, {
      headers: { accept: contentType },
    });
    assert.equal(resp.status, 200);
    assert.equal(resp.headers.get('content-type'), contentType);
    const imageStream = await resp.readable();
    assert(isStream.readable(imageStream));

    const finished = util.promisify(stream.finished);
    const out = new WritableStreamBuffer();
    imageStream.pipe(out);
    await finished(out);
    assert.equal(out.getContents().length, dataLen);
  });

  it('fetch supports json POST', async () => {
    const method = 'POST';
    const json = { foo: 'bar' };
    const resp = await fetch('https://httpbin.org/post', { method, json });
    assert.equal(resp.status, 200);
    assert.equal(resp.headers.get('content-type'), 'application/json');
    const jsonResponseBody = await resp.json();
    assert(jsonResponseBody !== null && typeof jsonResponseBody === 'object');
    assert.deepEqual(jsonResponseBody.json, json);
  });

  it('fetch sanitizes lowercase method names', async () => {
    const method = 'post';
    const json = { foo: 'bar' };
    const resp = await fetch('https://httpbin.org/post', { method, json });
    assert.equal(resp.status, 200);
    assert.equal(resp.headers.get('content-type'), 'application/json');
    const jsonResponseBody = await resp.json();
    assert(jsonResponseBody !== null && typeof jsonResponseBody === 'object');
    assert.deepEqual(jsonResponseBody.json, json);
  });

  it('fetch rejects on non-string method option', async () => {
    assert.rejects(() => fetch('http://httpbin.org/status/200', { method: true }));
  });

  it('fetch supports caching', async () => {
    const url = 'https://httpbin.org/cache/60'; // -> max-age=2 (seconds)
    // send initial request, priming cache
    let resp = await fetch(url);
    assert.equal(resp.status, 200);

    // re-send request and make sure it's served from cache
    resp = await fetch(url);
    assert.equal(resp.status, 200);
    assert(resp.fromCache);

    // re-send request, this time with network disabled
    nock.disableNetConnect();
    try {
      resp = await fetch(url);
      assert.equal(resp.status, 200);
      assert(resp.fromCache);
    } finally {
      nock.cleanAll();
      nock.enableNetConnect();
    }

    // re-send request, this time with cache disabled via option
    resp = await fetch(url, { cache: 'no-store' });
    assert.equal(resp.status, 200);
    assert(!resp.fromCache);
  });

  it('clearCache works', async () => {
    const url = 'https://httpbin.org/cache/60'; // -> max-age=2 (seconds)
    // send initial request, priming cache
    let resp = await fetch(url);
    assert.equal(resp.status, 200);
    const cc = parseCacheControl(resp.headers.get('cache-control'));
    assert(cc);
    assert.equal(cc['max-age'], 60);

    // re-send request and make sure it's served from cache
    resp = await fetch(url);
    assert.equal(resp.status, 200);
    assert(resp.fromCache);

    // clear client cache
    clearCache();

    const { size, count } = cacheStats();
    assert.equal(size, 0);
    assert.equal(count, 0);

    // re-send request, make sure it's returning a fresh response
    resp = await fetch(url);
    assert.equal(resp.status, 200);
    assert(!resp.fromCache);
  });

  it('cache size limit is configurable', async () => {
    const maxCacheSize = 100 * 1024; // 100kb
    // custom context with cache size limit
    const ctx = context({ maxCacheSize });

    const sizes = [34 * 1024, 35 * 1024, 36 * 1024]; // sizes add up to >100kb
    const urls = sizes.map((size) => `http://httpbin.org/bytes/${size}`);
    // prime cache with multiple requests that together hit the cache size limit of 100kb
    const resps = await Promise.all(urls.map((url) => ctx.fetch(url)));
    assert.equal(resps.filter((resp) => resp.status === 200).length, urls.length);

    const { size, count } = ctx.cacheStats();
    assert(size < maxCacheSize);
    assert.equal(count, urls.length - 1);

    ctx.clearCache();
    await ctx.disconnectAll();
  });

  it('fetch supports max-age directive', async function test() {
    this.timeout(5000);

    // max-age=3 seconds
    const url = 'https://httpbin.org/cache/3';
    // send request
    let resp = await fetch(url);
    assert.equal(resp.status, 200);
    const cc = parseCacheControl(resp.headers.get('cache-control'));
    assert(cc);
    assert.equal(cc['max-age'], 3);
    // wait a second...
    await sleep(1000);
    // re-send request and make sure it's served from cache
    resp = await fetch(url);
    assert.equal(resp.status, 200);
    assert(parseInt(resp.headers.get('age'), 10) > 0);
    assert(resp.fromCache);
    // wait another 2 seconds to make sure max-age expires...
    await sleep(2000);
    // re-send request and make sure it's not served from cache
    resp = await fetch(url);
    assert.equal(resp.status, 200);
    assert(!resp.fromCache);
  });

  it('fetch supports max-age=0', async () => {
    const url = 'https://httpbin.org/cache/0';
    let resp = await fetch(url);
    assert.equal(resp.status, 200);
    const cc = parseCacheControl(resp.headers.get('cache-control'));
    assert.equal(cc['max-age'], 0);
    // re-send request and make sure it's not served from cache
    resp = await fetch(url);
    assert.equal(resp.status, 200);
    assert(!resp.fromCache);
  });

  it('fetch supports no-store directive', async () => {
    // send request with no-store directive
    const resp = await fetch('https://httpbin.org/image/jpeg', { headers: { 'cache-control': 'no-store' } });
    assert.equal(resp.status, 200);
    assert(!resp.fromCache);
  });

  it('buffer() et al work on un-cached response', async () => {
    // send initial request with no-store directive
    let resp = await fetch('https://httpbin.org/image/jpeg', { cache: 'no-store' });
    assert.equal(resp.status, 200);
    // re-send request
    resp = await fetch('https://httpbin.org/image/jpeg', { cache: 'no-store' });
    assert.equal(resp.status, 200);
    // make sure it's not delivered from cache
    assert(!resp.fromCache);

    // buffer()
    const buf = await resp.buffer();
    assert(Buffer.isBuffer(buf));
    const contentLength = resp.headers.raw()['content-length'];
    assert.equal(buf.length, contentLength);
  });

  it('readable() works on un-cached response', async () => {
    const url = 'https://httpbin.org/image/jpeg';
    // send initial request with no-store directive
    let resp = await fetch(url, { cache: 'no-store' });
    assert.equal(resp.status, 200);
    // re-send request
    resp = await fetch(url, { cache: 'no-store' });
    assert.equal(resp.status, 200);
    // make sure it's not delivered from cache
    assert(!resp.fromCache);

    // body
    assert(isStream.readable(await resp.readable()));
  });

  it('text() works on un-cached response', async () => {
    const url = 'https://httpbin.org/get';
    // send initial request with no-store directive
    let resp = await fetch(url, { cache: 'no-store' });
    assert.equal(resp.status, 200);
    // re-send request
    resp = await fetch(url, { cache: 'no-store' });
    assert.equal(resp.status, 200);
    // make sure it's not delivered from cache
    assert(!resp.fromCache);

    // text()
    assert.doesNotReject(() => resp.text());
  });

  it('arrayBuffer() works on un-cached response', async () => {
    const url = 'https://httpbin.org/get';
    // send initial request with no-store directive
    let resp = await fetch(url, { cache: 'no-store' });
    assert.equal(resp.status, 200);
    // re-send request
    resp = await fetch(url, { cache: 'no-store' });
    assert.equal(resp.status, 200);
    const contentLength = resp.headers.raw()['content-length'];
    // make sure it's not delivered from cache
    assert(!resp.fromCache);

    // arrayBuffer()
    const arrBuf = await resp.arrayBuffer();
    assert(arrBuf !== null && arrBuf instanceof ArrayBuffer);
    assert.equal(arrBuf.byteLength, contentLength);
  });

  it('json() works on un-cached response', async () => {
    const url = 'https://httpbin.org/get';
    // send initial request with no-store directive
    let resp = await fetch(url, { cache: 'no-store' });
    assert.equal(resp.status, 200);
    // re-send request
    resp = await fetch(url, { cache: 'no-store' });
    assert.equal(resp.status, 200);
    // make sure it's not delivered from cache
    assert(!resp.fromCache);

    // json()
    assert.equal(resp.headers.raw()['content-type'], 'application/json');
    const json = await resp.json();
    assert.equal(json.url, url);
  });

  it('body accessor methods work on cached response', async () => {
    const url = 'https://httpbin.org/cache/60';
    // send initial request, priming cache
    let resp = await fetch(url);
    assert.equal(resp.status, 200);
    // re-send request, to be delivered from cache
    resp = await fetch(url);
    assert.equal(resp.status, 200);
    // make sure it's delivered from cache
    assert(resp.fromCache);

    const buf = await resp.buffer();
    assert(Buffer.isBuffer(buf));
    const contentLength = resp.headers.raw()['content-length'];
    assert.equal(buf.length, contentLength);

    const arrBuf = await resp.arrayBuffer();
    assert(arrBuf !== null && arrBuf instanceof ArrayBuffer);
    assert.equal(arrBuf.byteLength, contentLength);

    assert(isStream.readable(await resp.readable()));

    assert.equal(resp.headers.raw()['content-type'], 'application/json');
    const json = await resp.json();
    assert.equal(json.url, url);

    assert.deepEqual(JSON.parse(await resp.text()), json);
  });

  it('fetch supports HTTP/2 server push', async function test() {
    this.timeout(5000);

    // returns a promise which resolves with the url of the pushed resource
    const receivedPush = () => new Promise((resolve) => {
      const handler = (url) => {
        offPush(handler);
        resolve(url);
      };
      onPush(handler);
    });

    const [resp, url] = await Promise.all([
      // see https://nghttp2.org/blog/2015/02/10/nghttp2-dot-org-enabled-http2-server-push/
      fetch('https://nghttp2.org'),
      // resolves with either WOKEUP or the url of the pushed resource
      Promise.race([sleep(2000), receivedPush()]),
    ]);
    assert.equal(resp.httpVersion, 2);
    assert.equal(resp.status, 200);
    assert.equal(resp.headers.get('content-type'), 'text/html');
    assert.equal(resp.headers.get('content-length'), (await resp.text()).length);
    assert.notEqual(url, WOKEUP);

    // check cache for pushed resource (stylesheets/screen.css)
    nock.disableNetConnect();
    try {
      const pushedResp = await fetch(url);
      assert.equal(pushedResp.httpVersion, 2);
      assert.equal(pushedResp.status, 200);
      assert(pushedResp.fromCache);
    } finally {
      nock.cleanAll();
      nock.enableNetConnect();
    }
  });

  it('test redundant server push', async function test() {
    this.timeout(5000);

    const receivedPush = () => new Promise((resolve) => onPush(resolve));

    let [resp, result] = await Promise.all([
      // see https://nghttp2.org/blog/2015/02/10/nghttp2-dot-org-enabled-http2-server-push/
      fetch('https://nghttp2.org', { cache: 'no-store' }),
      // resolves with either WOKEUP or the url of the pushed resource
      Promise.race([sleep(3000), receivedPush()]),
    ]);
    assert.equal(resp.httpVersion, 2);
    assert.equal(resp.status, 200);
    assert.notEqual(result, WOKEUP);

    // re-trigger push
    [resp, result] = await Promise.all([
      fetch('https://nghttp2.org', { cache: 'no-store' }),
      Promise.race([sleep(3000), receivedPush()]),
    ]);
    assert.equal(resp.httpVersion, 2);
    assert.equal(resp.status, 200);
    assert.notEqual(result, WOKEUP);
  });

  it('timeout works', async function test() {
    this.timeout(5000);
    const ts0 = Date.now();
    try {
      // the server responds with a 2 second delay, the timeout is set to 1 second.
      await fetch('https://httpbin.org/delay/2', { cache: 'no-store', timeout: 1000 });
      assert.fail();
    } catch (err) {
      assert(err instanceof TimeoutError);
    }
    const ts1 = Date.now();
    assert((ts1 - ts0) < 2000);
  });

  it('createUrl encodes query paramters', async () => {
    const EXPECTED = 'https://httpbin.org/json?helix=42&dummy=true&name=Andr%C3%A9+Citro%C3%ABn&rumple=stiltskin&nephews=Huey&nephews=Louie&nephews=Dewey';
    const qs = {
      helix: 42,
      dummy: true,
      name: 'André Citroën',
      rumple: 'stiltskin',
      nephews: ['Huey', 'Louie', 'Dewey'],
    };
    const ACTUAL = createUrl('https://httpbin.org/json', qs);
    assert.equal(ACTUAL, EXPECTED);
  });

  it('createUrl works without qs object', async () => {
    const EXPECTED = 'https://httpbin.org/json';
    const ACTUAL = createUrl('https://httpbin.org/json');
    assert.equal(ACTUAL, EXPECTED);
  });

  it('createUrl checks arguments types', async () => {
    assert.throws(() => createUrl(true));
    assert.throws(() => createUrl('https://httpbin.org/json', 'abc'));
    assert.throws(() => createUrl('https://httpbin.org/json', 123));
    assert.throws(() => createUrl('https://httpbin.org/json', ['foo', 'bar']));
  });

  it('creating custom fetch context works', async () => {
    const ctx = context();
    const resp = await ctx.fetch('https://httpbin.org/status/200');
    assert.equal(resp.status, 200);
  });

  it('overriding user-agent works', async () => {
    const customUserAgent = 'helix-custom-fetch';
    const ctx = context({
      userAgent: customUserAgent,
      overwriteUserAgent: true,
    });
    const resp = await ctx.fetch('https://httpbin.org/user-agent');
    assert.equal(resp.status, 200);
    assert.equal(resp.headers.get('content-type'), 'application/json');
    const json = await resp.json();
    assert.equal(json['user-agent'], customUserAgent);
    assert(!resp.fromCache);
  });

  it('forcing HTTP/1(.1) works', async function test() {
    this.timeout(5000);
    // endpoint supporting http2 & http1
    const url = 'https://www.nghttp2.org/httpbin/status/200';
    // default context defaults to http2
    let resp = await fetch(url);
    assert.equal(resp.status, 200);
    assert.equal(resp.httpVersion, 2);

    // custom context forces http1
    const ctx = context({
      httpsProtocols: ['http1'],
    });
    resp = await ctx.fetch(url);
    assert.equal(resp.status, 200);
    assert.equal(resp.httpVersion, 1);
  });

  it('test for issue #41', async () => {
    const resp = await fetch('https://httpbin.org/put', {
      method: 'PUT',
      body: JSON.stringify({ foo: 'bar' }),
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
      },
    });
    assert.equal(resp.status, 200);
    assert.equal(resp.headers.raw()['content-type'], 'application/json');
    const json = await resp.json();
    assert(json !== null && typeof json === 'object');
  });

  it('redirects work (HTTP/2)', async () => {
    const resp = await fetch('https://nghttp2.org/httpbin/absolute-redirect/3', { redirect: 'follow' });
    assert.equal(resp.status, 200);
    assert.equal(resp.httpVersion, 2);
    assert.equal(resp.redirected, true);
  });
});
