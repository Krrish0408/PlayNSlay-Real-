import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { initCsrfFetchInterceptor } from "./lib/csrf";

initCsrfFetchInterceptor();

createRoot(document.getElementById("root")!).render(<App />);
