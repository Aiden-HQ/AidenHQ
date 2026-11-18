// Every agent is a record: Paperclip requires an adapter and verifies it before the agent can take work, and never runs it
// (the kernel runs every job). The built-in process adapter's check only needs the command to resolve and the cwd to exist, so a
// record passes it; were it ever invoked, `true` does nothing.
export const RECORD_ADAPTER = { adapterType: "process", adapterConfig: { command: "true", cwd: "/" } };

/** Create the agent's record, or bring an existing one (any adapter it had) to the record adapter. Returns the record. */
export async function writeRecord({ api, companyId, agent, body, instructionsBundle }) {
  const record = { ...body, ...RECORD_ADAPTER };
  if (agent) {
    await api("PATCH", `/api/agents/${agent.id}`, record);
    return { agent, created: false };
  }
  return { agent: (await api("POST", `/api/companies/${companyId}/agents`, { ...record, instructionsBundle })).json, created: true };
}
