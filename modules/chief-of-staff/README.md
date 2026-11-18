# chief-of-staff

Event wake-ups (board `wake.ts`, every 2 minutes): a heartbeat agent is woken on its open task, with a notice naming what changed, when a sub-task it delegated is done or cancelled, an approval card on it is decided, a sub-task's grade settles, or a PR it names merges or closes, unless a run of it already followed; at most 4 wakes per agent per hour.
