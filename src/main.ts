import { emit, listen } from "@tauri-apps/api/event";

const status = document.querySelector("#status");
const detail = document.querySelector("#detail");

function showError(message: string) {
  if (status) status.textContent = "Failed to start DeepSeek Harness";
  if (detail instanceof HTMLElement) {
    detail.hidden = false;
    detail.textContent = message;
  }
}

void listen<string>("host-ready", (event) => {
  if (status) status.textContent = "Opening…";
  window.location.replace(event.payload);
});

void listen<string>("host-error", (event) => {
  showError(event.payload);
});

// Tell the host the listeners are up; events sent before this would be lost.
void emit("splash-ready");
