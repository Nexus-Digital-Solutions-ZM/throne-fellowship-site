/**
 * admin/nexus-gateway-backend.js
 *
 * Custom Decap CMS backend that talks to the Nexus CMS Gateway instead of
 * GitHub directly (replacing the previous `name: github` OAuth backend in
 * config.yml). Registered as CMS.registerBackend("nexus-gateway", ...).
 *
 * Auth model (see Gateway's lib/auth.ts / cms-guard.ts / handoff-exchange
 * route): this page never logs in on its own. An editor signs in at the
 * Gateway (/login), or a Nexus admin clicks "Edit this site" in the
 * Gateway's /admin dashboard; either way the Gateway redirects here with
 * a one-time token in the URL FRAGMENT:
 *   https://throneoffamiliesandnations.org/admin/#nexus_handoff=<jwt>
 *
 * admin/index.html captures that fragment BEFORE Decap boots (into
 * window.__NEXUS_HANDOFF__) and clears it from the URL, so Decap's hash
 * router starts on a clean "#/" and never tries to route to
 * "#/nexus_handoff=..." (which rendered "Not Found"). This file then
 * exchanges the token via POST /handoff-exchange for a real session
 * token and holds it in sessionStorage, so a page refresh keeps the
 * editor signed in but closing the tab (or the whole browser) signs
 * them out — never localStorage, never a cookie. Never sent anywhere
 * except as the Authorization: Bearer header on Gateway API calls.
 * sessionStorage is per-tab by design, so a second tab does not inherit
 * the session; the editor signs in there independently.
 *
 * Error handling: when there is no usable session (opened without a
 * handoff link, link expired/already used, session timed out, signed out,
 * or the Gateway is unreachable) this file shows ONE full-page panel with a
 * "Sign in" button instead of Decap's blank page and a pile of identical
 * red toasts. Every Gateway call made while the session is dead stays
 * pending (so Decap raises no toast per collection) and the panel is the
 * only thing the person sees. Other failures (save failed, file too large,
 * server error) still surface as a single normal Decap toast, with a
 * plain-English message.
 *
 * Decap 3.19 interface notes (learned the hard way, from runtime errors):
 *   - authComponent() must exist and return a component function.
 *   - config/collection objects are plain objects, not Immutable Maps.
 *   - entriesByFolder(folder: string, extension, depth) gets the folder
 *     path string directly.
 *   - entriesByFiles(files) gets an array of { path, label } — the key
 *     is `path`, NOT `file`.
 *   - Media library cards render thumbnails from `displayURL`.
 */
