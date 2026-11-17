// A module's page (#/modules/<name>/<tab>) (lane D, build step 4). Placeholder until that lane lands.
export type ModuleTab = "overview" | "contents" | "settings" | "changes";
export function ModulePage({ name }: { name: string; tab: ModuleTab; go: (hash: string) => void; onSignIn: () => void }) {
  return (
    <main className="page wide">
      <p className="fleet-empty">The page for {name} is on its way. <a href="#/modules">Modules</a></p>
    </main>
  );
}
