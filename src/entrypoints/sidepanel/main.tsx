import ReactDOM from "react-dom/client";
import "../../ui/styles.css";
import {
  ErrorBoundary,
  installClientErrorReporting,
} from "../../ui/components/ErrorBoundary";
import { App } from "./App";

installClientErrorReporting("sidepanel");

const root = document.getElementById("root");
if (root) {
  ReactDOM.createRoot(root).render(
    <ErrorBoundary surface="sidepanel">
      <App />
    </ErrorBoundary>,
  );
}
