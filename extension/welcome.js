// The welcome page: opened once by the service worker on a fresh install.
// Its one job with consequences is the consent card — the same jdCatalog key
// every other surface reads, written here with the same two answers.
//
// A welcome tab can outlive the extension that opened it (an update or a
// reload at chrome://extensions orphans it, same as a content script), so
// every chrome.* call is wrapped: a dead context degrades to a page that
// still reads fine, and a failed consent write says so instead of settling.
(() => {
  // Split the wordmark so the flight can deposit it a letter at a time.
  // Runs before first paint (script sits at the end of body); without JS the
  // whole-word fallback animation in welcome.css covers the page.
  const mark = document.querySelector(".wel-mark");
  if (mark) {
    const word = mark.textContent.trim();
    mark.setAttribute("role", "img");
    mark.setAttribute("aria-label", word);
    mark.textContent = "";
    for (let i = 0; i < word.length; i++) {
      const letter = document.createElement("i");
      letter.style.setProperty("--i", String(i));
      letter.textContent = word[i];
      mark.appendChild(letter);
    }
    mark.classList.add("split");
  }

  // ---------- Idle repertoire ----------
  // After the arrival the hero doesn't freeze: the glyph soars in place,
  // flicks a wing now and then, and occasionally — or when the pointer
  // wanders over the hero — flies one circuit over the wordmark and lands
  // back. Everything here only ADDS classes; the motion itself lives behind
  // welcome.css's reduced-motion gate. The .settled/.aloft classes are what
  // make the circuit safe to end: they hand every finished entrance
  // animation to a quiet state first, so removing .idle-fly returns there
  // instead of re-applying (and replaying) the arrival.
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  const hero = document.querySelector(".wel-hero");
  const sky = document.querySelector(".wel-sky");
  const bird = document.querySelector(".wel-bird");
  const flight = document.querySelector(".wel-flight");
  if (!reduced.matches && hero && sky && bird && flight && mark) {
    const wings = bird.querySelector("g");
    const perchBody = document.querySelector(".wel-perched-body");
    let flying = false;
    let lastFlight = 0;
    let flyTimer = 0;
    let adjustTimer = 0;
    // The repertoire alternates: a plain circuit, then a circuit that lands
    // in the sapling. Cycle state lives here so the hover handler and the
    // reduced-motion teardown can both reach it.
    let nextCircuitLands = false;
    let perchPhase = null; // null | "flight" | "perched" | "depart"
    let cycleTimers = [];
    let lastPeck = 0;

    const settleIdle = () => {
      if (bird.classList.contains("aloft")) return;
      sky.classList.add("settled");
      mark.classList.add("settled");
      bird.classList.add("aloft");
      scheduleFly(9000 + Math.random() * 5000);
      scheduleAdjust();
    };

    // Idle begins where the arrival ends: the glyph's touchdown. The timeout
    // is a backstop — a background tab can throttle animation events, and a
    // missed one must not leave the hero frozen forever.
    bird.addEventListener("animationend", (e) => {
      if (e.animationName === "wel-land") settleIdle();
    });
    setTimeout(settleIdle, 4200);

    function scheduleFly(ms) {
      clearTimeout(flyTimer);
      flyTimer = setTimeout(tryFly, ms);
    }

    // The flick's class is removed on its own animationend, so the next add
    // is a fresh animation — no reflow tricks needed to restart it. The
    // perched bird's business classes follow the same pattern.
    if (wings) wings.addEventListener("animationend", () => wings.classList.remove("adjust"));
    if (perchBody) {
      perchBody.addEventListener("animationend", (e) => {
        if (e.animationName === "wel-perch-shift" || e.animationName === "wel-perch-peck") {
          perchBody.classList.remove("shift", "peck");
        }
      });
    }
    function scheduleAdjust() {
      clearTimeout(adjustTimer);
      adjustTimer = setTimeout(() => {
        if (!flying && !document.hidden && wings) wings.classList.add("adjust");
        scheduleAdjust();
      }, 9000 + Math.random() * 7000);
    }

    function tryFly() {
      if (flying || document.hidden || !bird.classList.contains("aloft")) {
        scheduleFly(6000);
        return;
      }
      flying = true;
      const lands = nextCircuitLands;
      nextCircuitLands = !lands;
      if (lands) {
        runPerchCycle();
        return;
      }
      hero.classList.add("idle-fly");
      // Cleanup on the flight's own end, with a timeout backstop so a missed
      // event can never leave the flag stuck and the repertoire dead.
      const done = () => {
        if (!flying) return;
        flying = false;
        lastFlight = performance.now();
        hero.classList.remove("idle-fly");
        scheduleFly(22000 + Math.random() * 16000);
      };
      flight.addEventListener("animationend", function onEnd(e) {
        if (e.animationName !== "wel-circuit") return;
        flight.removeEventListener("animationend", onEnd);
        done();
      });
      setTimeout(done, 3400);
    }

    // Variant B: circuit → land in the sapling → perch (10–16s, with the
    // odd shift or peck) → launch → back to the glyph. Phases advance on
    // the flight's own animationends, each with a timeout backstop and a
    // phase guard, so a missed or doubled event can neither stall the
    // cycle nor run a phase twice. All CSS: JS only adds .idle-perch, then
    // .idle-depart ALONGSIDE it, and removes both at the end.
    function runPerchCycle() {
      perchPhase = "flight";
      hero.classList.add("idle-perch");
      const later = (fn, ms) => cycleTimers.push(setTimeout(fn, ms));

      function scheduleBusiness() {
        later(() => {
          if (perchPhase !== "perched") return;
          if (perchBody && !perchBody.classList.contains("peck") && !perchBody.classList.contains("shift")) {
            perchBody.classList.add(Math.random() < 0.35 ? "peck" : "shift");
          }
          scheduleBusiness();
        }, 3500 + Math.random() * 3000);
      }

      const land = () => {
        if (perchPhase !== "flight") return;
        perchPhase = "perched";
        scheduleBusiness();
        later(depart, 10000 + Math.random() * 6000);
      };
      const depart = () => {
        if (perchPhase !== "perched") return;
        perchPhase = "depart";
        hero.classList.add("idle-depart");
        later(finish, 2400);
      };
      const finish = () => {
        if (perchPhase === null) return;
        perchPhase = null;
        flight.removeEventListener("animationend", onEnd);
        cycleTimers.forEach(clearTimeout);
        cycleTimers = [];
        if (perchBody) perchBody.classList.remove("shift", "peck");
        hero.classList.remove("idle-perch", "idle-depart");
        flying = false;
        lastFlight = performance.now();
        scheduleFly(22000 + Math.random() * 16000);
      };
      const onEnd = (e) => {
        if (e.animationName === "wel-circuit-land") land();
        else if (e.animationName === "wel-depart") finish();
      };
      flight.addEventListener("animationend", onEnd);
      later(land, 4800);
    }

    // Hover jumps the queue — a reader leaning in deserves the show — but
    // never mid-flight and never twice in quick succession. A hover over a
    // PERCHED bird gets a peck instead of a flight, on its own cooldown.
    if (window.matchMedia("(hover: hover) and (pointer: fine)").matches) {
      hero.addEventListener("pointerenter", () => {
        if (perchPhase === "perched") {
          const now = performance.now();
          if (perchBody && now - lastPeck > 2500 &&
              !perchBody.classList.contains("peck") && !perchBody.classList.contains("shift")) {
            lastPeck = now;
            perchBody.classList.add("peck");
          }
          return;
        }
        if (flying || !bird.classList.contains("aloft")) return;
        if (performance.now() - lastFlight < 6000) return;
        tryFly();
      });
    }

    // Motion switched off mid-session: stop scheduling and strike the idle
    // classes — the CSS half already went quiet the moment the media query
    // flipped, but a stray class must not resume anything if it flips back.
    if (reduced.addEventListener) {
      reduced.addEventListener("change", (e) => {
        if (e.matches) {
          clearTimeout(flyTimer);
          clearTimeout(adjustTimer);
          cycleTimers.forEach(clearTimeout);
          cycleTimers = [];
          perchPhase = null;
          flying = false;
          if (perchBody) perchBody.classList.remove("shift", "peck");
          hero.classList.remove("idle-fly", "idle-perch", "idle-depart");
        }
      });
    }
  }

  const store = {
    async get(keys) {
      try {
        return await chrome.storage.local.get(keys);
      } catch {
        return {};
      }
    },
    async set(obj) {
      try {
        await chrome.storage.local.set(obj);
        return true;
      } catch {
        return false;
      }
    },
  };

  const yes = document.getElementById("yes");
  const no = document.getElementById("no");
  const note = document.getElementById("note");

  // The answered state: buttons go, one line confirms, and the popup is named
  // as the place to change it — this page never opens again.
  function settle(on) {
    yes.hidden = true;
    no.hidden = true;
    note.hidden = false;
    note.textContent = on
      ? "You're contributing. Change it any time in the Jackdaw popup, under Settings."
      : "Nothing will be shared. Change your mind any time in the Jackdaw popup, under Settings.";
  }

  async function answer(on) {
    const ok = await store.set({ jdCatalog: on });
    if (ok) settle(on);
    else {
      note.hidden = false;
      note.textContent = "Couldn't save that. Open the Jackdaw popup from the toolbar to answer.";
    }
  }

  yes.addEventListener("click", () => answer(true));
  no.addEventListener("click", () => answer(false));

  store.get(["jdTheme", "jdCatalog"]).then(({ jdTheme, jdCatalog }) => {
    // The popup's stored choice wins; a fresh install follows the OS.
    const dark = jdTheme
      ? jdTheme === "dark"
      : window.matchMedia("(prefers-color-scheme: dark)").matches;
    document.body.classList.toggle("dark", dark);
    // Already answered elsewhere (popup, tour) — show the settled state.
    if (jdCatalog !== undefined) settle(jdCatalog === true);
  });

  // Answered in another surface while this tab sat open: settle live rather
  // than leave a question standing that has already been answered.
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.jdCatalog && changes.jdCatalog.newValue !== undefined) {
        settle(changes.jdCatalog.newValue === true);
      }
    });
  } catch {
    // dead context: the buttons' own failure path already covers it
  }
})();
