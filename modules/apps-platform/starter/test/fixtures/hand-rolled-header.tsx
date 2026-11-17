// A typical hand-rolled app header: its brand link intercepts the click, so it goes dead when the router owns the URL.
import * as React from "react"

export function AppHeader() {
  React.useEffect(() => void setTimeout(() => {}, 100), [])
  return (
    <header style={{ background: "#0b1220" }}>
      <a href="/" onClick={() => history.pushState(null, "", "/")}>
        Roadmap Keeper
      </a>
      <span className="text-[#fff]">Projects</span>
    </header>
  )
}
