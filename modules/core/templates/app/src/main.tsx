import "@/lib/csp" // first: Radix's run-time <style> tags need the CSP nonce before anything renders
import "./index.css"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { App } from "./App"

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
