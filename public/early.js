// Runs before the first paint (a classic script in <head>, since the CSP allows no inline
// script): ?wall picks the wall layout before anything is drawn, so nothing shifts afterwards.
if (/[?&]wall(=|&|$)/.test(location.search)) document.documentElement.classList.add("wall");
