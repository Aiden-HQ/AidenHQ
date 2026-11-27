// Replaces a global for one test (fetch, EventSource) and puts it back in afterEach via unstubAllGlobals.
const saved = new Map<string, unknown>();
const globals = globalThis as Record<string, unknown>;

export const stubGlobal = (name: string, value: unknown) => {
  if (!saved.has(name)) saved.set(name, globals[name]);
  globals[name] = value;
};
export const unstubAllGlobals = () => {
  for (const [name, value] of saved) globals[name] = value;
  saved.clear();
};
