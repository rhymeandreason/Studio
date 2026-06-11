// Note card themes and fonts.
//
// These define the preset styling options offered in the notes toolbar when a
// card is selected. Add or tweak entries here to change the available palette.

// Preset colour themes for a card. An empty value means "use the default",
// so unstyled cards look exactly as before.
export const NOTE_THEMES = [
  { id: "default", name: "Default" },
  { id: "sand", name: "Sand", bg: "#efe9dc", titleColor: "#6e6154" },
  { id: "clay", name: "Clay", bg: "#ead9c5", titleColor: "#6e6154" },
  { id: "sage", name: "Sage", bg: "#e6ebe3", titleColor: "#566150" },
  { id: "rose", name: "Rose", bg: "#f3e0db", titleColor: "#a85a4a" },
  { id: "ink", name: "Ink", bg: "#2a2a28", titleColor: "#f7f5f0", bodyColor: "#d8d4ca" },
  { id: "lemon", name: "Lemon", bg: "#fdf0a8", titleColor: "#7a6a1e" },
  { id: "mint", name: "Mint", bg: "#bdf0d6", titleColor: "#1f6e4a" },
  { id: "sky", name: "Sky", bg: "#bfe3fb", titleColor: "#1f5f8b" },
  { id: "coral", name: "Coral", bg: "#ffd0c2", titleColor: "#a8412a" },
  { id: "violet", name: "Violet", bg: "#e3d3fb", titleColor: "#6a3fa0" },
  { id: "emerald", name: "Emerald", bg: "#0fcf86", titleColor: "#f4fff9", bodyColor: "#f4fff9" },
  { id: "sapphire", name: "Sapphire", bg: "#2f8cf4", titleColor: "#f2f7ff", bodyColor: "#f2f7ff" },
  { id: "ruby", name: "Ruby", bg: "#fb2f5e", titleColor: "#fff1f4", bodyColor: "#fff1f4" },
  { id: "amethyst", name: "Amethyst", bg: "#a85bf6", titleColor: "#f8f1ff", bodyColor: "#f8f1ff" },
  { id: "amber", name: "Amber", bg: "#ffb01f", titleColor: "#fff6e9", bodyColor: "#fff6e9" },
];

export const NOTE_FONTS = [
  { name: "Default", value: "" },
  { name: "Futura", value: "'Futura', sans-serif" },
  { name: "System", value: "system-ui" },
  { name: "Verdana", value: "Verdana, sans-serif" },
  { name: "New York", value: "'New York', 'New York Medium', serif" },
  { name: "Georgia", value: "Georgia, serif" },
  { name: "Palatino", value: "'Palatino Linotype', Palatino, serif" },
  { name: "Menlo", value: "Menlo, monospace" },
];
