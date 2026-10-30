import DefaultTheme from "vitepress/theme";
import "./myrmo.css";

// The navbar title is the logo (the M with its antennae) followed by "yrmo": say it as one word.
if (typeof document !== "undefined") {
  const name = (): boolean => {
    const title = document.querySelector(".VPNavBarTitle a.title");
    title?.setAttribute("aria-label", "Myrmo");
    return Boolean(title);
  };
  const watch = new MutationObserver(() => name() && watch.disconnect());
  addEventListener("DOMContentLoaded", () => name() || watch.observe(document.body, { childList: true, subtree: true }));
}

export default DefaultTheme;
