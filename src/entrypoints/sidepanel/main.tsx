import ReactDOM from "react-dom/client";
import "../../ui/styles.css";

function App() {
  return (
    <main className="p-4">
      <h1 className="text-lg font-semibold">Bookmarks Manager</h1>
      <p className="mt-2 text-sm text-gray-600">
        Review suggested bookmark changes here.
      </p>
      <button
        type="button"
        className="mt-4 rounded bg-blue-600 px-3 py-1 text-sm text-white"
      >
        Review suggestions
      </button>
    </main>
  );
}

const root = document.getElementById("root");
if (root) {
  ReactDOM.createRoot(root).render(<App />);
}
