import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useUIStore } from "@/stores/ui.store";
import { quitApp, startSync } from "@/lib/api";
import { useAccountsQuery } from "@/hooks/queries";

export function useCloseToBackground() {
  const { data: accounts } = useAccountsQuery();
  const pollInterval = useUIStore((s) => s.pollInterval);
  const realtimeMode = useUIStore((s) => s.realtimeMode);

  useEffect(() => {
    const appWindow = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    let disposed = false;

    appWindow
      .onCloseRequested((event) => {
        // Tauri's JS wrapper destroys the window when this handler returns
        // without `preventDefault`, and `destroy()` never raises Rust's
        // `CloseRequested` event — the one place the window is hidden instead of
        // destroyed. Letting the default run would therefore tear the window
        // down behind the backend's back and take the whole app with it, since
        // the window is the only one it has. So the event is always claimed and
        // the outcome chosen here: hide, or leave on purpose.
        event.preventDefault();

        if (!useUIStore.getState().keepRunningInBackground) {
          void quitApp().catch((err) => console.warn("Failed to quit on close", err));
          return;
        }

        void appWindow
          .hide()
          .catch((err) => console.warn("Failed to hide window on close", err));
      })
      .then((fn) => {
        if (disposed) {
          fn();
          return;
        }
        unlisten = fn;
      })
      .catch((err) => console.warn("Failed to register close-to-background handler", err));

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // Resume sync workers when window regains visibility after being hidden to tray
  useEffect(() => {
    const appWindow = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    let disposed = false;

    appWindow
      .onFocusChanged(({ payload: focused }) => {
        if (!focused) return;
        if (realtimeMode === "manual") return;
        const ids = accounts?.map((a) => a.id) ?? [];
        for (const id of ids) {
          startSync(id, pollInterval).catch(() => {});
        }
      })
      .then((fn) => {
        if (disposed) {
          fn();
          return;
        }
        unlisten = fn;
      })
      .catch(() => {});

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [accounts, pollInterval, realtimeMode]);
}
