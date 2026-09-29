import ReactDOM from "react-dom/client";
import "../../ui/styles.css";
import { OptionsApp } from "./OptionsApp";

const root = document.getElementById("root");
if (root) {
  ReactDOM.createRoot(root).render(<OptionsApp />);
}
