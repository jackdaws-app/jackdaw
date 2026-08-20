/* The console shell: everything the two admin pages share.
 *
 * There are two rooms — the numbers (`admin.html`) and the policy text
 * (`admin-policies.html`) — and exactly one console. The key, the gate, the
 * power-on choreography, the plate stagger and the Convex transport are all
 * properties of the console rather than of either room, so they live here and
 * each page supplies only its own contents.
 *
 * The gate is why this is a file and not a copy-paste. It holds a 256-bit
 * bearer secret in sessionStorage, and a second implementation of that is the
 * kind of thing that drifts one commit at a time until the two pages disagree
 * about when a key is cleared. One implementation, two callers.
 *
 * SECURITY POSTURE (unchanged in kind from the panel's original note): both
 * credentials are held in sessionStorage — cleared when the tab closes, never
 * in localStorage, never in a URL — sent over HTTPS and compared server-side
 * without early return. Failed attempts are NOT rate limited, because a Convex
 * mutation that throws rolls back its own transaction including the limiter's
 * write, and queries cannot write at all. The credential's entropy is the
 * lock: a 256-bit key, or a 256-bit session token that a six-digit code and a
 * server-side lockout stood in front of once. Both pages are noindex +
 * Disallow'd, which keeps them out of search results and is not a security
 * control. A single operator tool, not a multi-user auth system.
 *
 * TWO DOORS, ONE GATE. `requireAdmin` accepts a session token from an account
 * whose `isAdmin` is true, or the admin key, and the gate presents both:
 * email + code is the primary door — revocable per account, and what lets
 * ADMIN_KEY be retired — while the key waits behind a quiet link for as long
 * as it exists. Every admin call sends whatever credentials are held; an
 * invalid session falls through to the key server-side, so holding a stale
 * one beside a good key costs nothing. `verifyCode` is an action, and this
 * transport never retries — a retried sign-in would spend the single-use code
 * and then report it bad. The `deviceId` sent with sign-in is minted fresh
 * per page load: watch adoption keys on it, a novel id adopts nothing, and
 * the console is not a shopper.
 *
 * One key serves both pages, deliberately: unlocking the numbers unlocks the
 * policies, and signing out of either signs out of both. Two keys for one
 * operator would only mean typing the same secret twice.
 */
