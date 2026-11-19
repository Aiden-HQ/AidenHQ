// Who moves an instance's `product:` pin, decided by instance.yaml alone: a `release:` key means the instance installs
// releases and the kernel's updater (kernel/src/updates.ts) is the only mover; no `release:` means it pins product commits
// itself and the code host's release train (codehost-github train.ts) is the only mover. Both sides ask this one function.
export type PinOwner = "updater" | "train";
export const pinOwner = (instanceText: string): PinOwner => (/^release:/m.test(instanceText) ? "updater" : "train");
