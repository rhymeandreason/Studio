// Studio kit — components.
//
// Registers the <studio-*> custom elements. Import once per document:
//   <script type="module" src="../kit/components.js"></script>
// Then use the elements anywhere. Each exposes a `.value` getter/setter and
// emits `input`/`change`, so tools treat them like native form controls.
//
// See docs/tools-dynamic-loading.md for the design (Shadow DOM + CSS-var
// theming for most components; light DOM where a vendored lib is
// document-global, as Coloris is).

import Coloris from "../vendor/coloris.js";

// Ensure Coloris's stylesheet is present (resolved relative to THIS module, so
// it works regardless of where the consuming document lives).
function ensureColorisCss() {
    const href = new URL("../vendor/coloris.css", import.meta.url).href;
    if (![...document.styleSheets].some((s) => s.href === href)) {
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = href;
        document.head.appendChild(link);
    }
}

let colorisReady = false;
function ensureColoris() {
    if (colorisReady) return;
    ensureColorisCss();
    Coloris.init();
    // Delegated binding: any [data-coloris] input (incl. ones added later)
    // gets the picker. Themed to Runes via tokens.
    Coloris({
        el: "[data-coloris]",
        themeMode: "light",
        format: "hex",
        alpha: true,
        focusInput: false,
        swatches: [],
    });
    colorisReady = true;
}

/**
 * <studio-color value="#6e6154"> — a color field that opens the Coloris picker.
 *
 * Light DOM on purpose: Coloris is document-global (it appends its picker to
 * <body> and binds via delegation), so a shadow root would hide the input from
 * it. The inner <input> uses the kit `.field` class for Runes styling.
 */
class StudioColor extends HTMLElement {
    static observedAttributes = ["value", "disabled"];

    connectedCallback() {
        ensureColoris();
        if (this._input) return;
        const input = document.createElement("input");
        input.type = "text";
        input.className = "field studio-color-input";
        input.setAttribute("data-coloris", "");
        input.value = this.getAttribute("value") || "#000000";
        if (this.hasAttribute("disabled")) input.disabled = true;
        // Re-emit the inner input's events as the host's own.
        input.addEventListener("input", () => this._emit("input"));
        input.addEventListener("change", () => this._emit("change"));
        this.appendChild(input);
        this._input = input;
    }

    _emit(type) {
        this.dispatchEvent(new Event(type, { bubbles: true }));
    }

    get value() {
        return this._input ? this._input.value : this.getAttribute("value");
    }
    set value(v) {
        this.setAttribute("value", v);
    }

    attributeChangedCallback(name, _old, val) {
        if (!this._input) return;
        if (name === "value" && this._input.value !== val) {
            this._input.value = val;
            // Nudge Coloris to repaint the swatch.
            this._input.dispatchEvent(new Event("input", { bubbles: true }));
        }
        if (name === "disabled") this._input.disabled = val !== null;
    }
}

customElements.define("studio-color", StudioColor);
