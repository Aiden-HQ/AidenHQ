// Sets <html data-theme> (light or dark) and data-palette before the first paint, so nothing flashes. A separate file
// because the CSP allows no inline script. The mode is ?mode=, else the viewer's saved choice, else the system setting,
// and it follows the system while the choice is "system". ?palette= picks a palette or preset (ui-review --palettes uses both).
(function () {
  var root = document.documentElement;
  var q = new URLSearchParams(location.search);
  var palette = q.get("palette");
  if (/^[a-z][a-z-]*$/.test(palette || "")) root.setAttribute("data-palette", palette); // a palette or a preset the page imports
  var dark = matchMedia("(prefers-color-scheme: dark)");
  function apply() {
    var saved = null;
    try { saved = localStorage.getItem("theme"); } catch (e) {}
    var mode = q.get("mode") || saved || "system";
    root.setAttribute("data-theme", mode === "dark" || (mode !== "light" && dark.matches) ? "dark" : "light");
  }
  apply();
  dark.addEventListener("change", apply);
  window.addEventListener("themechange", apply);
})();
