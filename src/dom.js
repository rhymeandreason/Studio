// Generic DOM utilities used across the app.

// Create an element with an optional class name and property assignments.
export function el(tag, className, props = {}) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  Object.assign(node, props);
  return node;
}

// Material Symbols icon markup.
export function mi(name, sm = true) {
  return `<span class="mi${sm ? " mi-sm" : ""}">${name}</span>`;
}

// Generate a short random ID (note IDs, etc.).
export function genId() {
  return "n" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// Clamp a value between min and max (inclusive).
export function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}
