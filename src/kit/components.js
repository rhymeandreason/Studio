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
        theme: "polaroid",
        themeMode: "light",
        format: "hex",
        alpha: true,
        focusInput: false,
        swatches: [
            'DarkSlateGray',
            '#2a9d8f',
            '#e9c46a',
            'coral',
            'rgb(231, 111, 81)',
            'Crimson',
            '#023e8a',
            '#0077b6',
            'hsl(194, 100%, 39%)',
            '#00b4d8',
            '#48cae4',
        ],
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

/**
 * <studio-swatch value="#e9c46a" name="Accent" deletable name-editable>
 *
 * A color swatch chip with label and hex display. Clicking the color block
 * opens a Coloris picker.
 *
 * Attributes:
 *   value         — hex color (default #000000)
 *   name          — label text
 *   deletable     — boolean; shows × delete button
 *   name-editable — boolean; makes the label an editable <input>
 *
 * Events:
 *   input / change  — color changed (.value)
 *   nameinput       — name edited (.name)
 *   delete          — delete button clicked
 */
class StudioSwatch extends HTMLElement {
    static observedAttributes = ["value", "name", "deletable", "name-editable", "picker"];

    connectedCallback() {
        ensureColoris();
        if (this._built) return;
        this._built = true;
        this.classList.add("swatch-chip");

        // Hidden Coloris trigger
        this._trigger = document.createElement("input");
        this._trigger.type = "text";
        this._trigger.className = "swatch-chip__trigger";
        this._trigger.setAttribute("data-coloris", "");
        this._trigger.value = this.getAttribute("value") || "#000000";
        this._trigger.addEventListener("input", () => {
            this._block.style.background = this._trigger.value;
            this._hex.textContent = this._trigger.value;
            this.dispatchEvent(new Event("input", { bubbles: true }));
        });
        this._trigger.addEventListener("change", () => {
            this.dispatchEvent(new Event("change", { bubbles: true }));
        });

        this._block = document.createElement("div");
        this._block.className = "swatch-chip__block";
        this._block.style.background = this._trigger.value;
        this._block.addEventListener("click", () => this._trigger.click());

        const nameVal = this.getAttribute("name") || "";
        if (this.hasAttribute("name-editable")) {
            this._nameEl = document.createElement("input");
            this._nameEl.className = "swatch-chip__name";
            this._nameEl.value = nameVal;
            this._nameEl.addEventListener("input", () => {
                this.dispatchEvent(new Event("nameinput", { bubbles: true }));
            });
        } else {
            this._nameEl = document.createElement("div");
            this._nameEl.className = "swatch-chip__name";
            this._nameEl.textContent = nameVal;
        }

        this._hex = document.createElement("div");
        this._hex.className = "swatch-chip__hex";
        this._hex.textContent = this._trigger.value;

        this._del = document.createElement("button");
        this._del.className = "swatch-chip__del";
        this._del.title = "Remove";
        this._del.textContent = "×";
        this._del.addEventListener("click", () => {
            this.dispatchEvent(new Event("delete", { bubbles: true }));
        });
        if (!this.hasAttribute("deletable")) this._del.style.display = "none";

        this.append(this._trigger, this._block, this._nameEl, this._hex, this._del);
    }

    get value() { return this._trigger ? this._trigger.value : (this.getAttribute("value") || "#000000"); }
    set value(v) { this.setAttribute("value", v); }

    get name() { return this._nameEl ? (this._nameEl.value ?? this._nameEl.textContent) : (this.getAttribute("name") || ""); }
    set name(v) { this.setAttribute("name", v); }

    attributeChangedCallback(attr, _old, val) {
        if (!this._built) return;
        if (attr === "value" && this._trigger.value !== val) {
            this._trigger.value = val || "#000000";
            this._block.style.background = this._trigger.value;
            this._hex.textContent = this._trigger.value;
        }
        if (attr === "name") {
            if (this._nameEl.tagName === "INPUT") this._nameEl.value = val || "";
            else this._nameEl.textContent = val || "";
        }
        if (attr === "deletable") {
            this._del.style.display = val !== null ? "" : "none";
        }
    }
}

customElements.define("studio-swatch", StudioSwatch);
