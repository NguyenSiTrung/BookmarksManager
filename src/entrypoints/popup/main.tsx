import ReactDOM from "react-dom/client";
import "../../ui/styles.css";

function App() {
  return (
    <main className="w-64 p-4">
      <h1 className="text-lg font-semibold">Bookmarks Manager</h1>
      <p className="mt-2 text-sm text-gray-600">
        Find and organize your bookmarks.
      </p>
      <div className="mt-3">
        <label htmlFor="popup-search" className="block text-sm font-medium">
          Search bookmarks
        </label>
        <input
          id="popup-search"
          type="search"
          placeholder="Search…"
          className="mt-1 w-full rounded border border-gray-300 px-2 py-1 text-sm"
        />
      </div>
    </main>
  );
}

const root = document.getElementById("root");
if (root) {
  ReactDOM.createRoot(root).render(<App />);
}
