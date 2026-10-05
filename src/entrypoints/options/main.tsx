import ReactDOM from "react-dom/client";
import "../../ui/styles.css";
import {
  ErrorBoundary,
  installClientErrorReporting,
} from "../../ui/components/ErrorBoundary";
import { OptionsApp } from "./OptionsApp";

installClientErrorReporting("options");

const root = document.getElementById("root");
if (root) {
  ReactDOM.createRoot(root).render(
    <ErrorBoundary surface="options">
      <OptionsApp />
    </ErrorBoundary>,
  );
}
