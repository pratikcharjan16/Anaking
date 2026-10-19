/* Same-origin staff fetches carry the session CSRF token. No tokens go to providers. */
(function () {
  var original = window.fetch;
  window.fetch = function (input, init) {
    var url = new URL(typeof input === 'string' ? input : input.url, location.href);
    var method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();
    if (url.origin === location.origin && !['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      init = Object.assign({}, init);
      var headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
      var token = document.querySelector('meta[name="csrf-token"]');
      if (token) headers.set('X-CSRF-Token', token.content);
      init.headers = headers;
    }
    return original.call(window, input, init);
  };
})();
