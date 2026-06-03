// Studio frontend shell.
// M2: render the active project. The tray (Rust side) owns project discovery
// and activation; here we just reflect the active project in the window.

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

function render(project) {
  const empty = document.getElementById("empty-state");
  const content = document.getElementById("project-content");
  const header = document.getElementById("project-header");

  if (project) {
    document.getElementById("project-name").textContent = project.name;
    document.getElementById("project-path").textContent = project.path;
    header.hidden = false;
    empty.hidden = true;
    content.hidden = false;
  } else {
    header.hidden = true;
    empty.hidden = false;
    content.hidden = true;
  }
}

window.addEventListener("DOMContentLoaded", async () => {
  // Reflect whatever's already active (e.g. window reopened after activation).
  render(await invoke("get_active_project"));

  // Update live when a project is activated from the tray.
  await listen("project-activated", (event) => render(event.payload));
});
