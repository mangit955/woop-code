/**
 * Docs client behaviour.
 *
 * Four small things: the sliding sidebar rail, the scroll-spy table of
 * contents, the theme toggle, and the mobile navigation sheet. No framework and
 * no build step — this file is served as-is.
 *
 * Everything here is an enhancement. With JavaScript off the sidebar is a list
 * of links, the table of contents is a list of anchors, and the theme follows
 * the operating system. Nothing becomes unreachable.
 */

(function () {
  "use strict";

  // ── The active rail ──────────────────────────────────────────────────
  //
  // One rail for the whole sidebar rather than a border on each link, so it can
  // travel to the active item. Its position is measured rather than declared:
  // the sidebar is server-rendered and the active item can be at any depth.

  function placeRail() {
    var sidebar = document.querySelector(".sidebar");
    var rail = sidebar && sidebar.querySelector(".sidebar__rail");
    var active = sidebar && sidebar.querySelector('[aria-current="page"]');

    if (!rail) return;

    if (!active) {
      rail.style.setProperty("--rail-o", "0");
      return;
    }

    var top = active.offsetTop;
    var height = active.offsetHeight;

    rail.style.setProperty("--rail-y", top + "px");
    rail.style.setProperty("--rail-h", height + "px");
    rail.style.setProperty("--rail-o", "1");
  }

  // ── Scroll-spy ───────────────────────────────────────────────────────
  //
  // The current section is the last heading to have crossed the reading line —
  // a band just below the sticky top bar. Computed directly rather than through
  // an IntersectionObserver: an observer answers "is this visible", which is a
  // different question, and it leaves the list blank whenever a heading sits
  // exactly on the boundary or a section is taller than the viewport.

  var READING_LINE = 96;

  function spy() {
    var links = Array.prototype.slice.call(
      document.querySelectorAll("[data-toc]"),
    );
    if (links.length === 0) return;

    var headings = links
      .map(function (link) {
        return document.getElementById(link.getAttribute("data-toc"));
      })
      .filter(Boolean);

    if (headings.length === 0) return;

    function mark() {
      // Before the first heading, the first entry is still the right answer:
      // the reader is in that section's opening prose.
      var current = headings[0].id;

      for (var i = 0; i < headings.length; i++) {
        if (headings[i].getBoundingClientRect().top <= READING_LINE) {
          current = headings[i].id;
        } else {
          break;
        }
      }

      // At the bottom of the page the last section may never reach the reading
      // line, so nothing would mark it. Hand it the last heading instead.
      if (innerHeight + scrollY >= document.body.scrollHeight - 2) {
        current = headings[headings.length - 1].id;
      }

      links.forEach(function (link) {
        if (link.getAttribute("data-toc") === current) {
          link.setAttribute("data-active", "");
        } else {
          link.removeAttribute("data-active");
        }
      });
    }

    // Called straight from the scroll handler rather than deferred to a frame.
    // It is a dozen getBoundingClientRect reads against headings that are
    // already laid out, and requestAnimationFrame does not run in a hidden tab
    // — deferring to it meant a single missed frame could leave the list stuck
    // on one entry until the tab was focused again.
    addEventListener("scroll", mark, { passive: true });
    addEventListener("resize", mark);
    mark();
  }

  // ── Theme ────────────────────────────────────────────────────────────
  //
  // The toggle has to win over the OS in both directions, so it always writes
  // an explicit value rather than clearing back to "follow the system".

  function theme() {
    var button = document.querySelector("[data-theme-toggle]");
    if (!button) return;

    button.addEventListener("click", function () {
      var root = document.documentElement;
      var systemDark = matchMedia("(prefers-color-scheme: dark)").matches;
      var current = root.dataset.theme || (systemDark ? "dark" : "light");
      var next = current === "dark" ? "light" : "dark";

      root.dataset.theme = next;

      try {
        localStorage.setItem("woopcode-theme", next);
      } catch (e) {
        // Private mode, or storage disabled. The toggle still works for this
        // page; it just will not be remembered.
      }
    });
  }

  // ── Mobile navigation ────────────────────────────────────────────────

  function menu() {
    var button = document.querySelector("[data-menu]");
    var sidebar = document.querySelector("[data-sidebar]");
    var scrim = document.querySelector("[data-scrim]");

    if (!button || !sidebar || !scrim) return;

    function setOpen(open) {
      if (open) {
        sidebar.setAttribute("data-open", "");
        scrim.hidden = false;
      } else {
        sidebar.removeAttribute("data-open");
        scrim.hidden = true;
      }

      button.setAttribute("aria-expanded", open ? "true" : "false");
    }

    button.addEventListener("click", function () {
      setOpen(!sidebar.hasAttribute("data-open"));
    });

    scrim.addEventListener("click", function () {
      setOpen(false);
    });

    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape") setOpen(false);
    });

    // Following a link inside the sheet navigates; the sheet should not be
    // left open behind the new page on a browser that restores it.
    sidebar.addEventListener("click", function (event) {
      if (event.target.closest("a")) setOpen(false);
    });
  }

  // ── Copy ─────────────────────────────────────────────────────────────
  //
  // The clipboard API needs a secure context, which http://localhost is but a
  // plain-http staging host is not. The textarea fallback is the same one the
  // landing page's install field uses (site/src/components/CopyCommand.tsx).

  function writeClipboard(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(
        function () {
          return true;
        },
        function () {
          return false;
        },
      );
    }

    var field = document.createElement("textarea");
    field.value = text;
    field.setAttribute("readonly", "");
    field.style.position = "fixed";
    field.style.opacity = "0";
    document.body.appendChild(field);
    field.select();

    var ok = false;
    try {
      ok = document.execCommand("copy");
    } catch (e) {
      ok = false;
    }

    field.remove();
    return Promise.resolve(ok);
  }

  function copy() {
    document.addEventListener("click", function (event) {
      var button = event.target.closest("[data-copy]");
      if (!button) return;

      var block = button.closest(".code");
      var code = block && block.querySelector("code");
      if (!code) return;

      writeClipboard(code.innerText).then(function (ok) {
        if (!ok) return;

        button.setAttribute("data-copied", "");
        button.textContent = "Copied";

        setTimeout(function () {
          button.removeAttribute("data-copied");
          button.textContent = "Copy";
        }, 1600);
      });
    });
  }

  // ── Tabs ─────────────────────────────────────────────────────────────
  //
  // The choice is remembered and applied to every group on the page that offers
  // it: someone who uses bun does not want to pick it again on each page.

  var TAB_KEY = "woopcode-tab";

  function select(group, label) {
    var tabs = group.querySelectorAll(".tabs__tab");
    var panels = group.querySelectorAll(".tabs__panel");
    var matched = false;

    for (var i = 0; i < tabs.length; i++) {
      var on = tabs[i].getAttribute("data-tab") === label;
      tabs[i].setAttribute("aria-selected", on ? "true" : "false");
      if (on) matched = true;
    }

    for (var j = 0; j < panels.length; j++) {
      panels[j].hidden = panels[j].getAttribute("data-tab") !== label;
    }

    // A group that does not offer the remembered label keeps its first tab
    // rather than showing nothing at all.
    if (!matched) {
      for (var k = 0; k < tabs.length; k++) {
        tabs[k].setAttribute("aria-selected", k === 0 ? "true" : "false");
      }
      for (var m = 0; m < panels.length; m++) {
        panels[m].hidden = m !== 0;
      }
    }
  }

  function tabs() {
    var groups = document.querySelectorAll("[data-tabs]");
    if (groups.length === 0) return;

    var remembered = null;
    try {
      remembered = localStorage.getItem(TAB_KEY);
    } catch (e) {}

    if (remembered) {
      for (var i = 0; i < groups.length; i++) select(groups[i], remembered);
    }

    document.addEventListener("click", function (event) {
      var tab = event.target.closest(".tabs__tab");
      if (!tab) return;

      var label = tab.getAttribute("data-tab");

      try {
        localStorage.setItem(TAB_KEY, label);
      } catch (e) {}

      var all = document.querySelectorAll("[data-tabs]");
      for (var j = 0; j < all.length; j++) select(all[j], label);
    });
  }

  // ── Search ───────────────────────────────────────────────────────────
  //
  // The index is fetched once, the first time the palette is opened — it is
  // not needed to read a page, and most readers never open it.

  var RECENT_KEY = "woopcode-recent";
  var index = null;
  var loading = null;

  function loadIndex() {
    if (index) return Promise.resolve(index);
    if (loading) return loading;

    loading = fetch("/docs/search.json")
      .then(function (response) {
        return response.json();
      })
      .then(function (data) {
        index = data;
        return index;
      })
      .catch(function () {
        // Offline, or the route is missing. An empty index degrades to "no
        // results" rather than to a broken dialog.
        index = [];
        return index;
      });

    return loading;
  }

  /**
   * Every term has to match somewhere, and where it matches decides the rank:
   * a hit in the heading beats a hit in the page title, which beats a hit in
   * the body. Deliberately not a fuzzy matcher — for a set this small,
   * substring matching is predictable, and predictable beats clever when
   * someone is typing a flag name they already know.
   */
  function search(query) {
    var phrase = query.toLowerCase().trim();
    var terms = phrase.split(/\s+/).filter(Boolean);
    if (terms.length === 0) return [];

    var hits = [];

    for (var i = 0; i < index.length; i++) {
      var entry = index[i];
      var title = entry.title.toLowerCase();
      var score = 0;
      var matchedAll = true;

      // The whole query appearing intact outranks the same words scattered
      // across a section. Without this, "no auto approve" ranks a paragraph
      // that happens to contain "no", "auto" and "approve" above the page
      // documenting `--no-auto-approve`.
      if (terms.length > 1 && entry.text.indexOf(phrase) >= 0) score += 30;

      for (var t = 0; t < terms.length; t++) {
        var term = terms[t];
        var inTitle = title.indexOf(term);

        if (inTitle === 0) score += 14;
        else if (inTitle > 0) score += 9;

        if (entry.page.toLowerCase().indexOf(term) >= 0) score += 4;

        if (entry.text.indexOf(term) >= 0) score += 1;
        else if (inTitle < 0) {
          matchedAll = false;
          break;
        }
      }

      if (matchedAll) hits.push({ entry: entry, score: score });
    }

    hits.sort(function (a, b) {
      return b.score - a.score;
    });

    return hits.slice(0, 20).map(function (hit) {
      return hit.entry;
    });
  }

  function recent() {
    var urls = [];
    try {
      urls = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
    } catch (e) {}

    return urls
      .map(function (url) {
        for (var i = 0; i < index.length; i++) {
          if (index[i].url === url) return index[i];
        }
        return null;
      })
      .filter(Boolean)
      .slice(0, 5);
  }

  function rememberVisit() {
    var url = location.pathname;
    try {
      var urls = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
      urls = urls.filter(function (entry) {
        return entry !== url;
      });
      urls.unshift(url);
      localStorage.setItem(RECENT_KEY, JSON.stringify(urls.slice(0, 8)));
    } catch (e) {}
  }

  function escapeText(value) {
    return value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function palette() {
    var root = document.querySelector("[data-palette]");
    var input = document.querySelector("[data-palette-input]");
    var list = document.querySelector("[data-palette-results]");
    var dismiss = document.querySelector("[data-palette-dismiss]");

    if (!root || !input || !list) return;

    var results = [];
    var active = 0;
    var lastFocus = null;

    function draw(entries, heading) {
      results = entries;
      active = 0;

      if (entries.length === 0) {
        list.innerHTML =
          '<li class="palette__empty">' +
          (input.value ? "No matches." : "Type to search.") +
          "</li>";
        return;
      }

      var html = heading
        ? '<li class="palette__group" role="presentation">' + heading + "</li>"
        : "";

      for (var i = 0; i < entries.length; i++) {
        var entry = entries[i];
        html +=
          '<li class="palette__result" role="option" id="palette-option-' +
          i +
          '" aria-selected="' +
          (i === 0) +
          '" data-url="' +
          escapeText(entry.url) +
          '">' +
          '<span class="palette__crumb">' +
          escapeText(entry.group) +
          " · " +
          escapeText(entry.page) +
          "</span>" +
          '<span class="palette__title">' +
          escapeText(entry.title) +
          "</span>" +
          '<span class="palette__snippet">' +
          escapeText(entry.snippet) +
          "</span>" +
          "</li>";
      }

      list.innerHTML = html;
      highlight();
    }

    function highlight() {
      var options = list.querySelectorAll(".palette__result");

      for (var i = 0; i < options.length; i++) {
        var on = i === active;
        options[i].setAttribute("aria-selected", on ? "true" : "false");
        if (on) {
          options[i].scrollIntoView({ block: "nearest" });
          input.setAttribute("aria-activedescendant", options[i].id);
        }
      }
    }

    function update() {
      if (!index) return;

      var query = input.value.trim();
      if (query === "") {
        var recents = recent();
        draw(recents, recents.length ? "Recently viewed" : "");
        return;
      }

      draw(search(query), "");
    }

    function open() {
      lastFocus = document.activeElement;
      root.hidden = false;
      input.value = "";
      input.focus();

      loadIndex().then(update);
    }

    function close() {
      root.hidden = true;
      list.innerHTML = "";
      if (lastFocus && lastFocus.focus) lastFocus.focus();
    }

    function go() {
      var entry = results[active];
      if (!entry) return;
      close();
      location.href = entry.url;
    }

    // Delegated rather than bound to one element: the topbar has a trigger and
    // so does the 404 page, and binding only the first left the 404's button
    // dead — the page where search matters most.
    document.addEventListener("click", function (event) {
      if (event.target.closest("[data-search-open]")) open();
    });

    if (dismiss) dismiss.addEventListener("click", close);

    input.addEventListener("input", update);

    document.addEventListener("keydown", function (event) {
      var key = event.key.toLowerCase();

      if ((event.metaKey || event.ctrlKey) && key === "k") {
        event.preventDefault();
        return root.hidden ? open() : close();
      }

      if (root.hidden) {
        // `/` is a search shortcut everywhere except inside a field, where it
        // is a character someone is trying to type.
        var typing = /^(input|textarea|select)$/i.test(
          document.activeElement.tagName,
        );

        if (key === "/" && !typing && !event.metaKey && !event.ctrlKey) {
          event.preventDefault();
          open();
        }
        return;
      }

      if (key === "escape") {
        event.preventDefault();
        return close();
      }

      if (key === "arrowdown") {
        event.preventDefault();
        active = Math.min(active + 1, results.length - 1);
        return highlight();
      }

      if (key === "arrowup") {
        event.preventDefault();
        active = Math.max(active - 1, 0);
        return highlight();
      }

      if (key === "enter") {
        event.preventDefault();
        return go();
      }
    });

    list.addEventListener("click", function (event) {
      var option = event.target.closest(".palette__result");
      if (!option) return;

      var options = Array.prototype.slice.call(
        list.querySelectorAll(".palette__result"),
      );
      active = options.indexOf(option);
      go();
    });
  }

  function init() {
    placeRail();
    spy();
    theme();
    menu();
    copy();
    tabs();
    palette();
    rememberVisit();

    // The rail is measured, so it has to be re-measured when the measurements
    // change. Fonts land after first paint and shift every row.
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(placeRail);
    }

    addEventListener("resize", placeRail);
  }

  // Reduced motion is handled entirely in layout.css: the rail and the sheet
  // still move, they just arrive without a transition.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
