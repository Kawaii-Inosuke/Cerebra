import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import type { Api } from "../api";
import { ActionsProvider } from "../actions";
import { AgentsProvider } from "../agents";
import { PromptProvider } from "../components/Dialogs";
import { ToastProvider } from "../components/Toast";
import { ApiProvider, LibraryProvider, PrefsProvider, ShellProvider } from "../context";

export function renderApp(ui: ReactNode, api: Api) {
  return render(
    <ApiProvider api={api}>
      <PrefsProvider>
        <ToastProvider>
          <PromptProvider>
            <LibraryProvider>
              <ShellProvider>
                <AgentsProvider>
                  <ActionsProvider>{ui}</ActionsProvider>
                </AgentsProvider>
              </ShellProvider>
            </LibraryProvider>
          </PromptProvider>
        </ToastProvider>
      </PrefsProvider>
    </ApiProvider>,
  );
}
