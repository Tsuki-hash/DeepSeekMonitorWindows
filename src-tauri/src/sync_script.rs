//! 登录窗口注入脚本：从平台请求的 Authorization 头抓取 Bearer，经 IPC 回传。

/// 注入到 `login-sync` 的 initialization script。
pub const USAGE_SYNC_POLL_JS: &str = r#"
    (function() {
      if (location.host !== 'platform.deepseek.com') return;
      if (window.__dsm_token_hook__) {
        // Finished-load injection must not wrap twice or discard a pending queue.
        if (typeof window.__dsm_token_hook__.resume === 'function') {
          window.__dsm_token_hook__.resume();
        }
        return;
      }
      var stopped = false;
      var pending = false;
      var activeToken = '';
      var waiting = [];
      var pumpScheduled = false;
      // At most one active and two waiting strings, each <= 16 Ki characters.
      // Keep the oldest waiting candidate and replace only the newest slot.
      var maxTokenChars = 16 * 1024;
      var origFetch = window.fetch;
      var xhrPrototype = typeof XMLHttpRequest !== 'undefined' && XMLHttpRequest.prototype;
      var origSet = xhrPrototype && xhrPrototype.setRequestHeader;
      var wrappedFetch;
      var wrappedSet;

      function stop() {
        stopped = true;
        pending = false;
        activeToken = '';
        waiting.length = 0;
        try {
          if (window.fetch === wrappedFetch) window.fetch = origFetch;
        } catch (e) {}
        try {
          if (xhrPrototype && xhrPrototype.setRequestHeader === wrappedSet) {
            xhrPrototype.setRequestHeader = origSet;
          }
        } catch (e) {}
        try { window.removeEventListener('pagehide', stop); } catch (e) {}
        try { window.removeEventListener('unload', stop); } catch (e) {}
      }

      function revoked(error) {
        // These are the backend's terminal generation/lifetime rejections, not
        // an authentication or transient validation failure for one candidate.
        var message = typeof error === 'string' ? error : error && error.message;
        return message === '同步已取消' || message === '同步已取消或已被新的操作替代';
      }

      function failed(error) {
        if (stopped) return;
        pending = false;
        activeToken = '';
        try {
          if (revoked(error)) {
            stop();
            return;
          }
        } catch (e) {}
        // Never requeue the failed candidate. Defer even synchronous bridge
        // failures so advancing the bounded queue cannot recurse on this stack.
        if (waiting.length && !pumpScheduled) {
          pumpScheduled = true;
          Promise.resolve().then(function() {
            pumpScheduled = false;
            drain();
          });
        }
      }

      function invokeToken(core, token) {
        // 校验月份由后端的东八区探针月统一决定，页面无需传递本地时间。
        // Keep the existing backend generation substitution at this IPC boundary.
        return core.invoke('usage_token_captured', { token: token });
      }

      function drain() {
        if (stopped || pending || !waiting.length) return;
        var core;
        // An unavailable bridge leaves the bounded queue for the next header
        // or finished-load injection. Do not spin on an accessor that throws.
        try {
          core = window.__TAURI__ && window.__TAURI__.core;
          if (!core || typeof core.invoke !== 'function') return;
        } catch (e) { return; }
        try {
          activeToken = waiting.shift();
          pending = true;
          var result = invokeToken(core, activeToken);
          // Only an acknowledged async IPC can complete this hook. A missing
          // or malformed bridge result must not permanently set done/pending.
          if (!result || typeof result.then !== 'function') {
            failed();
            return;
          }
          Promise.resolve(result).then(stop, failed);
        } catch (e) {
          failed(e);
        }
      }

      function deliver(token) {
        if (stopped) return;
        if (!token || typeof token !== 'string') return;
        token = token.trim();
        if (token.length < 20 || token.length > maxTokenChars) return;
        if (token !== activeToken && waiting.indexOf(token) === -1) {
          if (waiting.length < 2) waiting.push(token);
          else waiting[1] = token;
        }
        drain();
      }

      function fromAuth(value) {
        if (!value) return;
        var m = /Bearer\s+(\S+)/i.exec(String(value));
        if (m && m[1]) deliver(m[1]);
      }

      // The public marker contains controls only, never credentials. Keeping it
      // after stop prevents a late reinjection from reviving this document.
      window.__dsm_token_hook__ = { resume: drain };
      window.addEventListener('pagehide', stop);
      window.addEventListener('unload', stop);

      if (typeof origFetch === 'function') {
        wrappedFetch = function(input, init) {
          try {
            var headers = (init && init.headers) || (input && input.headers);
            if (headers) {
              if (typeof Headers !== 'undefined' && headers instanceof Headers) {
                fromAuth(headers.get('authorization'));
              } else if (Array.isArray(headers)) {
                for (var i = 0; i < headers.length; i++) {
                  if (headers[i] && String(headers[i][0]).toLowerCase() === 'authorization') {
                    fromAuth(headers[i][1]);
                  }
                }
              } else if (typeof headers === 'object') {
                for (var k in headers) {
                  if (k.toLowerCase() === 'authorization') fromAuth(headers[k]);
                }
              }
            }
          } catch (e) {}
          return origFetch.apply(this, arguments);
        };
        window.fetch = wrappedFetch;
      }

      if (typeof origSet === 'function') {
        wrappedSet = function(name, value) {
          try {
            if (name && String(name).toLowerCase() === 'authorization') fromAuth(value);
          } catch (e) {}
          return origSet.apply(this, arguments);
        };
        xhrPrototype.setRequestHeader = wrappedSet;
      }
    })();
    "#;
