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

  function init() {
    placeRail();
    spy();
    theme();
    menu();

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
