(function () {
  const root = document.documentElement;
  const storageKey = "imindbench-theme-v2";

  function savedTheme() {
    try {
      return localStorage.getItem(storageKey);
    } catch {
      return null;
    }
  }

  function applyTheme(theme, persist) {
    root.dataset.theme = theme;
    root.style.colorScheme = theme;
    const themeColor = document.querySelector('meta[name="theme-color"]');
    if (themeColor) themeColor.content = theme === "dark" ? "#16191d" : "#f1f3f5";

    if (persist) {
      try {
        localStorage.setItem(storageKey, theme);
      } catch {
        // The selected theme still applies when storage is unavailable.
      }
    }

    document.querySelectorAll(".theme-toggle").forEach((button) => {
      const nextTheme = theme === "dark" ? "light" : "dark";
      button.setAttribute("aria-label", `Use ${nextTheme} mode`);
      button.setAttribute("title", `Use ${nextTheme} mode`);
    });

    window.dispatchEvent(new CustomEvent("imindbenchthemechange"));
  }

  applyTheme(savedTheme() || "light", false);

  document.addEventListener("DOMContentLoaded", () => {
    applyTheme(root.dataset.theme, false);
    document.querySelectorAll(".theme-toggle").forEach((button) => {
      button.addEventListener("click", () => {
        applyTheme(root.dataset.theme === "dark" ? "light" : "dark", true);
      });
    });
  });

})();
