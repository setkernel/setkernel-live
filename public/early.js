// Runs before the first paint (a classic script in <head>, since the CSP allows no inline
// script): ?wall picks the wall, a fixed 16:9 canvas in one dark theme (hq#177, question 7), so
// nothing shifts or flashes afterwards. The page follows the system's light or dark and stores nothing.
(() => {
  if (/[?&]wall(=|&|$)/.test(location.search)) document.documentElement.classList.add("wall");
})();
