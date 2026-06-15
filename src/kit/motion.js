// Studio kit — motion.
//
// Thin wrapper over the vendored Motion One (@motionone/dom). Tools and
// components call THESE helpers, not Motion directly, so we can re-theme or swap
// the library without touching consumers (see docs/tools-dynamic-loading.md).
//
// Durations/easings come from the --dur-*/--ease-* tokens in tokens.css; read
// them once so motion stays consistent with the rest of the design system.

import { animate, spring, stagger, inView } from "../vendor/motion-one.mjs";

// Re-export the raw primitives for advanced use; prefer the helpers below.
export { animate, spring, stagger, inView };

function tokens() {
    const s = getComputedStyle(document.documentElement);
    const num = (name, fallback) => {
        const v = s.getPropertyValue(name).trim();
        if (!v) return fallback;
        return v.endsWith("ms") ? parseFloat(v) / 1000 : parseFloat(v);
    };
    return {
        fast: num("--dur-fast", 0.13),
        base: num("--dur-base", 0.22),
        slow: num("--dur-slow", 0.4),
        ease: s.getPropertyValue("--ease-standard").trim() || "ease",
        easeEmphasized:
            s.getPropertyValue("--ease-emphasized").trim() || "ease",
    };
}

/** Fade + slide a freshly-shown element in. */
export function enter(el, { y = 6, duration } = {}) {
    const t = tokens();
    return animate(
        el,
        { opacity: [0, 1], transform: [`translateY(${y}px)`, "translateY(0)"] },
        { duration: duration ?? t.base, easing: t.ease },
    );
}

/** Fade + slide an element out; resolves when done (then remove/hide it). */
export function exit(el, { y = 6, duration } = {}) {
    const t = tokens();
    return animate(
        el,
        { opacity: [1, 0], transform: ["translateY(0)", `translateY(${y}px)`] },
        { duration: duration ?? t.fast, easing: t.ease },
    ).finished;
}

/** Stagger `enter` across a list of elements. */
export function enterStagger(els, { y = 6, each = 0.04 } = {}) {
    const t = tokens();
    return animate(
        els,
        { opacity: [0, 1], transform: [`translateY(${y}px)`, "translateY(0)"] },
        { duration: t.base, easing: t.ease, delay: stagger(each) },
    );
}

/** A small press/pop feedback (e.g. on a successful action). */
export function pop(el) {
    const t = tokens();
    return animate(
        el,
        { transform: ["scale(1)", "scale(1.06)", "scale(1)"] },
        { duration: t.base, easing: spring({ stiffness: 500, damping: 18 }) },
    );
}
