import ReactDOM from "react-dom/client";
import "../../ui/styles.css";
import { ProviderSetup } from "./ProviderSetup";

const root = document.getElementById("root");
if (root) {
  ReactDOM.createRoot(root).render(<ProviderSetup />);
}
