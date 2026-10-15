// Runs before the first paint (a classic script in <head>, since the CSP allows no inline
// script): ?wall picks the wall layout and the theme is chosen before anything is drawn, so
// nothing shifts or flashes afterwards.
(() => {
  const root = document.documentElement;
  const wall = /[?&]wall(=|&|$)/.test(location.search);
  if (wall) root.classList.add("wall");
  // Day or Night (setkernel-live#37): the visitor's own choice once they use the toggle, else Night
  // on a wall and the system's light or dark everywhere else. A wall keeps its own choice. Storage
  // can be missing or refuse (private windows, blocked site data), so every read and write is
  // guarded and the page works without it. app.js uses this through globalThis.liveTheme.
  const key = wall ? "sk-live-theme-wall" : "sk-live-theme";
  const theme = {
    saved() {
      try {
        const t = localStorage.getItem(key);
        return t === "day" || t === "night" ? t : null;
      } catch {
        return null;
      }
    },
    save(t) {
      try {
        localStorage.setItem(key, t);
      } catch {
        // not saved: the choice lasts this visit
      }
    },
    system: () => (!wall && matchMedia("(prefers-color-scheme: light)").matches ? "day" : "night"),
    // whether a change of the system's light or dark should change the page
    follows: () => !wall && !theme.saved(),
  };
  root.dataset.theme = theme.saved() || theme.system();
  globalThis.liveTheme = theme;
})();
