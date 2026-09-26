import ReactDOM from "react-dom/client";
import "../../ui/styles.css";
import { DeleteAllData } from "./DeleteAllData";
import { ProviderSetup } from "./ProviderSetup";

const root = document.getElementById("root");
if (root) {
  ReactDOM.createRoot(root).render(
    <>
      <ProviderSetup />
      <DeleteAllData />
    </>,
  );
}
