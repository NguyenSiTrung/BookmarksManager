import ReactDOM from "react-dom/client";
import "../../ui/styles.css";

function App() {
  return (
    <main className="mx-auto max-w-xl p-6">
      <h1 className="text-xl font-semibold">Bookmarks Manager Options</h1>
      <form className="mt-4 space-y-4">
        <div>
          <label htmlFor="provider" className="block text-sm font-medium">
            Provider
          </label>
          <select
            id="provider"
            className="mt-1 w-full rounded border border-gray-300 px-2 py-1 text-sm"
          >
            <option value="typesafe">TypeSafe</option>
            <option value="openrouter">OpenRouter</option>
          </select>
        </div>
        <div>
          <label htmlFor="api-key" className="block text-sm font-medium">
            API key
          </label>
          <input
            id="api-key"
            type="password"
            autoComplete="off"
            className="mt-1 w-full rounded border border-gray-300 px-2 py-1 text-sm"
          />
        </div>
        <button
          type="button"
          className="rounded bg-blue-600 px-3 py-1 text-sm text-white"
        >
          Save settings
        </button>
      </form>
    </main>
  );
}

const root = document.getElementById("root");
if (root) {
  ReactDOM.createRoot(root).render(<App />);
}
