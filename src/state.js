// Shared mutable app state.
//
// Only globals that are read/written across feature boundaries live here, so
// that feature modules (notes/media/projects/workspace) can be split out of
// main.js without fighting read-only ES `import` bindings. Feature-local state
// stays as module-locals inside each feature's own file.
export const state = {};
