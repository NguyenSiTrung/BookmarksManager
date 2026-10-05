import ReactDOM from "react-dom/client";
import "../../ui/styles.css";
import {
  ErrorBoundary,
  installClientErrorReporting,
} from "../../ui/components/ErrorBoundary";
import { App } from "./App";

installClientErrorReporting("popup");

const root = document.getElementById("root");
if (root) {
  ReactDOM.createRoot(root).render(
    <ErrorBoundary surface="popup">
      <App />
    </ErrorBoundary>,
  );
}
