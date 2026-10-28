/**
 * The docs' light/dark choice (Batch 38 item 9), applied before first paint
 * by the docs layout's head, so a dark-mode reader never sees a flash of
 * light. Its own module: the layout's head stays in the app's main bundle.
 */
export const THEME_KEY = "aidwar-docs-theme";

export const THEME_SCRIPT = `try{var t=localStorage.getItem("${THEME_KEY}");if(t!=="light"&&t!=="dark")t=matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";document.documentElement.dataset.docsTheme=t}catch(e){}`;