(function () {
  "use strict";

  // Set in config.js so the site and the extension are swapped together.
  var CONVEX_URL = window.JACKDAW_CONVEX_URL;
  if (!CONVEX_URL) {
    document.body.innerHTML =
      '<p style="font:14px system-ui;padding:40px">config.js is missing: no Convex deployment configured.</p>';
    window.JackdawAdmin = { ok: false };
    return;
  }
  var KEY_STORE = "jd_admin_key";
  var SESSION_STORE = "jd_admin_session";
  /* The door shown first — "email" or "key". A UI preference rather than a
     credential, so it alone may survive the tab in localStorage: an operator
     who always uses one door should not be walked through the other first. */
  var DOOR_STORE = "jd_admin_door";

  var $ = function (id) {
    return document.getElementById(id);
  };
  var gate = $("gate");
  var gateForm = $("gateForm");
  var gateSub = $("gateSub");
  var emailInput = $("emailInput");
  var codeInput = $("codeInput");
  var keyInput = $("keyInput");
  var gateGo = $("gateGo");
  var gateAlt = $("gateAlt");
  var gateBack = $("gateBack");
  var gateResend = $("gateResend");
  var gateError = $("gateError");
  var panelWrap = $("panelWrap");
  var signOut = $("signOut");

  var adminKey = sessionStorage.getItem(KEY_STORE) || "";
  var session = sessionStorage.getItem(SESSION_STORE) || "";

  /* Fresh per page load, deliberately — see the head note. */
  var deviceId = (function () {
    var b = new Uint8Array(8);
    crypto.getRandomValues(b);
    var s = "panel-";
    for (var i = 0; i < b.length; i++) s += (b[i] + 256).toString(16).slice(1);
    return s;
  })();

  function doorPref() {
    try {
      return localStorage.getItem(DOOR_STORE) === "key" ? "key" : "email";
    } catch (e) {
      return "email";
    }
  }
  function rememberDoor(door) {
    try {
      localStorage.setItem(DOOR_STORE, door);
    } catch (e) {}
  }

  /* Every animation on both pages is gated on this ONE query rather than each
     one testing for itself, so a stale gate cannot leave half the choreography
     running. The CSS half is each stylesheet's own `reduce` block; a JS check
     cannot substitute for it (media queries are evaluated by the engine, not by
     us) and neither can substitute for the other — both halves are needed. */
  var still = window.matchMedia("(prefers-reduced-motion: reduce)");

  /* The boot choreography plays once, on the transition from gate to panel.
     Refresh redraws the same plates; replaying their entrance on every poll
     would make a routine refresh look like a page load. */
  var booted = false;
  var loader = null;

  // ── Convex HTTP ──
  function call(kind, path, args) {
    return fetch(CONVEX_URL + "/api/" + kind, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: path, args: args, format: "json" }),
    })
      .then(function (res) {
        return res.json();
      })
      .then(function (json) {
        if (json.status === "success") return json.value;
        var err = new Error(json.errorMessage || "Request failed");
        err.code = json.errorData && json.errorData.code;
        // The server's own sentence, kept separate from `message` because
        // `errorMessage` wraps it in a request id and a stack. A refusal that
        // names the rule it enforced is worth showing verbatim.
        err.detail = json.errorData && json.errorData.message;
        throw err;
      });
  }

  // ── Helpers ──
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function fmt(n) {
    return n == null ? "—" : n.toLocaleString();
  }
  function money(n) {
    return "$" + Math.round(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 });
  }
  var DAY = 86400000;
  function ago(ts) {
    var d = Math.floor((Date.now() - ts) / DAY);
    if (d <= 0) return "today";
    if (d === 1) return "yesterday";
    if (d < 30) return d + " days ago";
    return new Date(ts).toISOString().slice(0, 10);
  }

  var toastEl = null;
  var toastTimer = null;
  function toast(msg) {
    if (!toastEl) {
      toastEl = el("div", "toast");
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    requestAnimationFrame(function () {
      toastEl.classList.add("in");
    });
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toastEl.classList.remove("in");
    }, 2400);
  }

  // ── Gate ──
  /* Three ways in, one plate. "email" asks for an address and requests a
     six-digit code, "code" spends it, "key" is the original shared-secret
     door behind a quiet link. A mode swaps the plate's CONTENTS — input,
     instruction, button label — while the lamp, the bezel and the error line
     hold still: the gate changing shape between attempts would read as a
     different lock rather than another way to turn this one. */
  var mode = "email";
  var pendingEmail = "";

  function activeInput() {
    return mode === "email" ? emailInput : mode === "code" ? codeInput : keyInput;
  }

  function setMode(next) {
    var changed = gate.dataset.mode !== next;
    mode = next;
    gate.dataset.mode = next;
    gateSub.textContent =
      next === "email"
        ? "Sign in with your email. A six-digit code will be sent to it."
        : next === "code"
          ? "Enter the six-digit code sent to " + pendingEmail + "."
          : "Enter the admin key. It is kept for this browser session only.";
    gateGo.textContent = next === "email" ? "Send code" : "Unlock";
    gateAlt.textContent =
      next === "key" ? "Sign in with email instead" : "Use the admin key instead";
    emailInput.hidden = next !== "email";
    codeInput.hidden = next !== "code";
    keyInput.hidden = next !== "key";
    gateResend.hidden = next !== "code";
    gateBack.hidden = next !== "code";
    if (next !== "code") codeInput.value = "";
    gateError.hidden = true;
    /* The contents step, the plate does not move. Class-cycle + reflow,
       because a finished animation never restarts under the same name. */
    if (changed && !still.matches) {
      [gateForm, gateSub].forEach(function (n) {
        n.classList.remove("swap");
        void n.offsetWidth;
        n.classList.add("swap");
      });
    }
    if (panelWrap.hidden && !gate.hidden) activeInput().focus();
  }

  function gateOops(message) {
    gateError.textContent = message;
    gateError.hidden = false;
    // Retrigger the shake: a finished animation never restarts under the
    // same name.
    gateError.style.animation = "none";
    void gateError.offsetWidth;
    gateError.style.animation = "";
  }

  function showGate(message) {
    panelWrap.hidden = true;
    if (signOut) signOut.hidden = true;
    gate.hidden = false;
    if (message) gateOops(message);
    activeInput().focus();
  }

  /* The client half of resend hygiene. The server's per-address bucket is the
     real limit; this only keeps one impatient double-click from spending it. */
  var resendTimer = null;
  function startResendCooldown() {
    gateResend.disabled = true;
    clearTimeout(resendTimer);
    resendTimer = setTimeout(function () {
      gateResend.disabled = false;
    }, 30000);
  }

  function refusal(e, fallback) {
    // The server's own sentence when it sent one — a refusal that names the
    // rule it enforced beats anything composed out here.
    return (e && e.detail) || fallback;
  }

  /* `requestCode` answers ok whether or not an account exists (enumeration
     resistance is the server's, not ours), so success here only means the
     question was asked. */
  function requestCode(email) {
    gate.classList.add("checking");
    return call("mutation", "auth:requestCode", { email: email }).then(
      function () {
        gate.classList.remove("checking");
        pendingEmail = email;
        setMode("code");
        startResendCooldown();
        return true;
      },
      function (e) {
        gate.classList.remove("checking");
        gateOops(refusal(e, "Couldn't reach the backend. Check your connection."));
        return false;
      },
    );
  }

  function verifyCode(code) {
    gate.classList.add("checking");
    return call("action", "auth:verifyCode", {
      email: pendingEmail,
      code: code,
      deviceId: deviceId,
    })
      .then(function (res) {
        /* Signed in is not authorized. `auth:me` reads the account's own
           record; its `isAdmin` is a hint that lets the copy here be honest,
           never the gate — the server re-checks every call regardless. */
        return call("query", "auth:me", { sessionToken: res.sessionToken }).then(function (me) {
          if (me && me.isAdmin === true) {
            /* Known good regardless of what the first load does: a network
               failure after this point costs a retry, not a fresh code. */
            session = res.sessionToken;
            sessionStorage.setItem(SESSION_STORE, session);
            rememberDoor("email");
            emailInput.value = "";
            codeInput.value = "";
            return load().then(function () {
              gate.classList.remove("checking");
            });
          }
          /* A real account without the admin bit. Keeping the session would
             mean a signed-in console that refuses every call — kill it
             server-side and say what actually happened. */
          call("mutation", "auth:signOut", { sessionToken: res.sessionToken }).catch(
            function () {},
          );
          gate.classList.remove("checking");
          setMode("email");
          gateOops("That account signed in, but it has no admin access.");
        });
      })
      .catch(function (e) {
        gate.classList.remove("checking");
        gateOops(refusal(e, "Couldn't reach the backend. Check your connection."));
        codeInput.select();
      });
  }

  function tryKey(val) {
    adminKey = val;
    gate.classList.add("checking");
    return load().then(function (ok) {
      gate.classList.remove("checking");
      if (ok) {
        sessionStorage.setItem(KEY_STORE, adminKey);
        rememberDoor("key");
        keyInput.value = "";
      } else {
        adminKey = "";
      }
    });
  }

  function showPanel() {
    gateError.hidden = true;
    panelWrap.hidden = false;
    if (signOut) signOut.hidden = false;
    if (gate.hidden) return;
    /* Power-on, not a page swap. The lamp goes green, the gate plate drops
       away, and the console's own plates come up BEHIND it rather than after
       it — the overlap is the point, and it is the same continuity rule the
       bird arrival is built on: one stage hands its mass to the next. */
    gate.classList.remove("checking");
    gate.classList.add("opened");
    panelWrap.classList.add("booting");
    var finish = function () {
      gate.hidden = true;
      gate.classList.remove("opened", "leaving");
    };
    if (still.matches) {
      finish();
      return;
    }
    gate.classList.add("leaving");
    /* The plates start at 240ms, while the gate is still fading: the two
       overlap by ~180ms. Sequenced by timer rather than by `animationend`
       because the gate's own exit is what we are deliberately NOT waiting for. */
    setTimeout(finish, 430);
  }

  /* Boot state is a class on the wrapper, dropped once the last plate has
     landed. Leaving it on would keep an inert `::before` element on every card
     and, worse, would mean a later re-render inherits a finished animation —
     which never restarts under the same name. */
  function bootDone() {
    panelWrap.classList.remove("booting");
    booted = true;
  }

  /* One load at a time, and a second caller joins the first rather than racing
     it. `#refresh` used to call `load()` with no guard at all, and a
     double-click on a slow reply ran two passes that interleaved inside the one
     renderer that awaits before it paints — four policy rows where there are
     two documents. Joining rather than dropping is what keeps the gate's own
     submit correct: it needs the real verdict, not a `false` that means
     "somebody else is already asking". */
  var inFlight = null;
  function load() {
    if (inFlight) return inFlight;
    inFlight = Promise.resolve()
      .then(loader)
      .then(
        function (ok) {
          inFlight = null;
          return ok;
        },
        function (e) {
          inFlight = null;
          throw e;
        },
      );
    return inFlight;
  }

  // ── Plates ──
  /* The entrance stagger is stamped in DOCUMENT order over what is actually on
     screen. Cards that start `hidden` and are revealed only when they have
     something to say would otherwise leave gaps in the cascade — a 62ms beat
     with two silent rests in it reads as jank, not as rhythm. */
  function plates() {
    return Array.prototype.slice
      .call(panelWrap.querySelectorAll(".kpi, [data-plate]"))
      .filter(function (n) {
        return !n.hidden && !n.closest("[hidden]");
      });
  }
  function stampPlates() {
    plates().forEach(function (n, i) {
      n.style.setProperty("--plate-i", String(i));
    });
  }

  /* One plate at a time, page-wide — the same rule brand.js applies to the
     birds, for the same reason: a console where six surfaces glint at once
     reads as a screensaver. Only plates on screen are eligible, so the sweep is
     never spent on something nobody is looking at. */
  var sweepTimer = null;
  function scheduleSweep() {
    clearTimeout(sweepTimer);
    if (still.matches) return;
    sweepTimer = setTimeout(function () {
      scheduleSweep();
      if (document.hidden || panelWrap.hidden) return;
      var vh = window.innerHeight;
      var eligible = plates().filter(function (n) {
        if (!n.classList.contains("admin-card")) return false;
        var r = n.getBoundingClientRect();
        return r.top < vh - 40 && r.bottom > 40;
      });
      if (!eligible.length) return;
      var card = eligible[Math.floor(Math.random() * eligible.length)];
      // A finished animation never restarts under the same name, so the class
      // is removed on the way out rather than left on the winner.
      card.classList.remove("sweep");
      void card.offsetWidth;
      card.classList.add("sweep");
      setTimeout(function () {
        card.classList.remove("sweep");
      }, 2200);
    }, 9000 + Math.random() * 7000);
  }
  still.addEventListener("change", function () {
    if (still.matches) clearTimeout(sweepTimer);
    else scheduleSweep();
  });

  /* Called by a page once every renderer has run — never before, because a card
     that decides while rendering whether it is hidden must have decided before
     the order is stamped. */
  function afterRender() {
    stampPlates();
    if (booted) return;
    // The last plate's contents finish at index*62 + 200 + 420.
    setTimeout(bootDone, plates().length * 62 + 700);
    scheduleSweep();
  }

  /* The deployment host, for comparing against a `data-policy-deployment`
     stamp. Version numbers are per-deployment counters, so one stamped by a
     different deployment is not a floor here: dev v9 says nothing about prod. */
  var HOST = String(CONVEX_URL)
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
    .split("/")[0]
    .toLowerCase();

  function init(opts) {
    loader = opts.load;

    /* The door the operator used last is the door shown first. */
    setMode(doorPref());

    gateForm.addEventListener("submit", function (e) {
      e.preventDefault();
      if (mode === "email") {
        var email = emailInput.value.trim();
        if (email) requestCode(email);
      } else if (mode === "code") {
        var code = codeInput.value.trim();
        if (code) verifyCode(code);
      } else {
        var val = keyInput.value.trim();
        if (val) tryKey(val);
      }
    });

    gateAlt.addEventListener("click", function () {
      setMode(mode === "key" ? "email" : "key");
    });
    gateBack.addEventListener("click", function () {
      setMode("email");
      emailInput.select();
    });
    gateResend.addEventListener("click", function () {
      if (gateResend.disabled || !pendingEmail) return;
      requestCode(pendingEmail).then(function (ok) {
        if (ok) toast("A new code is on its way.");
      });
    });

    if (signOut) {
      signOut.addEventListener("click", function () {
        /* Server-side first, so the token is dead even where a copy of it
           survives. Fire and forget: the console signs out either way, and
           `auth:signOut` is idempotent. */
        if (session) {
          call("mutation", "auth:signOut", { sessionToken: session }).catch(function () {});
        }
        sessionStorage.removeItem(KEY_STORE);
        sessionStorage.removeItem(SESSION_STORE);
        adminKey = "";
        session = "";
        booted = false;
        gate.classList.remove("opened", "leaving", "checking");
        if (opts.onSignOut) opts.onSignOut();
        setMode(doorPref());
        showGate();
      });
    }

    var refresh = $("refresh");
    if (refresh) refresh.addEventListener("click", function () { load(); });

    if (session || adminKey) {
      /* A session is a row with a rolling expiry and `touch` renews it — fire
         and forget, since the queries about to run exercise it anyway. */
      if (session) {
        call("mutation", "auth:touch", { sessionToken: session }).catch(function () {});
      }
      gate.classList.add("checking");
      load().then(function () {
        gate.classList.remove("checking");
      });
    } else {
      showGate();
    }
  }

  window.JackdawAdmin = {
    ok: true,
    url: CONVEX_URL,
    host: HOST,
    still: still,
    query: function (path, args) {
      return call("query", path, args);
    },
    mutate: function (path, args) {
      return call("mutation", path, args);
    },
    /* Functions rather than properties, for the original reason `key()` was
       one: the values change on unlock and on sign-out, and a snapshot taken
       at page load would be empty forever. Only fields actually held are
       returned — absent means absent, on the wire as in the schema. */
    creds: function () {
      var c = {};
      if (session) c.sessionToken = session;
      if (adminKey) c.adminKey = adminKey;
      return c;
    },
    hasCreds: function () {
      return !!(session || adminKey);
    },
    booted: function () {
      return booted;
    },
    setLoading: function (on) {
      panelWrap.classList.toggle("loading", !!on);
    },
    panelWrap: panelWrap,
    el: el,
    fmt: fmt,
    money: money,
    ago: ago,
    toast: toast,
    showGate: showGate,
    showPanel: showPanel,
    stampPlates: stampPlates,
    afterRender: afterRender,
    load: load,
    init: init,
  };
})();
