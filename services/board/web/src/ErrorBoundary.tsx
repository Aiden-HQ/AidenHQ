// A render error in one page shows a message in its place instead of unmounting the whole board: the nav above it stays
// usable, and changing the route (resetKey) drops the error. main.tsx keeps one around <App/> as the last resort.
import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "./ui";

interface Props {
  children: ReactNode;
  /** The route the page is on: a new value clears a caught error, so the next page renders. */
  resetKey?: string;
}
interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Page failed to render", error, info.componentStack);
  }

  componentDidUpdate(prev: Props) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const retry = () => this.setState({ error: null });
    return (
      <main className="page wide error-boundary" role="alert">
        <h1>This page failed to load</h1>
        <p className="muted">The rest of the board still works; use the navigation, or try this page again.</p>
        <pre className="error-boundary-detail">{error.message || error.name}</pre>
        <div className="error-boundary-actions">
          <Button variant="primary" onClick={retry}>
            Retry
          </Button>
          <Button onClick={() => location.reload()}>Reload page</Button>
        </div>
      </main>
    );
  }
}