(function () {
  "use strict";

  // ---------------------------------------------------------------------
  // Config
  // ---------------------------------------------------------------------
  var GATEWAY_BASE_URL = "https://nexus-cms-gateway.nexus-digital-solutions.workers.dev";

  // Throne of Families and Nations' real `clients.id` (a cuid) from the Gateway DB.
  var GATEWAY_CLIENT_ID = "cmuksi5m70001psp7u5vj5dls";

  if (!GATEWAY_CLIENT_ID || GATEWAY_CLIENT_ID.indexOf("REPLACE_WITH") === 0) {
    throw new Error(
      "[nexus-gateway-backend] GATEWAY_CLIENT_ID is still the placeholder \u2014 " +
        "set it to this site's real client id from the Gateway's /admin/<clientId> URL " +
        "before this backend can talk to the Gateway."
    );
  }

  var API_BASE = GATEWAY_BASE_URL + "/api/cms/" + GATEWAY_CLIENT_ID;

  // ---------------------------------------------------------------------
  // Session token, held in sessionStorage rather than a plain closure
  // variable so a page refresh keeps the editor signed in, but closing
  // the tab (or the whole browser) signs them out — the same lifetime a
  // normal in-memory variable has, extended across one reload. NOT
  // localStorage: that would outlive the tab and the browser restart.
  // NOT a cookie: the cookie the Gateway sets on its own domain is not
  // readable from a client site's origin anyway (see file doc comment).
  // ---------------------------------------------------------------------
  var SESSION_STORAGE_KEY = "nexus_session_token";

  function readStoredToken() {
    try {
      return window.sessionStorage.getItem(SESSION_STORAGE_KEY);
    } catch (e) {
      // sessionStorage can throw in some privacy modes; fall back to memory.
      return null;
    }
  }

  function writeStoredToken(token) {
    try {
      if (token) window.sessionStorage.setItem(SESSION_STORAGE_KEY, token);
      else window.sessionStorage.removeItem(SESSION_STORAGE_KEY);
    } catch (e) {
      /* memory-only is fine; the tab keeps working until it closes */
    }
  }

  var sessionToken = readStoredToken();

  var exchangePromise = null;
  // The first failed handoff exchange is remembered and re-thrown, so every
  // later call reports the REAL cause (CORS/network/expired/already used)
  // instead of the misleading "No Nexus handoff token found" that the
  // second attempt would otherwise produce once the fragment is consumed.
  var exchangeError = null;
  var panelShown = false;

  // ---------------------------------------------------------------------
  // "No usable session" panel
  // ---------------------------------------------------------------------

  var PANEL_COPY = {
    signin: {
      title: "Sign in to edit this site",
      body:
        "This editor opens from a secure sign-in. Sign in with your email and we’ll send you a link that brings you straight back here.",
    },
    signedout: {
      title: "You’re signed out",
      body: "Sign in again whenever you’re ready to keep editing.",
    },
    expired: {
      title: "Your session has ended",
      body:
        "Your sign-in link has expired or was already used, or your session timed out. Sign in again to get back to editing.",
    },
    network: {
      title: "Can’t reach the editing service",
      body: "Check your internet connection, then sign in again.",
    },
    paused: {
      title: "Editing is paused for this account",
      body:
        "The Nexus team has paused access for this client. Your content is safe \u2014 contact the Nexus team to have editing restored.",
    },
  };

  /** Error that means "there is no usable session"; carries which panel to show. */
  function sessionError(kind, message) {
    var err = new Error(message);
    err.nexusKind = kind;
    return err;
  }

  function showPanel(kind, detail) {
    if (panelShown) return;
    panelShown = true;
    var copy = PANEL_COPY[kind] || PANEL_COPY.signin;

    function build() {
      var root = document.createElement("div");
      root.setAttribute("role", "alertdialog");
      root.setAttribute("aria-modal", "true");
      root.setAttribute("aria-labelledby", "nexus-panel-title");
      root.setAttribute("aria-describedby", "nexus-panel-body");
      root.style.cssText =
        "position:fixed;top:0;right:0;bottom:0;left:0;z-index:2147483647;display:flex;" +
        "align-items:center;justify-content:center;padding:24px;background:#f4f5f7;" +
        "font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:#1f2937;";

      var card = document.createElement("div");
      card.style.cssText =
        "max-width:420px;width:100%;background:#fff;border:1px solid #e5e7eb;border-radius:12px;" +
        "padding:28px 24px;box-shadow:0 4px 24px rgba(0,0,0,.08);text-align:center;";

      var title = document.createElement("h1");
      title.id = "nexus-panel-title";
      title.textContent = copy.title;
      title.style.cssText = "margin:0 0 10px;font-size:20px;font-weight:600;line-height:1.3;";

      var body = document.createElement("p");
      body.id = "nexus-panel-body";
      body.textContent = copy.body;
      body.style.cssText = "margin:0 0 22px;font-size:15px;line-height:1.5;color:#4b5563;";

      var button = document.createElement("a");
      button.href = GATEWAY_BASE_URL + "/login";
      button.textContent = "Sign in";
      button.style.cssText =
        "display:inline-block;background:#1f2937;color:#fff;text-decoration:none;font-size:15px;" +
        "font-weight:500;padding:11px 26px;border-radius:8px;";

      card.appendChild(title);
      card.appendChild(body);
      card.appendChild(button);

      if (detail && (kind === "expired" || kind === "network")) {
        var small = document.createElement("p");
        small.textContent = "Details: " + detail;
        small.style.cssText = "margin:20px 0 0;font-size:12px;line-height:1.4;color:#9ca3af;word-break:break-word;";
        card.appendChild(small);
      }

      root.appendChild(card);
      document.body.appendChild(root);
      try {
        button.focus();
      } catch (e) {
        /* focus is a nicety only */
      }
    }

    if (document.body) build();
    else document.addEventListener("DOMContentLoaded", build);
  }

  /**
   * Session failures show the panel and then stay pending forever, so Decap
   * never raises a toast (let alone one per collection). Anything else is a
   * normal error and is re-thrown for Decap to report once.
   */
  function handleSessionFailure(err) {
    if (err && err.nexusKind) {
      showPanel(err.nexusKind, err.message);
      return new Promise(function () {});
    }
    throw err;
  }

  // ---------------------------------------------------------------------
  // Session exchange
  // ---------------------------------------------------------------------

  function readHandoffFragment() {
    // Preferred path: admin/index.html already captured the token before
    // Decap booted and cleared the URL.
    if (window.__NEXUS_HANDOFF__) {
      var early = window.__NEXUS_HANDOFF__;
      window.__NEXUS_HANDOFF__ = null;
      return early;
    }

    // Fallback: the fragment is still in the URL (e.g. index.html was not
    // updated). Read it and strip it from the address bar.
    var hash = window.location.hash || "";
    var match = /(?:^|[#&])\/?nexus_handoff=([^&]+)/.exec(hash);
    if (!match) return null;
    var cleanUrl = window.location.pathname + window.location.search;
    window.history.replaceState(null, "", cleanUrl);
    return decodeURIComponent(match[1]);
  }

  function exchangeHandoffToken(handoffToken) {
    return fetch(API_BASE + "/handoff-exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: handoffToken }),
    })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          if (!res.ok) {
            if (res.status === 403 && data && data.code === "ACCESS_PAUSED") {
              throw sessionError("paused", data.error || "Access paused by the Nexus team.");
            }
            throw sessionError(
              "expired",
              (data && data.error) || "handoff exchange failed (" + res.status + ")"
            );
          }
          return data;
        });
      })
      .then(function (data) {
        sessionToken = data.token;
        writeStoredToken(sessionToken);
        return sessionToken;
      });
  }

  /**
   * Ensures we have a session token, exchanging the handoff token the
   * first time this is called. Safe to call repeatedly — subsequent
   * calls reuse the same in-flight/completed exchange.
   */
  function ensureSession() {
    if (sessionToken) return Promise.resolve(sessionToken);
    if (exchangeError) return Promise.reject(exchangeError);
    if (exchangePromise) return exchangePromise;

    var handoff = readHandoffFragment();
    if (!handoff) {
      return Promise.reject(
        sessionError("signin", "No Nexus handoff token found.")
      );
    }
    exchangePromise = exchangeHandoffToken(handoff)
      .catch(function (err) {
        if (err instanceof TypeError) {
          // fetch() rejects with a TypeError for network failures AND for
          // CORS blocks; the browser hides which. Say both.
          err = sessionError(
            "network",
            "Could not reach the Nexus Gateway (network problem, or the request was blocked by CORS — " +
              "check this site's website_url on the Gateway matches " +
              window.location.origin +
              " exactly)."
          );
        }
        exchangeError = err;
        throw err;
      })
      .finally(function () {
        exchangePromise = null;
      });
    return exchangePromise;
  }

  function authedFetch(path, options) {
    options = options || {};
    return ensureSession()
      .then(function (token) {
        var headers = Object.assign({}, options.headers, {
          Authorization: "Bearer " + token,
        });
        if (options.body && !headers["Content-Type"]) {
          headers["Content-Type"] = "application/json";
        }
        return fetch(API_BASE + path, Object.assign({}, options, { headers: headers })).then(
          function (res) {
            if (res.status === 401) {
              // Session expired or was revoked mid-use.
              sessionToken = null;
              writeStoredToken(null);
              exchangeError = sessionError("expired", "session no longer valid (401)");
              throw exchangeError;
            }
            if (res.status === 403) {
              // Non-destructive peek: the caller still needs the body if
              // this turns out NOT to be a pause.
              return res
                .clone()
                .json()
                .catch(function () {
                  return {};
                })
                .then(function (data) {
                  if (data && data.code === "ACCESS_PAUSED") {
                    sessionToken = null;
                    writeStoredToken(null);
                    exchangeError = sessionError(
                      "paused",
                      data.error || "Access paused by the Nexus team."
                    );
                    throw exchangeError;
                  }
                  return res;
                });
            }
            return res;
          },
          function (err) {
            if (err instanceof TypeError) {
              throw new Error("Network problem. Check your connection and try again.");
            }
            throw err;
          }
        );
      })
      .catch(handleSessionFailure);
  }

  function friendlyError(status, serverMessage, path) {
    if (status === 403) return "You don’t have permission to do that.";
    if (status === 413) return "That file is too large to upload.";
    if (status === 429) return "Too many requests. Wait a moment and try again.";
    if (status >= 500) return "The editing service had a problem. Try again in a moment.";
    if (typeof serverMessage === "string" && serverMessage) return serverMessage;
    return "Request failed (" + status + ") for " + path;
  }

  function authedJson(path, options) {
    return authedFetch(path, options).then(function (res) {
      return res
        .json()
        .catch(function () {
          return {};
        })
        .then(function (data) {
          if (!res.ok) {
            throw new Error(friendlyError(res.status, data && data.error, path));
          }
          return data;
        });
    });
  }

  // ---------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------

  function guessMimeType(path) {
    var ext = (path.split(".").pop() || "").toLowerCase();
    var map = {
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      png: "image/png",
      gif: "image/gif",
      webp: "image/webp",
      svg: "image/svg+xml",
      pdf: "application/pdf",
    };
    return map[ext] || "application/octet-stream";
  }

  /**
   * Reads a key from either a plain object or an Immutable-style Map, so
   * this backend doesn't care which convention a given Decap version uses.
   */
  function cfgGet(obj, key, fallback) {
    if (obj == null) return fallback;
    var value;
    if (typeof obj.get === "function") {
      value = obj.get(key);
    } else if (typeof obj.toJS === "function") {
      value = obj.toJS()[key];
    } else {
      value = obj[key];
    }
    return value === undefined ? fallback : value;
  }

  function readFileAsBase64(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        var result = String(reader.result);
        var comma = result.indexOf(",");
        resolve(comma === -1 ? result : result.slice(comma + 1));
      };
      reader.onerror = function () {
        reject(reader.error || new Error("failed to read file"));
      };
      reader.readAsDataURL(file);
    });
  }

  // ---------------------------------------------------------------------
  // The Implementation class Decap registers.
  // ---------------------------------------------------------------------

  function NexusGatewayBackend(config, options) {
    this.config = config;
    this.options = options || {};
    ensureSession().catch(function (err) {
      console.error("[nexus-gateway-backend] handoff exchange failed:", err);
    });
  }

  NexusGatewayBackend.prototype.isGitBackend = function () {
    return false;
  };

  /**
   * authComponent — NOT optional in this Decap bundle: the internal
   * Backend wrapper calls `this.implementation.authComponent()`
   * unconditionally. It must exist AND return a valid component
   * function, not `null` (React error #130).
   *
   * Auth already happens via the handoff-token exchange, so this renders
   * nothing and, on first render, calls `props.onLogin({})` once
   * (deferred with setTimeout so it doesn't fire during React's render
   * phase) to trigger this.authenticate() below with no visible form.
   */
  NexusGatewayBackend.prototype.authComponent = function () {
    var triggered = false;
    return function NexusAutoAuth(props) {
      if (!triggered) {
        triggered = true;
        setTimeout(function () {
          if (props && typeof props.onLogin === "function") {
            props.onLogin({});
          }
        }, 0);
      }
      return null;
    };
  };

  // We never persist the user, so Decap always ends up calling
  // authenticate() on load instead of skipping straight to "logged in".
  NexusGatewayBackend.prototype.restoreUser = function () {
    return Promise.reject(new Error("no persisted Nexus session"));
  };

  NexusGatewayBackend.prototype.authenticate = function () {
    return ensureSession()
      .then(function () {
        return { name: "Nexus Editor", login: "nexus-editor" };
      })
      .catch(handleSessionFailure);
  };

  NexusGatewayBackend.prototype.logout = function () {
    var token = sessionToken;
    sessionToken = null;
    writeStoredToken(null);
    if (token) {
      // Best effort: also end the session on the Gateway, not just here.
      try {
        fetch(GATEWAY_BASE_URL + "/api/logout", {
          method: "POST",
          headers: { Authorization: "Bearer " + token, Accept: "application/json" },
        }).catch(function () {});
      } catch (e) {
        /* ignore */
      }
    }
    showPanel("signedout");
    return Promise.resolve();
  };

  NexusGatewayBackend.prototype.getToken = function () {
    return Promise.resolve(sessionToken);
  };

  /**
   * entriesByFolder — list a collection's folder, then fetch each file's
   * raw content. N+1 by nature (one list call, then one ?file=true call
   * per file) — an accepted tradeoff for current folder sizes.
   */
  NexusGatewayBackend.prototype.entriesByFolder = function (collection, extension) {
    // Decap 3.19 passes the folder path string directly.
    var folder = typeof collection === "string" ? collection : cfgGet(collection, "folder");
    if (!folder) {
      return Promise.reject(
        new Error("[nexus-gateway-backend] entriesByFolder: could not work out the folder path")
      );
    }
    return authedJson("/entries?path=" + encodeURIComponent(folder)).then(function (listing) {
      var files = (listing.entries || []).filter(function (e) {
        return e.type === "file" && e.path.endsWith("." + extension);
      });
      return Promise.all(
        files.map(function (f) {
          return authedJson("/entries?path=" + encodeURIComponent(f.path) + "&file=true").then(
            function (fileData) {
              return { file: { path: fileData.path, id: fileData.path }, data: fileData.content };
            }
          );
        })
      );
    });
  };

  NexusGatewayBackend.prototype.getEntry = function (path) {
    return authedJson("/entries?path=" + encodeURIComponent(path) + "&file=true").then(function (
      fileData
    ) {
      return { file: { path: fileData.path, id: fileData.path }, data: fileData.content };
    });
  };

  /**
   * entriesByFiles — for `files:`-based collections (fixed named files).
   *
   * Decap 3.x passes an array of { path, label } objects. The path key is
   * `path` — reading `.file` (the config.yml key) gave undefined, which
   * became "?path=undefined", a 502 from the Gateway and, because that
   * error response carried no CORS headers, a bare "Failed to fetch".
   */
  NexusGatewayBackend.prototype.entriesByFiles = function (files) {
    var filesArray = Array.isArray(files)
      ? files
      : typeof (files && files.toJS) === "function"
      ? files.toJS()
      : cfgGet(files, "files", []);
    if (typeof filesArray.toJS === "function") filesArray = filesArray.toJS();

    return Promise.all(
      filesArray.map(function (fileEntry) {
        var path =
          typeof fileEntry === "string"
            ? fileEntry
            : cfgGet(fileEntry, "path") || cfgGet(fileEntry, "file");
        var label = typeof fileEntry === "string" ? undefined : cfgGet(fileEntry, "label");

        if (!path) {
          return Promise.reject(
            new Error(
              "[nexus-gateway-backend] entriesByFiles: no path on file entry " +
                JSON.stringify(fileEntry)
            )
          );
        }

        return authedJson("/entries?path=" + encodeURIComponent(path) + "&file=true").then(
          function (fileData) {
            return {
              file: { path: fileData.path, label: label, id: fileData.path },
              data: fileData.content,
            };
          }
        );
      })
    );
  };

  /**
   * persistEntry — writes one or more files via POST /commit. Targets
   * Decap 3.x's `entry.dataFiles` shape, with a fallback to the older
   * single path/raw shape in case the running Decap version differs.
   */
  NexusGatewayBackend.prototype.persistEntry = function (entry, opts) {
    opts = opts || {};
    var message = opts.commitMessage || "Update via Nexus CMS Gateway";

    var files =
      entry.dataFiles && entry.dataFiles.length
        ? entry.dataFiles
        : [{ path: entry.path, raw: entry.raw }];

    var commits = files.map(function (f) {
      return authedJson("/commit", {
        method: "POST",
        body: JSON.stringify({
          path: f.path,
          content: f.raw,
          message: message,
          action: "update", // the Gateway resolves create-vs-update itself
        }),
      });
    });

    return Promise.all(commits).then(function () {
      return undefined;
    });
  };

  /**
   * getMedia — lists the media folder WITH content, using the
   * content=true param on /entries. Decap's media cards draw their
   * thumbnails from `displayURL`; without it they fall back to the
   * "JPG"/"JPEG" placeholder text.
   */
  NexusGatewayBackend.prototype.getMedia = function (folder) {
    var mediaFolder = folder || cfgGet(this.config, "media_folder") || "images/uploads";
    return authedJson(
      "/entries?path=" + encodeURIComponent(mediaFolder) + "&content=true"
    ).then(function (listing) {
      return (listing.entries || [])
        .filter(function (e) {
          return e.type === "file" && e.contentBase64;
        })
        .map(function (e) {
          var dataUri = "data:" + guessMimeType(e.path) + ";base64," + e.contentBase64;
          var name = e.path.split("/").pop();
          return {
            id: e.sha,
            name: name,
            size: e.size,
            url: dataUri,
            displayURL: dataUri,
            path: e.path,
          };
        });
    });
  };

  NexusGatewayBackend.prototype.persistMedia = function (file, opts) {
    opts = opts || {};
    var mediaFolder = cfgGet(this.config, "media_folder") || "images/uploads";
    var path = mediaFolder + "/" + file.name;

    return readFileAsBase64(file.fileObj || file).then(function (base64) {
      return authedJson("/media", {
        method: "POST",
        body: JSON.stringify({
          path: path,
          contentBase64: base64,
          message: opts.commitMessage || "Upload media: " + path,
        }),
      }).then(function () {
        var dataUri = "data:" + guessMimeType(path) + ";base64," + base64;
        return {
          id: path,
          name: file.name,
          size: file.size,
          displayURL: dataUri,
          url: dataUri,
          path: path,
        };
      });
    });
  };

  /**
   * deleteFiles — one /commit(action:"delete") call per path. Each delete
   * needs the file's current sha first, fetched via /entries?file=true.
   * Sequential, so an error can be attributed to a single path.
   */
  NexusGatewayBackend.prototype.deleteFiles = function (paths, commitMessage) {
    var message = commitMessage || "Delete via Nexus CMS Gateway";

    function deleteOne(path) {
      return authedJson("/entries?path=" + encodeURIComponent(path) + "&file=true").then(function (
        fileData
      ) {
        return authedJson("/commit", {
          method: "POST",
          body: JSON.stringify({
            path: path,
            message: message,
            action: "delete",
            sha: fileData.sha,
          }),
        });
      });
    }

    return paths
      .reduce(function (chain, path) {
        return chain.then(function () {
          return deleteOne(path);
        });
      }, Promise.resolve())
      .then(function () {
        return undefined;
      });
  };

  // Expose globally so admin/index.html can register it with CMS.
  window.NexusGatewayBackend = NexusGatewayBackend;
})();
