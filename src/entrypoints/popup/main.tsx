import ReactDOM from "react-dom/client";
import "../../ui/styles.css";
import { App } from "./App";

const root = document.getElementById("root");
if (root) {
  ReactDOM.createRoot(root).render(<App />);
}
