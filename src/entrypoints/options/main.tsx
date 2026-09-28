import ReactDOM from "react-dom/client";
import "../../ui/styles.css";
import { DecisionSettings } from "./DecisionSettings";
import { DeleteAllData } from "./DeleteAllData";
import { LlmProviderSetup } from "./LlmProviderSetup";
import { ProviderSetup } from "./ProviderSetup";
import { SentLog } from "./SentLog";

const root = document.getElementById("root");
if (root) {
  ReactDOM.createRoot(root).render(
    <>
      <ProviderSetup />
      <LlmProviderSetup />
      <DecisionSettings />
      <SentLog />
      <DeleteAllData />
    </>,
  );
}
